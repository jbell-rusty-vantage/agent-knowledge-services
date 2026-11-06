import { CanonicalRetrievalExecutor } from "@aiengineer/knowledge-application";
import { createHost, createLocalIdentityResolver } from "@aiengineer/knowledge-host";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { buildServer } from "./server.js";
import { createCallbackSigningSecretResolver } from "./a2a-http.js";
import { apiServerOptions } from "./composition.js";
import { loadRepositoryDemoEvaluationBundles } from "./demo-evaluation-bundles.js";

// Trusted host composition injects the same accounted adapter used by selected publication.
export { buildServer, CanonicalRetrievalExecutor };

type Environment = Readonly<Record<string, string | undefined>>;

export function validateApiPublicOrigin(value: string | undefined, production: boolean): string | undefined {
  if (!value?.trim()) {
    if (production) throw new Error("KNOWLEDGE_API_URL_REQUIRED");
    return undefined;
  }
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && !production))
  )
    throw new Error("INVALID_KNOWLEDGE_API_URL");
  return url.origin;
}

export async function createApiRuntime(environment: Environment = process.env) {
  const host = await createHost({
    profile: "server",
    role: "api",
    environment,
    resolvePublicOrigin: (config) =>
      validateApiPublicOrigin(environment.KNOWLEDGE_API_URL, config.NODE_ENV === "production"),
  });
  try {
    const server = buildServer({
      ...apiServerOptions(host),
      resolveIdentity: createLocalIdentityResolver(environment.KNOWLEDGE_API_IDENTITIES),
      resolveCallbackSigningSecret: createCallbackSigningSecretResolver(environment.KNOWLEDGE_CALLBACK_SIGNING_KEYS),
      loadDemoEvaluationBundles: loadRepositoryDemoEvaluationBundles,
    });
    let closing: Promise<void> | undefined;
    return {
      config: host.config,
      server,
      retrievalConfigured: host.capabilities.retrieval,
      citationReplayConfigured: host.capabilities.citationReplay,
      verificationConfigured: host.capabilities.verification,
      /** Closes listeners before releasing host resources; idempotent. */
      close: () =>
        (closing ??= (async () => {
          try {
            await server.close();
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

let serverlessRuntime: ReturnType<typeof createApiRuntime> | undefined;
const getServerlessRuntime = () => (serverlessRuntime ??= createApiRuntime());

export function createApiRequestHandler(
  runtime: () => Promise<Pick<Awaited<ReturnType<typeof createApiRuntime>>, "server">>,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { server } = await runtime();
    await server.ready();
    await new Promise<void>((resolve, reject) => {
      response.once("finish", resolve);
      response.once("error", reject);
      server.server.emit("request", request, response);
    });
  };
}

/** Vercel Node function entrypoint; the Fastify/runtime singleton survives warm invocations. */
const handler = createApiRequestHandler(getServerlessRuntime);
export default handler;

async function main() {
  const runtime = await createApiRuntime();
  const { config, server } = runtime;
  try {
    await server.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
  const shutdown = (signal: string) => {
    void runtime.close().catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ event: "knowledge.api.shutdown_failed", signal, error: error instanceof Error ? error.message : "unknown" })}\n`,
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ event: "knowledge.api.start_failed", error: error instanceof Error ? error.message : "unknown" })}\n`,
    );
    process.exitCode = 1;
  });
