import {
  parseVerificationBenchmarkRuntimeConfig,
  RegisteredBenchmarkInputAdmission,
  RegisteredBenchmarkProfileAdmission,
  RegisteredBenchmarkReplayAdmission,
  RegisteredBenchmarkSourceImportAdmission,
  RegisteredDiagnosticsOfflineBenchmark,
  RegisteredBenchmarkPublicationBuilder,
} from "@aiengineer/knowledge-application";
import {
  PostgresVerificationBenchmarkPublisher,
  PostgresVerificationBenchmarkRunStore,
  PostgresVerificationRepository,
  type PostgresCanonicalRepository,
} from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-core";
import { createEd25519Signer } from "@aiengineer/knowledge-verification";
import { verificationBenchmarkActivityHandler } from "./verification-benchmark-activity.js";

/** Standalone offline composition; no parser process or provider dispatch port is created. */
export function createConfiguredVerificationBenchmarkHandler(input: {
  database: PostgresCanonicalRepository;
  tenantId: string;
  projectUrl: string;
  serviceRoleKey: string;
  maximumArtifactBytes: number;
  environment: Readonly<Record<string, string | undefined>>;
}) {
  const raw = input.environment.VERIFICATION_BENCHMARK_CONFIG_JSON?.trim();
  if (!raw) return undefined;
  const config = parseVerificationBenchmarkRuntimeConfig(raw);
  if (config.tenantId !== input.tenantId) throw new Error("BENCHMARK_RUNTIME_TENANT_MISMATCH");
  const privateKey = input.environment.VERIFICATION_BENCHMARK_SIGNING_PRIVATE_KEY_PEM?.trim(),
    keyId = input.environment.VERIFICATION_BENCHMARK_SIGNING_KEY_ID?.trim();
  if (!privateKey || !keyId) throw new Error("BENCHMARK_RUNTIME_SIGNING_KEY_REQUIRED");
  const signer = createEd25519Signer(privateKey, keyId);
  const storageBucket = input.environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket";
  const artifacts = new SupabaseArtifactStore({
    projectUrl: input.projectUrl,
    serviceRoleKey: input.serviceRoleKey,
    bucket: storageBucket,
    maximumBytes: input.maximumArtifactBytes,
  });
  const repository = new PostgresVerificationRepository(input.database, artifacts, {
    async authorize(request) {
      if (request.tenantId !== config.tenantId) throw new Error("VERIFICATION_WORKER_TENANT_DENIED");
    },
  });
  const resolver = repository.createTrustedArtifactResolver();
  const benchmark = new RegisteredDiagnosticsOfflineBenchmark({
    inputs: new RegisteredBenchmarkInputAdmission(config.inputs, resolver),
    profiles: new RegisteredBenchmarkProfileAdmission(config.profiles, resolver),
    sources: new RegisteredBenchmarkSourceImportAdmission(config.sources, resolver),
    replays: new RegisteredBenchmarkReplayAdmission(config.replays, resolver),
  });
  const publicationBuilder = new RegisteredBenchmarkPublicationBuilder({
    policies: config.policies,
    resolver,
    signer,
    artifacts: {
      async register(value) {
        if (value.tenantId !== config.tenantId) throw new Error("BENCHMARK_PUBLICATION_TENANT_MISMATCH");
        return repository.registerContentAddressedArtifact({
          ...value,
          mediaType: "application/json",
          producerActivityId: "verification-service:runBenchmark",
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
  return verificationBenchmarkActivityHandler({
    benchmark,
    runStore: new PostgresVerificationBenchmarkRunStore(input.database),
    publicationBuilder,
    publisher: new PostgresVerificationBenchmarkPublisher(input.database),
    operations: input.database,
    runtime: {
      resolve(context) {
        if (context.tenantId !== config.tenantId) throw new Error("BENCHMARK_RUNTIME_TENANT_MISMATCH");
        return { ...config.runtime, attemptId: context.attemptId };
      },
    },
    now: () => new Date().toISOString(),
  });
}
