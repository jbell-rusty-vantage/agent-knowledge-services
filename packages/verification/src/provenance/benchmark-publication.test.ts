import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { VerificationBenchmarkPublicationManifest } from "@aiengineer/knowledge-contracts";
import {
  sealVerificationBenchmarkPublication,
  verifyVerificationBenchmarkPublication,
} from "./benchmark-publication.js";
import { createEd25519Signer, createEd25519Verifier } from "./seal.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const tenantId = id(1),
  time = "2026-09-05T00:00:00.000Z";
function body(): Omit<VerificationBenchmarkPublicationManifest, "seal"> {
  const artifact = (value: number) => ({
    artifactId: id(value),
    tenantId,
    digest,
    mediaType: "application/json",
    byteLength: 2,
    objectKey: `private/${id(value)}`,
    createdAt: time,
    producerActivityId: "fixture",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "restricted" as const,
    parentArtifactIds: [],
  });
  return {
    schemaVersion: "verification-benchmark-publication.v1",
    verificationContractVersion: "verification.v1",
    tenantId,
    runId: id(2),
    operationId: id(3),
    dataset: {
      artifact: artifact(10),
      datasetId: id(11),
      datasetVersionId: id(12),
      version: 4,
      caseCount: 43,
      manifestDigest: digest,
      labelProvenance: "engineering_expectations",
    },
    experiment: {
      artifact: artifact(13),
      experimentId: id(14),
      runnerVersion: "verification-benchmark-runner.v1",
      randomSeed: 7,
      repetitions: 1,
    },
    runnerPayload: artifact(15),
    runnerManifestDigest: digest,
    checkpointPlanDigest: digest,
    summaryArtifact: artifact(16),
    provenanceArtifact: artifact(17),
    arms: [0, 1].map((index) => ({
      armId: `arm-${index}`,
      experimentArmId: id(20 + index),
      evalRunId: id(30 + index),
      configurationArtifact: artifact(40 + index),
      policyArtifact: artifact(50),
      isControl: index === 0,
      terminalStatus: "review" as const,
      dispositionBasis: "source_authority_unassessed" as const,
      summaryDigest: digest,
    })),
    runtime: {
      deploymentId: "verifier",
      attemptId: id(60),
      capabilityVersion: "verification.v1",
      targetCodeRef: "fixture-code",
      gitSha: "fixture-sha",
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
const keys = () => {
  const pair = generateKeyPairSync("ed25519");
  return {
    signer: createEd25519Signer(pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "proof-key"),
    verifier: createEd25519Verifier({
      "proof-key": pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    }),
  };
};

describe("benchmark publication seal", () => {
  it("verifies a real Ed25519 signature and detects rebinding canonical evaluation identity", async () => {
    const { signer, verifier } = keys(),
      sealed = await sealVerificationBenchmarkPublication(body(), signer);
    expect(
      (
        await verifyVerificationBenchmarkPublication(sealed, {
          verifier,
          requireSignature: true,
        })
      ).signatureStatus,
    ).toBe("verified");
    const changed = structuredClone(sealed);
    changed.arms[0]!.evalRunId = id(900);
    await expect(verifyVerificationBenchmarkPublication(changed, { verifier })).rejects.toThrow("DIGEST_MISMATCH");
    const rebound = await sealVerificationBenchmarkPublication({
      ...body(),
      runId: id(901),
    });
    // A newly computed digest cannot make the previous signature valid.
    await expect(
      verifyVerificationBenchmarkPublication(
        {
          ...rebound,
          seal: { ...rebound.seal, signature: sealed.seal.signature },
        },
        { verifier },
      ),
    ).rejects.toThrow("SIGNATURE_INVALID");
    await expect(
      verifyVerificationBenchmarkPublication(sealed, {
        verifier: keys().verifier,
      }),
    ).rejects.toThrow("SIGNATURE_INVALID");
  });

  it("distinguishes unsigned integrity from trusted signature verification", async () => {
    const unsigned = await sealVerificationBenchmarkPublication(body());
    expect((await verifyVerificationBenchmarkPublication(unsigned)).signatureStatus).toBe("unsigned");
    await expect(
      verifyVerificationBenchmarkPublication(unsigned, {
        requireSignature: true,
      }),
    ).rejects.toThrow("SIGNATURE_REQUIRED");
    await expect(
      verifyVerificationBenchmarkPublication(await sealVerificationBenchmarkPublication(body(), keys().signer)),
    ).rejects.toThrow("VERIFIER_REQUIRED");
  });

  it.each(["tenant", "arm", "artifact", "clock", "quality"])(
    "rejects invalid %s binding before signing",
    async (mode) => {
      const input = body();
      if (mode === "tenant") input.runnerPayload.tenantId = id(999);
      if (mode === "arm") input.arms[1]!.evalRunId = input.arms[0]!.evalRunId;
      if (mode === "artifact") input.arms[1]!.policyArtifact.parentArtifactIds = [id(998)];
      if (mode === "clock") input.completedAt = "2026-09-05T00:00:00Z";
      if (mode === "quality") Object.assign(input.qualityClaims, { humanGoldValidated: true });
      await expect(sealVerificationBenchmarkPublication(input)).rejects.toThrow();
    },
  );

  it("owns the payload across an asynchronous signer and returns immutable nested values", async () => {
    const input = body(),
      { signer, verifier } = keys();
    const sealed = await sealVerificationBenchmarkPublication(input, {
      ...signer,
      async sign(bytes) {
        input.dataset.version = 99;
        return signer.sign(bytes);
      },
    });
    expect(sealed.dataset.version).toBe(4);
    expect(Object.isFrozen(sealed.arms[0]!.configurationArtifact)).toBe(true);
    expect((await verifyVerificationBenchmarkPublication(sealed, { verifier })).signatureStatus).toBe("verified");
  });
});
