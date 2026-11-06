import { replayPrototypeArithmetic, type PrototypeArithmeticExpression } from "./arithmetic.js";
import { prototypeSha256 } from "./digest.js";
import { resolvePrototypeJsonPointer } from "./json-pointer.js";
import { resolvePrototypeTextLocator } from "./text-locator.js";

/**
 * Offline translation boundary for `verification-bundle-0.1.0` experiments.
 * It only reproduces unauthenticated prototype mechanics. It does not create a
 * KS provenance binding, semantic verdict, runtime-principal attestation, or a
 * policy admission decision.
 */
type Status = "passed" | "failed" | "review_required";
type Locator =
  | {
      readonly kind: "text_quote";
      readonly quote: string;
      readonly claimedStart?: number;
      readonly claimedEnd?: number;
      readonly offsetBasis: "raw_utf16" | "lf_normalized" | "lf_normalized_newlines_collapsed";
    }
  | {
      readonly kind: "json_pointer";
      readonly pointer: string;
      readonly expectedValue?: unknown;
    };
type Evidence = {
  readonly evidenceId: string;
  readonly captureId: string;
  readonly locator: Locator;
  readonly expectedSelectedContentSha256?: string;
};
type Capture = {
  readonly captureId: string;
  readonly content: string;
  readonly contentSha256: string;
};
type PrototypeBundle = {
  readonly schemaVersion: "verification-bundle-0.1.0";
  readonly policyVersion: string;
  readonly producer: {
    readonly deploymentId: string;
    readonly attemptId: string;
  };
  readonly verifier: {
    readonly deploymentId: string;
    readonly attemptId: string;
  };
  readonly captures: readonly Capture[];
  readonly claims: readonly {
    readonly claimId: string;
    readonly composite: boolean;
    readonly evidence: readonly Evidence[];
  }[];
  readonly metrics: readonly {
    readonly observationId: string;
    readonly entity: { readonly kind: string; readonly canonicalId: string };
    readonly metricDefinitionVersion: string;
    readonly provider: string;
    readonly comparabilityKey: string;
    readonly observedAt: string;
    readonly periodStart?: string;
    readonly periodEnd?: string;
    readonly value: number;
    readonly captureId: string;
    readonly evidence: Evidence;
    readonly methodology: {
      readonly acquisition: string;
      readonly extraction: string;
      readonly normalization: string;
      readonly calculation: string;
    };
    readonly arithmeticProof?: {
      readonly expression: PrototypeArithmeticExpression;
      readonly operands: readonly number[];
      readonly expectedResult: number;
      readonly tolerance: number;
    };
  }[];
};

const check = (code: string, passed: boolean, detail: string) => ({
  code,
  passed,
  deterministic: true,
  detail,
});

function resolveEvidence(capture: Capture | undefined, evidence: Evidence) {
  if (!capture)
    return {
      evidenceId: evidence.evidenceId,
      mechanicalStatus: "failed" as const,
      resolvedLocator: {
        matchMode: "not_found" as const,
        start: null,
        end: null,
        selectedContentSha256: null,
        occurrenceCount: 0,
      },
      checks: [check("CAPTURE_PRESENT", false, `Capture ${evidence.captureId} is missing.`)],
    };
  const resolved =
    evidence.locator.kind === "text_quote"
      ? {
          ...resolvePrototypeTextLocator(capture.content, evidence.locator),
          value: evidence.locator.quote,
        }
      : resolvePrototypeJsonPointer(capture.content, evidence.locator.pointer);
  const captureHashMatches = prototypeSha256(capture.content) === capture.contentSha256;
  const uniquelyResolved =
    resolved.matchMode === "exact" || resolved.matchMode === "normalized" || resolved.matchMode === "json_pointer";
  const claimedOffsetsMatch =
    evidence.locator.kind !== "text_quote" ||
    evidence.locator.claimedStart === undefined ||
    evidence.locator.claimedEnd === undefined ||
    (evidence.locator.claimedStart === resolved.start && evidence.locator.claimedEnd === resolved.end);
  const selectedHashMatches =
    evidence.expectedSelectedContentSha256 === undefined ||
    evidence.expectedSelectedContentSha256 === resolved.selectedContentSha256;
  const expectedValueMatches =
    evidence.locator.kind !== "json_pointer" ||
    evidence.locator.expectedValue === undefined ||
    JSON.stringify(evidence.locator.expectedValue) === JSON.stringify(resolved.value);
  const checks = [
    check(
      "CAPTURE_HASH_MATCH",
      captureHashMatches,
      captureHashMatches
        ? "Capture bytes match the declared SHA-256."
        : "Capture bytes do not match the declared SHA-256.",
    ),
    check(
      "LOCATOR_UNIQUE",
      uniquelyResolved,
      uniquelyResolved
        ? `Quote resolved once using ${resolved.matchMode} matching.`
        : `Quote resolution returned ${resolved.matchMode} with ${resolved.occurrenceCount} occurrences.`,
    ),
    check(
      "CLAIMED_OFFSETS_MATCH",
      claimedOffsetsMatch,
      claimedOffsetsMatch
        ? "Claimed offsets match the deterministic resolution or were omitted."
        : `Claimed offsets do not match deterministic offsets ${resolved.start}:${resolved.end}.`,
    ),
    check(
      "SELECTED_CONTENT_HASH_MATCH",
      selectedHashMatches,
      selectedHashMatches ? "Selected content hash matches or was not predeclared." : "Selected content hash differs.",
    ),
    check(
      "EXPECTED_VALUE_MATCH",
      expectedValueMatches,
      expectedValueMatches
        ? "Resolved value matches or no expected value was declared."
        : "Resolved JSON value differs from the declared expected value.",
    ),
  ];
  const failed = checks.some((item) => !item.passed);
  return {
    evidenceId: evidence.evidenceId,
    mechanicalStatus: failed
      ? ("failed" as const)
      : resolved.matchMode === "normalized"
        ? ("review_required" as const)
        : ("passed" as const),
    resolvedLocator: {
      matchMode: resolved.matchMode,
      start: resolved.start,
      end: resolved.end,
      selectedContentSha256: resolved.selectedContentSha256,
      occurrenceCount: resolved.occurrenceCount,
    },
    checks,
  };
}

/** Returns the exact legacy result shape; callers must validate their legacy schema. */
export function verifyPrototypeBundle(input: PrototypeBundle): unknown {
  const captures = new Map(input.captures.map((capture) => [capture.captureId, capture]));
  const independent = input.producer.deploymentId !== input.verifier.deploymentId;
  const reviewReasons: string[] = independent ? [] : ["Producer and verifier deployment IDs are identical."];
  const claims = input.claims.map((claim) => {
    const evidence = claim.evidence.map((reference) => resolveEvidence(captures.get(reference.captureId), reference));
    const checks = [
      check(
        "PRODUCER_VERIFIER_INDEPENDENT",
        independent,
        independent ? "Deployments are independent." : "The same deployment produced and verified the claim.",
      ),
      check(
        "CLAIM_ATOMIC",
        !claim.composite,
        !claim.composite
          ? "Claim is declared atomic."
          : "Composite claim requires decomposition before semantic verification.",
      ),
      check("EVIDENCE_PRESENT", evidence.length > 0, `${evidence.length} evidence reference(s) supplied.`),
    ];
    const mechanicalStatus: Status =
      checks.some((item) => !item.passed) || evidence.some((item) => item.mechanicalStatus === "failed")
        ? "failed"
        : evidence.some((item) => item.mechanicalStatus === "review_required")
          ? "review_required"
          : "passed";
    if (mechanicalStatus !== "passed")
      reviewReasons.push(`Claim ${claim.claimId} failed or requires mechanical review.`);
    return {
      claimId: claim.claimId,
      mechanicalStatus,
      supportVerdict: "pending_semantic_review" as const,
      evidence,
      checks,
    };
  });
  const metrics = input.metrics.map((metric) => {
    const evidence = resolveEvidence(captures.get(metric.captureId), metric.evidence);
    const proof = metric.arithmeticProof;
    const calculated = proof ? replayPrototypeArithmetic(proof.expression, proof.operands) : metric.value;
    const arithmeticMatches = proof
      ? Number.isFinite(calculated) && Math.abs(calculated - proof.expectedResult) <= proof.tolerance
      : true;
    const valueMatchesProof = proof ? Math.abs(metric.value - proof.expectedResult) <= proof.tolerance : true;
    const periodValid =
      !metric.periodStart || !metric.periodEnd || Date.parse(metric.periodStart) <= Date.parse(metric.periodEnd);
    const checks = [
      check(
        "PRODUCER_VERIFIER_INDEPENDENT",
        independent,
        independent ? "Deployments are independent." : "Metric was self-verified.",
      ),
      check(
        "ENTITY_ID_EXPLICIT",
        metric.entity.canonicalId.length > 0,
        `Entity is ${metric.entity.kind}:${metric.entity.canonicalId}.`,
      ),
      check(
        "COMPARABILITY_KEY_PRESENT",
        metric.comparabilityKey.length > 0,
        `Comparability key is ${metric.comparabilityKey}.`,
      ),
      check(
        "OBSERVATION_PERIOD_VALID",
        periodValid,
        periodValid ? "Observation period is ordered." : "Observation period ends before it starts.",
      ),
      check(
        "EVIDENCE_MECHANICALLY_VALID",
        evidence.mechanicalStatus !== "failed",
        `Evidence status is ${evidence.mechanicalStatus}.`,
      ),
      check(
        "ARITHMETIC_REPLAYS",
        arithmeticMatches,
        proof
          ? `Replayed result is ${calculated}; expected ${proof.expectedResult}.`
          : "No derived arithmetic was declared.",
      ),
      check(
        "OBSERVED_VALUE_MATCHES_PROOF",
        valueMatchesProof,
        proof
          ? `Observed value is ${metric.value}; proof result is ${proof.expectedResult}.`
          : "Metric is a direct observation.",
      ),
    ];
    const status: Status = checks.some((item) => !item.passed)
      ? "failed"
      : evidence.mechanicalStatus === "review_required"
        ? "review_required"
        : "passed";
    if (status !== "passed") reviewReasons.push(`Metric ${metric.observationId} failed or requires review.`);
    return {
      observationId: metric.observationId,
      status,
      checks,
      reproducibility: {
        entityId: `${metric.entity.kind}:${metric.entity.canonicalId}`,
        provider: metric.provider,
        metricDefinitionVersion: metric.metricDefinitionVersion,
        comparabilityKey: metric.comparabilityKey,
        observedAt: metric.observedAt,
        methodology: [
          metric.methodology.acquisition,
          metric.methodology.extraction,
          metric.methodology.normalization,
          metric.methodology.calculation,
        ].join(" -> "),
      },
    };
  });
  const anyFailed =
    !independent ||
    claims.some((claim) => claim.mechanicalStatus === "failed") ||
    metrics.some((metric) => metric.status === "failed");
  const anyReview =
    claims.some((claim) => claim.mechanicalStatus === "review_required") ||
    metrics.some((metric) => metric.status === "review_required");
  return {
    schemaVersion: "verification-result-0.1.0",
    policyVersion: input.policyVersion,
    status: anyFailed ? "failed" : anyReview ? "review_required" : "passed",
    producerVerifierIndependent: independent,
    claims,
    metrics,
    summary: {
      claimsTotal: claims.length,
      claimsMechanicallyPassed: claims.filter((claim) => claim.mechanicalStatus === "passed").length,
      metricsTotal: metrics.length,
      metricsPassed: metrics.filter((metric) => metric.status === "passed").length,
      falseAcceptanceRiskCount:
        claims.filter((claim) => claim.mechanicalStatus !== "passed").length +
        metrics.filter((metric) => metric.status !== "passed").length,
      reviewReasons: [...new Set(reviewReasons)],
    },
  };
}
