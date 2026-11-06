import { A2AKnowledgeAdapter } from "../a2a-adapter.js";
import { CallbackReplayGuard, KnowledgeIntegrationService } from "@aiengineer/knowledge-application";
import type { LocalApiIdentity } from "@aiengineer/knowledge-host";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";
import type { CanonicalRetrievalExecutorPort } from "@aiengineer/knowledge-application";

const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
const tenantId = id(1);
const token = "a2a-test-token-at-least-16-characters";
const secret = "callback-signing-secret-is-at-least-32-bytes";
const actor = {
  kind: "service" as const,
  id: id(2),
  serviceIdentity: "mission_control_client" as const,
};
const identity: LocalApiIdentity = {
  actor,
  grants: [{ tenantId, roles: ["knowledge_operator"], scopes: [] }],
};
const context = {
  tenantId,
  operationId: id(3),
  attemptId: id(4),
  workItemId: id(5),
  missionId: id(6),
  correlationId: "root-mission:nested-eve:knowledge",
  causationId: "eve-tool-call-parent",
  actor,
  capabilityVersion: "a2a-http/v1",
  idempotencyKey: "a2a-http-task-0001",
  reason: "exercise nested A2A transport",
  contractVersion: "v1" as const,
  externalExecution: {
    runtime: "eve" as const,
    runId: "nested-eve-run",
    rootRunId: "root-mission-run",
    sessionId: "eve-session",
    turnId: "eve-turn",
    toolCallId: "eve-tool-call",
  },
};
const task = {
  taskId: id(7),
  kind: "document_preparation" as const,
  contractVersion: "v1" as const,
  context,
  purpose: "construct a source-grounded packet",
  capabilityVersions: { transformation: "v1" },
  expectedOutputContract: "knowledge.representation/v1",
  inputArtifactIds: [],
  operationInput: {
    schemaVersion: "knowledge.transformation/v1",
    captureOperationId: id(8),
    document: {
      documentKind: "web_page",
      canonicalTitle: "A2A fixture",
      versionLabel: "captured",
    },
    profile: {
      profileKey: "deterministic-text",
      version: "1",
      mediaType: "text/plain",
      managedProcessingAllowed: false,
    },
    providerRoute: ["deterministic-text"],
  },
  callback: {
    url: "https://eve.example/callbacks/knowledge",
    authenticationReference: "secret://eve/callback-bearer",
    signingKeyReference: "secret://eve/callback-signing",
  },
};
const clock = () => new Date("2026-09-03T12:00:00Z");
const headers = {
  authorization: `Bearer ${token}`,
  "x-tenant-id": tenantId,
  "x-correlation-id": context.correlationId,
};
const service = new KnowledgeIntegrationService();
const server = buildServer({
  service,
  operationService: service,
  publicOrigin: "https://knowledge.example",
  resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
  resolveCallbackSigningSecret: (tenant, reference) =>
    tenant === tenantId && [task.callback.signingKeyReference, "secret://alternate-valid-key"].includes(reference)
      ? secret
      : undefined,
  callbackReplayStore: new CallbackReplayGuard(),
  callbackClock: clock,
});

afterAll(async () => server.close());

describe("authenticated HTTP A2A transport", () => {
  it("routes retrieval through the retrieval-only port and canonical executor exactly once", async () => {
    const generic = new KnowledgeIntegrationService(),
      retrieval = new KnowledgeIntegrationService();
    const execute = vi.fn<CanonicalRetrievalExecutorPort["execute"]>(async () => ({
      retrievalRunId: id(30),
      evidencePacketId: id(34),
      resultCount: 0,
      abstained: true,
      replayed: false,
    }));
    const retrievalContext = {
      ...context,
      operationId: id(30),
      attemptId: id(31),
      idempotencyKey: "a2a-retrieval-0001",
    };
    const retrievalTask = {
      ...task,
      taskId: id(32),
      kind: "retrieval" as const,
      context: retrievalContext,
      capabilityVersions: { retrieval: "v1" },
      expectedOutputContract: "evidence-packet/v1",
      operationInput: {
        plan: {
          policyVersion: id(33),
          query: "canonical retrieval",
          intents: ["knowledge_evidence"],
          subqueries: [{ id: "q", text: "canonical retrieval", coverageRole: "required" }],
          spaces: ["engineering_claims"],
          anchors: { entities: [], concepts: [], useCases: [] },
          hardFilters: [],
          softBoosts: [],
          temporalScope: {},
          candidateK: 10,
          finalK: 5,
          graph: { maxDepth: 0, allowedEdges: [] },
          abstention: { minimumCoverage: 0.5 },
        },
      },
    };
    const api = buildServer({
      service: generic,
      operationService: generic,
      retrievalOperationService: retrieval,
      canonicalRetrievalExecutor: { execute },
      publicOrigin: "https://knowledge.example",
      resolveIdentity: (candidate) => (candidate === token ? identity : undefined),
    });
    const response = await api.inject({
      method: "POST",
      url: "/v1/a2a/tasks",
      headers,
      payload: retrievalTask,
    });
    const replay = await api.inject({
      method: "POST",
      url: "/v1/a2a/tasks",
      headers,
      payload: retrievalTask,
    });
    expect(response.statusCode).toBe(202);
    expect(replay.json().operationId).toBe(response.json().operationId);
    expect(generic.get(retrievalContext.operationId)).toBeUndefined();
    expect(retrieval.list(tenantId)).toHaveLength(1);
    expect(retrieval.get(retrievalContext.operationId)?.kind).toBe("retrieval_run");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      input: {
        plan: { query: "canonical retrieval" },
        a2a: { taskId: retrievalTask.taskId },
      },
      expectedVersions: { retrieval: "v1" },
    });
    const invalidTask = {
      ...retrievalTask,
      taskId: id(35),
      context: { ...retrievalContext, operationId: id(36), idempotencyKey: "a2a-retrieval-invalid-0001" },
      operationInput: { ...retrievalTask.operationInput, queryEmbedding: [0, 1] },
    };
    const invalidA2A = await api.inject({ method: "POST", url: "/v1/a2a/tasks", headers, payload: invalidTask });
    const invalidHttp = await api.inject({
      method: "POST",
      url: "/v1/retrieval-runs",
      headers,
      payload: {
        context: invalidTask.context,
        input: invalidTask.operationInput,
        expectedVersions: { contract: "v1", retrieval: "v1" },
      },
    });
    expect(invalidA2A.statusCode).toBe(400);
    expect(invalidA2A.json().code).toBe(invalidHttp.json().code);
    expect(invalidA2A.json().title).toBe(invalidHttp.json().title);
    expect(retrieval.list(tenantId)).toHaveLength(1);
    const wrongVersion = await api.inject({
      method: "POST",
      url: "/v1/a2a/tasks",
      headers,
      payload: {
        ...invalidTask,
        operationInput: retrievalTask.operationInput,
        capabilityVersions: { retrieval: "v2" },
      },
    });
    expect(wrongVersion.statusCode).toBe(400);
    expect(wrongVersion.json().code).toBe("INVALID_CONTRACT");
    expect(retrieval.list(tenantId)).toHaveLength(1);
    await api.close();
  });
  it("admits a task through the shared operation port with full nested lineage", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/a2a/tasks",
      headers,
      payload: task,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      taskId: task.taskId,
      operationId: context.operationId,
      state: "accepted",
      statusUrl: `https://knowledge.example/v1/operations/${context.operationId}`,
      eventStreamUrl: `https://knowledge.example/v1/operations/${context.operationId}/events`,
      cancellationUrl: `https://knowledge.example/v1/operations/${context.operationId}:cancel`,
    });
    expect(service.get(context.operationId)?.context).toMatchObject({
      correlationId: context.correlationId,
      causationId: context.causationId,
      externalExecution: context.externalExecution,
    });
  });

  it("records a valid signed callback once and rejects replay and tamper", async () => {
    const callback = new A2AKnowledgeAdapter(service, "https://knowledge.example").callback(
      task,
      { outcome: "succeeded", nestedRunId: "nested-eve-run" },
      secret,
      clock().toISOString(),
    );
    const request = async (payload: Record<string, unknown>) =>
      await server.inject({
        method: "POST",
        url: "/v1/a2a/callbacks",
        headers: {
          ...headers,
          "x-knowledge-callback-signing-key-reference": task.callback.signingKeyReference,
        },
        payload,
      });
    const accepted = await request(callback);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      callbackId: callback.callbackId,
      operationId: context.operationId,
      state: "accepted",
      receivedAt: clock().toISOString(),
    });
    const replay = await request(callback);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: "CONFLICT" });
    const tampered = await request({
      ...callback,
      payload: { outcome: "failed" },
    });
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects actor, tenant, correlation, signature-reference, and lineage substitution", async () => {
    const wrongActor = await server.inject({
      method: "POST",
      url: "/v1/a2a/tasks",
      headers,
      payload: {
        ...task,
        context: { ...context, actor: { ...actor, id: id(99) } },
      },
    });
    expect(wrongActor.statusCode).toBe(403);

    const freshTask = {
      ...task,
      taskId: id(8),
      context: {
        ...context,
        operationId: id(9),
        attemptId: id(10),
        idempotencyKey: "a2a-http-task-0002",
      },
    };
    await server.inject({
      method: "POST",
      url: "/v1/a2a/tasks",
      headers,
      payload: freshTask,
    });
    const callback = new A2AKnowledgeAdapter(service, "https://knowledge.example").callback(
      freshTask,
      { outcome: "succeeded" },
      secret,
      clock().toISOString(),
    );
    const unknownKey = await server.inject({
      method: "POST",
      url: "/v1/a2a/callbacks",
      headers: {
        ...headers,
        "x-knowledge-callback-signing-key-reference": "secret://attacker/key",
      },
      payload: callback,
    });
    expect(unknownKey.statusCode).toBe(401);
    const forgedTaskCallback = new A2AKnowledgeAdapter(service, "https://knowledge.example").callback(
      { ...freshTask, taskId: id(97) },
      { outcome: "succeeded" },
      secret,
      clock().toISOString(),
    );
    const wrongTaskBinding = await server.inject({
      method: "POST",
      url: "/v1/a2a/callbacks",
      headers: {
        ...headers,
        "x-knowledge-callback-signing-key-reference": task.callback.signingKeyReference,
      },
      payload: forgedTaskCallback,
    });
    expect(wrongTaskBinding.statusCode).toBe(403);
    expect(wrongTaskBinding.json()).toMatchObject({ code: "FORBIDDEN" });
    const wrongKeyBinding = await server.inject({
      method: "POST",
      url: "/v1/a2a/callbacks",
      headers: {
        ...headers,
        "x-knowledge-callback-signing-key-reference": "secret://alternate-valid-key",
      },
      payload: callback,
    });
    expect(wrongKeyBinding.statusCode).toBe(403);
    const wrongTenant = await server.inject({
      method: "POST",
      url: "/v1/a2a/callbacks",
      headers: {
        ...headers,
        "x-tenant-id": id(98),
        "x-knowledge-callback-signing-key-reference": task.callback.signingKeyReference,
      },
      payload: callback,
    });
    expect(wrongTenant.statusCode).toBe(403);
    const wrongLineage = await server.inject({
      method: "POST",
      url: "/v1/a2a/callbacks",
      headers: {
        ...headers,
        "x-correlation-id": "attacker-correlation",
        "x-knowledge-callback-signing-key-reference": task.callback.signingKeyReference,
      },
      payload: callback,
    });
    expect(wrongLineage.statusCode).toBe(403);
  });
});
