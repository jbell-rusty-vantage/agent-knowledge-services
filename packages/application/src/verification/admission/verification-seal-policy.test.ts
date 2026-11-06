import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-verification";
import { describe, expect, it, vi } from "vitest";
import { VerificationSealPolicyCatalog } from "./verification-seal-policy.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
function fixture(policyVersion = "policy.v1") {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: "verification-policy.v1",
      policyVersion,
      definitionId: "test-policy",
      criticalDownstreamUses: ["publication"],
      requireCrossFamilyForRisk: ["critical"],
      requireIndependentAuthorityForScopes: ["clinical_utility"],
      mixedEvidenceOutcome: "review",
      unknownCriticalOutcome: "abstain",
      authorityWithheldOutcome: "review",
      reviewAvailable: true,
    }),
  );
  const registration: VerificationArtifactHandle = {
    artifactId,
    tenantId,
    digest: sha256Digest(bytes),
    mediaType: "application/json",
    byteLength: bytes.length,
    objectKey: "private/policy",
    createdAt: "2026-09-05T00:00:00.000Z",
    producerActivityId: "policy-publish",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "restricted",
    parentArtifactIds: [],
  };
  const grant = { tenantId, policyVersion: "policy.v1", policyArtifact: { artifactId, digest: registration.digest } };
  const calls: string[] = [];
  const resolver = {
    authorizeArtifact: vi.fn(async () => {
      calls.push("authorize");
    }),
    hydrateRegisteredArtifact: vi.fn(async () => {
      calls.push("hydrate");
      return { registration, bytes };
    }),
  };
  return { grant, registration, bytes, resolver, calls, catalog: new VerificationSealPolicyCatalog([grant]) };
}
describe("trusted sealing policy", () => {
  it("authorizes before hydration and resolves the exact registered version", async () => {
    const f = fixture();
    const resolved = await f.catalog.resolve({ tenantId, policyVersion: "policy.v1" }, f.resolver);
    expect(f.calls).toEqual(["authorize", "hydrate"]);
    expect(resolved.artifact.digest).toBe(f.registration.digest);
    expect(resolved.definition.policyVersion).toBe("policy.v1");
  });
  it("does not hydrate another tenant or an ungranted version", async () => {
    const f = fixture();
    for (const input of [
      { tenantId: artifactId, policyVersion: "policy.v1" },
      { tenantId, policyVersion: "caller-policy" },
    ]) {
      await expect(f.catalog.resolve(input, f.resolver)).rejects.toThrow("GRANT_REQUIRED");
    }
    expect(f.calls).toEqual([]);
  });
  it("copies configuration and rejects ambiguous version grants", async () => {
    const f = fixture();
    expect(() => new VerificationSealPolicyCatalog([f.grant, f.grant])).toThrow("DUPLICATE_GRANT");
    f.grant.policyArtifact.artifactId = tenantId;
    await expect(f.catalog.resolve({ tenantId, policyVersion: "policy.v1" }, f.resolver)).resolves.toBeDefined();
  });
  it("rejects bytes tampering even if registration still matches the grant", async () => {
    const f = fixture();
    f.bytes[0] = 0;
    await expect(f.catalog.resolve({ tenantId, policyVersion: "policy.v1" }, f.resolver)).rejects.toThrow(
      "ARTIFACT_MISMATCH",
    );
  });
  it("rejects a foreign registration and a mismatched policy version", async () => {
    const f = fixture();
    f.registration.tenantId = artifactId;
    await expect(f.catalog.resolve({ tenantId, policyVersion: "policy.v1" }, f.resolver)).rejects.toThrow(
      "ARTIFACT_MISMATCH",
    );
    const mismatched = fixture("other.v1");
    await expect(
      mismatched.catalog.resolve({ tenantId, policyVersion: "policy.v1" }, mismatched.resolver),
    ).rejects.toThrow("VERSION_MISMATCH");
  });
  it("does not hydrate when authorization fails", async () => {
    const f = fixture();
    f.resolver.authorizeArtifact.mockRejectedValue(new Error("DENIED"));
    await expect(f.catalog.resolve({ tenantId, policyVersion: "policy.v1" }, f.resolver)).rejects.toThrow("DENIED");
    expect(f.resolver.hydrateRegisteredArtifact).not.toHaveBeenCalled();
  });
});
