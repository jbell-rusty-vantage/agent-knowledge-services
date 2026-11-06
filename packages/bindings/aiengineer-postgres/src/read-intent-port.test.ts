import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeError, type ReadSnapshot, type Workspace } from "@aiengineer/knowledge-db";
import { ProtocolRefusal } from "@aiengineer/knowledge-host/knowledge-operation";
import {
  KnowledgeReadIntentRequestSchema,
  type OperationEnvelope,
  digestCanonical,
  readIntentSnapshotDigest,
} from "@aiengineer/knowledge-operation-protocol";
import { afterAll, describe, expect, it } from "vitest";
import { createReadIntentPort, protocolInstant } from "./read-intent-port.js";

const TENANT = "00000000-0000-7000-8000-0000000000ad";
const dir = mkdtempSync(join(tmpdir(), "ks-read-intent-"));
mkdirSync(join(dir, "relations", "knowledge"), { recursive: true });
writeFileSync(join(dir, "relations", "knowledge", "entity.md"), "# knowledge.entity\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const WORKSPACE = {
  dir,
  manifest: {},
  migrationHead: "20261031000000",
  fingerprint: "fp-1",
  index: [
    {
      id: "rel:knowledge.entity",
      kind: "relation",
      path: "relations/knowledge/entity.md",
      name: "entity",
      aliases: [],
      summary: "knowledge entity",
    },
  ],
  aliases: {},
  terminology: {},
  catalog: undefined,
} as unknown as Workspace;

const ENVELOPE = { requestId: "req-1", dispatchId: "dispatch-1" } as OperationEnvelope;
const scope = (tenant = TENANT) =>
  ({ tenant, application: "ai-engineer", binding: "aiengineer-postgres" }) as Parameters<
    ReturnType<typeof createReadIntentPort>["run"]
  >[0];

function snapshot(intent: { operations: { opId: string; query: string }[] }): ReadSnapshot {
  return {
    schemaVersion: "knowledge-read-snapshot.v1",
    snapshotId: "019a0000-0000-7000-8000-00000000000a",
    intentRef: { intentId: "x", intentDigest: `sha256:${"0".repeat(64)}` },
    context: { tenantId: TENANT, executorVersion: "t" },
    contract: { migrationHead: "20261031000000", catalogVersion: "1.2.0" },
    knowledgeHead: { knowledgeSeq: 9, updatedAt: "2026-10-31T10:00:00.120Z" },
    knowledgeHeadAfter: { knowledgeSeq: 9, updatedAt: "2026-10-31T10:00:00.120Z" },
    headChanged: false,
    atKnowledgeSeq: 9,
    executedAt: "2026-10-31T10:00:01.000Z",
    operations: intent.operations.map((operation) => ({
      opId: operation.opId,
      kind: "named_query",
      query: operation.query,
      status: "ok",
      rowCount: 1,
      truncated: false,
      columns: ["id", "score"],
      rows: [{ id: "e-1", score: 0.25 }],
      contentDigest: `sha256:${"1".repeat(64)}`,
      durationMs: 1,
    })),
    snapshotDigest: `sha256:${"2".repeat(64)}`,
  };
}

describe("AIDB knowledge.read_intent port", () => {
  it("answers named queries and schema reads in request order with K01 digests over protocol JSON", async () => {
    const calls: { intent: unknown; persist: boolean | undefined }[] = [];
    const port = createReadIntentPort(
      {
        runIntent: async (intent: never, options?: { persist?: boolean }) => {
          calls.push({ intent, persist: options?.persist });
          return snapshot(intent);
        },
        head: async () => ({ knowledgeSeq: 9, updatedAt: "2026-10-31T10:00:00Z" }),
      } as never,
      WORKSPACE,
      TENANT,
    );
    const request = KnowledgeReadIntentRequestSchema.parse({
      schemaVersion: "knowledge-read-intent-request.v1",
      purpose: "discovery",
      persist: true,
      operations: [
        { opId: "page", kind: "schema_get", id: "rel:knowledge.entity" },
        { opId: "find", kind: "named_query", query: "entity.resolve", params: { text: "LangGraph" }, limit: 5 },
        { opId: "missing", kind: "schema_get", id: "rel:knowledge.nothing" },
      ],
    });
    const answer = await port.run(scope(), { envelope: ENVELOPE, request });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.persist).toBe(true);
    expect(calls[0]?.intent).toMatchObject({ context: { tenantId: TENANT } });
    expect(answer.operations.map((operation) => operation.opId)).toEqual(["page", "find", "missing"]);
    const find = answer.operations[1];
    expect(find?.rows).toEqual([{ id: "e-1", score: "0.25" }]);
    expect(find?.contentDigest).toBe(digestCanonical([{ id: "e-1", score: "0.25" }]));
    expect(answer.operations[2]?.status).toBe("error");
    expect(answer.operations[2]?.error?.code).toBe("PAGE_NOT_FOUND");
    expect(answer.knowledgeHead.updatedAt).toBe("2026-10-31T10:00:00.12Z");
    expect(answer.contract).toEqual({
      migrationHead: "20261031000000",
      workspaceFingerprint: "fp-1",
      catalogVersion: "1.2.0",
    });
    expect(answer.snapshotDigest).toBe(readIntentSnapshotDigest(9, answer.operations));
  });

  it("reads the head only when no named query is asked", async () => {
    let ran = false;
    const port = createReadIntentPort(
      {
        runIntent: async () => {
          ran = true;
          throw new Error("unexpected");
        },
        head: async () => ({ knowledgeSeq: 4, updatedAt: "2026-10-31T10:00:00.000Z" }),
      } as never,
      WORKSPACE,
      TENANT,
    );
    const request = KnowledgeReadIntentRequestSchema.parse({
      schemaVersion: "knowledge-read-intent-request.v1",
      purpose: "discovery",
      operations: [{ opId: "where", kind: "schema_search", query: "entity" }],
    });
    const answer = await port.run(scope(), { envelope: ENVELOPE, request });
    expect(ran).toBe(false);
    expect(answer.atKnowledgeSeq).toBe(4);
    expect(answer.knowledgeHead.updatedAt).toBe("2026-10-31T10:00:00Z");
    await expect(
      port.run(scope(), { envelope: ENVELOPE, request: { ...request, atKnowledgeSeq: 5 } }),
    ).rejects.toMatchObject({ error: { code: "EXACT_REVISION_UNAVAILABLE" } });
  });

  it("refuses another tenant and a non-allowlisted query before any read; maps native errors", async () => {
    let reads = 0;
    const port = createReadIntentPort(
      {
        runIntent: async () => {
          reads += 1;
          throw new KnowledgeError("PARAMS_INVALID", "bad params", 1);
        },
        head: async () => {
          reads += 1;
          return { knowledgeSeq: 0, updatedAt: "2026-10-31T10:00:00Z" };
        },
      } as never,
      WORKSPACE,
      TENANT,
    );
    const request = KnowledgeReadIntentRequestSchema.parse({
      schemaVersion: "knowledge-read-intent-request.v1",
      purpose: "discovery",
      operations: [{ opId: "a", kind: "named_query", query: "entity.card", params: {} }],
    });
    const other = await port
      .run(scope("00000000-0000-7000-8000-0000000000ff"), { envelope: ENVELOPE, request })
      .catch((error: unknown) => error);
    expect(other).toBeInstanceOf(ProtocolRefusal);
    expect((other as ProtocolRefusal).error.code).toBe("SCOPE_DENIED");
    const sneaky = {
      ...request,
      operations: [{ opId: "a", kind: "named_query", query: "admin.dump", params: {} }],
    } as never;
    await expect(port.run(scope(), { envelope: ENVELOPE, request: sneaky })).rejects.toMatchObject({
      error: { code: "SCOPE_DENIED" },
    });
    expect(reads).toBe(0);
    await expect(port.run(scope(), { envelope: ENVELOPE, request })).rejects.toMatchObject({
      error: { code: "INVALID_ENVELOPE" },
    });
  });

  it("writes K01 instants without trailing fraction zeros", () => {
    expect(protocolInstant("2026-10-31T10:00:00.000Z")).toBe("2026-10-31T10:00:00Z");
    expect(protocolInstant("2026-10-31T10:00:00.500Z")).toBe("2026-10-31T10:00:00.5Z");
    expect(protocolInstant("2026-10-31 10:00:00.123+00")).toBe("2026-10-31T10:00:00.123Z");
  });
});
