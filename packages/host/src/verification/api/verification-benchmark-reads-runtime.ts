import { createPublicKey, verify } from "node:crypto";
import { parseBenchmarkReadPublicKeys, VerificationBenchmarkReadService } from "@aiengineer/knowledge-application";
import {
  PostgresVerificationBenchmarkReadRepository,
  PostgresVerificationRepository,
  type PostgresCanonicalRepository,
} from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-core";

export { parseBenchmarkReadPublicKeys };

export function createVerificationBenchmarkReads(
  database: PostgresCanonicalRepository | undefined,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const raw = environment.VERIFICATION_BENCHMARK_READ_PUBLIC_KEYS_JSON?.trim();
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
  if (!database || !projectUrl || !serviceRoleKey) throw new Error("VERIFICATION_BENCHMARK_READS_STORAGE_REQUIRED");
  const store = new SupabaseArtifactStore({
    projectUrl,
    serviceRoleKey,
    bucket: environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket",
    maximumBytes: 4_194_304,
  });
  const service = (tenantId: string) => {
    // Fresh tenant authorization and resolver state for each concurrent request.
    const repository = new PostgresVerificationRepository(database, store, {
      async authorize(input) {
        if (input.tenantId !== tenantId || input.purpose !== "verification_replay")
          throw new Error("BENCHMARK_READ_ARTIFACT_DENIED");
      },
    });
    return new VerificationBenchmarkReadService(
      new PostgresVerificationBenchmarkReadRepository(database, repository, { verifier }),
    );
  };
  return {
    getRun: (input: { tenantId: string; runId: string }) => service(input.tenantId).getRun(input),
    getManifest: (input: { tenantId: string; runId: string }) => service(input.tenantId).getManifest(input),
  };
}
