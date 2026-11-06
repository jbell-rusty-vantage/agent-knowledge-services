import { z } from "zod";
import {
  ActorSchema,
  UuidSchema,
  VerificationArtifactHandleSchema,
  type Actor,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { actorsMatch } from "@aiengineer/knowledge-application";
import { ProviderReconciliationAdmission } from "@aiengineer/knowledge-application";
import {
  PostgresProviderReconciliationStore,
  PostgresProviderReconciliationReadRepository,
  PostgresVerificationRepository,
  type PostgresCanonicalRepository,
} from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-core";
import { createEd25519Verifier } from "@aiengineer/knowledge-verification";
import { createVerificationOperationReadAuthorizer } from "./verification-ownership.js";
import { parseBenchmarkReadPublicKeys } from "@aiengineer/knowledge-application";

const grantSchema = z.strictObject({
  tenantId: UuidSchema,
  actor: ActorSchema,
  providerId: z.enum(["gateway-structured-extraction.v1", "interfaze-extraction.v1"]),
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u),
  operatorId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u),
  basis: z.enum(["synthetic_fixture", "supplier_statement"]),
});
const denied = () => Object.assign(new Error("RECONCILIATION_NOT_FOUND"), { code: "NOT_FOUND" });

/** Actor grants are server-owned and additionally constrained by original mission/deployment ownership. */
export function createVerificationProviderReconciliationService(
  database: PostgresCanonicalRepository | undefined,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const raw = environment.VERIFICATION_PROVIDER_RECONCILIATION_GRANTS_JSON?.trim();
  if (!raw) return undefined;
  if (Buffer.byteLength(raw) > 262_144) throw new Error("RECONCILIATION_CONFIG_TOO_LARGE");
  const grants = z.array(grantSchema).min(1).max(256).parse(JSON.parse(raw));
  const identities = grants.map((g) =>
    [g.tenantId, g.actor.kind, g.actor.id, g.providerId, g.keyId, g.operatorId, g.basis].join(":"),
  );
  if (new Set(identities).size !== identities.length) throw new Error("RECONCILIATION_DUPLICATE_GRANT");
  const keys = environment.VERIFICATION_PROVIDER_RECONCILIATION_PUBLIC_KEYS_JSON?.trim(),
    ownership = environment.VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON?.trim();
  const projectUrl = environment.SUPABASE_URL?.trim(),
    serviceRoleKey = environment.SUPABASE_SECRET_KEY?.trim();
  if (!database || !keys || !ownership || !projectUrl || !serviceRoleKey)
    throw new Error("RECONCILIATION_STORAGE_KEYS_OWNERSHIP_REQUIRED");
  const verifier = createEd25519Verifier(parseBenchmarkReadPublicKeys(keys)),
    authorize = createVerificationOperationReadAuthorizer(database, ownership);
  const store = new SupabaseArtifactStore({
    projectUrl,
    serviceRoleKey,
    bucket: environment.VERIFICATION_STORAGE_BUCKET?.trim() || "ai-engineer-cloud-bucket",
    maximumBytes: 1_000_000,
  });
  const control: Pick<PostgresCanonicalRepository, "transaction"> = {
    transaction: async (tenant, work) =>
      database.transaction(tenant, async (client) => {
        await client.query("set local role control_plane");
        return work(client);
      }),
  };
  async function scope(input: { tenantId: string; operationId: string; providerAttemptId: string; actor: Actor }) {
    const scoped = {
      tenantId: UuidSchema.parse(input.tenantId),
      operationId: UuidSchema.parse(input.operationId),
      providerAttemptId: UuidSchema.parse(input.providerAttemptId),
      actor: ActorSchema.parse(input.actor),
    };
    const matched = grants.filter((g) => g.tenantId === scoped.tenantId && actorsMatch(g.actor, scoped.actor));
    if (!matched.length || !(await authorize(scoped))) throw denied();
    const repository = new PostgresVerificationRepository(database!, store, {
      async authorize(request) {
        if (request.tenantId !== scoped.tenantId || request.purpose !== "verification_replay") throw denied();
      },
    });
    const factory = () => repository.createTrustedArtifactResolver();
    const admission = new ProviderReconciliationAdmission(
      matched.map(({ actor, ...grant }) => grant),
      factory,
      verifier,
    );
    return { scoped, factory, admission };
  }
  return {
    async applyDecision(input: {
      tenantId: string;
      operationId: string;
      providerAttemptId: string;
      actor: Actor;
      artifact: VerificationArtifactHandle;
    }) {
      // Snapshot the caller-controlled handle before the first asynchronous authorization operation.
      const artifact = VerificationArtifactHandleSchema.parse(input.artifact),
        { scoped, admission } = await scope(input);
      if (artifact.tenantId !== scoped.tenantId) throw denied();
      const permit = await admission.admit({ tenantId: scoped.tenantId, artifact });
      if (
        permit.receipt.operationId !== scoped.operationId ||
        permit.receipt.providerAttemptId !== scoped.providerAttemptId
      )
        throw denied();
      return new PostgresProviderReconciliationStore(control, admission).apply(permit);
    },
    async getDecision(input: { tenantId: string; operationId: string; providerAttemptId: string; actor: Actor }) {
      const { scoped, admission, factory } = await scope(input);
      return new PostgresProviderReconciliationReadRepository(control, admission, factory).loadAppliedDecision(
        scoped.tenantId,
        scoped.operationId,
        scoped.providerAttemptId,
      );
    },
  };
}
