import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KnowledgeOperationPort } from "@aiengineer/knowledge-application";
import { createLocalIdentityResolver, type LocalApiIdentity } from "@aiengineer/knowledge-host";
import type { AcceptedOperation, OperationContext } from "@aiengineer/knowledge-contracts";
import { PostgresCanonicalRepository, PostgresKnowledgeOperationService } from "@aiengineer/knowledge-persistence";
import { apiPublicOrigin, buildKnowledgeMcpApp, createMcpRequestHandler, createMcpToolExecutor } from "../index.js";
import vercelHandler from "../index.js";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const context: OperationContext = {
  tenantId: id(1),
  operationId: id(2),
  attemptId: id(3),
  correlationId: "mcp-durable-correlation",
  actor: {
    kind: "service",
    id: id(4),
    serviceIdentity: "mission_control_client",
  },
  capabilityVersion: "mcp/1",
  idempotencyKey: "mcp-durable-operation-001",
  reason: "bounded MCP durable admission",
  contractVersion: "v1",
};
const identity: LocalApiIdentity = {
  actor: context.actor,
  grants: [{ tenantId: context.tenantId, roles: ["knowledge_operator"], scopes: [] }],
};
const accepted: AcceptedOperation = {
  operationId: context.operationId,
  state: "queued",
  contractVersion: "v1",
  statusUrl: `https://api.example/v1/operations/${context.operationId}`,
  eventStreamUrl: `https://api.example/v1/operations/${context.operationId}/events`,
  cancellationUrl: `https://api.example/v1/operations/${context.operationId}:cancel`,
  retryUrl: `https://api.example/v1/operations/${context.operationId}:retry`,
  reconcileUrl: `https://api.example/v1/operations/${context.operationId}:reconcile`,
};

function operationPort(submit: KnowledgeOperationPort["submit"]): KnowledgeOperationPort {
  return {
    submit,
    get: async () => undefined,
    input: async () => undefined,
    list: async () => [],
    events: async () => undefined,
    cancel: async () => undefined,
    retry: async () => undefined,
    reconcile: async () => undefined,
  };
}

describe("durable MCP operation facade", () => {
  it("does not expose identity resolver failures or malformed request details", async () => {
    const app = buildKnowledgeMcpApp({
      operationService: operationPort(async () => accepted),
      apiOrigin: "https://api.example",
      resolveIdentity: async () => {
        throw new Error("postgres://user:secret@example/private-evidence");
      },
    });
    try {
      const failure = await app.inject({
        method: "POST",
        url: "/mcp?private=restricted",
        headers: { authorization: "Bearer secret" },
        payload: {},
      });
      expect(failure.statusCode).toBe(500);
      expect(failure.json()).toEqual({ code: "INTERNAL_ERROR" });
      const malformed = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json" },
        payload: '{"private-evidence":',
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toEqual({ code: "INVALID_REQUEST" });
    } finally {
      await app.close();
    }
  });
  it("is side-effect free on import and exports a Vercel handler", () => {
    expect(typeof vercelHandler).toBe("function");
    expect(() => apiPublicOrigin("http://mcp.example", true)).toThrow("INVALID_KNOWLEDGE_API_URL");
  });
  it("bridges a real Node request through the exported serverless handler", async () => {
    const app = Fastify();
    app.get("/health", async () => ({ status: "ok" }));
    const bridge = createMcpRequestHandler(async () => ({ app }));
    const nodeServer = createServer((request, response) => {
      void bridge(request, response).catch((error) => {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "handler failure");
      });
    });
    await new Promise<void>((resolve) => nodeServer.listen(0, "127.0.0.1", resolve));
    const address = nodeServer.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    await new Promise<void>((resolve, reject) => nodeServer.close((error) => (error ? reject(error) : resolve())));
    await app.close();
  });
  it("awaits the injected durable application port and roots accepted URLs at the API", async () => {
    let finish: ((value: AcceptedOperation) => void) | undefined;
    const submit = vi.fn<KnowledgeOperationPort["submit"]>(
      () =>
        new Promise<AcceptedOperation>((resolve) => {
          finish = resolve;
        }),
    );
    const execute = createMcpToolExecutor({
      operationService: operationPort(submit),
      apiOrigin: "https://api.example",
      identity,
    });
    const pending = execute("knowledge_source_fetch", "capture", {
      context,
      input: { query: "durable MCP operation" },
      expectedVersions: { api: "v1" },
    });
    await Promise.resolve();
    expect(submit).toHaveBeenCalledWith(
      "capture",
      {
        context,
        input: { query: "durable MCP operation" },
        expectedVersions: { api: "v1" },
      },
      "https://api.example",
    );
    expect(finish).toBeTypeOf("function");
    finish!(accepted);
    await expect(pending).resolves.toMatchObject({
      structuredContent: accepted,
      content: [{ text: JSON.stringify(accepted) }],
    });
  });

  it("enforces the same tenant grant and actor binding before durable admission", async () => {
    const submit = vi.fn<KnowledgeOperationPort["submit"]>(async () => accepted);
    const execute = createMcpToolExecutor({
      operationService: operationPort(submit),
      apiOrigin: "https://api.example",
      identity,
    });
    const denied = await execute("knowledge_source_fetch", "capture", {
      context: { ...context, tenantId: id(99) },
      input: { query: "forbidden" },
      expectedVersions: { api: "v1" },
    });
    const forged = await execute("knowledge_source_fetch", "capture", {
      context: { ...context, actor: { ...context.actor, id: id(98) } },
      input: { query: "forged" },
      expectedVersions: { api: "v1" },
    });
    expect(denied).toMatchObject({
      isError: true,
      content: [{ text: '{"code":"FORBIDDEN"}' }],
    });
    expect(forged).toMatchObject({
      isError: true,
      content: [{ text: '{"code":"ACTOR_MISMATCH"}' }],
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("routes status and explanation tools to canonical in-process reads without admitting writes", async () => {
    const submit = vi.fn<KnowledgeOperationPort["submit"]>(async () => accepted);
    const reads = {
      vectorStoreOperation: vi.fn(),
      retrievalExplanation: vi.fn(async () => ({
        ok: true as const,
        value: { retrievalRunId: id(20), candidates: [] },
      })),
      evaluationFailures: vi.fn(),
    };
    const execute = createMcpToolExecutor({
      operationService: {
        ...operationPort(submit),
        get: async () => ({ state: "succeeded" }) as never,
      },
      apiOrigin: "https://api.example",
      identity,
      knowledge: { reads: reads as never },
    });
    const status = await execute("knowledge_embed_status", "embedding_run", {
      context,
      input: { operationId: id(20) },
      expectedVersions: { api: "v1" },
    });
    const explanation = await execute("knowledge_retrieve_explain", "retrieval_run", {
      context,
      input: { runId: id(20) },
      expectedVersions: { api: "v1" },
    });
    expect(status).toMatchObject({ structuredContent: { state: "succeeded" } });
    expect(explanation).toMatchObject({
      structuredContent: { retrievalRunId: id(20) },
    });
    expect(reads.retrievalExplanation).toHaveBeenCalledWith(context.tenantId, id(20));
    expect(submit).not.toHaveBeenCalled();
  });

  it("rejects deferred read-like tools before admission", async () => {
    const submit = vi.fn<KnowledgeOperationPort["submit"]>(async () => accepted);
    const execute = createMcpToolExecutor({
      operationService: operationPort(submit),
      apiOrigin: "https://api.example",
      identity,
    });
    expect(
      await execute("knowledge_embed_estimate", "embedding_run", {
        context,
        input: {},
        expectedVersions: { api: "v1" },
      }),
    ).toMatchObject({
      isError: true,
      content: [{ text: '{"code":"CAPABILITY_NOT_ADMITTED"}' }],
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("uses the shared API identity resolver for the MCP HTTP host", async () => {
    const token = "mcp-shared-identity-token-long-enough";
    const resolveIdentity = createLocalIdentityResolver(
      JSON.stringify([{ token, actor: context.actor, grants: identity.grants }]),
    );
    const app = buildKnowledgeMcpApp({
      operationService: operationPort(async () => accepted),
      apiOrigin: "https://api.example",
      resolveIdentity,
    });
    const missing = await app.inject({ method: "POST", url: "/mcp" });
    const unknown = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer an-unknown-token-long-enough" },
    });
    expect(missing.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    await app.close();
  });

  it("rejects non-public API origin forms before creating operation links", () => {
    expect(apiPublicOrigin("https://api.example/")).toBe("https://api.example");
    expect(() => apiPublicOrigin(undefined)).toThrow("KNOWLEDGE_API_URL_REQUIRED");
    expect(() => apiPublicOrigin("https://token@api.example")).toThrow("INVALID_KNOWLEDGE_API_URL");
  });
});

describe.skipIf(process.env.RUN_LOCAL_PERSISTENCE_TESTS !== "1")("MCP durable PostgreSQL admission", () => {
  let mcpRepository: PostgresCanonicalRepository;
  let workerRepository: PostgresCanonicalRepository;

  beforeAll(() => {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) throw new Error("POSTGRES_URL_REQUIRED");
    mcpRepository = new PostgresCanonicalRepository({
      connectionString,
      localOnly: true,
    });
    workerRepository = new PostgresCanonicalRepository({
      connectionString,
      localOnly: true,
    });
  });

  afterAll(async () => {
    await Promise.all([mcpRepository?.close(), workerRepository?.close()]);
  });

  it("persists MCP admission for a separately connected worker and returns API-rooted links", async () => {
    const durableContext: OperationContext = {
      ...context,
      tenantId: randomUUID(),
      operationId: randomUUID(),
      attemptId: randomUUID(),
      correlationId: `mcp-durable-${randomUUID()}`,
      actor: { ...context.actor, id: randomUUID() },
      idempotencyKey: `mcp-durable-${randomUUID()}`,
    };
    const durableIdentity: LocalApiIdentity = {
      actor: durableContext.actor,
      grants: [
        {
          tenantId: durableContext.tenantId,
          roles: ["knowledge_operator"],
          scopes: [],
        },
      ],
    };
    const execute = createMcpToolExecutor({
      operationService: new PostgresKnowledgeOperationService(mcpRepository),
      apiOrigin: "https://api.example",
      identity: durableIdentity,
    });
    const result = await execute("knowledge_source_fetch", "capture", {
      context: durableContext,
      input: { subject: "durably admitted through MCP" },
      expectedVersions: { api: "v1" },
    });
    expect(result).not.toHaveProperty("isError", true);
    if (!("structuredContent" in result)) throw new Error("MCP_RESULT_REQUIRED");
    expect(result.structuredContent).toMatchObject({
      operationId: durableContext.operationId,
      statusUrl: `https://api.example/v1/operations/${durableContext.operationId}`,
    });
    const claimed = await workerRepository.claimOperation(
      durableContext.tenantId,
      durableContext.operationId,
      "separate-mcp-worker",
    );
    expect(claimed).toMatchObject({
      operationId: durableContext.operationId,
      stepKey: "acquire",
      input: {
        kind: "capture",
        operationInput: { subject: "durably admitted through MCP" },
        context: { operationId: durableContext.operationId },
      },
    });
  });
});
