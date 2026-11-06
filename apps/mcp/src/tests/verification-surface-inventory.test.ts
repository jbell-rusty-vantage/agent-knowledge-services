import { describe, expect, it } from "vitest";
import {
  KnowledgeIntegrationService,
  VerificationOperationApplicationService,
} from "@aiengineer/knowledge-application";
import { KnowledgeClient } from "../../../../packages/client/src/client.js";
import { dispatchCliCommand, resolveCommand } from "../../../cli/src/commands.js";
import { createVerificationMcpToolExecutor } from "../index.js";
import { buildServer } from "../../../api/src/server.js";
import { verificationMutationInventory, version } from "./verification-inventory.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenant = id(1),
  actor = {
    kind: "service" as const,
    id: id(2),
    serviceIdentity: "mission_control_client" as const,
  };
const identity = {
  actor,
  grants: [{ tenantId: tenant, roles: ["knowledge_operator" as const], scopes: [] }],
};
const inventory = verificationMutationInventory;

describe("complete verification mutation admission inventory", () => {
  it.each(inventory)("$useCase preserves HTTP/CLI/MCP input and worker lease identity", async (entry) => {
    const operations = new KnowledgeIntegrationService();
    const context = {
      tenantId: tenant,
      correlationId: `inventory-${entry.useCase}`,
      idempotencyKey: `inventory-${entry.useCase}`,
      operationId: id(10),
      attemptId: id(11),
      actor,
      capabilityVersion: "verification-service.v1",
      reason: "cross-surface admission fixture",
      contractVersion: "v1" as const,
    };
    const api = buildServer({
      verificationOperationService: operations,
      resolveIdentity: () => identity,
      resolveVerificationContext: () => context,
      isParseArtifactRequestAdmitted: () => true,
      isStructuredExtractionRequestAdmitted: () => true,
      isBenchmarkRequestAdmitted: () => true,
      isBenchmarkComparisonRequestAdmitted: () => true,
    });
    const request = { ...version, ...entry.request };
    const headers = {
      authorization: "Bearer synthetic-inventory",
      "x-tenant-id": tenant,
      "x-correlation-id": context.correlationId,
      "idempotency-key": context.idempotencyKey,
    };
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://knowledge.example");
      const response = await api.inject({
        method: (init?.method ?? "GET") as "POST",
        url: url.pathname,
        headers: Object.fromEntries(new Headers(init?.headers)),
        payload: init?.body as string,
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new KnowledgeClient({
      baseUrl: "https://knowledge.example",
      getAccessToken: () => "synthetic-inventory",
      fetch: transport,
    });
    try {
      const direct = await api.inject({
        method: "POST",
        url: entry.path,
        headers,
        payload: request,
      });
      expect(direct.statusCode, direct.body).toBe(202);
      const cli = await dispatchCliCommand(client, resolveCommand(entry.cli[0], entry.cli[1])!, request, context);
      const execute = createVerificationMcpToolExecutor({
        operationService: operations,
        apiOrigin: "https://knowledge.example",
        identity,
        verificationOperations: new VerificationOperationApplicationService(operations, "https://knowledge.example"),
        resolveVerificationContext: () => context,
        verificationAdmission: {
          isParseArtifactRequestAdmitted: () => true,
          isStructuredExtractionRequestAdmitted: () => true,
          isBenchmarkRequestAdmitted: () => true,
          isBenchmarkComparisonRequestAdmitted: () => true,
        },
      });
      const mcp = await execute(entry.tool, {
        context: {
          tenantId: tenant,
          correlationId: context.correlationId,
          idempotencyKey: context.idempotencyKey,
        },
        request,
      });
      expect("structuredContent" in mcp).toBe(true);
      for (const accepted of [direct.json(), cli, "structuredContent" in mcp ? mcp.structuredContent : undefined])
        expect(accepted).toMatchObject({
          operationId: context.operationId,
          state: "queued",
        });
      expect(operations.list(tenant)).toHaveLength(1);
      expect(operations.input(context.operationId, tenant)).toEqual({
        schemaVersion: "verification-service-request.v1",
        useCase: entry.useCase,
        request,
      });
      const claim = operations.claimOperation(context.operationId, "fixture-worker");
      expect(claim?.operation).toMatchObject({ kind: entry.kind, context });
      expect(claim?.step).toMatchObject({ name: entry.step });
      // This is admission/lease parity. It deliberately does not synthesize a
      // worker terminal or claim execution of the twelve verification algorithms.
    } finally {
      await api.close();
    }
  });
});
