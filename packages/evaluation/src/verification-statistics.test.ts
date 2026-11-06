import { describe, expect, it } from "vitest";
import {
  holmAdjustment,
  mcnemarExact,
  pairedClusterBootstrap,
  pairedSignFlipTest,
  verificationCalibration,
  verificationRiskCoverage,
  wilson95,
} from "./verification-statistics.js";
describe("verification statistics", () => {
  it("runs reproducible paired sign-flip tests and preserves null effects", () => {
    expect(pairedSignFlipTest([0, 0, 0], { seed: 4, permutations: 100 })).toMatchObject({
      estimate: 0,
      pValue: 1,
      permutations: 0,
      method: "degenerate",
    });
    const unit = pairedSignFlipTest([1, 1, 1, 1], { seed: 4, permutations: 100 });
    expect(unit).toMatchObject({
      pValue: 0.125,
      permutations: 16,
      extreme: 2,
      method: "exact_enumeration",
      nullHypothesis: "cluster_differences_are_sign_exchangeable",
    });
    expect(unit).toEqual(pairedSignFlipTest([1, 1, 1, 1], { seed: 4, permutations: 100 }));
    expect(pairedSignFlipTest([1e-20, 1e-20], { seed: 4, permutations: 100 }).pValue).toBe(
      pairedSignFlipTest([1, 1], { seed: 4, permutations: 100 }).pValue,
    );
    expect(pairedSignFlipTest([1e6, 1e6], { seed: 4, permutations: 100 }).pValue).toBe(
      pairedSignFlipTest([1, 1], { seed: 4, permutations: 100 }).pValue,
    );
    expect(
      pairedSignFlipTest(
        Array.from({ length: 17 }, () => 1),
        { seed: 4, permutations: 100 },
      ),
    ).toMatchObject({ method: "monte_carlo", monteCarloCorrection: "plus_one", permutations: 100 });
  });
  it("does not turn zero samples or zero observed failures into perfect certainty", () => {
    expect(wilson95(0, 0).upper).toBeNull();
    expect(wilson95(0, 40).upper).toBeCloseTo(0.08762160119728664, 12);
    expect(wilson95(40, 40).lower).toBeCloseTo(1 - 0.08762160119728664, 12);
    expect(() => wilson95(41, 40)).toThrow();
    for (let total = 1; total <= 100; total++) {
      expect(wilson95(0, total).lower).toBe(0);
      expect(wilson95(total, total).upper).toBe(1);
    }
  });
  it("uses exact discordant-pair probability and retains underflow information", () => {
    expect(mcnemarExact(1, 9).pValue).toBeCloseTo(0.021484375, 12);
    expect(mcnemarExact(9, 1)).toEqual(mcnemarExact(1, 9));
    expect(mcnemarExact(0, 0).pValue).toBe(1);
    expect(mcnemarExact(0, 2000).numericalUnderflow).toBe(true);
    expect(Number.isFinite(mcnemarExact(0, 2000).logPValue)).toBe(true);
  });
  it("keeps pairs and source clusters together with reproducible order-independent resampling", () => {
    const rows = [
      ...Array.from({ length: 50 }, (_, index) => ({
        caseId: `a${index}`,
        clusterId: "source1",
        baseline: 0,
        candidate: 1,
      })),
      { caseId: "negative", clusterId: "source2", baseline: 1, candidate: 0 },
    ];
    const result = pairedClusterBootstrap(rows, { seed: 7 });
    expect(result.estimate).toBeCloseTo(49 / 51);
    expect(result.lower).toBe(-1);
    expect(result.upper).toBe(1);
    expect(result).toEqual(pairedClusterBootstrap([...rows].reverse(), { seed: 7 }));
    const inverse = pairedClusterBootstrap(
      rows.map((row) => ({ ...row, baseline: row.candidate, candidate: row.baseline })),
      { seed: 7 },
    );
    expect(inverse.lower).toBeCloseTo(-result.upper!);
    expect(inverse.upper).toBeCloseTo(-result.lower!);
    expect(pairedClusterBootstrap(rows.slice(0, 2), { seed: 7 }).lower).toBeNull();
    expect(() => pairedClusterBootstrap([rows[0]!, rows[0]!], { seed: 7 })).toThrow();
  });
  it("reports calibration denominators and admits confidence ties as a group", () => {
    const observations = [
      { probability: 0.9, correct: true },
      { probability: 0.9, correct: false },
      { probability: 0.1, correct: false },
    ];
    expect(verificationCalibration(observations).brier).toBeCloseTo(0.83 / 3);
    const curve = verificationRiskCoverage(observations);
    expect(curve).toHaveLength(3);
    expect(curve[1]?.accepted).toBe(2);
    expect(curve[1]?.risk).toBe(0.5);
    expect(verificationCalibration([]).brier).toBeNull();
    expect(verificationRiskCoverage([])[0]?.risk).toBeNull();
  });
  it("adjusts a whole declared hypothesis family and rejects duplicates", () => {
    expect(
      holmAdjustment([
        { id: "a", pValue: 0.01 },
        { id: "b", pValue: 0.04 },
        { id: "c", pValue: 0.03 },
      ]).map((x) => x.adjustedPValue),
    ).toEqual([0.03, 0.06, 0.06]);
    expect(() =>
      holmAdjustment([
        { id: "a", pValue: 0.01 },
        { id: "a", pValue: 0.02 },
      ]),
    ).toThrow();
  });
});
