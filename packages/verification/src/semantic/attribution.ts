export interface AttributionPerturbationObservation {
  readonly assertionId: string;
  readonly baselineVerdict: string;
  readonly deletionVerdict: string;
  readonly replacementVerdict: string;
  readonly reorderedVerdict: string;
}

export function summarizeAttributionPerturbations(observations: readonly AttributionPerturbationObservation[]): {
  readonly status: "audit_metric_only";
  readonly sampleSize: number;
  readonly claimSurvivalRate: number | null;
  readonly flipRate: number | null;
  readonly evidenceSensitivityRate: number | null;
  readonly causalProof: false;
} {
  if (new Set(observations.map((item) => item.assertionId)).size !== observations.length)
    throw new Error("ATTRIBUTION_ASSERTION_DUPLICATE");
  if (observations.length === 0)
    return Object.freeze({
      status: "audit_metric_only",
      sampleSize: 0,
      claimSurvivalRate: null,
      flipRate: null,
      evidenceSensitivityRate: null,
      causalProof: false,
    });
  const survives = observations.filter((item) => item.deletionVerdict === item.baselineVerdict).length;
  const flips = observations.filter(
    (item) => item.deletionVerdict !== item.baselineVerdict || item.replacementVerdict !== item.baselineVerdict,
  ).length;
  const sensitive = observations.filter(
    (item) =>
      item.deletionVerdict !== item.baselineVerdict ||
      item.replacementVerdict !== item.baselineVerdict ||
      item.reorderedVerdict !== item.baselineVerdict,
  ).length;
  return Object.freeze({
    status: "audit_metric_only",
    sampleSize: observations.length,
    claimSurvivalRate: survives / observations.length,
    flipRate: flips / observations.length,
    evidenceSensitivityRate: sensitive / observations.length,
    causalProof: false,
  });
}
