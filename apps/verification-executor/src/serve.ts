import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadExecutorConfig, VerificationExecutor } from "./executor.js";
import { createHttpServer } from "./http.js";
import type { ScopedExecutorAccess } from "./access.js";
import { createCaptureCustodyReader } from "./knowledge-operation/capture-bridge.js";
import {
  createKnowledgeServices,
  loadKnowledgeConfig,
  type KnowledgeServices,
  type KnowledgeServicesOptions,
} from "./knowledge/context.js";
import {
  BACKEND as AIENGINEER_POSTGRES_BACKEND,
  createIngestionApplyPort,
  createReadIntentPort,
} from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { BACKEND as BIOTECH_GRAPH_BACKEND } from "@aiengineer/knowledge-binding-biotech-graph";
import type { AuditorDiscovery } from "@aiengineer/knowledge-host/knowledge-operation";
import {
  BackendRegistry,
  IN_MEMORY_BACKEND,
  type KnowledgeOperationSurface,
  createKnowledgeOperationSurfaceFromEnv,
} from "@aiengineer/knowledge-host/knowledge-operation";

/**
 * The knowledge backends this executable serves (Sprint OC R5): composition belongs to the executable, so the binding
 * packages are imported here and nowhere else in production code; `KS_KNOWLEDGE_BINDINGS_JSON` names registry ids.
 */
export const KNOWLEDGE_BACKENDS = new BackendRegistry([
  AIENGINEER_POSTGRES_BACKEND,
  BIOTECH_GRAPH_BACKEND,
  IN_MEMORY_BACKEND,
]);

export interface ServeOptions {
  readonly port: number;
  readonly host: string;
  readonly token?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly scopedAccess?: ScopedExecutorAccess;
  /** Trusted host injection; never resolved from a request or environment value. */
  readonly prepareCapturedSource?: KnowledgeServicesOptions["prepareCapturedSource"];
  /** Trusted host injection: the independent census auditor for `report.assess` over K01 (SV-16). */
  readonly knowledgeOperationAuditor?: AuditorDiscovery;
}

export interface RunningExecutor {
  readonly server: Server;
  readonly executor: VerificationExecutor;
  readonly knowledge: KnowledgeServices | undefined;
  /** `ks.knowledge_operation.v2` (configured by KS_KNOWLEDGE_* variables), or undefined. */
  readonly knowledgeOperation: KnowledgeOperationSurface | undefined;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * One process: capture/artifact tools always; knowledge (schema/db/ingest/checkpoints/source discovery) when a
 * database URL and workspace are configured; ks.knowledge_operation.v2 when KS_KNOWLEDGE_* is configured.
 */
export async function startExecutorServer(options: ServeOptions): Promise<RunningExecutor> {
  const env = options.env ?? process.env;
  const executor = await VerificationExecutor.create(loadExecutorConfig(env));
  const knowledgeConfig = loadKnowledgeConfig(env);
  const knowledge = knowledgeConfig
    ? createKnowledgeServices(knowledgeConfig, {
        verification: executor,
        ...(options.prepareCapturedSource ? { prepareCapturedSource: options.prepareCapturedSource } : {}),
      })
    : undefined;
  let server: Server;
  let knowledgeOperation: KnowledgeOperationSurface | undefined;
  try {
    knowledgeOperation = await createKnowledgeOperationSurfaceFromEnv(env, {
      registry: KNOWLEDGE_BACKENDS,
      externalCustody: createCaptureCustodyReader(executor.store),
      ...(options.knowledgeOperationAuditor ? { auditor: options.knowledgeOperationAuditor } : {}),
      ...(knowledge
        ? {
            apply: createIngestionApplyPort(knowledge.ingestion, knowledge.useClasses),
            // OVE-204: `knowledge.read_intent` over the AIDB ReadExecutor + workspace, for the executor's tenant only.
            readIntent: createReadIntentPort(knowledge.reads, knowledge.workspace, knowledge.config.defaultTenantId),
          }
        : {}),
    });
    server = createHttpServer(executor, {
      ...(options.token ? { token: options.token } : {}),
      ...(knowledge ? { knowledge } : {}),
      ...(options.scopedAccess ? { scopedAccess: options.scopedAccess } : {}),
      ...(knowledgeOperation ? { knowledgeOperation: knowledgeOperation.service } : {}),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await knowledgeOperation?.close().catch(() => undefined);
    await knowledge?.close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  const url = `http://${host}:${address.port}`;
  return {
    server,
    executor,
    knowledge,
    knowledgeOperation,
    url,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await knowledgeOperation?.close();
      await knowledge?.close();
    },
  };
}

export function describeRunning(running: RunningExecutor, auth: "bearer" | "none"): Record<string, unknown> {
  return {
    listening: running.url,
    mcp: `${running.url}/mcp`,
    store: running.executor.store.rootDir,
    tenantId: running.executor.store.tenantId,
    auth,
    knowledgeOperation: running.knowledgeOperation
      ? {
          routes: `${running.url}/knowledge-operation/v2`,
          auth: "K07 issuer credential (KS_KNOWLEDGE_ISSUER / KS_KNOWLEDGE_AUDIENCE / KS_KNOWLEDGE_JWKS_*)",
          bindings: running.knowledgeOperation.backends.map((backend) => ({
            application: backend.application,
            binding: backend.binding,
            served: backend.unsupportedReason === null,
            capabilities: [...backend.capabilities].sort(),
          })),
        }
      : "disabled (set KS_KNOWLEDGE_ISSUER, KS_KNOWLEDGE_AUDIENCE, KS_KNOWLEDGE_JWKS_FILE|URL, KS_KNOWLEDGE_BINDINGS_JSON)",
    knowledge: running.knowledge
      ? {
          workspaceDir: running.knowledge.workspace.dir,
          workspaceHead: running.knowledge.workspace.migrationHead,
          defaultTenantId: running.knowledge.config.defaultTenantId,
          artifactDir: running.knowledge.config.artifactDir,
          storage: running.knowledge.config.storage ? "supabase" : "local",
          evidenceOracle: "component-exact-use",
          useClasses: running.knowledge.useClasses.registry,
          allowStale: running.knowledge.config.allowStale,
        }
      : "disabled (set KS_AIENG_DB_RUNTIME_DSN and SCHEMA_WORKSPACE_DIR)",
  };
}

export async function createKnowledgeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  verification?: VerificationExecutor,
): Promise<KnowledgeServices | undefined> {
  const config = loadKnowledgeConfig(env);
  if (!config) return undefined;
  const executor = verification ?? (await VerificationExecutor.create(loadExecutorConfig(env)));
  return createKnowledgeServices(config, { verification: executor });
}
