/**
 * The frozen diagnostics pack may be assessed against engineering expectations,
 * but this gate never admits a policy result or promotes those expectations to
 * human gold. Callers must supply an observation for every required full-demo
 * obligation; there is no caller-selectable subset.
 */
export const DIAGNOSTICS_FULL_DEMO_GATE_IDS = Object.freeze([
  "catalog_preparation_integrity",
  "extraction_verification",
  "selector_resolution",
  "count_timeline_conflicts_visible",
  "authority_and_applicability_boundaries",
  "adversarial_mutations",
  "report_generation_and_citations",
  "deterministic_replay",
  "verdict_fragment_navigation",
  "offline_artifact_set",
  "provider_arm_execution",
  "semantic_claim_report_coverage",
  "live_refresh_immutable_diff",
] as const);

export type DiagnosticsFullDemoGateId = (typeof DIAGNOSTICS_FULL_DEMO_GATE_IDS)[number];
export type DiagnosticsFullDemoGateObservationOutcome = "passed" | "failed" | "unavailable";
export type DiagnosticsFullDemoGateOutcome = "pass" | "fail" | "unavailable";

export interface DiagnosticsFullDemoGateObservation {
  readonly gateId: string;
  readonly outcome: DiagnosticsFullDemoGateObservationOutcome;
  /** Compact evidence references or stable codes; never raw source content. */
  readonly evidence: readonly string[];
  readonly reason?: string;
}

export interface DiagnosticsFullDemoQualityGateInput {
  readonly datasetManifestDigest: string;
  readonly runManifestDigest: string;
  readonly observations: readonly DiagnosticsFullDemoGateObservation[];
  readonly admissionChanged?: false;
  readonly humanGoldScoringEligible?: false;
  readonly labelBoundary?: "engineering_expectations_only";
}

export interface DiagnosticsFullDemoQualityGateResult {
  readonly schemaVersion: "verification-diagnostics-full-demo-quality-gate.v1";
  readonly outcome: DiagnosticsFullDemoGateOutcome;
  readonly exitCode: 0 | 1 | 2;
  readonly admissionChanged: false;
  readonly humanGoldScoringEligible: false;
  readonly labelBoundary: "engineering_expectations_only";
  readonly datasetManifestDigest: string;
  readonly runManifestDigest: string;
  readonly gates: readonly DiagnosticsFullDemoGateObservation[];
  readonly reasons: readonly string[];
}

const digest = (value: unknown): value is `sha256:${string}` =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const string = (value: unknown, maximum: number) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const knownGateIds = new Set<string>(DIAGNOSTICS_FULL_DEMO_GATE_IDS);

function invalidResult(
  input: DiagnosticsFullDemoQualityGateInput,
  reasons: readonly string[],
): DiagnosticsFullDemoQualityGateResult {
  return Object.freeze({
    schemaVersion: "verification-diagnostics-full-demo-quality-gate.v1",
    outcome: "unavailable",
    exitCode: 2,
    admissionChanged: false,
    humanGoldScoringEligible: false,
    labelBoundary: "engineering_expectations_only",
    datasetManifestDigest: typeof input.datasetManifestDigest === "string" ? input.datasetManifestDigest : "",
    runManifestDigest: typeof input.runManifestDigest === "string" ? input.runManifestDigest : "",
    gates: Object.freeze([]),
    reasons: Object.freeze([...reasons]),
  });
}

/**
 * Classifies complete frozen-demo evidence without running verification. A
 * missing execution path is configuration-incomplete (2), a measured failure
 * after complete coverage is a quality failure (1), and only full pass is 0.
 */
export function evaluateDiagnosticsFullDemoQualityGate(
  input: DiagnosticsFullDemoQualityGateInput,
): DiagnosticsFullDemoQualityGateResult {
  const invalid: string[] = [];
  if (!digest(input.datasetManifestDigest)) invalid.push("DATASET_MANIFEST_DIGEST_INVALID");
  if (!digest(input.runManifestDigest)) invalid.push("RUN_MANIFEST_DIGEST_INVALID");
  if (input.admissionChanged !== undefined && input.admissionChanged !== false)
    invalid.push("ADMISSION_CHANGE_FORBIDDEN");
  if (input.humanGoldScoringEligible !== undefined && input.humanGoldScoringEligible !== false)
    invalid.push("HUMAN_GOLD_ELIGIBILITY_FORBIDDEN");
  if (input.labelBoundary !== undefined && input.labelBoundary !== "engineering_expectations_only")
    invalid.push("LABEL_BOUNDARY_INVALID");
  if (!Array.isArray(input.observations)) invalid.push("GATE_OBSERVATIONS_INVALID");
  if (invalid.length > 0) return invalidResult(input, invalid);

  const byId = new Map<string, DiagnosticsFullDemoGateObservation>();
  for (const observation of input.observations) {
    if (!observation || typeof observation !== "object") {
      invalid.push("GATE_RECORD_INVALID");
      continue;
    }
    if (!knownGateIds.has(observation.gateId)) {
      invalid.push(`GATE_UNKNOWN:${String(observation.gateId)}`);
      continue;
    }
    if (byId.has(observation.gateId)) {
      invalid.push(`GATE_DUPLICATE:${observation.gateId}`);
      continue;
    }
    if (
      !(["passed", "failed", "unavailable"] as const).includes(observation.outcome) ||
      !Array.isArray(observation.evidence) ||
      observation.evidence.length === 0 ||
      observation.evidence.length > 24 ||
      observation.evidence.some((item) => !string(item, 240)) ||
      (observation.reason !== undefined && !string(observation.reason, 500))
    ) {
      invalid.push(`GATE_RECORD_INVALID:${observation.gateId}`);
      continue;
    }
    byId.set(
      observation.gateId,
      Object.freeze({
        gateId: observation.gateId,
        outcome: observation.outcome,
        evidence: Object.freeze([...observation.evidence]),
        ...(observation.reason === undefined ? {} : { reason: observation.reason }),
      }),
    );
  }
  for (const gateId of DIAGNOSTICS_FULL_DEMO_GATE_IDS) if (!byId.has(gateId)) invalid.push(`GATE_MISSING:${gateId}`);
  if (invalid.length > 0) return invalidResult(input, invalid);

  const gates = Object.freeze(DIAGNOSTICS_FULL_DEMO_GATE_IDS.map((gateId) => byId.get(gateId)!));
  const unavailable = gates.filter((gate) => gate.outcome === "unavailable");
  const failed = gates.filter((gate) => gate.outcome === "failed");
  const outcome: DiagnosticsFullDemoGateOutcome =
    unavailable.length > 0 ? "unavailable" : failed.length > 0 ? "fail" : "pass";
  const reasons =
    outcome === "pass"
      ? ["FULL_DEMO_GATE_PASSED"]
      : (outcome === "unavailable" ? unavailable : failed).map(
          (gate) => `${gate.gateId}:${gate.reason ?? gate.outcome.toUpperCase()}`,
        );
  return Object.freeze({
    schemaVersion: "verification-diagnostics-full-demo-quality-gate.v1",
    outcome,
    exitCode: outcome === "pass" ? 0 : outcome === "fail" ? 1 : 2,
    admissionChanged: false,
    humanGoldScoringEligible: false,
    labelBoundary: "engineering_expectations_only",
    datasetManifestDigest: input.datasetManifestDigest,
    runManifestDigest: input.runManifestDigest,
    gates,
    reasons: Object.freeze(reasons),
  });
}
