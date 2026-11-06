import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { createJevService } from "@aiengineer/knowledge-application/jev";
import { JevTaskSchema } from "@aiengineer/knowledge-contracts/jev";
import { z } from "zod";
import { createJevMcpServer } from "./mcp.js";
import { publicErrorCode } from "./errors.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const BatchSchema = z.strictObject({ tasks: z.array(JevTaskSchema).min(1).max(1000) });
type Application = ReturnType<typeof createJevService>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function authorize(request: IncomingMessage, token: string | undefined): void {
  if (request.headers.origin) throw new HttpError(403, "BROWSER_ORIGIN_NOT_ALLOWED");
  if (!token) {
    const host = new URL(`http://${request.headers.host ?? "invalid"}`).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new HttpError(403, "HOST_NOT_ALLOWED");
    return;
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new HttpError(401, "UNAUTHORIZED");
}

async function handleMcp(application: Application, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const server = createJevMcpServer(application);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(request, response, request.method === "POST" ? await readJson(request) : undefined);
}

async function handleApi(application: Application, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path === "/mcp") return handleMcp(application, request, response);
  if (request.method === "GET" && path === "/v1/jev/health") return json(response, 200, await application.stats());
  if (request.method === "GET" && path === "/v1/jev/jobs") {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(url.searchParams.get("limit") ?? 100);
    return json(response, 200, await application.list({ limit }));
  }
  if (request.method === "POST" && path === "/v1/jev/jobs") {
    return json(response, 202, await application.submit(JevTaskSchema.parse(await readJson(request))));
  }
  if (request.method === "POST" && path === "/v1/jev/batches") {
    return json(response, 202, await application.submitBatch(BatchSchema.parse(await readJson(request)).tasks));
  }
  const match = /^\/v1\/jev\/jobs\/([^/]+)(\/cancel)?$/.exec(path);
  if (match && ((request.method === "GET" && !match[2]) || (request.method === "POST" && match[2]))) {
    const id = decodeURIComponent(match[1]!);
    const job = match[2] ? await application.cancel(id) : await application.get(id);
    return json(response, job ? 200 : 404, job ?? { error: "NOT_FOUND" });
  }
  json(response, 404, { error: "NOT_FOUND" });
}

export function createJevHttpServer(
  application: Application,
  options: { token?: string; reportPath?: string; experimentReadmePath?: string } = {},
) {
  const server = createServer((request, response) => {
    void (async () => {
      // Reports contain public experiment data only; all operations share authorization.
      authorize(request, options.token);
      if (request.method === "GET" && request.url === "/" && options.reportPath) {
        const html = await readFile(options.reportPath);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
        response.end(html);
        return;
      }
      if (request.method === "GET" && request.url === "/receipts.json" && options.reportPath) {
        const receipts = await readFile(join(dirname(options.reportPath), "receipts.json"));
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(receipts);
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/scripts/experiments/jev/README.md" &&
        options.experimentReadmePath
      ) {
        const readme = await readFile(options.experimentReadmePath);
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
        response.end(readme);
        return;
      }
      await handleApi(application, request, response);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpError) {
        json(response, error.status, { error: error.message });
        return;
      }
      if (error instanceof z.ZodError) {
        json(response, 400, {
          error: "INVALID_REQUEST",
          issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
        });
        return;
      }
      const code = publicErrorCode(error);
      json(response, code === "IDEMPOTENCY_CONFLICT" ? 409 : 400, { error: code });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
