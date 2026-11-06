import { describe, expect, it } from "vitest";
import { VerificationBenchmarkComparisonProfileSchema } from "./benchmark-comparison.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const profile = (profileId: "paired_default" | "regression_gate" = "paired_default") => ({
  schemaVersion: "verification-benchmark-comparison-profile.v1",
  verificationContractVersion: "verification.v1",
  tenantId,
  profileId,
  version: 1,
  armPairs: [
    { pairId: "baseline", baselineArmId: "baseline", candidateArmId: "baseline" },
    { pairId: "candidate", baselineArmId: "candidate", candidateArmId: "candidate" },
  ],
  clusterUnit: "source_family",
  seed: 17,
  bootstrapReplicates: 2_000,
  correction: "holm",
  primaryMetric: "engineering_expectation_agreement",
  regressionGate: profileId === "regression_gate" ? { maximumAllowedObservedDecrease: 0.01 } : null,
});

describe("verification benchmark comparison profile", () => {
  it("admits same-ID cross-run arm pairs and both fixed profile modes", () => {
    expect(VerificationBenchmarkComparisonProfileSchema.parse(profile()).armPairs[0]).toMatchObject({
      baselineArmId: "baseline",
      candidateArmId: "baseline",
    });
    expect(VerificationBenchmarkComparisonProfileSchema.parse(profile("regression_gate")).regressionGate).toEqual({
      maximumAllowedObservedDecrease: 0.01,
    });
  });

  it("binds gate presence to the registered profile ID", () => {
    expect(() =>
      VerificationBenchmarkComparisonProfileSchema.parse({
        ...profile(),
        regressionGate: { maximumAllowedObservedDecrease: 0 },
      }),
    ).toThrow();
    expect(() =>
      VerificationBenchmarkComparisonProfileSchema.parse({ ...profile("regression_gate"), regressionGate: null }),
    ).toThrow();
  });

  it("rejects duplicate IDs, duplicate ordered pairs and unknown profile fields", () => {
    const duplicateId = profile();
    duplicateId.armPairs[1] = { ...duplicateId.armPairs[1]!, pairId: duplicateId.armPairs[0]!.pairId };
    expect(() => VerificationBenchmarkComparisonProfileSchema.parse(duplicateId)).toThrow(/pair IDs must be unique/);
    const duplicatePair = profile();
    duplicatePair.armPairs[1] = { ...duplicatePair.armPairs[0]!, pairId: "other" };
    expect(() => VerificationBenchmarkComparisonProfileSchema.parse(duplicatePair)).toThrow(
      /ordered arm pairs must be unique/,
    );
    expect(() => VerificationBenchmarkComparisonProfileSchema.parse({ ...profile(), callerThreshold: 1 })).toThrow();
  });

  it("enforces bounded deterministic statistics settings", () => {
    expect(() => VerificationBenchmarkComparisonProfileSchema.parse({ ...profile(), seed: 0x1_0000_0000 })).toThrow();
    expect(() =>
      VerificationBenchmarkComparisonProfileSchema.parse({ ...profile(), bootstrapReplicates: 99 }),
    ).toThrow();
    expect(() =>
      VerificationBenchmarkComparisonProfileSchema.parse({
        ...profile("regression_gate"),
        regressionGate: { maximumAllowedObservedDecrease: 1.01 },
      }),
    ).toThrow();
  });
});
