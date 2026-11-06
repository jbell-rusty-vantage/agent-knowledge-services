// Drives one API route and one MCP tool (over the real MCP HTTP app) and normalizes
// their outcomes: a success body, or the problem/tool error code.
import { buildServer, type ServerOptions } from "../../../api/src/server.js";
import { buildKnowledgeMcpApp, type KnowledgeMcpAppOptions } from "../index.js";
import { CORRELATION, IDEMPOTENCY, ORIGIN, resolveIdentity } from "./parity-rows.js";

export type Outcome =
  | { readonly status?: number; readonly value: unknown }
  | { readonly status?: number; readonly code: string }
  | { readonly error: string };

export async function viaApi(
  options: ServerOptions,
  token: string,
  tenantId: string,
  request: { method: "GET" | "POST"; url: string; payload?: unknown },
): Promise<Outcome> {
  const server = buildServer({ resolveIdentity, ...options });
  try {
    const response = await server.inject({
      method: request.method,
      url: request.url,
      headers: {
        authorization: `Bearer ${token}`,
        "x-tenant-id": tenantId,
        "x-correlation-id": CORRELATION,
        "idempotency-key": IDEMPOTENCY,
      },
      ...(request.payload === undefined ? {} : { payload: request.payload as object }),
    });
    const body = response.json();
    return response.statusCode < 300
      ? { status: response.statusCode, value: body }
      : { status: response.statusCode, code: body.code };
  } finally {
    await server.close();
  }
}

export async function viaMcp(
  options: Partial<KnowledgeMcpAppOptions>,
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<Outcome> {
  const app = buildKnowledgeMcpApp({
    operationService: {} as never,
    apiOrigin: ORIGIN,
    resolveIdentity,
    ...options,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
    });
    const body = response.json();
    if (body.error) return { error: JSON.stringify(body.error) };
    const result = body.result as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
    if (!result.isError) return { value: result.structuredContent };
    try {
      return { code: (JSON.parse(result.content[0]!.text) as { code: string }).code };
    } catch {
      return { error: result.content[0]!.text };
    }
  } finally {
    await app.close();
  }
}
