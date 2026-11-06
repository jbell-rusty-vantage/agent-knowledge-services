import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactLedger, ReadExecutor } from "@aiengineer/knowledge-db";
import { IngestionExecutor, exactUseEvidenceOracle, type UseClassPolicy } from "@aiengineer/knowledge-db";
import {
  PostgresCanonicalRepository,
  PostgresCheckpointStore,
  PostgresGovernedIndexRepository,
  PostgresSourceDiscoveryStore,
  TenantPostgres,
} from "@aiengineer/knowledge-persistence";
import {
  CheckpointApplicationService,
  SourceDiscoveryApplicationService,
  loadUseClassesFile,
  type SourceDiscoveryHost,
  useClassPolicy,
} from "@aiengineer/knowledge-application";
import { LocalArtifactStore, SupabaseArtifactStore, type ArtifactStore } from "@aiengineer/knowledge-core";
import { loadWorkspace, resolveWorkspaceDir, type Workspace } from "@aiengineer/knowledge-db";
import { loadExecutorConfig, type VerificationExecutor } from "../executor.js";
import { createExecutorCustody } from "../store-custody-postgres.js";
import { createSourceDiscoveryHost, type DiscoveryHostConfig } from "./source-discovery-host.js";
import { createSourceDiscoveryCustody } from "./source-discovery-custody.js";
import { EXECUTOR_STORAGE_PROFILE } from "../store-custody-profile.js";
import { CHECKPOINT_POLICY } from "./checkpoints-policy.js";
import { createCheckpointCustody } from "./checkpoints-custody.js";
import { createCheckpointReconciler } from "./checkpoints-reconciler.js";
import { KnowledgeCheckpointHarness } from "./checkpoints-harness.js";
import { createCheckpointOwnerReconciler } from "./checkpoints-owners.js";

export const KNOWLEDGE_EXECUTOR_VERSION = "knowledge-executor/0.1.0";
const LEDGER_BUCKET = "research-ingestion-intents";
const DEFAULT_ARTIFACT_DIR = ".knowledge-artifacts";
const FALLBACK_WORKSPACE = "../../../../aiengineer/ai-engineer-db-contract/workspace";

/**
 * SV-17 retired the executor-hosted evidence oracle (sealed file-store runs), the legacy report package service and
 * report assessment, the content-link authority over legacy claim evidence and the durable recovery host; their
 * AIDB tables were withdrawn by contract 0.5.0. Ingestion admits claims only through the verification component's
 * exact-use decision (`exactUseEvidenceOracle`); official and consequential uses must carry `exactUse` (K08 F9).
 */
export interface KnowledgeConfig {
  readonly databaseUrl: string;
  readonly workspaceDir: string;
  readonly artifactDir: string;
  readonly defaultTenantId: string;
  readonly allowStale: boolean;
  /** The K08 use-class registry file (`catalog/research/use-classes.json`). */
  readonly useClassesFile: string;
  readonly storage: { readonly projectUrl: string; readonly secretKey: string } | undefined;
  readonly producerAttemptId?: string;
  readonly missionId?: string;
  readonly discoveryProviders?: DiscoveryHostConfig;
}

export interface KnowledgeServices {
  readonly config: KnowledgeConfig;
  readonly db: TenantPostgres;
  readonly workspace: Workspace;
  readonly artifacts: ArtifactLedger;
  readonly reads: ReadExecutor;
  readonly ingestion: IngestionExecutor;
  readonly useClasses: UseClassPolicy;
  readonly sourceDiscovery?: SourceDiscoveryApplicationService;
  readonly checkpoints?: CheckpointApplicationService;
  readonly checkpointHarness?: KnowledgeCheckpointHarness;
  readonly prepareCapturedSource?: (input: unknown) => Promise<unknown>;
  close(): Promise<void>;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The repository K08 use-class registry, found from this module (or the working directory) upward. */
export function defaultUseClassesFile(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(directory, "catalog", "research", "use-classes.json");
    if (existsSync(candidate)) return candidate;
    directory = dirname(directory);
  }
  return resolve(process.cwd(), "catalog", "research", "use-classes.json");
}

/** `undefined` when no database URL is configured: the executor then serves capture and artifact tools only. */
export function loadKnowledgeConfig(env: Env = process.env): KnowledgeConfig | undefined {
  const executor = loadExecutorConfig(env);
  const databaseUrl = env.KNOWLEDGE_DB_URL?.trim() || env.POSTGRES_URL?.trim();
  if (!databaseUrl) {
    if (env.KNOWLEDGE_ARTIFACT_STORAGE === "supabase")
      throw new Error("REMOTE_ARTIFACT_DATABASE_CONFIGURATION_REQUIRED");
    return undefined;
  }
  const secretKey = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const projectUrl = env.SUPABASE_URL?.trim();
  if (env.KNOWLEDGE_ARTIFACT_STORAGE === "supabase" && (!projectUrl || !secretKey))
    throw new Error("REMOTE_ARTIFACT_STORAGE_CONFIGURATION_REQUIRED");
  return {
    databaseUrl,
    workspaceDir: resolveWorkspaceDir({ env, fallbackDir: FALLBACK_WORKSPACE }),
    artifactDir: env.KNOWLEDGE_ARTIFACT_DIR?.trim() || DEFAULT_ARTIFACT_DIR,
    defaultTenantId: env.KNOWLEDGE_TENANT_ID?.trim() || env.VERIFY_TENANT_ID?.trim() || executor.tenantId,
    allowStale: env.KNOWLEDGE_ALLOW_STALE === "1",
    useClassesFile: env.KNOWLEDGE_USE_CLASSES_FILE?.trim() || defaultUseClassesFile(),
    storage:
      env.KNOWLEDGE_ARTIFACT_STORAGE === "supabase" && projectUrl && secretKey ? { projectUrl, secretKey } : undefined,
    ...(env.KNOWLEDGE_PRODUCER_ATTEMPT_ID?.trim()
      ? { producerAttemptId: env.KNOWLEDGE_PRODUCER_ATTEMPT_ID.trim() }
      : {}),
    ...(env.KNOWLEDGE_MISSION_ID?.trim() ? { missionId: env.KNOWLEDGE_MISSION_ID.trim() } : {}),
    discoveryProviders: {
      ...(env.TAVILY_API_KEY?.trim() ? { tavilyApiKey: env.TAVILY_API_KEY.trim() } : {}),
      ...(env.FIRECRAWL_API_KEY?.trim() ? { firecrawlApiKey: env.FIRECRAWL_API_KEY.trim() } : {}),
    },
  };
}

function artifactStore(config: KnowledgeConfig): { store: ArtifactStore; uploaded: boolean } {
  if (config.storage)
    return {
      store: new SupabaseArtifactStore({
        projectUrl: config.storage.projectUrl,
        serviceRoleKey: config.storage.secretKey,
        bucket: LEDGER_BUCKET,
        maximumBytes: 64_000_000,
      }),
      uploaded: true,
    };
  return { store: new LocalArtifactStore(config.artifactDir), uploaded: false };
}

export interface KnowledgeServicesOptions {
  /** The co-hosted capture and artifact store; omission rejects before database initialization. */
  readonly verification?: VerificationExecutor;
  readonly sourceDiscoveryHost?: SourceDiscoveryHost;
  readonly prepareCapturedSource?: (input: unknown) => Promise<unknown>;
}

export function createKnowledgeServices(
  config: KnowledgeConfig,
  options: KnowledgeServicesOptions = {},
): KnowledgeServices {
  if (!options.verification) throw new Error("KNOWLEDGE_CAPTURE_STORE_REQUIRED");
  // The co-hosted capture store and the knowledge services serve one tenant.
  if (options.verification.store.tenantId !== config.defaultTenantId) throw new Error("KNOWLEDGE_TENANT_MISMATCH");
  const useClasses = useClassPolicy(loadUseClassesFile(config.useClassesFile));
  const db = new TenantPostgres({
    connectionString: config.databaseUrl,
    applicationName: "ai-engineer-knowledge-executor",
  });
  const workspace = loadWorkspace(config.workspaceDir);
  const { store, uploaded } = artifactStore(config);
  const artifacts = new ArtifactLedger({
    db,
    store,
    bucket: LEDGER_BUCKET,
    uploaded,
    executorVersion: KNOWLEDGE_EXECUTOR_VERSION,
  });
  const reads = new ReadExecutor({
    db,
    workspace,
    artifacts,
    executorVersion: KNOWLEDGE_EXECUTOR_VERSION,
    allowStale: config.allowStale,
  });
  const ingestion = new IngestionExecutor({
    db,
    workspace,
    artifacts,
    executorVersion: KNOWLEDGE_EXECUTOR_VERSION,
    allowStale: config.allowStale,
    evidence: exactUseEvidenceOracle,
    useClasses,
  });
  const custody = config.storage
    ? createExecutorCustody({
        databaseUrl: config.databaseUrl,
        tenantId: config.defaultTenantId,
        ...config.storage,
        ...(config.producerAttemptId ? { producerAttemptId: config.producerAttemptId } : {}),
        ...(config.missionId ? { missionId: config.missionId } : {}),
      })
    : undefined;
  if (custody) options.verification.store.attachCustody(custody);
  const discoveryDatabase = custody
    ? new PostgresCanonicalRepository({ connectionString: config.databaseUrl })
    : undefined;
  const sourceDiscovery =
    discoveryDatabase && custody
      ? new SourceDiscoveryApplicationService(
          new PostgresSourceDiscoveryStore(discoveryDatabase),
          createSourceDiscoveryCustody(
            options.verification.store,
            custody,
            new SupabaseArtifactStore({
              projectUrl: config.storage!.projectUrl,
              serviceRoleKey: config.storage!.secretKey,
              bucket: EXECUTOR_STORAGE_PROFILE.intermediate.bucket,
              maximumBytes: EXECUTOR_STORAGE_PROFILE.maximumArtifactBytes,
            }),
          ),
          options.sourceDiscoveryHost ?? createSourceDiscoveryHost(config.discoveryProviders ?? {}),
        )
      : undefined;
  const checkpoints =
    discoveryDatabase && custody
      ? new CheckpointApplicationService(
          new PostgresCheckpointStore(discoveryDatabase),
          createCheckpointCustody(options.verification.store, custody),
          createCheckpointReconciler(
            discoveryDatabase,
            custody,
            createCheckpointOwnerReconciler({
              database: discoveryDatabase,
              store: options.verification.store,
              artifacts,
              custody,
              publications: new PostgresGovernedIndexRepository(discoveryDatabase),
              sourceDiscovery: sourceDiscovery!,
              ingestion,
            }),
          ),
          CHECKPOINT_POLICY,
        )
      : undefined;
  const checkpointHarness =
    checkpoints && custody
      ? new KnowledgeCheckpointHarness({
          tenantId: config.defaultTenantId,
          service: checkpoints,
          store: options.verification.store,
          custody,
          sourceDiscovery: sourceDiscovery!,
        })
      : undefined;
  return {
    config,
    db,
    workspace,
    artifacts,
    reads,
    ingestion,
    useClasses,
    ...(sourceDiscovery ? { sourceDiscovery } : {}),
    ...(checkpoints ? { checkpoints } : {}),
    ...(checkpointHarness ? { checkpointHarness } : {}),
    ...(options.prepareCapturedSource ? { prepareCapturedSource: options.prepareCapturedSource } : {}),
    close: async () => {
      await discoveryDatabase?.close();
      await custody?.close();
      await db.close();
    },
  };
}
