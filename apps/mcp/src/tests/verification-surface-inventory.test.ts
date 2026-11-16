import { describe, expect, it, vi } from "vitest";
import {
  createKnowledgeResourceReads,
  KnowledgeIntegrationService,
  VerificationOperationApplicationService,
} from "@aiengineer/knowledge-application";
import { OPERATION_CONTRACTS, operationContractForKind, operationInputIssues } from "@aiengineer/knowledge-contracts";
import { KnowledgeClient } from "../../../../packages/client/src/client.js";
import {
  CLI_COMMANDS,
  CliInputError,
  dispatchCliCommand,
  resolveCommand,
  type CliCommand,
} from "../../../cli/src/commands.js";
import { createMcpToolExecutor, createVerificationMcpToolExecutor } from "../index.js";
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

describe("knowledge operation input refusal on HTTP, CLI and MCP", () => {
  const context = {
    tenantId: tenant,
    operationId: id(10),
    attemptId: id(11),
    correlationId: "input-refusal",
    actor,
    capabilityVersion: "mcp/1",
    idempotencyKey: "input-refusal-0001",
    reason: "cross-surface input refusal fixture",
    contractVersion: "v1" as const,
  };

  it("refuses the same invalid input with the same code and issues on every transport, before submission", async () => {
    const submit = vi.fn();
    const port = { submit, get: vi.fn(), input: vi.fn(), list: vi.fn(), events: vi.fn() } as never;
    const retrieval = { submit: vi.fn(), execute: vi.fn() };
    const api = buildServer({
      resolveIdentity: () => identity,
      operationService: port,
      retrievalOperationService: { submit: retrieval.submit } as never,
      canonicalRetrievalExecutor: { execute: retrieval.execute } as never,
    });
    const execute = createMcpToolExecutor({
      operationService: port,
      apiOrigin: "https://knowledge.example",
      identity,
      knowledge: {
        reads: createKnowledgeResourceReads({}),
        retrievalOperations: { submit: retrieval.submit },
        retrievalExecutor: { execute: retrieval.execute } as never,
      },
    });
    const commands = Object.values(CLI_COMMANDS).flatMap((actions) => Object.values(actions) as CliCommand[]);
    let checked = 0;
    try {
      for (const contract of OPERATION_CONTRACTS) {
        const [tool] = contract.mcp;
        const [route] = contract.http;
        if (contract.effect !== "submit" || !contract.kind || contract.shape !== "envelope" || !tool || !route)
          continue;
        const kind = contract.kind;
        const invalid = kind === "retrieval_run" ? { plan: {} } : { unexpected: true };
        const issues = operationInputIssues(kind, invalid);
        expect(issues.length, kind).toBeGreaterThan(0);
        expect(
          issues.every((issue) => issue.path === "input" || issue.path.startsWith("input.")),
          kind,
        ).toBe(true);
        const envelope = {
          context,
          input: invalid,
          expectedVersions: { api: "v1", ...(kind === "retrieval_run" ? { retrieval: "v1" } : {}) },
        };

        const called = await execute(tool as never, kind, envelope);
        expect(called, tool).toHaveProperty("isError", true);
        const [content] = called.content as { text: string }[];
        expect(JSON.parse(content?.text ?? "null"), tool).toEqual({
          code: "INVALID_CONTRACT",
          issues,
          describe: `tool:${tool}`,
        });

        const [method, path] = route.split(" ") as ["POST", string];
        const response = await api.inject({
          method,
          url: path.replace(/\{[^}]+\}/gu, id(60)),
          headers: {
            authorization: "Bearer synthetic-inventory",
            "x-tenant-id": tenant,
            "x-correlation-id": context.correlationId,
          },
          payload: envelope,
        });
        expect(response.statusCode, route).toBe(400);
        expect(response.json(), route).toMatchObject({ code: "INVALID_CONTRACT", issues });

        const command = commands.find(
          (item) =>
            (item.mode === "submit" && item.kind === kind) || (item.mode === "retrieval" && kind === "retrieval_run"),
        );
        if (command) {
          const refused = await dispatchCliCommand({} as never, command, invalid, context).catch(
            (error: unknown) => error,
          );
          expect(refused, `ks ${kind}`).toBeInstanceOf(CliInputError);
          expect(refused, `ks ${kind}`).toMatchObject({ code: "INVALID_CONTRACT", issues });
        }
        checked += 1;
      }
    } finally {
      await api.close();
    }
    // Every knowledge operation with an MCP tool and an HTTP route of its own was checked (evidence_packet has no
    // route of its own; its tool makes the same check).
    expect(checked).toBe(18);
    expect(submit).not.toHaveBeenCalled();
    expect(retrieval.submit).not.toHaveBeenCalled();
    expect(retrieval.execute).not.toHaveBeenCalled();
  });

  it("admits on every transport the example each operation's contract publishes", async () => {
    const capture = operationContractForKind("capture").example;
    const envelope = { context, input: capture, expectedVersions: { api: "v1" } };
    const operations = () => new KnowledgeIntegrationService();
    const api = buildServer({ resolveIdentity: () => identity, operationService: operations() });
    try {
      const direct = await api.inject({
        method: "POST",
        url: "/v1/captures",
        headers: {
          authorization: "Bearer synthetic-inventory",
          "x-tenant-id": tenant,
          "x-correlation-id": context.correlationId,
        },
        payload: envelope,
      });
      expect(direct.statusCode, direct.body).toBe(202);
      const mcp = await createMcpToolExecutor({
        operationService: operations(),
        apiOrigin: "https://knowledge.example",
        identity,
      })("knowledge_source_fetch", "capture", envelope);
      expect(mcp).not.toHaveProperty("isError", true);
      const submitOperation = vi.fn(async () => ({ operationId: context.operationId, state: "queued" }));
      const cli = await dispatchCliCommand({ submitOperation } as never, CLI_COMMANDS.source.fetch, capture, context);
      // The CLI sends the input it was given: the check validates and changes nothing.
      expect(submitOperation).toHaveBeenCalledWith("capture", capture, context);
      for (const accepted of [direct.json(), mcp.structuredContent, cli])
        expect(accepted).toMatchObject({ operationId: context.operationId, state: "queued" });
    } finally {
      await api.close();
    }
  });
});
