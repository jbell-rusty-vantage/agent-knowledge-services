import { describe, expect, it, vi } from "vitest";
import type {
  VerificationArtifactHandle,
  VerificationBenchmarkPublicationManifest,
} from "@aiengineer/knowledge-contracts";
import {
  VerificationBenchmarkReadError,
  VerificationBenchmarkReadService,
  type VerifiedBenchmarkPublicationReadPort,
} from "./verification-benchmark-reads.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1),
  runId = id(2),
  operationId = id(3),
  attemptId = id(4),
  createdAt = "2026-09-05T00:00:00.000Z",
  digest = (n: string) => `sha256:${n.repeat(64)}` as `sha256:${string}`;
const handle = (n: number, d = digest(`${n % 10}`)): VerificationArtifactHandle => ({
  artifactId: id(n),
  tenantId,
  digest: d,
  mediaType: "application/json",
  byteLength: 12,
  objectKey: `private/${id(n)}`,
  createdAt,
  producerActivityId: "fixture",
  producerVersion: "1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
});
function manifest(): VerificationBenchmarkPublicationManifest {
  return {
    schemaVersion: "verification-benchmark-publication.v1",
    verificationContractVersion: "verification.v1",
    tenantId,
    runId,
    operationId,
    dataset: {
      artifact: handle(10),
      datasetId: id(11),
      datasetVersionId: id(12),
      version: 1,
      caseCount: 2,
      manifestDigest: digest("a"),
      labelProvenance: "engineering_expectations",
    },
    experiment: {
      artifact: handle(13),
      experimentId: id(14),
      runnerVersion: "verification-benchmark-runner.v1",
      randomSeed: 7,
      repetitions: 1,
    },
    runnerPayload: handle(15),
    runnerManifestDigest: digest("b"),
    checkpointPlanDigest: digest("c"),
    summaryArtifact: handle(16),
    provenanceArtifact: handle(17),
    arms: [
      {
        armId: "control",
        experimentArmId: id(18),
        evalRunId: id(19),
        configurationArtifact: handle(20),
        policyArtifact: handle(21),
        isControl: true,
        terminalStatus: "review",
        dispositionBasis: "source_authority_unassessed",
        summaryDigest: digest("d"),
      },
      {
        armId: "candidate",
        experimentArmId: id(22),
        evalRunId: id(23),
        configurationArtifact: handle(24),
        policyArtifact: handle(25),
        isControl: false,
        terminalStatus: "review",
        dispositionBasis: "source_authority_unassessed",
        summaryDigest: digest("e"),
      },
    ],
    runtime: {
      deploymentId: "fixture",
      attemptId,
      capabilityVersion: "verification-service.v1",
      targetCodeRef: "uncommitted:fixture",
      gitSha: "uncommitted",
      dirty: true,
      dirtyStateArtifact: handle(26),
    },
    execution: { mode: "offline_recorded", externalProviderRequests: 0 },
    qualityClaims: { humanGoldValidated: false, sourceAuthorityAssessed: false, calibrated: false },
    startedAt: createdAt,
    completedAt: createdAt,
    seal: {
      payloadDigest: digest("f"),
      signature: { algorithm: "Ed25519", keyId: "fixture-key", signatureBase64: `${"A".repeat(86)}==` },
    },
  };
}
function subject(value = manifest()) {
  const port: VerifiedBenchmarkPublicationReadPort = {
    loadVerifiedBenchmarkPublication: vi.fn(async () => ({
      publicationArtifact: handle(30),
      manifest: value,
      signatureStatus: "verified" as const,
    })),
  };
  return { port, read: new VerificationBenchmarkReadService(port) };
}

describe("benchmark publication reads (unit-only)", () => {
  it("projects compact signed terminal metadata without paths, report bytes, or signature material", async () => {
    const value = subject(),
      summary = await value.read.getRun({ tenantId, runId }),
      full = await value.read.getManifest({ tenantId, runId });
    expect(summary).toMatchObject({
      tenantId,
      runId,
      operationId,
      publication: { signatureStatus: "verified" },
      qualityClaims: { humanGoldValidated: false },
    });
    expect(summary.arms).toEqual(
      expect.arrayContaining([expect.objectContaining({ armId: "control", isControl: true, evalRunId: id(19) })]),
    );
    expect(full.arms[0]).toMatchObject({
      configurationArtifact: { artifactId: id(20) },
      policyArtifact: { artifactId: id(21) },
    });
    const publicJson = JSON.stringify({ summary, full });
    for (const omitted of [
      "objectKey",
      "private/",
      "signatureBase64",
      "fixture-key",
      "summaryArtifact",
      "provenanceArtifact",
      "runnerPayload",
    ])
      expect(publicJson).not.toContain(omitted);
  });
  it("rejects invalid input before I/O and hides missing or incomplete repository state", async () => {
    const value = subject();
    await expect(value.read.getRun({ tenantId: "no", runId })).rejects.toMatchObject({ code: "INVALID" });
    expect(value.port.loadVerifiedBenchmarkPublication).not.toHaveBeenCalled();
    vi.mocked(value.port.loadVerifiedBenchmarkPublication).mockRejectedValueOnce(
      new Error("VERIFICATION_BENCHMARK_RUN_NOT_FOUND"),
    );
    await expect(value.read.getRun({ tenantId, runId })).rejects.toEqual(
      expect.objectContaining<Partial<VerificationBenchmarkReadError>>({ code: "NOT_FOUND" }),
    );
    vi.mocked(value.port.loadVerifiedBenchmarkPublication).mockRejectedValueOnce(
      new Error("private cancelled operation"),
    );
    await expect(value.read.getRun({ tenantId, runId })).rejects.toMatchObject({
      code: "INTEGRITY",
      message: "VERIFICATION_BENCHMARK_READ_INTEGRITY",
    });
  });
  it("rejects tenant, signature, and canonical arm binding drift", async () => {
    for (const changed of [
      { ...manifest(), tenantId: id(90) },
      { ...manifest(), seal: { payloadDigest: digest("f") } },
      { ...manifest(), arms: [...manifest().arms, { ...manifest().arms[1]!, armId: "control" }] },
    ])
      await expect(
        subject(changed as VerificationBenchmarkPublicationManifest).read.getManifest({ tenantId, runId }),
      ).rejects.toMatchObject({ code: "INTEGRITY" });
  });
});
