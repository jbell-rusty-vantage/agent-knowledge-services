import type { IncomingMessage, ServerResponse } from "node:http";
import { type ProtocolError, isTerminal } from "@aiengineer/knowledge-host/knowledge-operation";
import { HTTP_STATUS, refusal, toProtocolError } from "@aiengineer/knowledge-host/knowledge-operation";
import type { KnowledgeOperationService } from "@aiengineer/knowledge-host/knowledge-operation";

/**
 * HTTP surface of `ks.knowledge_operation.v2` (SV-16). Bodies are exactly the K01 schemas:
 *
 *   POST /knowledge-operation/v2/invoke                      operation-envelope.v2 -> operation-receipt.v2 | operation-handle.v2
 *                                                            | knowledge-plan-preview.v1 (knowledge.plan_preview, 200)
 *   GET  /knowledge-operation/v2/operations/{operationId}    -> operation-status.v2 (Retry-After mirrors retryAfterMs)
 *   POST /knowledge-operation/v2/operations/{operationId}/cancel   {cancelRequestId} -> operation-status.v2 (idempotent)
 *   GET  /knowledge-operation/v2/receipts/{effectKey}        -> receipt-lookup.v2 (found | not_found | unresolved)
 *   GET  /knowledge-operation/v2/describe                    -> binding-descriptor.v2
 *   GET  /knowledge-operation/v2/artifacts/{artifactId}?digest=sha256:...  exact custody bytes (executor extension)
 *
 * Authentication is the K07 bearer credential (`Authorization: Bearer <compact JWS>`) on every route; the legacy static
 * bearer never authorizes these routes. Every refusal is a `protocol-error.v2` with the HTTP status mirrored from its
 * code; the status code never replaces the domain outcome carried in the body.
 */
export const KNOWLEDGE_OPERATION_PREFIX = "/knowledge-operation/v2";
const BODY_LIMIT = 8_000_000;

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = chunk as Uint8Array;
    total += bytes.byteLength;
    if (total > BODY_LIMIT) throw refusal("BUDGET_EXHAUSTED", "request body exceeds the executor limit");
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

function send(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

function sendError(response: ServerResponse, error: ProtocolError): void {
  send(response, HTTP_STATUS[error.code], error);
}

export function bearerOf(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

function segment(value: string): string {
  return decodeURIComponent(value);
}

/** Handles the knowledge-operation routes; `false` when the path is not one of them. */
export async function handleKnowledgeOperation(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: KnowledgeOperationService | undefined,
): Promise<boolean> {
  if (url.pathname !== KNOWLEDGE_OPERATION_PREFIX && !url.pathname.startsWith(`${KNOWLEDGE_OPERATION_PREFIX}/`)) {
    return false;
  }
  if (service === undefined) {
    sendError(
      response,
      refusal(
        "CAPABILITY_UNAVAILABLE",
        "ks.knowledge_operation.v2 is not configured on this executor (set KS_KNOWLEDGE_ISSUER and the binding config)",
      ).error,
    );
    return true;
  }
  const path = url.pathname.slice(KNOWLEDGE_OPERATION_PREFIX.length);
  const token = bearerOf(request);
  const method = request.method ?? "GET";
  try {
    if (path === "/invoke" && method === "POST") {
      const result = await service.invoke(token, await readJson(request));
      // A receipt or a synchronous result document (plan preview, read intent result) answers 200; a handle 202.
      const synchronous = "outcome" in result || "planId" in result || "schemaVersion" in result;
      send(response, synchronous ? 200 : 202, result);
      return true;
    }
    if (path === "/describe" && method === "GET") {
      send(response, 200, await service.describe(token));
      return true;
    }
    const cancel = /^\/operations\/([^/]+)\/cancel$/.exec(path);
    if (cancel && method === "POST") {
      send(response, 200, await service.cancel(token, segment(cancel[1] as string), await readJson(request)));
      return true;
    }
    const operation = /^\/operations\/([^/]+)$/.exec(path);
    if (operation && method === "GET") {
      const status = await service.status(token, segment(operation[1] as string));
      const headers: Record<string, string> =
        !isTerminal(status.state) && status.retryAfterMs !== null
          ? { "retry-after": String(Math.max(1, Math.ceil(status.retryAfterMs / 1000))) }
          : {};
      send(response, 200, status, headers);
      return true;
    }
    const receipt = /^\/receipts\/([^/]+)$/.exec(path);
    if (receipt && method === "GET") {
      send(response, 200, await service.receipt(token, segment(receipt[1] as string)));
      return true;
    }
    const artifact = /^\/artifacts\/([^/]+)$/.exec(path);
    if (artifact && method === "GET") {
      const digest = url.searchParams.get("digest") ?? "";
      const found = await service.artifact(token, segment(artifact[1] as string), digest);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "x-artifact-digest": found.digest,
      });
      response.end(Buffer.from(found.bytes));
      return true;
    }
    sendError(response, refusal("NOT_FOUND", `no knowledge-operation route ${method} ${path}`).error);
    return true;
  } catch (error) {
    if (!response.headersSent) sendError(response, toProtocolError(error));
    else response.end();
    return true;
  }
}
