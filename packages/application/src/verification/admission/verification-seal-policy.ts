import {
  VerificationArtifactHandleSchema,
  type VerificationArtifactHandle,
  type VerificationPolicyDefinition,
} from "@aiengineer/knowledge-contracts";
import { parseVerificationPolicyDefinition } from "@aiengineer/knowledge-policy";
import { sha256Digest, type TrustedArtifactResolver } from "@aiengineer/knowledge-verification";
import { z } from "zod";

const grantSchema = z.strictObject({
  tenantId: z.uuid(),
  policyVersion: z.string().trim().min(1).max(160),
  policyArtifact: z.strictObject({ artifactId: z.uuid(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }),
});
export type VerificationSealPolicyGrant = z.infer<typeof grantSchema>;

/** Server configuration binds each tenant/version to exactly one immutable policy. */
export class VerificationSealPolicyCatalog {
  readonly #grants = new Map<string, VerificationSealPolicyGrant>();

  constructor(grants: readonly VerificationSealPolicyGrant[]) {
    for (const value of grants) {
      const grant = grantSchema.parse(value);
      const key = JSON.stringify([grant.tenantId, grant.policyVersion]);
      if (this.#grants.has(key)) throw new Error("VERIFICATION_SEAL_POLICY_DUPLICATE_GRANT");
      Object.freeze(grant.policyArtifact);
      this.#grants.set(key, Object.freeze(grant));
    }
  }

  async resolve(
    input: { tenantId: string; policyVersion: string },
    resolver: TrustedArtifactResolver,
  ): Promise<{
    artifact: VerificationArtifactHandle;
    definition: VerificationPolicyDefinition;
  }> {
    const grant = this.#grants.get(JSON.stringify([input.tenantId, input.policyVersion]));
    if (!grant) throw new Error("VERIFICATION_SEAL_POLICY_GRANT_REQUIRED");
    await resolver.authorizeArtifact({
      tenantId: grant.tenantId,
      artifactId: grant.policyArtifact.artifactId,
      purpose: "verification_admission",
    });
    const hydrated = await resolver.hydrateRegisteredArtifact({
      tenantId: grant.tenantId,
      artifactId: grant.policyArtifact.artifactId,
    });
    const artifact = VerificationArtifactHandleSchema.parse(hydrated.registration);
    if (
      artifact.tenantId !== grant.tenantId ||
      artifact.artifactId !== grant.policyArtifact.artifactId ||
      artifact.digest !== grant.policyArtifact.digest ||
      sha256Digest(hydrated.bytes) !== artifact.digest ||
      hydrated.bytes.byteLength !== artifact.byteLength
    )
      throw new Error("VERIFICATION_SEAL_POLICY_ARTIFACT_MISMATCH");
    const definition = parseVerificationPolicyDefinition(hydrated.bytes);
    if (definition.policyVersion !== grant.policyVersion) throw new Error("VERIFICATION_SEAL_POLICY_VERSION_MISMATCH");
    return { artifact, definition };
  }
}
