import {
  BoundedManualUploadAdapter,
  ExactHttpAcquisitionAdapter,
  FilesystemManualUploadSource,
  RoutedAcquisitionAdapter,
} from "@aiengineer/knowledge-acquisition";
import { createKnowledgeApplication } from "@aiengineer/knowledge-application";
import { UuidSchema } from "@aiengineer/knowledge-contracts";
import { SupabaseArtifactStore, type ArtifactStore } from "@aiengineer/knowledge-core";
import {
  canonicalPersistenceConfigFromEnvironment,
  createCanonicalPersistence,
  type CanonicalPersistence,
  type CanonicalPersistenceConfig,
} from "@aiengineer/knowledge-persistence";
import {
  createDoclingServeClientFromEnvironment,
  DeterministicTextConversionProvider,
  DoclingServeProvider,
  HttpUnstructuredTransformClient,
  UnstructuredTransformProvider,
  type DocumentConversionProvider,
} from "@aiengineer/knowledge-preparation";
import { createGatewayEmbeddingAdapterFromEnvironment, type EmbeddingAdapter } from "@aiengineer/knowledge-retrieval";
import { constructWithResources, type HostResources } from "../lifecycle/resources.js";
import { positiveIntegerSetting, type HostEnvironment } from "./shared.js";

export type WorkerPersistenceMode = "postgres" | "memory";

export function parseWorkerPersistenceMode(environment: HostEnvironment): WorkerPersistenceMode {
  const mode = environment.KNOWLEDGE_PERSISTENCE_MODE?.trim() || "postgres";
  if (mode !== "postgres" && mode !== "memory") throw new Error("INVALID_KNOWLEDGE_PERSISTENCE_MODE");
  return mode;
}

/** Limits a local worker to one canonical operation. Unset preserves normal
 * tenant-wide reconciliation and polling; this is intentionally not a kind filter. */
export function parseWorkerOperationScope(environment: HostEnvironment): string | undefined {
  const raw = environment.WORKER_OPERATION_ID?.trim();
  if (!raw) return undefined;
  try {
    return UuidSchema.parse(raw);
  } catch {
    throw new Error("INVALID_WORKER_OPERATION_ID");
  }
}

/** Server adapters constructed and owned by host for canonical (Postgres) execution. */
export interface PostgresWorkerAdapters {
  readonly mode: "postgres";
  readonly environment: HostEnvironment;
  readonly owner: string;
  readonly leaseMs: number;
  readonly tenantId: string;
  readonly scopedOperationId: string | undefined;
  readonly persistence: Pick<CanonicalPersistence, "database">;
  readonly storage: Pick<CanonicalPersistenceConfig, "supabaseUrl" | "supabaseSecretKey">;
  readonly maximumArtifactBytes: number;
  readonly sourceArtifacts: SupabaseArtifactStore;
  readonly derivativeArtifacts: SupabaseArtifactStore;
  readonly acquisition: RoutedAcquisitionAdapter;
  readonly conversionProviders: readonly DocumentConversionProvider[];
  /** Resolves gateway credentials on each call, as the worker always has. */
  readonly embeddings: EmbeddingAdapter;
}

/** Development/test-only in-memory execution; never the offline file-backed profile. */
export interface MemoryWorkerAdapters {
  readonly mode: "memory";
  readonly environment: HostEnvironment;
  readonly owner: string;
  readonly leaseMs: number;
}

export type WorkerAdapters = PostgresWorkerAdapters | MemoryWorkerAdapters;

/** Activity dispatch composed by the worker app over host adapters. */
export interface WorkerExecution {
  readonly registeredActivities: readonly string[];
  reconcile(): Promise<number>;
  runOnce(): Promise<unknown>;
}

/**
 * Worker-owned execution seam. Phase one runs before any resource opens and may
 * only validate configuration; phase two receives host adapters. Activity
 * handlers, leases, receipts and retry algorithms remain in the worker until
 * their designated extraction.
 */
export type WorkerExecutionFactory = (context: {
  readonly environment: HostEnvironment;
  readonly mode: WorkerPersistenceMode;
}) => (adapters: WorkerAdapters) => WorkerExecution | Promise<WorkerExecution>;

export interface WorkerHostOptions {
  readonly profile: "server";
  readonly role: "worker";
  readonly environment: HostEnvironment;
  readonly execution: WorkerExecutionFactory;
}

export interface WorkerHost {
  readonly profile: "server";
  readonly role: "worker";
  readonly mode: WorkerPersistenceMode;
  readonly owner: string;
  readonly pollMs: number;
  /** Operations reconciled during construction, before any scheduling. */
  readonly reconciled: number;
  readonly registeredActivities: readonly string[];
  readonly status: Awaited<ReturnType<ReturnType<typeof createKnowledgeApplication>["getStatus"]>>;
  readonly operations: { runOnce(): Promise<unknown> };
  close(): Promise<void>;
}

function composePostgresAdapters(
  resources: HostResources,
  environment: HostEnvironment,
  base: { readonly owner: string; readonly leaseMs: number; readonly scopedOperationId: string | undefined },
): PostgresWorkerAdapters {
  const tenantId = environment.WORKER_TENANT_ID?.trim();
  if (!tenantId) throw new Error("WORKER_TENANT_ID_REQUIRED");
  const persistenceConfig = canonicalPersistenceConfigFromEnvironment(environment);
  const persistence = resources.own("canonical-persistence", createCanonicalPersistence(persistenceConfig), (owned) =>
    owned.close(),
  );
  const maximumArtifactBytes = positiveIntegerSetting(
    environment.MAXIMUM_ARTIFACT_BYTES,
    67_108_864,
    "MAXIMUM_ARTIFACT_BYTES",
  );
  const sourceArtifacts = new SupabaseArtifactStore({
    projectUrl: persistenceConfig.supabaseUrl,
    serviceRoleKey: persistenceConfig.supabaseSecretKey,
    bucket: "source-captures",
    maximumBytes: maximumArtifactBytes,
  });
  const derivativeArtifacts = new SupabaseArtifactStore({
    projectUrl: persistenceConfig.supabaseUrl,
    serviceRoleKey: persistenceConfig.supabaseSecretKey,
    bucket: "content-derivatives",
    maximumBytes: maximumArtifactBytes,
  });
  const preparationArtifacts: ArtifactStore = {
    put: (input) => derivativeArtifacts.put(input),
    get: (tenant, digest) => sourceArtifacts.get(tenant, digest),
  };
  const allowedHosts = environment.ACQUISITION_ALLOWED_HOSTS?.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const insecureHttp = environment.ALLOW_INSECURE_HTTP_ACQUISITION === "1";
  const httpAcquisition = new ExactHttpAcquisitionAdapter(sourceArtifacts, {
    allowedProtocols: ["https:", ...(insecureHttp ? ["http:" as const] : [])],
    allowedPorts: [443, ...(insecureHttp ? [80] : [])],
    maximumRedirects: positiveIntegerSetting(
      environment.ACQUISITION_MAXIMUM_REDIRECTS,
      5,
      "ACQUISITION_MAXIMUM_REDIRECTS",
    ),
    timeoutMs: positiveIntegerSetting(environment.ACQUISITION_TIMEOUT_MS, 30_000, "ACQUISITION_TIMEOUT_MS"),
    maximumBytes: maximumArtifactBytes,
    maximumDecompressionRatio: positiveIntegerSetting(
      environment.ACQUISITION_MAXIMUM_DECOMPRESSION_RATIO,
      20,
      "ACQUISITION_MAXIMUM_DECOMPRESSION_RATIO",
    ),
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  });
  const uploadRoot = environment.ACQUISITION_UPLOAD_ROOT?.trim();
  const acquisition = new RoutedAcquisitionAdapter([
    httpAcquisition,
    ...(uploadRoot
      ? [
          new BoundedManualUploadAdapter(sourceArtifacts, new FilesystemManualUploadSource(uploadRoot), {
            maximumBytes: maximumArtifactBytes,
            maximumPathLength: 240,
          }),
        ]
      : []),
  ]);
  const conversionProviders: DocumentConversionProvider[] = [
    new DeterministicTextConversionProvider(preparationArtifacts),
    new DoclingServeProvider(
      environment.DOCLING_VERSION?.trim() || "pinned-f8b324448e7c",
      createDoclingServeClientFromEnvironment(environment),
      preparationArtifacts,
    ),
  ];
  const unstructuredBaseUrl = environment.UNSTRUCTURED_BASE_URL?.trim() || environment.UNSTRUCTURED_API_URL?.trim();
  const unstructuredApiKey = environment.UNSTRUCTURED_API_KEY?.trim();
  const unstructuredTemplateId = environment.UNSTRUCTURED_TEMPLATE_ID?.trim();
  if (unstructuredBaseUrl && unstructuredApiKey && unstructuredTemplateId)
    conversionProviders.push(
      new UnstructuredTransformProvider(
        environment.UNSTRUCTURED_VERSION?.trim() || "configured-v1",
        new HttpUnstructuredTransformClient({
          baseUrl: unstructuredBaseUrl,
          apiKey: unstructuredApiKey,
          templateId: unstructuredTemplateId,
          maximumResultBytes: maximumArtifactBytes,
        }),
        preparationArtifacts,
      ),
    );
  const embeddings: EmbeddingAdapter = {
    discoverModel: (modelSlug) => createGatewayEmbeddingAdapterFromEnvironment(environment).discoverModel(modelSlug),
    embedOne: (request) => createGatewayEmbeddingAdapterFromEnvironment(environment).embedOne(request),
    embedMany: (request) => createGatewayEmbeddingAdapterFromEnvironment(environment).embedMany(request),
  };
  return {
    mode: "postgres",
    environment,
    ...base,
    tenantId,
    persistence: { database: persistence.database },
    storage: { supabaseUrl: persistenceConfig.supabaseUrl, supabaseSecretKey: persistenceConfig.supabaseSecretKey },
    maximumArtifactBytes,
    sourceArtifacts,
    derivativeArtifacts,
    acquisition,
    conversionProviders,
    embeddings,
  };
}

/**
 * Server worker composition. Validates the development-only memory gate, builds
 * adapters under host ownership and reconciles before the caller schedules work.
 * Any construction or reconciliation failure releases acquired resources.
 */
export async function createWorkerHost(options: WorkerHostOptions): Promise<WorkerHost> {
  const { environment } = options;
  const mode = parseWorkerPersistenceMode(environment);
  if (mode === "memory" && environment.NODE_ENV !== "development" && environment.NODE_ENV !== "test")
    throw new Error("IN_MEMORY_PERSISTENCE_NOT_ADMITTED");
  const scopedOperationId = parseWorkerOperationScope(environment);
  if (scopedOperationId && mode !== "postgres") throw new Error("WORKER_OPERATION_SCOPE_REQUIRES_POSTGRES");
  const buildExecution = options.execution({ environment, mode });
  const owner = environment.WORKER_ID?.trim() || `worker-${process.pid}`;
  const pollMs = positiveIntegerSetting(environment.WORKER_POLL_MS, 1_000, "WORKER_POLL_MS");
  const leaseMs = positiveIntegerSetting(environment.WORKER_LEASE_MS, 30_000, "WORKER_LEASE_MS");
  const application = createKnowledgeApplication();
  const { value, resources } = await constructWithResources(async (resources) => {
    const adapters: WorkerAdapters =
      mode === "postgres"
        ? composePostgresAdapters(resources, environment, { owner, leaseMs, scopedOperationId })
        : { mode, environment, owner, leaseMs };
    const execution = await buildExecution(adapters);
    const reconciled = await execution.reconcile();
    return { execution, reconciled, status: await application.getStatus() };
  });
  return {
    profile: "server",
    role: "worker",
    mode,
    owner,
    pollMs,
    reconciled: value.reconciled,
    registeredActivities: value.execution.registeredActivities,
    status: value.status,
    operations: { runOnce: () => value.execution.runOnce() },
    close: () => resources.close(),
  };
}
