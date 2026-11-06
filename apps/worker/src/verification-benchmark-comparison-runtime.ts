import {
  parseVerificationBenchmarkComparisonRuntimeConfig,
  VerificationBenchmarkComparisonApplicationService,
  RegisteredBenchmarkComparisonPublicationBuilder,
} from "@aiengineer/knowledge-application";
import {
  PostgresVerificationRepository,
  PostgresVerificationBenchmarkReadRepository,
  PostgresVerificationBenchmarkComparisonStore,
  type PostgresCanonicalRepository,
} from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-core";
import { createEd25519Signer, createEd25519Verifier } from "@aiengineer/knowledge-verification";
import { verificationBenchmarkComparisonActivityHandler } from "./verification-benchmark-comparison-activity.js";

/** Registered offline comparisons have no parser or provider-dispatch dependency. */
export function createConfiguredVerificationBenchmarkComparisonHandler(input: {
  database: PostgresCanonicalRepository;
  tenantId: string;
  projectUrl: string;
  serviceRoleKey: string;
  maximumArtifactBytes: number;
  environment: Readonly<Record<string, string | undefined>>;
}) {
  const raw = input.environment.VERIFICATION_BENCHMARK_COMPARISON_CONFIG_JSON?.trim();
  if (!raw) return undefined;
  const config = parseVerificationBenchmarkComparisonRuntimeConfig(raw);
  if (config.tenantId !== input.tenantId) throw new Error("BENCHMARK_COMPARISON_RUNTIME_TENANT_MISMATCH");
  const privateKey = input.environment.VERIFICATION_BENCHMARK_COMPARISON_SIGNING_PRIVATE_KEY_PEM?.trim(),
    keyId = input.environment.VERIFICATION_BENCHMARK_COMPARISON_SIGNING_KEY_ID?.trim();
  if (!privateKey || !keyId) throw new Error("BENCHMARK_COMPARISON_SIGNING_KEY_REQUIRED");
  const signer = createEd25519Signer(privateKey, keyId),
    verifier = createEd25519Verifier(config.inputPublicKeys);
  const storageBucket = input.environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket",
    maximumArtifactBytes = Math.min(input.maximumArtifactBytes, 8 * 1024 * 1024);
  const artifacts = new SupabaseArtifactStore({
    projectUrl: input.projectUrl,
    serviceRoleKey: input.serviceRoleKey,
    bucket: storageBucket,
    maximumBytes: maximumArtifactBytes,
  });
  const repository = new PostgresVerificationRepository(input.database, artifacts, {
    async authorize(request) {
      if (
        request.tenantId !== config.tenantId ||
        !["verification_admission", "verification_replay"].includes(request.purpose)
      )
        throw new Error("BENCHMARK_COMPARISON_ARTIFACT_DENIED");
    },
  });
  const application = new VerificationBenchmarkComparisonApplicationService(
    {
      publications: new PostgresVerificationBenchmarkReadRepository(input.database, repository, { verifier }),
      createResolver: () => repository.createTrustedArtifactResolver(),
      catalog: config.catalog,
    },
    { maximumArtifactBytes },
  );
  const publicationBuilder = new RegisteredBenchmarkComparisonPublicationBuilder({
    signer,
    artifacts: {
      async register(value) {
        if (value.tenantId !== config.tenantId) throw new Error("BENCHMARK_COMPARISON_ARTIFACT_TENANT_MISMATCH");
        return repository.registerContentAddressedArtifact({
          ...value,
          mediaType: "application/json",
          producerActivityId: "verification-service:compareBenchmarkRuns",
          producerVersion: "verification-service.v1",
          encryptionClass: "supabase-managed",
          retentionClass: "verification-audit",
          dataClassification: "restricted",
          bucketClass: "ledger",
          storageBucket,
        });
      },
    },
  });
  return verificationBenchmarkComparisonActivityHandler({
    application,
    store: new PostgresVerificationBenchmarkComparisonStore(input.database),
    publicationBuilder,
    operations: input.database,
    runtime: {
      resolve(context) {
        if (context.tenantId !== config.tenantId) throw new Error("BENCHMARK_COMPARISON_RUNTIME_TENANT_MISMATCH");
        return { ...config.runtime, attemptId: context.attemptId };
      },
    },
  });
}
