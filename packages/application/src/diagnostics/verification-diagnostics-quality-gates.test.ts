import { describe, expect, it } from "vitest";
import {
  DIAGNOSTICS_FULL_DEMO_GATE_IDS,
  evaluateDiagnosticsFullDemoQualityGate,
  type DiagnosticsFullDemoGateObservation,
} from "./verification-diagnostics-quality-gates.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const complete = (
  outcome: DiagnosticsFullDemoGateObservation["outcome"] = "passed",
): DiagnosticsFullDemoGateObservation[] =>
  DIAGNOSTICS_FULL_DEMO_GATE_IDS.map((gateId) => ({ gateId, outcome, evidence: [`receipt:${gateId}`] }));
const input = (observations: readonly DiagnosticsFullDemoGateObservation[]) =>
  ({
    datasetManifestDigest: digest("a"),
    runManifestDigest: digest("b"),
    observations,
  }) satisfies Parameters<typeof evaluateDiagnosticsFullDemoQualityGate>[0];

describe("diagnostics full-demo quality gate", () => {
  it("allows exit 0 only for a complete, passed full-demo record without admission", () => {
    const result = evaluateDiagnosticsFullDemoQualityGate(input(complete()));
    expect(result).toMatchObject({
      outcome: "pass",
      exitCode: 0,
      admissionChanged: false,
      humanGoldScoringEligible: false,
      labelBoundary: "engineering_expectations_only",
    });
    expect(result.gates).toHaveLength(DIAGNOSTICS_FULL_DEMO_GATE_IDS.length);
  });

  it("reports a measured completed gate failure as exit 1 only with complete coverage", () => {
    const observations = complete();
    observations[5] = { ...observations[5]!, outcome: "failed", reason: "MUTATION_EXPECTATION_MISMATCH" };
    expect(evaluateDiagnosticsFullDemoQualityGate(input(observations))).toMatchObject({
      outcome: "fail",
      exitCode: 1,
      reasons: ["adversarial_mutations:MUTATION_EXPECTATION_MISMATCH"],
    });
  });

  it("classifies an unavailable required path as configuration-incomplete with precedence over a measured failure", () => {
    const observations = complete();
    observations[0] = { ...observations[0]!, outcome: "failed", reason: "TAMPERED" };
    observations[10] = { ...observations[10]!, outcome: "unavailable", reason: "RECORDED_OUTPUTS_ABSENT" };
    expect(evaluateDiagnosticsFullDemoQualityGate(input(observations))).toMatchObject({
      outcome: "unavailable",
      exitCode: 2,
      reasons: ["provider_arm_execution:RECORDED_OUTPUTS_ABSENT"],
    });
  });

  it.each([
    ["missing", complete().slice(1), "GATE_MISSING:catalog_preparation_integrity"],
    ["duplicate", [...complete(), { ...complete()[0]! }], "GATE_DUPLICATE:catalog_preparation_integrity"],
    [
      "unknown",
      [...complete(), { gateId: "caller_scope_exclusion", outcome: "passed" as const, evidence: ["nope"] }],
      "GATE_UNKNOWN:caller_scope_exclusion",
    ],
    [
      "malformed",
      complete().map((item, index) => (index === 0 ? { ...item, evidence: [] } : item)),
      "GATE_RECORD_INVALID:catalog_preparation_integrity",
    ],
  ])("rejects %s gate records as unavailable", (_name, observations, reason) => {
    expect(evaluateDiagnosticsFullDemoQualityGate(input(observations))).toMatchObject({
      outcome: "unavailable",
      exitCode: 2,
      reasons: expect.arrayContaining([reason]),
    });
  });

  it("rejects an attempt to claim human gold or admission movement", () => {
    expect(
      evaluateDiagnosticsFullDemoQualityGate({
        ...input(complete()),
        admissionChanged: true as never,
        humanGoldScoringEligible: true as never,
      }),
    ).toMatchObject({
      outcome: "unavailable",
      exitCode: 2,
      reasons: expect.arrayContaining(["ADMISSION_CHANGE_FORBIDDEN", "HUMAN_GOLD_ELIGIBILITY_FORBIDDEN"]),
    });
  });
});
