import {
  TrustedVerificationSourceAcquirer,
  VerificationSourceAcquisitionCatalog,
} from "@aiengineer/knowledge-application";
import { lookup as resolveAcquisitionHost } from "node:dns/promises";
import { pathToFileURL } from "node:url";
import {
  createHost,
  parseWorkerPersistenceMode,
  startPollingLoop,
  type WorkerExecutionFactory,
} from "@aiengineer/knowledge-host";
import {
  createIntegrationService,
  VerificationAdmissionService,
  ParseArtifactApplicationService,
  VerificationServiceCatalog,
} from "@aiengineer/knowledge-application";
import { SandboxedVerificationParser, VERIFICATION_PARSER_LIMITS } from "@aiengineer/knowledge-preparation";
import {
  PostgresGovernedIndexRepository,
  type PromotionSelectionConfiguration,
  PostgresPreparationRepository,
  PostgresVectorStoreLifecycleRepository,
  PostgresVerificationRepository,
} from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-core";
import { createCanonicalActivityExecutor, createProductionActivityRegistry } from "./activity-registry.js";
import { parsePromotionSelectionAuthorityLocator, resolvePromotionSelectionHost } from "./promotion-selection.js";
import { CanonicalDurableKnowledgeWorker } from "./canonical-worker.js";
import { DurableKnowledgeWorker } from "./worker.js";
import { createVerificationOperationExecutor, verificationActivityHandlers } from "./verification-activities.js";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import { createConfiguredVerificationBenchmarkHandler } from "./verification-benchmark-runtime.js";
import { createConfiguredVerificationBenchmarkComparisonHandler } from "./verification-benchmark-comparison-runtime.js";
import { createConfiguredVerificationStructuredExtractionHandler } from "./verification-structured-extraction-runtime.js";
import { verificationParseArtifactActivityHandler } from "./verification-parse-activity.js";

export { CanonicalDurableKnowledgeWorker } from "./canonical-worker.js";
export { DurableKnowledgeWorker } from "./worker.js";
export * from "./activity-registry.js";
export {
  composePromotionSelectionWorkerHost,
  createCanonicalPromotionSelectionApplication,
  createPromotionSelectionConfiguration,
  parsePromotionSelectionAuthorityLocator,
  PromotionSelectionAuthorityLocatorSchema,
  resolvePromotionSelectionHost,
} from "./promotion-selection.js";
export type {
  CanonicalPromotionSelectionConfiguration,
  ComposedPromotionSelectionHost,
} from "./promotion-selection.js";
export * from "./verification-activities.js";

export interface RunningWorker {
  readonly mode: "postgres" | "memory";
  stop(signal?: string): Promise<void>;
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * SV-17 retired the worker's verification.v1 claims, report and metric sealers, the sealed audit replay, audit
 * inspection, adjudication and the claims semantic/source-authority stages (their AIDB run truth was withdrawn).
 * Their configuration is refused at startup, never ignored.
 */
const RETIRED_VERIFICATION_CONFIGURATION = [
  "VERIFICATION_METRIC_PROFILE_GRANTS_JSON",
  "VERIFICATION_CLAIMS_ENABLED",
  "VERIFICATION_CLAIMS_PROJECTION_GRANTS_JSON",
  "VERIFICATION_SEAL_POLICY_GRANTS_JSON",
  "VERIFICATION_SOURCE_AUTHORITY_PINS_JSON",
  "VERIFICATION_SEMANTIC_PROFILE_GRANTS_JSON",
  "VERIFICATION_SEMANTIC_RUNTIME_JSON",
  "VERIFICATION_AUDIT_INSPECTION_ENABLED",
  "VERIFICATION_AUDIT_INSPECTION_GRANTS_JSON",
  "VERIFICATION_AUDIT_INSPECTION_PUBLIC_KEYS_JSON",
  "VERIFICATION_ADJUDICATION_GRANTS_JSON",
  "VERIFICATION_ADJUDICATION_REVIEW_REQUIREMENTS_JSON",
  "VERIFICATION_ADJUDICATION_PUBLIC_KEYS_JSON",
  "VERIFICATION_ADJUDICATION_DECISIONS_ENABLED",
  "VERIFICATION_ADJUDICATION_SYNTHETIC_REVIEWER_GRANTS_JSON",
  "VERIFICATION_AUDIT_SIGNING_KEY_ID",
  "VERIFICATION_AUDIT_SIGNING_PRIVATE_KEY_PEM",
] as const;

export function assertNoRetiredWorkerVerificationConfiguration(environment: Environment): void {
  for (const name of RETIRED_VERIFICATION_CONFIGURATION) {
    const value = environment[name]?.trim();
    if (value && value !== "0") throw new Error(`VERIFICATION_RETIRED_CONFIGURATION:${name}`);
  }
}

export { parseWorkerOperationScope } from "@aiengineer/knowledge-host";

export async function reconcileWorkerScope(
  worker: {
    reconcile(): Promise<number>;
    reconcileOperation(operationId: string): Promise<unknown>;
  },
  operationId?: string,
): Promise<number> {
  if (!operationId) return worker.reconcile();
  return (await worker.reconcileOperation(operationId)) === undefined ? 0 : 1;
}

export function runWorkerScope(
  worker: {
    runOnce(): Promise<unknown>;
    runOperationOnce(operationId: string): Promise<unknown>;
  },
  operationId?: string,
): () => Promise<unknown> {
  return operationId ? () => worker.runOperationOnce(operationId) : () => worker.runOnce();
}

/**
 * Composition-root dependencies the worker process cannot build itself. The
 * canonical promotion-selection ports live in the knowledge executor host,
 * which owns ContentLink reconciliation and remote evidence; the worker only
 * accepts an already-composed authority. Process `main()` cannot build that
 * host: a locator without `promotionSelection` fails closed.
 */
export interface WorkerHostDependencies {
  readonly promotionSelection?: PromotionSelectionConfiguration;
}

export async function startWorker(
  environment: Environment = process.env,
  host: WorkerHostDependencies = {},
): Promise<RunningWorker> {
  const mode = parseWorkerPersistenceMode(environment);
  const selectionLocator = parsePromotionSelectionAuthorityLocator(environment);
  const promotionSelection = resolvePromotionSelectionHost({
    host,
    ...(selectionLocator ? { locator: selectionLocator } : {}),
    persistenceMode: mode,
  });
  const composed = await createHost({
    profile: "server",
    role: "worker",
    environment,
    execution: createWorkerExecution(promotionSelection),
  });
  const { owner, reconciled, registeredActivities, status } = composed;
  process.stdout.write(
    `${JSON.stringify({ event: "knowledge.worker.started", mode, owner, reconciled, registeredActivities, ...status })}
`,
  );
  // Host reconciled before this first schedule; stop drains the active run before release.
  const loop = startPollingLoop({
    pollMs: composed.pollMs,
    runOnce: composed.operations.runOnce,
    onError: (error) =>
      process.stderr.write(
        `${JSON.stringify({ event: "knowledge.worker.activity_failed", error: error instanceof Error ? error.message : "unknown" })}
`,
      ),
  });
  let stopping: Promise<void> | undefined;
  return {
    mode,
    stop(signal = "requested") {
      stopping ??= (async () => {
        try {
          await loop.stop();
        } finally {
          await composed.close();
        }
        process.stdout.write(
          `${JSON.stringify({ event: "knowledge.worker.stopped", mode, signal })}
`,
        );
      })();
      return stopping;
    },
  };
}

/**
 * Worker-owned activity composition over host adapters. Validation that must
 * precede resource construction runs in the outer phase; handlers, leases and
 * retry algorithms stay in this app until their designated extraction.
 */
function createWorkerExecution(
  promotionSelection: ReturnType<typeof resolvePromotionSelectionHost>,
): WorkerExecutionFactory {
  return ({ environment }) => {
    assertNoRetiredWorkerVerificationConfiguration(environment);
    return (adapters) => {
      if (adapters.mode === "memory") {
        const worker = new DurableKnowledgeWorker(
          adapters.owner,
          createIntegrationService(),
          undefined,
          adapters.leaseMs,
        );
        return { registeredActivities: [], reconcile: async () => 0, runOnce: () => worker.runOnce() };
      }
      const {
        tenantId,
        owner,
        leaseMs,
        scopedOperationId,
        persistence,
        storage: persistenceConfig,
        maximumArtifactBytes,
        sourceArtifacts,
        derivativeArtifacts,
        acquisition,
        conversionProviders,
        embeddings,
      } = adapters;
      const verificationCatalogJson = environment.VERIFICATION_SERVICE_CATALOG_JSON?.trim();
      const parseArtifactEnabled = environment.VERIFICATION_PARSE_ARTIFACT_ENABLED?.trim() === "1";
      if (parseArtifactEnabled && !verificationCatalogJson)
        throw new Error("VERIFICATION_PARSE_ARTIFACT_CATALOG_REQUIRED");
      let verificationHandlers: ReturnType<typeof verificationActivityHandlers> | undefined;
      if (verificationCatalogJson) {
        const imageDigest = environment.VERIFICATION_PARSER_IMAGE_DIGEST?.trim();
        if (!imageDigest || !/^sha256:[a-f0-9]{64}$/u.test(imageDigest))
          throw new Error("VERIFICATION_PARSER_IMAGE_DIGEST_REQUIRED");
        let catalogInput: unknown;
        try {
          catalogInput = verificationCatalogJson ? JSON.parse(verificationCatalogJson) : undefined;
        } catch {
          throw new Error("VERIFICATION_SERVICE_CATALOG_INVALID");
        }
        const verificationArtifacts = new SupabaseArtifactStore({
          projectUrl: persistenceConfig.supabaseUrl,
          serviceRoleKey: persistenceConfig.supabaseSecretKey,
          bucket: environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket",
          maximumBytes: maximumArtifactBytes,
        });
        const repository = new PostgresVerificationRepository(persistence.database, verificationArtifacts, {
          async authorize(input) {
            if (input.tenantId !== tenantId) throw new Error("VERIFICATION_WORKER_TENANT_DENIED");
          },
        });
        const parser = new SandboxedVerificationParser(
          imageDigest as `sha256:${string}`,
          environment.VERIFICATION_PARSER_COMMAND?.trim() || "docker",
        );
        const admission = new VerificationAdmissionService(
          repository,
          parser,
          {
            parserVersion: "verification-native-parser.v1",
            imageDigest: imageDigest as `sha256:${string}`,
            limits: VERIFICATION_PARSER_LIMITS,
          },
          {
            storageBucket: environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket",
            producerVersion: "verification-admission.v1",
            encryptionClass: "supabase-managed",
            retentionClass: "verification-audit",
            now: () => new Date().toISOString(),
          },
        );
        verificationHandlers = [];
        let verificationCatalog: VerificationServiceCatalog | undefined;
        if (verificationCatalogJson) {
          verificationCatalog = new VerificationServiceCatalog(
            catalogInput as ConstructorParameters<typeof VerificationServiceCatalog>[0],
          );
          const acquireEnabled = environment.VERIFICATION_CAPTURE_ACQUIRE_ENABLED?.trim();
          if (acquireEnabled && !["0", "1"].includes(acquireEnabled))
            throw new Error("INVALID_VERIFICATION_CAPTURE_ACQUIRE_ENABLED");
          let sourceAcquirer: TrustedVerificationSourceAcquirer | undefined;
          if (acquireEnabled === "1") {
            if (!verificationCatalog.hasAcquisitionGrants())
              throw new Error("VERIFICATION_ACQUISITION_RUNTIME_GRANTS_REQUIRED");
            const raw = environment.VERIFICATION_SOURCE_ACQUISITION_GRANTS_JSON?.trim();
            if (!raw || raw.length > 262_144) throw new Error("VERIFICATION_ACQUISITION_TRANSPORT_GRANTS_REQUIRED");
            let value: unknown;
            try {
              value = JSON.parse(raw);
            } catch {
              throw new Error("VERIFICATION_ACQUISITION_TRANSPORT_GRANTS_INVALID");
            }
            if (!Array.isArray(value)) throw new Error("VERIFICATION_ACQUISITION_TRANSPORT_GRANTS_INVALID");
            sourceAcquirer = new TrustedVerificationSourceAcquirer(
              new VerificationSourceAcquisitionCatalog(value),
              {
                resolve: async (hostname) =>
                  (
                    await resolveAcquisitionHost(hostname, {
                      all: true,
                      verbatim: true,
                    })
                  ).map((item) => item.address),
              },
              () => new Date().toISOString(),
            );
          }
          const executor = createVerificationOperationExecutor({
            operations: persistence.database,
            repository,
            admission,
            catalog: verificationCatalog,
            ...(sourceAcquirer ? { sourceAcquirer } : {}),
            config: {
              storageBucket: environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket",
              producerVersion: "verification-service.v1",
              encryptionClass: "supabase-managed",
              retentionClass: "verification-audit",
              now: () => new Date().toISOString(),
            },
          });
          verificationHandlers = verificationActivityHandlers(executor);
        }
        if (parseArtifactEnabled) {
          const catalog = verificationCatalog!;
          if (!catalog.hasParseArtifactGrants()) throw new Error("VERIFICATION_PARSE_ARTIFACT_RUNTIME_GRANTS_REQUIRED");
          const parseService = new ParseArtifactApplicationService(repository, admission, {
            storageBucket: environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket",
            producerVersion: "verification-service.v1",
            encryptionClass: "supabase-managed",
            retentionClass: "verification-audit",
            now: () => new Date().toISOString(),
          });
          verificationHandlers = [
            ...verificationHandlers,
            verificationParseArtifactActivityHandler({
              service: parseService,
              async resolveKind(input) {
                const binding = await repository.getRegisteredCapture({
                  tenantId: input.tenantId,
                  captureId: input.captureId,
                });
                if (digestCanonicalJson(binding.capture.contentArtifact) !== digestCanonicalJson(input.sourceArtifact))
                  throw new Error("PARSE_ARTIFACT_SOURCE_BINDING_INVALID");
                return catalog.parseArtifact(input.captureId, input.sourceArtifact).parserKind;
              },
              async assertActive(input) {
                const operation = await persistence.database.getOperationRecord(input.tenantId, input.operationId);
                if (!operation || operation.status !== "running")
                  throw new Error(
                    operation?.status === "cancelled"
                      ? "PARSE_ARTIFACT_CANCELLED"
                      : "PARSE_ARTIFACT_OPERATION_NOT_ACTIVE",
                  );
              },
            }),
          ];
        }
      }
      const benchmarkHandler = createConfiguredVerificationBenchmarkHandler({
        database: persistence.database,
        tenantId,
        projectUrl: persistenceConfig.supabaseUrl,
        serviceRoleKey: persistenceConfig.supabaseSecretKey,
        maximumArtifactBytes,
        environment,
      });
      if (benchmarkHandler) verificationHandlers = [...(verificationHandlers ?? []), benchmarkHandler];
      const comparisonHandler = createConfiguredVerificationBenchmarkComparisonHandler({
        database: persistence.database,
        tenantId,
        projectUrl: persistenceConfig.supabaseUrl,
        serviceRoleKey: persistenceConfig.supabaseSecretKey,
        maximumArtifactBytes,
        environment,
      });
      if (comparisonHandler) verificationHandlers = [...(verificationHandlers ?? []), comparisonHandler];
      const extractionHandler = createConfiguredVerificationStructuredExtractionHandler({
        database: persistence.database,
        tenantId,
        projectUrl: persistenceConfig.supabaseUrl,
        serviceRoleKey: persistenceConfig.supabaseSecretKey,
        maximumArtifactBytes,
        environment,
      });
      if (extractionHandler) verificationHandlers = [...(verificationHandlers ?? []), extractionHandler];
      const registry = createProductionActivityRegistry({
        retrieval: persistence.database,
        review: persistence.database,
        vectorStore: new PostgresVectorStoreLifecycleRepository(persistence.database),
        durablePreparation: {
          repository: new PostgresPreparationRepository(persistence.database),
          sourceArtifacts,
          derivativeArtifacts,
          sourceStorageBucket: "source-captures",
          derivativeStorageBucket: "content-derivatives",
          acquisition,
          conversionProviders,
        },
        governedIndex: {
          repository: new PostgresGovernedIndexRepository(persistence.database, promotionSelection),
          embeddingAdapter: embeddings,
          embeddingAdapterVersion: "vercel-ai-gateway/v1",
        },
        ...(verificationHandlers ? { verificationHandlers } : {}),
      });
      const worker = new CanonicalDurableKnowledgeWorker(
        owner,
        tenantId,
        persistence.database,
        createCanonicalActivityExecutor(persistence.database, registry),
        leaseMs,
        registry.operationKinds(),
      );
      return {
        registeredActivities: registry.activities(),
        reconcile: () => reconcileWorkerScope(worker, scopedOperationId),
        runOnce: runWorkerScope(worker, scopedOperationId),
      };
    };
  };
}

/** Generic process entry. Selection authority is host-composed; this path cannot supply ports. */
async function main() {
  const running = await startWorker();
  const shutdown = (signal: string) => {
    void running.stop(signal).catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ event: "knowledge.worker.shutdown_failed", error: error instanceof Error ? error.message : "unknown" })}\n`,
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ event: "knowledge.worker.start_failed", error: error instanceof Error ? error.message : "unknown" })}\n`,
    );
    process.exitCode = 1;
  });
}
