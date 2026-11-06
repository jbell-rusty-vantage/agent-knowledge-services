import { VerificationStructuredExtractionReadService } from "@aiengineer/knowledge-application";
import {
  PostgresStructuredExtractionReadRepository,
  PostgresVerificationRepository,
  type PostgresCanonicalRepository,
} from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-core";
import { createEd25519Verifier } from "@aiengineer/knowledge-verification";
import { UuidSchema, type Actor } from "@aiengineer/knowledge-contracts";
import { parseBenchmarkReadPublicKeys } from "@aiengineer/knowledge-application";
import { createVerificationOperationReadAuthorizer } from "./verification-ownership.js";

export function createVerificationStructuredExtractionReads(
  database: PostgresCanonicalRepository | undefined,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const raw = environment.VERIFICATION_STRUCTURED_EXTRACTION_READ_PUBLIC_KEYS_JSON?.trim();
  if (!raw) return undefined;
  const verifier = createEd25519Verifier(parseBenchmarkReadPublicKeys(raw));
  const projectUrl = environment.SUPABASE_URL?.trim(),
    serviceRoleKey = environment.SUPABASE_SECRET_KEY?.trim(),
    grants = environment.VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON?.trim();
  if (!database || !projectUrl || !serviceRoleKey || !grants)
    throw new Error("STRUCTURED_EXTRACTION_READS_STORAGE_AND_OWNERSHIP_REQUIRED");
  const authorize = createVerificationOperationReadAuthorizer(database, grants);
  const store = new SupabaseArtifactStore({
    projectUrl,
    serviceRoleKey,
    bucket: environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket",
    maximumBytes: 256_000,
  });
  return {
    async getExtraction(input: { tenantId: string; operationId: string; actor: Actor }) {
      const scoped = {
        tenantId: UuidSchema.parse(input.tenantId),
        operationId: UuidSchema.parse(input.operationId),
        actor: structuredClone(input.actor),
      };
      if (!(await authorize(scoped))) throw Object.assign(new Error("EXTRACTION_NOT_FOUND"), { code: "NOT_FOUND" });
      const repository = new PostgresVerificationRepository(database, store, {
        async authorize(request) {
          if (request.tenantId !== scoped.tenantId || request.purpose !== "verification_replay")
            throw new Error("EXTRACTION_READ_DENIED");
        },
      });
      return new VerificationStructuredExtractionReadService(
        new PostgresStructuredExtractionReadRepository(
          database,
          () => repository.createTrustedArtifactResolver(),
          verifier,
        ),
      ).getExtraction(scoped);
    },
  };
}
