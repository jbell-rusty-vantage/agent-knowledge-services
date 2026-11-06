import {
  createHost,
  createKnowledgeResourceReads,
  createLocalIdentityResolver,
  createVerificationResourceReads,
  verificationReadServices,
} from "@aiengineer/knowledge-host";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { KnowledgeMcpAppOptions } from "../tools/executors.js";
import { createKnowledgeMcpServer } from "../tools/register.js";

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
}

/** Stateless MCP HTTP host. The bearer is resolved by the same identity map as HTTP. */
export function buildKnowledgeMcpApp(options: KnowledgeMcpAppOptions): FastifyInstance {
  // Raw HTTP URLs and exception messages can contain tenant evidence or credentials.
  // Operational telemetry must use the application's bounded event projections.
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const candidate =
      error !== null && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
    const status =
      typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate < 500
        ? candidate
        : 500;
    return reply.status(status).send({ code: status === 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST" });
  });
  app.get("/health", async () => ({ status: "ok" }));
  app.all("/mcp", async (request, reply) => {
    const token = bearerToken(request);
    const identity = token ? await options.resolveIdentity(token) : undefined;
    if (!identity) return reply.status(401).send({ code: "UNAUTHORIZED" });
    const server = createKnowledgeMcpServer({
      operationService: options.operationService,
      apiOrigin: options.apiOrigin,
      identity,
      incomingRequest: {
        headers: request.headers as Record<string, unknown>,
        body: request.body,
      },
      ...(options.verificationOperations ? { verificationOperations: options.verificationOperations } : {}),
      ...(options.resolveVerificationContext ? { resolveVerificationContext: options.resolveVerificationContext } : {}),
      ...(options.verificationAdmission ? { verificationAdmission: options.verificationAdmission } : {}),
      ...(options.knowledge ? { knowledge: options.knowledge } : {}),
      ...(options.verificationReads ? { verificationReads: options.verificationReads } : {}),
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
  });
  return app;
}

export function apiPublicOrigin(value: string | undefined, production = process.env.NODE_ENV === "production"): string {
  if (!value?.trim()) throw new Error("KNOWLEDGE_API_URL_REQUIRED");
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (production && url.protocol !== "https:")
  )
    throw new Error("INVALID_KNOWLEDGE_API_URL");
  return url.toString().replace(/\/$/, "");
}

type Environment = Readonly<Record<string, string | undefined>>;

export async function createMcpRuntime(environment: Environment = process.env) {
  const host = await createHost({
    profile: "server",
    role: "mcp",
    environment,
    resolveApiOrigin: (config) => apiPublicOrigin(environment.KNOWLEDGE_API_URL, config.NODE_ENV === "production"),
  });
  try {
    const { apiOrigin, knowledge, operations, verify } = host;
    const app = buildKnowledgeMcpApp({
      operationService: operations.service,
      apiOrigin,
      knowledge: {
        reads: createKnowledgeResourceReads({
          ...(knowledge.resources ? { resources: knowledge.resources } : {}),
          operations: operations.service,
          ...(knowledge.getEvidencePacket ? { getEvidencePacket: knowledge.getEvidencePacket } : {}),
          ...(knowledge.replayEvidencePacketCitations
            ? {
                replayEvidencePacketCitations: knowledge.replayEvidencePacketCitations,
              }
            : {}),
        }),
        retrievalOperations: operations.retrieval,
        ...(knowledge.canonicalRetrievalExecutor ? { retrievalExecutor: knowledge.canonicalRetrievalExecutor } : {}),
      },
      resolveIdentity: createLocalIdentityResolver(environment.KNOWLEDGE_API_IDENTITIES),
      ...(verify.operations ? { verificationOperations: verify.operations } : {}),
      ...(verify.runtime.resolveVerificationContext
        ? { resolveVerificationContext: verify.runtime.resolveVerificationContext }
        : {}),
      // The API's admission gates.
      verificationAdmission: verify.runtime,
      verificationReads: createVerificationResourceReads(verificationReadServices(verify)),
    });
    let closing: Promise<void> | undefined;
    return {
      app,
      config: host.config,
      /** Closes the HTTP app before releasing host resources; idempotent. */
      close: () =>
        (closing ??= (async () => {
          try {
            await app.close();
          } finally {
            await host.close();
          }
        })()),
    };
  } catch (error) {
    await host.close().catch(() => undefined);
    throw error;
  }
}
