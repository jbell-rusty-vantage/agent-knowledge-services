import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { refusal, toProtocolError } from "@aiengineer/knowledge-host/knowledge-operation";
import type { KnowledgeOperationService } from "@aiengineer/knowledge-host/knowledge-operation";

/**
 * MCP mirror of the knowledge-operation routes, calling the same {@link KnowledgeOperationService} in process (MCP has
 * no HTTP client). The K07 credential travels out of band of the tool arguments, so it never lands in a tool-call log:
 * over Streamable HTTP it is the `X-Knowledge-Operation-Credential` request header (the `/mcp` route may still sit
 * behind the legacy static bearer); over stdio there is none, and every tool refuses `SCOPE_DENIED`.
 */
export const KNOWLEDGE_OPERATION_CREDENTIAL_HEADER = "x-knowledge-operation-credential";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failed(error: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(toProtocolError(error), null, 2) }], isError: true };
}

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/);

export function registerKnowledgeOperationTools(
  server: McpServer,
  service: KnowledgeOperationService | undefined,
  credential: () => string | null,
): void {
  const guard = (run: (svc: KnowledgeOperationService, token: string | null) => Promise<unknown>) => async () => {
    try {
      if (service === undefined) {
        throw refusal("CAPABILITY_UNAVAILABLE", "ks.knowledge_operation.v2 is not configured on this executor");
      }
      return ok(await run(service, credential()));
    } catch (error) {
      return failed(error);
    }
  };
  server.registerTool(
    "knowledge_operation_invoke",
    {
      title: "Invoke a knowledge operation (K01 v2)",
      description:
        "Send one ks.knowledge_operation.v2 operation-envelope.v2. Returns operation-receipt.v2 for a synchronous effect (report.register, knowledge.apply), knowledge-plan-preview.v1 for the read-only knowledge.plan_preview, knowledge-read-intent-result.v1 for the recorded read-only knowledge.read_intent (allowlisted named queries and schema reads), or operation-handle.v2 (report.assess, knowledge.read, verify.claims). Refusals are protocol-error.v2.",
      inputSchema: { envelope: z.record(z.string(), z.unknown()) },
    },
    async (input) => guard((svc, token) => svc.invoke(token, input.envelope))(),
  );
  server.registerTool(
    "knowledge_operation_get",
    {
      title: "Get an operation status",
      description:
        "Poll one operation handle by operationId (scope from the credential). Returns operation-status.v2 with a bounded retryAfterMs while not terminal.",
      inputSchema: { operationId: Id },
    },
    async (input) => guard((svc, token) => svc.status(token, input.operationId))(),
  );
  server.registerTool(
    "knowledge_operation_cancel",
    {
      title: "Cancel an operation",
      description:
        "Idempotent cancellation by cancelRequestId: the first request id is kept; queued operations cancel, running or waiting_review ones move to cancelling and settle cancelled.",
      inputSchema: { operationId: Id, cancelRequestId: Id },
    },
    async (input) =>
      guard((svc, token) => svc.cancel(token, input.operationId, { cancelRequestId: input.cancelRequestId }))(),
  );
  server.registerTool(
    "knowledge_receipt_get",
    {
      title: "Look up an effect receipt",
      description:
        "Receipt-first recovery: receipt-lookup.v2 for one effect key (found, not_found or unresolved). A negative lookup after an uncertain dispatch is not proof that nothing was applied.",
      inputSchema: { effectKey: Id },
    },
    async (input) => guard((svc, token) => svc.receipt(token, input.effectKey))(),
  );
  server.registerTool(
    "knowledge_describe",
    {
      title: "Describe the binding",
      description:
        "binding-descriptor.v2 of the credential's binding: protocol and core schemas, operations, report kinds, media, guarantees, signing issuer, pinned component and qualification receipts.",
      inputSchema: {},
    },
    async () => guard((svc, token) => svc.describe(token))(),
  );
}
