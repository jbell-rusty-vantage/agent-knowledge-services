import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { KnowledgeSqlClient, KnowledgeTransactionScope, KnowledgeTransactions } from "../ports.js";
import { isKnowledgeError } from "../schema-workspace/index.js";
import { CAPTURE_INTENT_TYPE, CaptureRegistrar, type CapturedSource } from "./register.js";

const TENANT = "00000000-0000-7000-8000-000000000001";
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const TEXT = "# Title\n\nA quotable paragraph.";

function source(overrides: Partial<CapturedSource> = {}): CapturedSource {
  const artifact = {
    artifactId: "0192e000-0000-7000-8000-000000000001",
    digest: digest(TEXT),
    mediaType: "text/markdown; charset=utf-8",
    byteLength: Buffer.byteLength(TEXT),
  };
  return {
    executorCaptureId: "capture-abc",
    requestedUrl: "https://docs.example.test/page#part",
    finalUrl: "https://docs.example.test/page",
    capturedAt: "2026-11-16T12:00:00.000Z",
    captureMethod: "file_text",
    captureMethodVersion: "verification-executor-capture.v2",
    sourceKind: "other",
    sourceMediaType: "text/markdown",
    capture: artifact,
    representation: { ...artifact, text: TEXT },
    custody: "local",
    ...overrides,
  };
}

/**
 * A database that records every statement and answers the few reads the registrar makes: nothing is registered
 * until the capture row is inserted, and the intent type is declared only when `declared` is true.
 */
function fakeDatabase(declared: boolean) {
  const scopes: KnowledgeTransactionScope[] = [];
  const statements: string[] = [];
  let captureInserted = false;
  const client: KnowledgeSqlClient = {
    async query(text: string, values: readonly unknown[] = []) {
      statements.push(text.replace(/\s+/g, " ").trim());
      const rows = (list: Record<string, unknown>[]) => ({ rows: list as never[], rowCount: list.length });
      if (/^insert into evidence\.source_capture/.test(text.trim())) captureInserted = true;
      if (/^insert into/.test(text.trim())) return { rows: [], rowCount: 1 };
      if (text.includes("from orchestration.intent_type")) return rows(declared ? [{ "?column?": 1 }] : []);
      if (text.includes("from orchestration.artifact") && text.includes("storage_bucket"))
        return rows([
          {
            id: "a1",
            artifact_type: "source_capture",
            sha256: digest(TEXT).slice(7),
            media_type: "text/markdown; charset=utf-8",
            size_bytes: Buffer.byteLength(TEXT),
            storage_state: "pending",
          },
        ]);
      if (text.includes("from evidence.source_capture c") && captureInserted)
        return rows([
          {
            capture_id: "c1",
            executor_capture_id: "capture-abc",
            source_id: "s1",
            document_id: "d1",
            document_version_id: "v1",
            representation_id: "r1",
            fetch_id: "f1",
            media_type: "text/markdown",
            content_sha256: digest(TEXT).slice(7),
            artifact_id: "a1",
            custody: "local",
            storage_state: "pending",
          },
        ]);
      if (text.includes("from content.document_node n") && text.includes("count(*) over () as total"))
        return rows([
          {
            node_id: "n1",
            unit_kind: "paragraph",
            ordinal: 1,
            start_offset: 9,
            end_offset: 31,
            pointer: null,
            text: "A quotable paragraph.",
            text_chars: 21,
            total: "2",
          },
        ]);
      if (text.includes("position("))
        return rows(values[2] === "quotable" ? [{ node_id: "n1", unit_kind: "paragraph", containing: "1" }] : []);
      if (text.includes("from orchestration.operation_intent i"))
        return rows(declared && captureInserted ? [{ intent_id: "i1", receipt_id: "rc1" }] : []);
      return rows([]);
    },
  };
  const db: KnowledgeTransactions = {
    async transaction(scope, work) {
      scopes.push(scope);
      return work(client);
    },
  };
  return { db, scopes, statements };
}

const refused = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isKnowledgeError(error)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
};

describe("capture registrar", () => {
  it("writes the capture lineage in one executor_service transaction, inserts only, and anchors a quote", async () => {
    const fake = fakeDatabase(false);
    const registrar = new CaptureRegistrar({ db: fake.db, executorVersion: "knowledge-executor/test" });
    const result = await registrar.register(TENANT, source(), { quotes: ["quotable", "absent"] });
    expect(fake.scopes).toEqual([{ tenantId: TENANT, role: "executor_service", statementTimeoutMs: 60_000 }]);
    const writes = fake.statements.filter((statement) => /^(insert|update|delete)/.test(statement));
    expect(writes.map((statement) => statement.split("(")[0]?.split(" set ")[0]?.trim())).toEqual([
      "insert into orchestration.artifact",
      "insert into acquisition.fetch",
      "insert into evidence.source",
      "insert into evidence.source_capture",
      "update evidence.source",
      "insert into content.document",
      "insert into content.document_version",
      "insert into content.document_version_source_capture",
      "insert into content.document_representation",
      "insert into content.document_node",
    ]);
    // The capture is bound to the URL without its fragment; the tenant is the session's, never an argument.
    const captureInsert = fake.statements.find((statement) =>
      statement.startsWith("insert into evidence.source_capture"),
    );
    expect(captureInsert).toContain("acquisition_fetch_id");
    expect(fake.statements.some((statement) => /set_config|set role|delete /i.test(statement))).toBe(false);
    expect(result).toMatchObject({
      capture_id: "c1",
      replayed: false,
      role: "executor_service",
      custody: { remote: false, storage_state: "pending" },
      units_total: 2,
      receipt: { receipt_id: null, unavailable: expect.stringContaining("INTENT_TYPE_UNDECLARED") },
    });
    expect(result.anchors).toEqual([
      {
        quote: "quotable",
        status: "found",
        anchor: { capture_id: "c1", node_id: "n1", quote: "quotable" },
        unit_kind: "paragraph",
        units_containing: 1,
      },
      { quote: "absent", status: "not_in_one_unit" },
    ]);
  });

  it("files the registration under an operation receipt once the contract declares its intent type", async () => {
    const fake = fakeDatabase(true);
    const result = await new CaptureRegistrar({ db: fake.db, executorVersion: "v" }).register(TENANT, source());
    const ledger = fake.statements.filter((statement) => /^insert into orchestration\.operation_/.test(statement));
    expect(ledger.map((statement) => statement.split("(")[0])).toEqual([
      "insert into orchestration.operation_intent",
      "insert into orchestration.operation_receipt",
      "insert into orchestration.operation_receipt_target",
      "insert into orchestration.operation_receipt_target",
      "insert into orchestration.operation_receipt_target",
    ]);
    expect(CAPTURE_INTENT_TYPE).toBe("capture_registration");
    expect(result.receipt).toEqual({ intent_id: "i1", receipt_id: "rc1" });
  });

  it("refuses before any transaction a media type it cannot split, text that is not its artifact, and a bad option", async () => {
    const fake = fakeDatabase(false);
    const registrar = new CaptureRegistrar({ db: fake.db, executorVersion: "v" });
    expect(await refused(registrar.register(TENANT, source({ sourceMediaType: "application/pdf" })))).toMatchObject({
      code: "CAPTURE_MEDIA_TYPE_UNSUPPORTED",
      exit: 1,
      details: { mediaType: "application/pdf" },
    });
    const tampered = source();
    expect(
      await refused(
        registrar.register(TENANT, { ...tampered, representation: { ...tampered.representation, text: `${TEXT}!` } }),
      ),
    ).toMatchObject({ code: "CAPTURE_REPRESENTATION_MISMATCH", exit: 2 });
    expect(await refused(registrar.register(TENANT, source(), { documentType: "Not A Code" }))).toMatchObject({
      code: "INPUT_INVALID",
    });
    expect(fake.scopes).toEqual([]);
  });

  it("maps a permission refusal to a stable infrastructure code", async () => {
    const db: KnowledgeTransactions = {
      async transaction() {
        throw Object.assign(new Error("permission denied for table source_capture"), { code: "42501" });
      },
    };
    expect(await refused(new CaptureRegistrar({ db, executorVersion: "v" }).register(TENANT, source()))).toMatchObject({
      code: "CAPTURE_ROLE_NOT_GRANTED",
      exit: 2,
      details: { sqlstate: "42501" },
    });
  });
});
