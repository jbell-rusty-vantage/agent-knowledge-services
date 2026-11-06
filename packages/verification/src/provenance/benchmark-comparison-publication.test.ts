import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { VerificationBenchmarkComparisonPublication } from "@aiengineer/knowledge-contracts";
import {
  sealVerificationBenchmarkComparisonPublication,
  verifyVerificationBenchmarkComparisonPublication,
} from "./benchmark-comparison-publication.js";
import { createEd25519Signer, createEd25519Verifier } from "./seal.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  digest = `sha256:${"a".repeat(64)}`,
  time = "2026-09-06T00:00:00.000Z";
function body(): Omit<VerificationBenchmarkComparisonPublication, "seal"> {
  const artifact = (n: number) => ({
    artifactId: id(n),
    tenantId: id(1),
    digest,
    mediaType: "application/json",
    byteLength: 2,
    objectKey: `private/${id(n)}`,
    createdAt: time,
    producerActivityId: "fixture",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "restricted" as const,
    parentArtifactIds: [],
  });
  return {
    schemaVersion: "verification-benchmark-comparison-publication.v1",
    verificationContractVersion: "verification.v1",
    tenantId: id(1),
    operationId: id(2),
    comparisonId: id(3),
    requestDigest: digest,
    baseline: {
      runId: id(4),
      publicationArtifact: artifact(5),
      payloadDigest: digest,
    },
    candidate: {
      runId: id(6),
      publicationArtifact: artifact(7),
      payloadDigest: digest,
    },
    profile: { profileId: "paired_default", artifact: artifact(8) },
    result: { artifact: artifact(9), resultDigest: digest },
    engineeringGateOutcome: "not_requested",
    interpretation: "observed_engineering_threshold_only",
    runtime: {
      deploymentId: "fixture",
      attemptId: id(10),
      capabilityVersion: "verification.v1",
      targetCodeRef: "fixture",
      gitSha: "a".repeat(40),
      dirty: false,
    },
    execution: { mode: "offline_recorded", externalProviderRequests: 0 },
    qualityClaims: {
      humanGoldValidated: false,
      sourceAuthorityAssessed: false,
      calibrated: false,
    },
    startedAt: time,
    completedAt: time,
  };
}
function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    signer: createEd25519Signer(pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "comparison"),
    verifier: createEd25519Verifier({
      comparison: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    }),
  };
}
describe("signed comparison publication", () => {
  it("authenticates actual Ed25519 bytes and rejects changed result bindings or signing identities", async () => {
    const key = keys(),
      manifest = await sealVerificationBenchmarkComparisonPublication(body(), key.signer);
    expect((await verifyVerificationBenchmarkComparisonPublication(manifest, key.verifier)).signatureStatus).toBe(
      "verified",
    );
    await expect(
      verifyVerificationBenchmarkComparisonPublication(
        {
          ...manifest,
          result: {
            ...manifest.result,
            resultDigest: `sha256:${"b".repeat(64)}`,
          },
        },
        key.verifier,
      ),
    ).rejects.toThrow("DIGEST_MISMATCH");
    await expect(verifyVerificationBenchmarkComparisonPublication(manifest, keys().verifier)).rejects.toThrow(
      "SIGNATURE_INVALID",
    );
    await expect(
      verifyVerificationBenchmarkComparisonPublication(
        { ...manifest, seal: { payloadDigest: manifest.seal.payloadDigest } },
        key.verifier,
      ),
    ).rejects.toThrow("SIGNATURE_REQUIRED");
  });
  it("snapshots mutable caller input before awaiting the signer", async () => {
    const key = keys(),
      input = body();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = sealVerificationBenchmarkComparisonPublication(input, {
      ...key.signer,
      async sign(bytes) {
        await gate;
        return key.signer.sign(bytes);
      },
    });
    input.result.resultDigest = `sha256:${"b".repeat(64)}`;
    release();
    const manifest = await pending;
    expect(manifest.result.resultDigest).toBe(digest);
    expect((await verifyVerificationBenchmarkComparisonPublication(manifest, key.verifier)).signatureStatus).toBe(
      "verified",
    );
  });
  it("rejects cross-tenant custody, missing dirty source state, and contradictory gate claims", async () => {
    const key = keys(),
      input = body();
    await expect(
      sealVerificationBenchmarkComparisonPublication(
        {
          ...input,
          result: {
            ...input.result,
            artifact: { ...input.result.artifact, tenantId: id(99) },
          },
        },
        key.signer,
      ),
    ).rejects.toThrow();
    await expect(
      sealVerificationBenchmarkComparisonPublication(
        { ...input, runtime: { ...input.runtime, dirty: true } },
        key.signer,
      ),
    ).rejects.toThrow();
    await expect(
      sealVerificationBenchmarkComparisonPublication({ ...input, engineeringGateOutcome: "pass" }, key.signer),
    ).rejects.toThrow();
  });
});
