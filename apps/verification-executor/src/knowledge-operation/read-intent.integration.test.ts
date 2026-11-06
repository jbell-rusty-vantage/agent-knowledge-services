import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReportKindCatalog } from "@aiengineer/knowledge-application";
import { createReadIntentPort } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { LocalArtifactStore } from "@aiengineer/knowledge-core";
import { ArtifactLedger, ReadExecutor, loadWorkspace } from "@aiengineer/knowledge-db";
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
  READ_INTENT_NAMED_QUERIES,
  readIntentSnapshotDigest,
} from "@aiengineer/knowledge-operation-protocol";
import { TenantPostgres } from "@aiengineer/knowledge-persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposableDatabaseUrl } from "../../../../packages/persistence/test/disposable.mjs";
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
 * OVE-204 slice 4 against the disposable AI Engineer database (`KS_TEST_DATABASE_URL` + `KS_TEST_PROJECT_DIR`): the AIDB
 * read port over the REAL `ReadExecutor` and the pinned db-contract workspace, through the K01 service. Every
 * allowlisted named query is in the catalog and runs; the operation row is the in-memory store's (the component
 * store's row is proven by backend-conformance `read_intent_recorded`).
 */
const url = disposableDatabaseUrl();
const TENANT = "00000000-0000-7000-8000-000000000001";
const WORKSPACE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../aiengineer/ai-engineer-db-contract/workspace",
);
const KINDS = ReportKindCatalog.fromDirectory(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/report-kinds"),
);

describe.skipIf(!url)("knowledge.read_intent over the real AIDB ReadExecutor", () => {
  let db!: TenantPostgres;
  let storeDir!: string;
  let svc!: KnowledgeOperationService;
  let key!: ReturnType<typeof generateIssuerKey>;
  const origin = liveOrigin(TENANT, { invocation: "inv-read-intent-aidb" });

  beforeAll(() => {
    const workspace = loadWorkspace(WORKSPACE_DIR);
    db = new TenantPostgres({ connectionString: url ?? "postgresql://unused", maximumPoolSize: 2 });
    storeDir = mkdtempSync(join(tmpdir(), "ks-read-intent-aidb-"));
    const artifacts = new ArtifactLedger({
      db,
      store: new LocalArtifactStore(storeDir),
      bucket: "research-ingestion-intents",
      uploaded: false,
      executorVersion: "knowledge-executor/test",
    });
    const reads = new ReadExecutor({ db, workspace, artifacts, executorVersion: "knowledge-executor/test" });
    key = generateIssuerKey("mc-read-intent-aidb");
    const backend = createInMemoryBackend({
      application: "ai-engineer",
      binding: "in-memory",
      kinds: KINDS,
      auditor: null,
      readIntent: createReadIntentPort(reads, workspace, TENANT),
    });
    svc = new KnowledgeOperationService({
      verifier: new KnowledgeCredentialVerifier({
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        jwks: new JwksCache(staticJwksSource(jwksOf([key]))),
      }),
      backends: [backend],
      installed: [
        { application: "ai-engineer", binding: "in-memory", installationId: TEST_INSTALLATION, tenants: null },
      ],
      dispatches: new DispatchRegistry(),
      signingIssuer: "knowledge-services",
    });
  });
  afterAll(async () => {
    try {
      await db?.close();
    } finally {
      if (storeDir) rmSync(storeDir, { recursive: true, force: true });
    }
  });

  const invoke = (payload: JsonValue) => {
    const envelope = envelopeFor({
      operation: "knowledge.read_intent",
      origin,
      payload,
      nativeContract: { ...READ_INTENT_CONTRACT },
    });
    const token = signCredential(
      key,
      claimsFor({ origin, operations: ["knowledge.read_intent"], dispatchId: envelope.dispatchId }),
    );
    return svc.invoke(token, envelope).catch((error: unknown) => {
      if (error instanceof ProtocolRefusal) return error.error;
      throw error;
    });
  };

  it("serves the allowlist from the pinned catalog with K01 digests and a repeatable snapshot digest", async () => {
    const payload = {
      schemaVersion: "knowledge-read-intent-request.v1",
      purpose: "discovery",
      persist: true,
      operations: [
        { opId: "head", kind: "named_query", query: "knowledge.head", params: {} },
        { opId: "resolve", kind: "named_query", query: "entity.resolve", params: { text: "OpenAI" } },
        { opId: "kinds", kind: "named_query", query: "vocab.relationship_kind", params: {}, limit: 50 },
        { opId: "where", kind: "schema_search", query: "entity", limit: 3 },
      ],
    } as unknown as JsonValue;
    const first = await invoke(payload);
    const answer = KnowledgeReadIntentResultSchema.parse(first);
    expect(answer.operations.map((operation) => [operation.opId, operation.status])).toEqual([
      ["head", "ok"],
      ["resolve", expect.stringMatching(/^(ok|empty)$/)],
      ["kinds", expect.stringMatching(/^(ok|empty|truncated)$/)],
      ["where", "ok"],
    ]);
    expect(answer.snapshotDigest).toBe(readIntentSnapshotDigest(answer.atKnowledgeSeq, answer.operations));
    expect(answer.retainedRef).not.toBeNull();
    const again = KnowledgeReadIntentResultSchema.parse(await invoke(payload));
    expect(again.snapshotDigest).toBe(answer.snapshotDigest);
    expect(again.operationId).not.toBe(answer.operationId);
  });

  it("every allowlisted named query exists in the pinned AIDB catalog", () => {
    const catalog = loadWorkspace(WORKSPACE_DIR).catalog;
    const names = new Set(catalog?.entries.map((entry) => entry.name));
    expect(READ_INTENT_NAMED_QUERIES.filter((name) => !names.has(name))).toEqual([]);
  });

  it("maps a native parameter refusal to INVALID_ENVELOPE", async () => {
    const refused = await invoke({
      schemaVersion: "knowledge-read-intent-request.v1",
      purpose: "discovery",
      operations: [{ opId: "card", kind: "named_query", query: "entity.card", params: { entity_id: "nope" } }],
    } as unknown as JsonValue);
    expect(refused).toMatchObject({ code: "INVALID_ENVELOPE", details: { nativeCode: "PARAMS_INVALID" } });
  });
});
