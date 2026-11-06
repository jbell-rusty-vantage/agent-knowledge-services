import { createPublicKey, verify } from "node:crypto";
import { VerificationBenchmarkComparisonReadService } from "@aiengineer/knowledge-application";
import {
  PostgresVerificationBenchmarkComparisonReadRepository,
  PostgresVerificationRepository,
  type PostgresCanonicalRepository,
} from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-core";
import { parseBenchmarkReadPublicKeys } from "@aiengineer/knowledge-application";
export function createVerificationBenchmarkComparisonReads(
  database: PostgresCanonicalRepository | undefined,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const raw = environment.VERIFICATION_BENCHMARK_COMPARISON_READ_PUBLIC_KEYS_JSON?.trim();
  if (!raw) return undefined;
  const keys = new Map(
    Object.entries(parseBenchmarkReadPublicKeys(raw)).map(([id, pem]) => [id, createPublicKey(pem)]),
  );
  const verifier = {
    async verify(input: { keyId: string; payload: Uint8Array; signatureBase64: string }) {
      const key = keys.get(input.keyId);
      return key !== undefined && verify(null, input.payload, key, Buffer.from(input.signatureBase64, "base64"));
    },
  };
  const projectUrl = environment.SUPABASE_URL?.trim(),
    serviceRoleKey = environment.SUPABASE_SECRET_KEY?.trim();
  if (!database || !projectUrl || !serviceRoleKey) throw new Error("BENCHMARK_COMPARISON_READS_STORAGE_REQUIRED");
  const store = new SupabaseArtifactStore({
    projectUrl,
    serviceRoleKey,
    bucket: environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket",
    maximumBytes: 8 * 1024 * 1024,
  });
  return {
    getComparison(input: { tenantId: string; comparisonId: string }) {
      const repository = new PostgresVerificationRepository(database, store, {
        async authorize(request) {
          if (request.tenantId !== input.tenantId || request.purpose !== "verification_replay")
            throw new Error("COMPARISON_READ_DENIED");
        },
      });
      return new VerificationBenchmarkComparisonReadService(
        new PostgresVerificationBenchmarkComparisonReadRepository(database, repository, { verifier }),
      ).getComparison(input);
    },
  };
}
