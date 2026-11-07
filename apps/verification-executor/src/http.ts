import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isKnowledgeError } from "@aiengineer/knowledge-db";
import type { VerificationExecutor } from "./executor.js";
import type { KnowledgeServices } from "./knowledge/context.js";
import { handleKnowledgeOperation } from "./knowledge-operation/http.js";
import { KNOWLEDGE_OPERATION_CREDENTIAL_HEADER } from "./knowledge-operation/mcp-tools.js";
import type { KnowledgeOperationService } from "@aiengineer/knowledge-host/knowledge-operation";
import { knowledgeOperations } from "./knowledge/operations.js";
import { createVerificationMcpServer, errorEnvelope } from "./mcp.js";
import { UnknownOperationError } from "./operations/define.js";
import { ScopedAccessError, type ScopedExecutorAccess } from "./access.js";
import { z } from "zod";

/**
 * Routes
 *   GET  /health                   store, tenant, and (when configured) workspace/database heads
 *   POST /mcp                      Streamable HTTP MCP (stateless; one server per request)
 *   POST /artifacts                raw bytes -> handle (headers: content-type, x-artifact-label, x-run-id)
 *   POST /captures                 document bytes -> capture (headers: content-type, x-filename, x-source-uri, x-capture-id, x-run-id)
 *   GET  /media-types              content types the executor can capture
 *   GET  /artifacts/:artifactId    raw bytes back (digest re-verified on read)
 *   GET  /runs/:runId              chain state + step receipts
 *   GET  /captures                 list captures
 *   POST /knowledge/:operation     JSON input -> JSON output for any knowledge operation (schema_*, db_*, ingest_*, artifact_get)
 *   GET  /knowledge/operations     the operation catalog
 *
 * Optional bearer auth: set VERIFY_EXECUTOR_TOKEN and clients must send `Authorization: Bearer <token>`.
 *
 * Knowledge Operation Protocol v2 (`/knowledge-operation/v2/*`, see knowledge-operation/http.ts) is authenticated by
 * the K07 issuer credential only, checked before (and independently of) the legacy static bearer above.
 */

async function readBody(request: IncomingMessage, limit = 16_000_000): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = chunk as Uint8Array;
    total += bytes.byteLength;
    if (total > limit) throw new Error("BODY_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value, null, 2));
}

export interface HttpServerOptions {
  readonly token?: string;
  readonly knowledge?: KnowledgeServices;
  readonly scopedAccess?: ScopedExecutorAccess;
  /** `ks.knowledge_operation.v2` (SV-16); absent, its routes answer CAPABILITY_UNAVAILABLE. */
  readonly knowledgeOperation?: KnowledgeOperationService;
}

const scopedInvocation = z.strictObject({
  assignment: z.unknown(),
  operation: z.string().min(1),
  payload: z.unknown(),
});
const scopedCatalog = z.strictObject({ assignment: z.unknown() });

async function healthPayload(
  executor: VerificationExecutor,
  knowledge: KnowledgeServices | undefined,
): Promise<Record<string, unknown>> {
  const base = { status: "ok", store: executor.store.rootDir, tenantId: executor.store.tenantId };
  if (!knowledge) return base;
  const databaseHead = await knowledge.reads.databaseHead().catch(() => undefined);
  return {
    ...base,
    knowledge: {
      workspaceDir: knowledge.workspace.dir,
      workspaceHead: knowledge.workspace.migrationHead,
      workspaceFingerprint: knowledge.workspace.fingerprint ?? null,
      databaseHead: databaseHead ?? null,
      headMatches: databaseHead === knowledge.workspace.migrationHead,
      defaultTenantId: knowledge.config.defaultTenantId,
      operations: knowledgeOperations.list().map((operation) => operation.name),
    },
  };
}

async function handleKnowledge(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  knowledge: KnowledgeServices | undefined,
): Promise<boolean> {
  if (!url.pathname.startsWith("/knowledge/")) return false;
  if (!knowledge) {
    json(response, 503, {
      error: "KNOWLEDGE_UNAVAILABLE",
      code: "KNOWLEDGE_UNAVAILABLE",
      exit: 2,
      hint: "set KS_AIENG_DB_RUNTIME_DSN and SCHEMA_WORKSPACE_DIR",
    });
    return true;
  }
  if (request.method === "GET" && url.pathname === "/knowledge/operations") {
    json(
      response,
      200,
      knowledgeOperations.list().map((operation) => ({
        name: operation.name,
        title: operation.title,
        description: operation.description,
        cli: operation.cli,
      })),
    );
    return true;
  }
  const name = url.pathname.slice("/knowledge/".length);
  if (request.method !== "POST") {
    json(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return true;
  }
  const body = Buffer.from(await readBody(request, name === "checkpoint_harness" ? 96_000_000 : 16_000_000)).toString(
    "utf8",
  );
  try {
    const { operation, output } = await knowledgeOperations.invoke(name, body ? JSON.parse(body) : {}, knowledge);
    const gate = operation.gate?.(output);
    json(
      response,
      200,
      gate ? { ...(output as Record<string, unknown>), qualityGate: { passed: false, reason: gate } } : output,
    );
  } catch (error) {
    if (error instanceof UnknownOperationError)
      json(response, 404, { error: error.message, code: "OPERATION_UNKNOWN", known: error.known });
    else json(response, isKnowledgeError(error) ? (error.exit === 1 ? 422 : 502) : 400, errorEnvelope(error));
  }
  return true;
}

export function createHttpServer(executor: VerificationExecutor, options: HttpServerOptions = {}): Server {
  if (options.scopedAccess && !options.token) throw new ScopedAccessError("SCOPED_HOST_AUTH_REQUIRED");
  return createServer(async (request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      return json(response, 400, { error: "INVALID_REQUEST_URL" });
    }
    try {
      if (request.method === "GET" && url.pathname === "/health")
        return json(response, 200, await healthPayload(executor, options.knowledge));
      if (await handleKnowledgeOperation(request, response, url, options.knowledgeOperation)) return;
      if (options.token) {
        const header = request.headers.authorization ?? "";
        if (header !== `Bearer ${options.token}`) return json(response, 401, { error: "UNAUTHORIZED" });
      }
      if (url.pathname === "/scoped/invoke" && request.method === "POST") {
        if (!options.scopedAccess) return json(response, 503, { error: "SCOPED_ACCESS_UNAVAILABLE" });
        const input = scopedInvocation.parse(JSON.parse(Buffer.from(await readBody(request)).toString("utf8")));
        return json(response, 200, await options.scopedAccess.executeScoped(input));
      }
      if (url.pathname === "/scoped/catalog" && request.method === "POST") {
        if (!options.scopedAccess) return json(response, 503, { error: "SCOPED_ACCESS_UNAVAILABLE" });
        const input = scopedCatalog.parse(JSON.parse(Buffer.from(await readBody(request)).toString("utf8")));
        return json(response, 200, options.scopedAccess.catalog(input.assignment));
      }
      if (url.pathname === "/mcp") {
        const body =
          request.method === "POST"
            ? JSON.parse(Buffer.from(await readBody(request)).toString("utf8") || "null")
            : undefined;
        const credentialHeader = request.headers[KNOWLEDGE_OPERATION_CREDENTIAL_HEADER];
        const credential = typeof credentialHeader === "string" ? credentialHeader.trim() || null : null;
        const server = createVerificationMcpServer(executor, options.knowledge, {
          service: options.knowledgeOperation,
          credential: () => credential,
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await server.connect(transport);
        response.on("close", () => {
          void transport.close();
          void server.close();
        });
        await transport.handleRequest(request, response, body);
        return;
      }
      if (await handleKnowledge(request, response, url, options.knowledge)) return;
      if (request.method === "POST" && url.pathname === "/artifacts") {
        const bytes = await readBody(request);
        if (bytes.byteLength === 0) return json(response, 400, { error: "EMPTY_BODY" });
        const label =
          typeof request.headers["x-artifact-label"] === "string" ? request.headers["x-artifact-label"] : undefined;
        const run = typeof request.headers["x-run-id"] === "string" ? request.headers["x-run-id"] : undefined;
        const mediaType = request.headers["content-type"]?.toString() || "application/octet-stream";
        const result = await executor.registerArtifact({
          bytes,
          mediaType,
          ...(label ? { label } : {}),
          ...(run ? { runId: run } : {}),
        });
        return json(response, 201, result);
      }
      if (request.method === "POST" && url.pathname === "/captures") {
        const bytes = await readBody(request, 60_000_000);
        if (bytes.byteLength === 0) return json(response, 400, { error: "EMPTY_BODY" });
        const header = (name: string): string | undefined =>
          typeof request.headers[name] === "string" ? decodeURIComponent(request.headers[name] as string) : undefined;
        const filename = header("x-filename");
        if (!filename) return json(response, 400, { error: "X_FILENAME_REQUIRED" });
        const declared = request.headers["content-type"]?.toString();
        const result = await executor.captureFile({
          bytes,
          filename,
          ...(declared && declared !== "application/octet-stream" ? { mediaType: declared } : {}),
          ...(header("x-source-uri") ? { sourceUri: header("x-source-uri")! } : {}),
          ...(header("x-capture-id") ? { captureId: header("x-capture-id")! } : {}),
          ...(header("x-run-id") ? { runId: header("x-run-id")! } : {}),
        });
        return json(response, 201, result);
      }
      if (request.method === "GET" && url.pathname === "/media-types")
        return json(response, 200, executor.supportedMediaTypes());
      const artifactMatch = /^\/artifacts\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && artifactMatch) {
        const id = decodeURIComponent(artifactMatch[1]!);
        const handle = await executor.store.resolveHandle(
          id.startsWith("sha256:") ? { digest: id } : { artifactId: id },
        );
        const bytes = await executor.store.bytes(handle);
        response.writeHead(200, {
          "content-type": handle.mediaType,
          "x-artifact-id": handle.artifactId,
          "x-artifact-digest": handle.digest,
        });
        response.end(Buffer.from(bytes));
        return;
      }
      if (request.method === "GET" && url.pathname === "/captures")
        return json(response, 200, await executor.listCaptures());
      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        error instanceof ScopedAccessError
          ? 403
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : message === "BODY_TOO_LARGE"
              ? 413
              : message.includes("NOT_FOUND")
                ? 404
                : 500;
      if (!response.headersSent) json(response, status, { error: message });
      else response.end();
    }
  });
}
