import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReportKindCatalog } from "@aiengineer/knowledge-application";
import type { ReadSnapshot, Workspace } from "@aiengineer/knowledge-db";
import { createReadIntentPort } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  KnowledgeOperationService,
  ProtocolRefusal,
  createInMemoryBackend,
  staticJwksSource,
} from "@aiengineer/knowledge-host/knowledge-operation";
import {
  type JsonValue,
  KnowledgeReadIntentResultSchema,
  READ_INTENT_CONTRACT,
  digestBytes,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import { afterAll, describe, expect, it } from "vitest";
import { handleKnowledgeOperation } from "./http.js";
import {
  TEST_AUDIENCE,
  TEST_INSTALLATION,
  TEST_ISSUER,
  claimsFor,
  envelopeFor,
  generateIssuerKey,
  jwksOf,
  liveOrigin,
  signCredential,
} from "./tests/test-support.js";

/**
 * OVE-204 slice 4: `knowledge.read_intent` through the K01 service, the AIDB binding's read port (over a fake
 * `ReadExecutor` and a temporary workspace; the real executor needs the AIDB database) and the in-memory operation
 * store. Every served read is one recorded operation row; refusals record nothing.
 */
const KINDS = ReportKindCatalog.fromDirectory(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/report-kinds"),
);
const TENANT = "00000000-0000-7000-8000-0000000000ae";
const origin = liveOrigin(TENANT, { invocation: "inv-read-intent" });

const dir = mkdtempSync(join(tmpdir(), "ks-read-intent-svc-"));
mkdirSync(join(dir, "relations", "knowledge"), { recursive: true });
writeFileSync(join(dir, "relations", "knowledge", "entity.md"), "# knowledge.entity\nThe entity relation.\n");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const WORKSPACE = {
  dir,
  manifest: {},
  migrationHead: "20261031000000",
  fingerprint: "fp-svc",
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

function fakeReads(rowsFor: (query: string) => Record<string, unknown>[] = () => [{ id: "e-1", score: 0.5 }]) {
  const calls: { persist: boolean | undefined }[] = [];
  return {
    calls,
    reads: {
      runIntent: async (
        intent: { atKnowledgeSeq: number | null; operations: { opId: string; query: string }[] },
        options?: { persist?: boolean },
      ): Promise<ReadSnapshot> => {
        calls.push({ persist: options?.persist });
        return {
          schemaVersion: "knowledge-read-snapshot.v1",
          snapshotId: "019a0000-0000-7000-8000-0000000000b1",
          intentRef: { intentId: "x", intentDigest: `sha256:${"0".repeat(64)}` },
          context: { tenantId: TENANT, executorVersion: "test" },
          contract: { migrationHead: "20261031000000", catalogVersion: "1.0.0" },
          knowledgeHead: { knowledgeSeq: 12, updatedAt: "2026-10-31T10:00:00.000Z" },
          knowledgeHeadAfter: { knowledgeSeq: 12, updatedAt: "2026-10-31T10:00:00.000Z" },
          headChanged: false,
          atKnowledgeSeq: intent.atKnowledgeSeq ?? 12,
          executedAt: "2026-10-31T10:00:01.000Z",
          operations: intent.operations.map((operation) => {
            const rows = rowsFor(operation.query);
            return {
              opId: operation.opId,
              kind: "named_query" as const,
              query: operation.query,
              status: rows.length === 0 ? ("empty" as const) : ("ok" as const),
              rowCount: rows.length,
              truncated: false,
              columns: rows[0] ? Object.keys(rows[0]) : [],
              rows,
              contentDigest: `sha256:${"1".repeat(64)}` as const,
              durationMs: 1,
            };
          }),
          snapshotDigest: `sha256:${"2".repeat(64)}`,
        };
      },
      head: async () => ({ knowledgeSeq: 12, updatedAt: "2026-10-31T10:00:00.000Z" }),
    },
  };
}

function service(options: { port?: boolean; rowsFor?: (query: string) => Record<string, unknown>[] } = {}) {
  const key = generateIssuerKey("mc-read-intent");
  const native = fakeReads(options.rowsFor);
  const backend = createInMemoryBackend({
    application: "ai-engineer",
    binding: "in-memory",
    kinds: KINDS,
    auditor: null,
    readIntent: options.port === false ? null : createReadIntentPort(native.reads as never, WORKSPACE, TENANT),
  });
  const svc = new KnowledgeOperationService({
    verifier: new KnowledgeCredentialVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwks: new JwksCache(staticJwksSource(jwksOf([key]))),
    }),
    backends: [backend],
    installed: [{ application: "ai-engineer", binding: "in-memory", installationId: TEST_INSTALLATION, tenants: null }],
    dispatches: new DispatchRegistry(),
    signingIssuer: "knowledge-services",
  });
  return { svc, key, backend, native };
}

const SCOPE = {
  tenant: TENANT,
  application: "ai-engineer",
  binding: "in-memory",
  origin,
  grants: [],
};

function readRequest(overrides: Record<string, unknown> = {}): JsonValue {
  return {
    schemaVersion: "knowledge-read-intent-request.v1",
    purpose: "discovery",
    operations: [
      { opId: "head", kind: "named_query", query: "knowledge.head", params: {} },
      { opId: "find", kind: "named_query", query: "entity.resolve", params: { text: "LangGraph" }, limit: 5 },
      { opId: "where", kind: "schema_search", query: "entity", limit: 3 },
      { opId: "page", kind: "schema_get", id: "rel:knowledge.entity" },
    ],
    ...overrides,
  } as unknown as JsonValue;
}

interface Call {
  readonly requestId?: string;
  readonly operations?: Parameters<typeof claimsFor>[0]["operations"];
  readonly evaluation?: Parameters<typeof claimsFor>[0]["evaluation"];
}

function signed(key: ReturnType<typeof generateIssuerKey>, payload: JsonValue, call: Call = {}) {
  const envelope = envelopeFor({
    operation: "knowledge.read_intent",
    origin,
    payload,
    nativeContract: { ...READ_INTENT_CONTRACT },
    ...(call.requestId ? { requestId: call.requestId } : {}),
  });
  const token = signCredential(
    key,
    claimsFor({
      origin,
      operations: call.operations ?? ["knowledge.read_intent"],
      dispatchId: envelope.dispatchId,
      ...(call.evaluation ? { evaluation: call.evaluation } : {}),
    }),
  );
  return { envelope, token };
}

async function readIntent(
  svc: KnowledgeOperationService,
  key: ReturnType<typeof generateIssuerKey>,
  payload: JsonValue,
  call: Call = {},
) {
  const { envelope, token } = signed(key, payload, call);
  return svc.invoke(token, envelope).catch((error: unknown) => {
    if (error instanceof ProtocolRefusal) return error.error;
    throw error;
  });
}

describe("knowledge.read_intent over K01", () => {
  it("answers knowledge-read-intent-result.v1 and records one operation row (no run, no subject, no result ref)", async () => {
    const { svc, key, backend, native } = service();
    const answer = KnowledgeReadIntentResultSchema.parse(
      await readIntent(svc, key, readRequest(), { requestId: "req-read-1" }),
    );
    expect(answer.operationId).toMatch(/^op-read_intent-[0-9a-f]{32}$/);
    expect(answer.operations.map((operation) => [operation.opId, operation.status])).toEqual([
      ["head", "ok"],
      ["find", "ok"],
      ["where", "ok"],
      ["page", "ok"],
    ]);
    expect(answer.operations[1]?.rows).toEqual([{ id: "e-1", score: "0.5" }]);
    expect(answer.operations[1]?.contentDigest).toBe(digestCanonical([{ id: "e-1", score: "0.5" }]));
    expect(answer.retainedRef).toBeNull();
    expect(answer.knowledgeHead).toEqual({ knowledgeSeq: 12, updatedAt: "2026-10-31T10:00:00Z" });
    expect(native.calls).toEqual([{ persist: false }]);
    const row = await backend.research().operations.get(SCOPE, answer.operationId);
    expect(row).not.toBeNull();
    expect(row?.operation).toBe("knowledge.read_intent");
    expect(row?.requestId).toBe("req-read-1");
    expect(row?.runId).toBeNull();
    expect(row?.subject).toBeNull();
    expect(row?.status.state).toBe("succeeded");
    expect(row?.status.resultRef).toBeNull();
    expect(row?.request).toEqual({ operation: "knowledge.read_intent", readIntent: readRequest() });
    expect(row?.requestDigest).toBe(
      digestCanonical({ operation: "knowledge.read_intent", readIntent: readRequest() } as unknown as JsonValue),
    );
  });

  it("is replay-safe: the same request id answers the same operation id; another request under it conflicts", async () => {
    const { svc, key } = service();
    const first = KnowledgeReadIntentResultSchema.parse(
      await readIntent(svc, key, readRequest(), { requestId: "req-replay" }),
    );
    const again = KnowledgeReadIntentResultSchema.parse(
      await readIntent(svc, key, readRequest(), { requestId: "req-replay" }),
    );
    expect(again.operationId).toBe(first.operationId);
    expect(again.snapshotDigest).toBe(first.snapshotDigest);
    const conflict = await readIntent(svc, key, readRequest({ purpose: "other" }), { requestId: "req-replay" });
    expect(conflict).toMatchObject({ code: "EFFECT_CONFLICT" });
  });

  it("persist freezes the result into custody: retainedRef = resultRef, and a replay answers it from custody", async () => {
    const { svc, key, backend, native } = service();
    const answer = KnowledgeReadIntentResultSchema.parse(
      await readIntent(svc, key, readRequest({ persist: true }), { requestId: "req-persist" }),
    );
    expect(native.calls).toEqual([{ persist: true }]);
    expect(answer.retainedRef).not.toBeNull();
    expect(answer.retainedRef?.version).toBe("knowledge-read-intent-result.v1");
    const row = await backend.research().operations.get(SCOPE, answer.operationId);
    expect(row?.status.resultRef).toEqual(answer.retainedRef);
    const bytes = await backend.research().binding.custody.get(SCOPE, answer.retainedRef as never);
    expect(digestBytes(bytes)).toBe(answer.retainedRef?.digest);
    expect(JSON.parse(Buffer.from(bytes).toString("utf8"))).toEqual({ ...answer, retainedRef: null });
    const replay = KnowledgeReadIntentResultSchema.parse(
      await readIntent(svc, key, readRequest({ persist: true }), { requestId: "req-persist" }),
    );
    expect(replay).toEqual(answer);
    expect(native.calls).toHaveLength(1);
  });

  it("refuses non-allowlisted queries, raw SQL and an over-long intent; records nothing", async () => {
    const { svc, key, backend, native } = service();
    const refused = await readIntent(
      svc,
      key,
      readRequest({ operations: [{ opId: "x", kind: "named_query", query: "admin.dump", params: {} }] }),
      { requestId: "req-refused" },
    );
    expect(refused).toMatchObject({ code: "INVALID_ENVELOPE" });
    const sql = await readIntent(svc, key, readRequest({ sql: "select * from secrets" }));
    expect(sql).toMatchObject({ code: "INVALID_ENVELOPE" });
    expect(native.calls).toHaveLength(0);
    const operationId = `op-read_intent-${digestCanonical({ tenant: TENANT, operation: "knowledge.read_intent", requestId: "req-refused" }).slice(7, 39)}`;
    expect(await backend.research().operations.get(SCOPE, operationId)).toBeNull();
  });

  it("refuses a credential without the knowledge.read_intent grant; an evaluator credential cannot carry it", async () => {
    const { svc, key, native } = service();
    const denied = await readIntent(svc, key, readRequest(), { operations: ["knowledge.read"] });
    expect(denied).toMatchObject({ code: "SCOPE_DENIED" });
    expect(() =>
      claimsFor({
        origin,
        operations: ["knowledge.read_intent"],
        dispatchId: "dispatch-evaluator",
        evaluation: { role: "judge", credentialRef: "judge.default", provider: "openai", family: "gpt-6" },
      }),
    ).toThrow(/evaluator credential/);
    const evaluator = await readIntent(svc, key, readRequest(), {
      operations: ["knowledge.read", "report.observe"],
      evaluation: { role: "judge", credentialRef: "judge.default", provider: "openai", family: "gpt-6" },
    });
    expect(evaluator).toMatchObject({ code: "SCOPE_DENIED" });
    expect(native.calls).toHaveLength(0);
  });

  it("withholds bodies past the inline budget and keeps their digests", async () => {
    const big = Array.from({ length: 800 }, (_, index) => ({ id: `e-${index}`, text: "x".repeat(400) }));
    const { svc, key } = service({ rowsFor: (query) => (query === "entity.resolve" ? big : [{ seq: 12 }]) });
    const answer = KnowledgeReadIntentResultSchema.parse(await readIntent(svc, key, readRequest()));
    const find = answer.operations.find((operation) => operation.opId === "find");
    expect(find?.bodyWithheld).toBe(true);
    expect(find?.rows).toBeUndefined();
    expect(find?.contentDigest).toBe(digestCanonical(big as unknown as JsonValue));
    expect(answer.operations.find((operation) => operation.opId === "head")?.bodyWithheld).toBe(false);
  });

  it("is described only when the backend serves a read port; otherwise SCHEMA_UNSUPPORTED", async () => {
    const served = service();
    expect(served.svc.descriptorFor(served.backend).operations).toContain("knowledge.read_intent");
    const bare = service({ port: false });
    expect(bare.svc.descriptorFor(bare.backend).operations).not.toContain("knowledge.read_intent");
    expect(await readIntent(bare.svc, bare.key, readRequest())).toMatchObject({ code: "SCHEMA_UNSUPPORTED" });
  });

  it("answers 200 over HTTP (synchronous result document)", async () => {
    const { svc, key } = service();
    const server = createServer((request, response) => {
      void handleKnowledgeOperation(request, response, new URL(request.url ?? "/", "http://localhost"), svc);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/knowledge-operation/v2/invoke`;
      const { envelope, token } = signed(key, readRequest());
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      expect(response.status).toBe(200);
      expect(KnowledgeReadIntentResultSchema.parse(await response.json()).schemaVersion).toBe(
        "knowledge-read-intent-result.v1",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
    }
  });
});
