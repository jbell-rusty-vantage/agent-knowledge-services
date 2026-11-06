import {
  VerificationAdmissionService,
  VerificationCaptureReadApplicationService,
} from "@aiengineer/knowledge-application";
import { UuidSchema, type Actor } from "@aiengineer/knowledge-contracts";
import { VERIFICATION_PARSER_LIMITS } from "@aiengineer/knowledge-preparation";
import {
  PostgresCaptureReadRepository,
  PostgresVerificationRepository,
  type PostgresCanonicalRepository,
} from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-core";
import { createVerificationOperationReadAuthorizer } from "./verification-ownership.js";

/** Authorizes the actor before reading immutable capture custody; it cannot fetch or parse sources. */
export function createVerificationCaptureReads(
  database: PostgresCanonicalRepository | undefined,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const enabled = environment.VERIFICATION_CAPTURE_READS_ENABLED?.trim();
  if (enabled && enabled !== "0" && enabled !== "1") throw new Error("INVALID_VERIFICATION_CAPTURE_READS_ENABLED");
  if (enabled !== "1") return undefined;
  const projectUrl = environment.SUPABASE_URL?.trim(),
    serviceRoleKey = environment.SUPABASE_SECRET_KEY?.trim(),
    grants = environment.VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON?.trim(),
    imageDigest = environment.VERIFICATION_PARSER_IMAGE_DIGEST?.trim();
  if (
    !database ||
    !projectUrl ||
    !serviceRoleKey ||
    !grants ||
    !imageDigest ||
    !/^sha256:[a-f0-9]{64}$/u.test(imageDigest)
  )
    throw new Error("VERIFICATION_CAPTURE_READS_CONFIGURATION_REQUIRED");
  const authorize = createVerificationOperationReadAuthorizer(database, grants, ["verification_capture"]);
  const bucket = environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket";
  const store = new SupabaseArtifactStore({ projectUrl, serviceRoleKey, bucket, maximumBytes: 32_000_000 });
  return {
    async getCapture(input: { tenantId: string; operationId: string; actor: Actor }) {
      const scoped = {
        tenantId: UuidSchema.parse(input.tenantId),
        operationId: UuidSchema.parse(input.operationId),
        actor: structuredClone(input.actor),
      };
      if (!(await authorize(scoped)))
        throw Object.assign(new Error("VERIFICATION_CAPTURE_NOT_FOUND"), { code: "NOT_FOUND" });
      const repository = new PostgresVerificationRepository(database, store, {
        async authorize(request) {
          if (
            request.tenantId !== scoped.tenantId ||
            !["verification_replay", "verification_admission"].includes(request.purpose)
          )
            throw new Error("VERIFICATION_CAPTURE_READ_DENIED");
        },
      });
      const readOnlyRepository = {
        createTrustedArtifactResolver: () => repository.createTrustedArtifactResolver(),
        getRegisteredCapture: repository.getRegisteredCapture.bind(repository),
        registerContentAddressedArtifact: async (): Promise<never> => {
          throw new Error("VERIFICATION_CAPTURE_READ_ONLY");
        },
      };
      const admission = new VerificationAdmissionService(
        readOnlyRepository,
        {
          parse: async () => {
            throw new Error("VERIFICATION_CAPTURE_READ_PARSER_DISABLED");
          },
        },
        {
          parserVersion: "verification-native-parser.v1",
          imageDigest: imageDigest as `sha256:${string}`,
          limits: VERIFICATION_PARSER_LIMITS,
        },
        {
          storageBucket: bucket,
          producerVersion: "verification-capture-reads.v1",
          encryptionClass: "supabase-managed",
          retentionClass: "verification-audit",
          now: () => new Date().toISOString(),
        },
      );
      return new VerificationCaptureReadApplicationService(
        new PostgresCaptureReadRepository(database, readOnlyRepository, admission),
      ).getCapture(scoped);
    },
  };
}
