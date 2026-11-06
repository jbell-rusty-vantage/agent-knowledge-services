import { afterAll, describe, expect, it, vi } from "vitest";
import { KnowledgeIntegrationService } from "@aiengineer/knowledge-application";
import { PostgresKnowledgeOperationService } from "@aiengineer/knowledge-persistence";
import { buildServer } from "../server.js";
import { loadRepositoryDemoEvaluationBundles } from "../demo-evaluation-bundles.js";
import type { ApiRole, LocalApiIdentity } from "@aiengineer/knowledge-host/config";

const server = buildServer();

afterAll(async () => server.close());

describe("knowledge API", () => {
  it("exposes readiness", async () => {
    const response = await server.inject({ method: "GET", url: "/readiness" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "knowledge-services",
      status: "ready",
    });
  });
  it("fails closed and returns typed problem details", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/v1/operations",
      headers: { "x-tenant-id": id(1), "x-correlation-id": "corr-auth" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "UNAUTHORIZED",
      correlationId: "corr-auth",
    });
  });
  it("returns capability unavailable without creating an unadmitted generic verification operation", async () => {
    const createOperation = vi.fn(),
      operations = new PostgresKnowledgeOperationService({
        createOperation,
      } as never),
      api = buildServer({
        operationService: operations,
        resolveIdentity: resolver(identity(["knowledge_operator"])),
        publicOrigin: "https://knowledge.example",
      });
    try {
      const response = await api.inject({
        method: "POST",
        url: "/v1/operations",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-tenant-id": context.tenantId,
          "x-correlation-id": context.correlationId,
        },
        payload: {
          kind: "verification_benchmark",
          envelope: {
            context,
            input: {},
            expectedVersions: { verification: "verification.v1" },
          },
        },
      });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_NOT_ADMITTED",
      });
      expect(createOperation).not.toHaveBeenCalled();
    } finally {
      await api.close();
    }
  });
  it("requires tenant context on authenticated reads and mutations", async () => {
    const service = new KnowledgeIntegrationService();
    const api = buildServer({
      service,
      resolveIdentity: resolver(identity(["knowledge_operator"])),
      publicOrigin: "https://knowledge.example",
    });
    const withoutTenant = {
      authorization: `Bearer ${TOKEN}`,
      "x-correlation-id": context.correlationId,
    };
    const read = await api.inject({
      method: "GET",
      url: `/v1/operations/${context.operationId}`,
      headers: withoutTenant,
    });
    const mutation = await api.inject({
      method: "POST",
      url: "/v1/retrieval-runs",
      headers: withoutTenant,
      payload: {
        context,
        input: { query: "durable state" },
        expectedVersions: { api: "v1" },
      },
    });
    expect(read.statusCode).toBe(400);
    expect(mutation.statusCode).toBe(400);
    expect(read.json()).toMatchObject({ code: "INVALID_CONTRACT" });
    expect(service.get(context.operationId)).toBeUndefined();
    await api.close();
  });
  it("returns a bare typed evidence packet from the configured durable resolver", async () => {
    const tenant = id(50),
      packetId = id(51),
      runId = id(52),
      policyId = id(53),
      actorId = id(54);
    const packet = {
      id: packetId,
      tenantId: tenant,
      digest: `sha256:${"a".repeat(64)}`,
      schemaVersion: "v1" as const,
      createdAt: "2026-09-03T00:00:00.000Z",
      retrievalRunId: runId,
      normalizedQuery: "durable agent state",
      plan: {
        policyVersion: policyId,
        query: "durable agent state",
        intents: ["knowledge_evidence" as const],
        subqueries: [
          {
            id: "durable-state",
            text: "durable agent state",
            coverageRole: "required" as const,
          },
        ],
        spaces: ["engineering_claims" as const],
        anchors: { entities: [], concepts: [], useCases: [] },
        hardFilters: [],
        softBoosts: [],
        temporalScope: {},
        candidateK: 10,
        finalK: 5,
        graph: { maxDepth: 0, allowedEdges: [] },
        abstention: { minimumCoverage: 1 },
      },
      authorization: {
        decisionId: id(55),
        tenantId: tenant,
        actorId,
        action: "read",
        resource: `evidence_packet:${packetId}`,
        allowed: true,
        policyVersion: policyId,
        reasonCodes: ["tenant_match"],
      },
      procedureVersionIds: [],
      members: [],
      omittedResults: [],
      coverage: [{ subqueryId: "durable-state", coverage: 0 }],
      abstention: { recommended: true, reason: "fixture has no members" },
      eventIds: [],
      artifactIds: [],
      receiptIds: [],
    };
    const api = buildServer({
      resolveIdentity: resolver(identity(["knowledge_reader"], tenant)),
      getEvidencePacket: async (t, p) => (t === tenant && p === packetId ? packet : undefined),
    });
    const response = await api.inject({
      method: "GET",
      url: `/v1/evidence-packets/${packetId}`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": tenant,
        "x-correlation-id": "corr-packet",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(packet);
    expect(response.json()).not.toHaveProperty("operation");
    await api.close();
  });
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = {
  tenantId: id(1),
  operationId: id(2),
  attemptId: id(3),
  workItemId: id(4),
  missionId: id(5),
  correlationId: "corr-eve",
  causationId: "cause-root",
  actor: {
    kind: "service" as const,
    id: id(6),
    serviceIdentity: "mission_control_client" as const,
  },
  capabilityVersion: "eve-adapter/1",
  idempotencyKey: "eve-evaluation-001",
  reason: "bounded exploratory evaluation",
  contractVersion: "v1" as const,
  externalExecution: {
    runtime: "eve" as const,
    runId: "run-1",
    rootRunId: "root-1",
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "tool-1",
  },
};
const TOKEN = "test-token-at-least-16-characters";
const identity = (roles: readonly ApiRole[], tenantId = context.tenantId): LocalApiIdentity => ({
  actor: context.actor,
  grants: [{ tenantId, roles, scopes: [] }],
});
const resolver = (value: LocalApiIdentity) => (token: string) => (token === TOKEN ? value : undefined);
const descriptors = ["kTnfJszFxCg", "bk0TmxoZlUY", "rmvDxxNubIg"].map((video_id) => ({
  schema_version: "ai-engineer-embedding-bundle/0.1.0",
  store_class: "internal_exploratory",
  video_id,
  evaluation_scope: "claims_retrieval",
}));
describe("Gate 6 operation API", () => {
  it("resolves bounded Eve descriptors server-side and deduplicates the evaluation", async () => {
    const service = new KnowledgeIntegrationService();
    const api = buildServer({
      service,
      publicOrigin: "https://knowledge.example",
      resolveIdentity: resolver(identity(["knowledge_evaluator"])),
      loadDemoEvaluationBundles: loadRepositoryDemoEvaluationBundles,
    });
    const request = {
      method: "POST" as const,
      url: "/v1/demo/evaluations",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload: {
        context,
        input: {
          mode: "three_bundle_internal_exploratory",
          bundles: descriptors,
        },
        expectedVersions: { api: "v1", bundle: "0.1.0" },
      },
    };
    const first = await api.inject(request);
    const replay = await api.inject(request);
    expect(first.statusCode).toBe(202);
    expect(replay.json().operationId).toBe(first.json().operationId);
    expect(first.json()).toMatchObject({
      operationId: context.operationId,
      state: "queued",
      contractVersion: "v1",
    });
    expect(service.result(context.operationId)).toMatchObject({
      storeClass: "internal_exploratory",
      canonicalPublication: false,
      bundleCount: 3,
      videoIds: ["kTnfJszFxCg", "bk0TmxoZlUY", "rmvDxxNubIg"],
      claimProjectionCount: 41,
      vectorCount: 41,
    });
    expect(first.headers["x-correlation-id"]).toBe(context.correlationId);
    await api.close();
  });
  it("answers fixture unavailable when no demo bundle loader is composed", async () => {
    const api = buildServer({
      service: new KnowledgeIntegrationService(),
      resolveIdentity: resolver(identity(["knowledge_evaluator"])),
    });
    const response = await api.inject({
      method: "POST",
      url: "/v1/demo/evaluations",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload: {
        context: { ...context, operationId: id(32), attemptId: id(33), idempotencyKey: "no-demo-loader-01" },
        input: { mode: "three_bundle_internal_exploratory", bundles: descriptors },
        expectedVersions: { api: "v1", bundle: "0.1.0" },
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      title: "Allow-listed exploratory fixture unavailable",
    });
    await api.close();
  });
  it("rejects descriptor sets outside the exact allow-list", async () => {
    const api = buildServer({
      resolveIdentity: resolver(identity(["knowledge_evaluator"])),
    });
    const response = await api.inject({
      method: "POST",
      url: "/v1/demo/evaluations",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload: {
        context: {
          ...context,
          operationId: id(30),
          attemptId: id(31),
          idempotencyKey: "invalid-descriptor-01",
        },
        input: {
          mode: "three_bundle_internal_exploratory",
          bundles: [...descriptors.slice(0, 2), { ...descriptors[2], video_id: "not-allowed" }],
        },
        expectedVersions: { api: "v1" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_CONTRACT" });
    await api.close();
  });
  it("reconciles an expired leased step after a restart snapshot", () => {
    let now = 0;
    const service = new KnowledgeIntegrationService(undefined, {
      now: () => new Date(now),
    });
    service.submit(
      "retrieval_run",
      {
        context: {
          ...context,
          operationId: id(20),
          attemptId: id(21),
          idempotencyKey: "restart-test-001",
        },
        input: { query: "durable state" },
        expectedVersions: { api: "v1" },
      },
      "https://knowledge.example",
    );
    const claim = service.claimNext("worker-a", 1)!;
    now = 2;
    const restarted = new KnowledgeIntegrationService(service.snapshot(), {
      now: () => new Date(now),
    });
    const reclaimed = restarted.claimNext("worker-b", 1);
    expect(reclaimed?.step.id).toBe(claim.step.id);
    expect(reclaimed?.step.attempts).toBe(2);
    expect(restarted.reconcile(id(20))?.context.correlationId).toBe("corr-eve");
  });
});

describe("typed vector-store ingestion admission", () => {
  const chain = {
    attachmentId: id(101),
    transformationOperationId: id(102),
    chunkSetId: id(103),
    chunkSetOperationId: id(104),
    promotionProposalId: id(105),
    promotionProposalOperationId: id(106),
    promotionDecisionId: id(107),
    promotionDecisionOperationId: id(108),
    embeddingRunId: id(109),
    embeddingOperationId: id(110),
    publicationId: id(111),
    publicationOperationId: id(112),
  };
  it("binds the path store id to the exact ingestion contract", async () => {
    const service = new KnowledgeIntegrationService();
    const api = buildServer({
      service,
      resolveIdentity: resolver(identity(["knowledge_operator"])),
    });
    const operationContext = {
      ...context,
      operationId: id(113),
      attemptId: id(114),
      idempotencyKey: "vector-ingestion-001",
    };
    const payload = {
      context: operationContext,
      input: {
        schemaVersion: "knowledge.vector-store-ingestion/v1",
        vectorStoreId: id(100),
        chains: [chain],
      },
      expectedVersions: { api: "v1" },
    };
    const accepted = await api.inject({
      method: "POST",
      url: `/v1/vector-stores/${id(100)}/ingestion-jobs`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload,
    });
    expect(accepted.statusCode).toBe(202);
    expect(service.get(operationContext.operationId)?.kind).toBe("vector_store_ingestion");
    await api.close();
  });
  it("rejects path mismatch and incomplete lineage before admission", async () => {
    const service = new KnowledgeIntegrationService();
    const api = buildServer({
      service,
      resolveIdentity: resolver(identity(["knowledge_operator"])),
    });
    const operationContext = {
      ...context,
      operationId: id(115),
      attemptId: id(116),
      idempotencyKey: "vector-ingestion-002",
    };
    const base = {
      context: operationContext,
      input: {
        schemaVersion: "knowledge.vector-store-ingestion/v1",
        vectorStoreId: id(100),
        chains: [chain],
      },
      expectedVersions: { api: "v1" },
    };
    const mismatch = await api.inject({
      method: "POST",
      url: `/v1/vector-stores/${id(99)}/ingestion-jobs`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload: base,
    });
    expect(mismatch.statusCode).toBe(400);
    const incomplete = await api.inject({
      method: "POST",
      url: `/v1/vector-stores/${id(100)}/ingestion-jobs`,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload: {
        ...base,
        input: { ...base.input, chains: [{ attachmentId: id(101) }] },
      },
    });
    expect(incomplete.statusCode).toBe(400);
    expect(service.get(operationContext.operationId)).toBeUndefined();
    await api.close();
  });
});

describe("API actor authorization", () => {
  it("denies a valid identity outside its explicit tenant grants", async () => {
    const api = buildServer({
      resolveIdentity: resolver(identity(["knowledge_reader"], id(99))),
    });
    const response = await api.inject({
      method: "GET",
      url: "/v1/operations",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": "tenant-denied",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "FORBIDDEN",
      correlationId: "tenant-denied",
    });
    await api.close();
  });
  it("denies reader mutations before creating an operation", async () => {
    const service = new KnowledgeIntegrationService();
    const api = buildServer({
      service,
      resolveIdentity: resolver(identity(["knowledge_reader"])),
    });
    const response = await api.inject({
      method: "POST",
      url: "/v1/retrieval-runs",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload: {
        context,
        input: { query: "durable state" },
        expectedVersions: { api: "v1" },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(service.get(context.operationId)).toBeUndefined();
    await api.close();
  });
  it("rejects a forged operation actor even when the token has the action", async () => {
    const service = new KnowledgeIntegrationService();
    const api = buildServer({
      service,
      resolveIdentity: resolver(identity(["knowledge_operator"])),
    });
    const response = await api.inject({
      method: "POST",
      url: "/v1/retrieval-runs",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload: {
        context: { ...context, actor: { ...context.actor, id: id(98) } },
        input: { query: "durable state" },
        expectedVersions: { api: "v1" },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(service.get(context.operationId)).toBeUndefined();
    await api.close();
  });
  it("does not treat actor, role, or scope headers as identity-provider claims", async () => {
    const api = buildServer();
    const response = await api.inject({
      method: "GET",
      url: "/v1/operations",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-actor-id": context.actor.id,
        "x-roles": "knowledge_admin",
        "x-scopes": "knowledge.read",
      },
    });
    expect(response.statusCode).toBe(401);
    await api.close();
  });
});

describe("canonical retrieval admission", () => {
  const plan = {
    policyVersion: id(70),
    query: "durable agent state",
    intents: ["knowledge_evidence" as const],
    subqueries: [
      {
        id: "q1",
        text: "durable agent state",
        coverageRole: "required" as const,
      },
    ],
    spaces: ["engineering_claims" as const],
    anchors: { entities: [], concepts: [], useCases: [] },
    hardFilters: [],
    softBoosts: [],
    temporalScope: {},
    candidateK: 10,
    finalK: 5,
    graph: { maxDepth: 0, allowedEdges: [] },
    abstention: { minimumCoverage: 1 },
  };
  it("executes the strict plan through the API-owned canonical executor", async () => {
    const service = new KnowledgeIntegrationService();
    const execute = vi.fn(async () => ({
      retrievalRunId: context.operationId,
      evidencePacketId: id(71),
      resultCount: 1,
      abstained: false,
      replayed: false,
    }));
    const api = buildServer({
      service,
      resolveIdentity: resolver(identity(["knowledge_operator"])),
      canonicalRetrievalExecutor: { execute },
    });
    const response = await api.inject({
      method: "POST",
      url: "/v1/retrieval-runs",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload: {
        context,
        input: { plan },
        expectedVersions: { api: "v1", retrieval: "v1" },
      },
    });
    expect(response.statusCode).toBe(202);
    expect(execute).toHaveBeenCalledOnce();
    expect(service.get(context.operationId)?.kind).toBe("retrieval_run");
    await api.close();
  });
  it("rejects client-supplied embeddings before operation admission", async () => {
    const service = new KnowledgeIntegrationService();
    const execute = vi.fn();
    const api = buildServer({
      service,
      resolveIdentity: resolver(identity(["knowledge_operator"])),
      canonicalRetrievalExecutor: { execute },
    });
    const response = await api.inject({
      method: "POST",
      url: "/v1/retrieval-runs",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload: {
        context,
        input: { plan, embedding: [1, 2, 3] },
        expectedVersions: { api: "v1", retrieval: "v1" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect(service.get(context.operationId)).toBeUndefined();
    await api.close();
  });
  it("returns 503 before admission when the embedding-backed executor is unconfigured", async () => {
    const service = new KnowledgeIntegrationService();
    const api = buildServer({
      service,
      resolveIdentity: resolver(identity(["knowledge_operator"])),
    });
    const response = await api.inject({
      method: "POST",
      url: "/v1/retrieval-runs",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload: {
        context,
        input: { plan },
        expectedVersions: { api: "v1", retrieval: "v1" },
      },
    });
    expect(response.statusCode).toBe(503);
    expect(service.get(context.operationId)).toBeUndefined();
    await api.close();
  });
  it("requires the retrieval v1 capability before operation admission", async () => {
    const service = new KnowledgeIntegrationService();
    const execute = vi.fn();
    const api = buildServer({
      service,
      resolveIdentity: resolver(identity(["knowledge_operator"])),
      canonicalRetrievalExecutor: { execute },
    });
    const response = await api.inject({
      method: "POST",
      url: "/v1/retrieval-runs",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-tenant-id": context.tenantId,
        "x-correlation-id": context.correlationId,
      },
      payload: { context, input: { plan }, expectedVersions: { api: "v1" } },
    });
    expect(response.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect(service.get(context.operationId)).toBeUndefined();
    await api.close();
  });
});
