import { describe, expect, it, vi } from "vitest";
import {
  VerificationBenchmarkEngineeringMetricSchema,
  type VerificationArtifactHandle,
  type VerificationBenchmarkComparisonPublication,
} from "@aiengineer/knowledge-contracts";
import {
  VerificationBenchmarkComparisonReadService,
  type VerifiedBenchmarkComparisonReadSnapshot,
} from "./verification-benchmark-comparison-reads.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1),
  comparisonId = id(3),
  digest = `sha256:${"a".repeat(64)}`,
  time = "2026-09-06T00:00:00.000Z";
function artifact(n: number): VerificationArtifactHandle {
  return {
    artifactId: id(n),
    tenantId,
    digest,
    mediaType: "application/json",
    byteLength: 2,
    objectKey: `private/${id(n)}`,
    createdAt: time,
    producerActivityId: "fixture",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "restricted",
    parentArtifactIds: [],
  };
}
function fixture(): VerifiedBenchmarkComparisonReadSnapshot {
  const manifest: VerificationBenchmarkComparisonPublication = {
    schemaVersion: "verification-benchmark-comparison-publication.v1",
    verificationContractVersion: "verification.v1",
    tenantId,
    operationId: id(2),
    comparisonId,
    requestDigest: digest,
    baseline: { runId: id(4), publicationArtifact: artifact(5), payloadDigest: digest },
    candidate: { runId: id(6), publicationArtifact: artifact(7), payloadDigest: digest },
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
    qualityClaims: { humanGoldValidated: false, sourceAuthorityAssessed: false, calibrated: false },
    startedAt: time,
    completedAt: time,
    seal: {
      payloadDigest: digest,
      signature: { algorithm: "Ed25519", keyId: "fixture-key", signatureBase64: `${"A".repeat(86)}==` },
    },
  };
  const metrics = Object.fromEntries(
    VerificationBenchmarkEngineeringMetricSchema.options.map((metric) => [
      metric,
      {
        denominator: 4,
        baseline: { successes: 1, denominator: 4, estimate: 0.25, lower: 0.01, upper: 0.7, total: 4 },
        candidate: { successes: 2, denominator: 4, estimate: 0.5, lower: 0.1, upper: 0.9, total: 4 },
        delta: 0.25,
        regressionObservation: "observed_improvement",
        clusterBootstrap: {
          estimate: 0.25,
          lower: 0,
          upper: 0.5,
          clusters: 2,
          cases: 4,
          resamples: 100,
          seed: 7,
          limitation: null,
        },
        mcnemar: { pValue: 1, discordantPairs: 1 },
        pairedClusterSignFlip: { pValue: 0.5, method: "exact" },
      },
    ]),
  );
  const tests = VerificationBenchmarkEngineeringMetricSchema.options.flatMap((metric) =>
    ["mcnemar", "cluster_sign_flip"].map((test) => ({ id: `pair:${metric}:${test}`, pValue: 1, adjustedPValue: 1 })),
  );
  return {
    publicationArtifact: artifact(11),
    manifest,
    signatureStatus: "verified",
    result: {
      privateKey: "must-not-project",
      pairComparisons: [
        {
          pairId: "pair",
          comparison: {
            pairing: {
              caseCount: 4,
              clusterCount: 2,
              clusterUnit: "source_family",
              clusterIndependenceAssessed: false,
              repetitionCount: 1,
            },
            metrics,
          },
        },
      ],
      globalInference: { hypothesisFamily: "registered_profile_pair_metric_tests.v1", correction: "holm", tests },
    },
  };
}
function subject(snapshot = fixture()) {
  const loadVerifiedBenchmarkComparison = vi.fn(async () => snapshot);
  return {
    load: loadVerifiedBenchmarkComparison,
    service: new VerificationBenchmarkComparisonReadService({ loadVerifiedBenchmarkComparison }),
  };
}
describe("comparison statistics read projection", () => {
  it("preserves paired statistics and explicit claim limits while removing private custody", async () => {
    const value = await subject().service.getComparison({ tenantId, comparisonId });
    expect(value.pairs[0]?.metrics).toHaveLength(9);
    expect(value.pairs[0]?.metrics[0]).toMatchObject({
      denominator: 4,
      baseline: { successes: 1, estimate: 0.25 },
      candidate: { successes: 2, estimate: 0.5 },
      delta: 0.25,
      mcnemarPValue: 1,
      clusterSignFlipPValue: 0.5,
      clusterBootstrap: { clusters: 2, cases: 4 },
    });
    expect(value.globalInference.tests).toHaveLength(18);
    expect(value.qualityClaims).toEqual({
      humanGoldValidated: false,
      sourceAuthorityAssessed: false,
      calibrated: false,
    });
    expect(value.statisticalScope).toBe("paired_engineering_observations_without_assessed_cluster_independence");
    for (const privateField of ["objectKey", "private/", "signatureBase64", "fixture-key", "privateKey", "runtime"])
      expect(JSON.stringify(value)).not.toContain(privateField);
  });
  it("rejects malformed identifiers before any repository access", async () => {
    const value = subject();
    await expect(value.service.getComparison({ tenantId: "bad", comparisonId })).rejects.toMatchObject({
      code: "INVALID",
    });
    await expect(value.service.getComparison({ tenantId, comparisonId: "bad" })).rejects.toMatchObject({
      code: "INVALID",
    });
    expect(value.load).not.toHaveBeenCalled();
  });
  it("fails closed on wrong tenant, comparison identity, unsigned publication, or missing metrics", async () => {
    const variants = [fixture(), fixture(), fixture(), fixture()];
    variants[0]!.manifest.tenantId = id(90);
    variants[1]!.manifest.comparisonId = id(91);
    delete variants[2]!.manifest.seal.signature;
    const invalid = variants[3]!.result as { pairComparisons: { comparison: { metrics: Record<string, unknown> } }[] };
    delete invalid.pairComparisons[0]!.comparison.metrics[VerificationBenchmarkEngineeringMetricSchema.options[0]!];
    for (const snapshot of variants)
      await expect(subject(snapshot).service.getComparison({ tenantId, comparisonId })).rejects.toMatchObject({
        code: "INTEGRITY",
        message: "VERIFICATION_BENCHMARK_COMPARISON_READ_INTEGRITY",
      });
  });
});
