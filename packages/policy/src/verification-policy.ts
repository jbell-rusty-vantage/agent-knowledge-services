import { createHash } from "node:crypto";
import {
  VerificationPolicyDecisionSchema,
  VerificationPolicyDefinitionSchema,
  VerificationPolicyOverrideRecordSchema,
  VerificationRecordedPolicyInputsSchema,
  type VerificationPolicyDecision,
  type VerificationPolicyDefinition,
  type VerificationPolicyOverrideRecord,
  type VerificationRecordedPolicyInputs,
} from "@aiengineer/knowledge-contracts";
import { assessSourceAuthority, canonicalizeJson } from "@aiengineer/knowledge-verification";

const decoder = new TextDecoder("utf-8", { fatal: true });

function parseBytes<T>(bytes: Uint8Array, maximumBytes: number, parse: (value: unknown) => T, code: string): T {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) throw new Error(`${code}_SIZE_INVALID`);
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(`${code}_JSON_INVALID`);
  }
  try {
    return parse(value);
  } catch {
    throw new Error(`${code}_SCHEMA_INVALID`);
  }
}

export function parseVerificationPolicyDefinition(bytes: Uint8Array): VerificationPolicyDefinition {
  return parseBytes(bytes, 64_000, (value) => VerificationPolicyDefinitionSchema.parse(value), "POLICY_DEFINITION");
}

export function parseRecordedPolicyInputs(bytes: Uint8Array): VerificationRecordedPolicyInputs {
  return parseBytes(bytes, 2_000_000, (value) => VerificationRecordedPolicyInputsSchema.parse(value), "POLICY_INPUTS");
}

const supportPass = new Set(["directly_supported", "derived_verified"]);
const supportWarning = new Set(["supported_with_qualification", "partially_supported"]);
const outcomeRank: Record<VerificationPolicyDecision["outcome"], number> = {
  pass: 0,
  pass_with_warnings: 1,
  review: 2,
  abstain: 3,
  fail: 4,
};
const stricter = (
  current: VerificationPolicyDecision["outcome"],
  candidate: VerificationPolicyDecision["outcome"],
): VerificationPolicyDecision["outcome"] => (outcomeRank[candidate] > outcomeRank[current] ? candidate : current);

export function evaluateVerificationPolicy(
  definitionInput: VerificationPolicyDefinition,
  recordedInput: VerificationRecordedPolicyInputs,
): VerificationPolicyDecision {
  const definition = VerificationPolicyDefinitionSchema.parse(definitionInput);
  const recorded = VerificationRecordedPolicyInputsSchema.parse(recordedInput);
  if (definition.policyVersion !== recorded.policyVersion) throw new Error("POLICY_VERSION_INPUT_MISMATCH");
  const mechanicalById = new Map(recorded.deterministicResult.assertions.map((item) => [item.assertionId, item]));
  if (new Set(recorded.assertions.map((item) => item.assertionId)).size !== recorded.assertions.length)
    throw new Error("POLICY_ASSERTION_DUPLICATE");
  if (new Set(recorded.sourceAssessments.map((item) => item.assessmentId)).size !== recorded.sourceAssessments.length)
    throw new Error("POLICY_SOURCE_ASSESSMENT_DUPLICATE");
  const recordedIds = new Set(recorded.assertions.map((item) => item.assertionId));
  if (recordedIds.size !== mechanicalById.size || [...mechanicalById.keys()].some((id) => !recordedIds.has(id)))
    throw new Error("POLICY_ASSERTION_COVERAGE_MISMATCH");
  if (recorded.sourceAssessments.some((item) => !recordedIds.has(item.assertionId)))
    throw new Error("POLICY_SOURCE_ASSERTION_UNKNOWN");
  const metricIds = new Set(recorded.metrics.map((item) => item.observationId));
  const mechanicalMetricIds = new Set(recorded.deterministicResult.metrics.map((item) => item.observationId));
  if (metricIds.size !== recorded.metrics.length) throw new Error("POLICY_METRIC_DUPLICATE");
  if (metricIds.size !== mechanicalMetricIds.size || [...mechanicalMetricIds].some((id) => !metricIds.has(id)))
    throw new Error("POLICY_METRIC_COVERAGE_MISMATCH");
  const assertionOutcomes = recorded.assertions.map((assertion) => {
    if (assertion.semantic.assertionId !== assertion.assertionId)
      throw new Error("POLICY_SEMANTIC_ASSERTION_BINDING_MISMATCH");
    const reasons: string[] = [];
    let outcome: VerificationPolicyDecision["outcome"] = "pass";
    const mechanical = mechanicalById.get(assertion.assertionId);
    if (!mechanical || mechanical.status !== "passed" || !mechanical.semanticEligibility) {
      outcome = "fail";
      reasons.push("MECHANICAL_ASSERTION_FAILURE");
    }
    if (["locator_error", "parser_error", "derived_failed", "contradicted"].includes(assertion.semantic.verdict)) {
      outcome = "fail";
      reasons.push("SEMANTIC_HARD_FAILURE");
    }
    const literalExtraction = literalExtractionAuthorized(definition, assertion);
    if (literalExtraction) reasons.push("LITERAL_EXTRACTION_POLICY_AUTHORIZED");
    const criticalUse =
      assertion.riskClass === "critical" ||
      assertion.downstreamUse.some((use) => definition.criticalDownstreamUses.includes(use));
    const sourceItems = recorded.sourceAssessments.filter((item) => item.assertionId === assertion.assertionId);
    if (sourceItems.some((item) => item.claimScope !== assertion.claimScope))
      throw new Error("POLICY_SOURCE_CLAIM_SCOPE_MISMATCH");
    const derivedAuthority = assessSourceAuthority(assertion.assertionId, sourceItems);
    if (derivedAuthority.independentCorroboration !== assertion.independentCorroboration)
      throw new Error("POLICY_INDEPENDENCE_CLAIM_MISMATCH");
    if (derivedAuthority.status !== assertion.authorityStatus)
      throw new Error("POLICY_AUTHORITY_STATUS_CLAIM_MISMATCH");
    if (derivedAuthority.conflictPresent !== assertion.conflictPresent)
      throw new Error("POLICY_CONFLICT_CLAIM_MISMATCH");
    const recordedFamilies = new Set(assertion.semantic.judgeIdentities.map((item) => item.family));
    const recordedDeployments = new Set(assertion.semantic.judgeIdentities.map((item) => item.deploymentId));
    if (assertion.semantic.crossFamilySecondJudge !== (recordedFamilies.size >= 2 && recordedDeployments.size >= 2))
      throw new Error("POLICY_JUDGE_DIVERSITY_CLAIM_MISMATCH");
    const sourceUnknown =
      sourceItems.length === 0 ||
      sourceItems.some(
        (item) =>
          item.vector.authority === "unknown" ||
          item.vector.independence === "unknown" ||
          item.vector.directness === "unknown" ||
          item.vector.freshness === "unknown" ||
          item.vector.applicability === "unknown" ||
          !item.jurisdictionKnown ||
          !item.licenseKnown ||
          !item.freshnessKnown,
      );
    const criticalSemanticUnknown =
      assertion.semantic.evidenceSupport !== "satisfied" ||
      assertion.semantic.provenanceIntegrity !== "satisfied" ||
      (assertion.claimScope !== "source_summary" && assertion.semantic.worldCorrectness !== "satisfied");
    if (
      outcome !== "fail" &&
      criticalUse &&
      (!assertion.criticalFactsKnown || sourceUnknown || criticalSemanticUnknown)
    ) {
      outcome = stricter(outcome, definition.unknownCriticalOutcome);
      reasons.push("UNKNOWN_CRITICAL_FACTS");
    }
    if (outcome !== "fail" && assertion.conflictPresent) {
      outcome = stricter(outcome, definition.mixedEvidenceOutcome);
      reasons.push("MIXED_OR_CONFLICTING_EVIDENCE");
    }
    const independentRequired = definition.requireIndependentAuthorityForScopes.includes(assertion.claimScope);
    if (
      outcome !== "fail" &&
      (assertion.authorityStatus === "withheld" ||
        assertion.authorityStatus === "unknown" ||
        (independentRequired && !assertion.independentCorroboration))
    ) {
      outcome = stricter(outcome, definition.authorityWithheldOutcome);
      reasons.push("SOURCE_AUTHORITY_WITHHELD");
    }
    if (
      outcome !== "fail" &&
      definition.requireCrossFamilyForRisk.includes(assertion.riskClass) &&
      !assertion.semantic.crossFamilySecondJudge
    ) {
      outcome = stricter(outcome, definition.reviewAvailable ? "review" : "abstain");
      reasons.push("CROSS_FAMILY_SECOND_JUDGE_MISSING");
    }
    if (outcome !== "fail" && assertion.semantic.disposition === "fail") {
      outcome = "fail";
      reasons.push("SEMANTIC_DISPOSITION_FAIL");
    } else if (outcome !== "fail" && assertion.semantic.disposition === "abstain") {
      outcome = stricter(outcome, "abstain");
      reasons.push("SEMANTIC_DISPOSITION_ABSTAIN");
    } else if (outcome === "pass" && assertion.semantic.disposition === "review" && !literalExtraction) {
      outcome = definition.reviewAvailable ? "review" : "abstain";
      reasons.push("SEMANTIC_REVIEW_REQUIRED");
    }
    if (outcome === "pass" && supportWarning.has(assertion.semantic.verdict)) {
      outcome = "pass_with_warnings";
      reasons.push("QUALIFIED_OR_PARTIAL_SUPPORT");
    }
    if (outcome === "pass" && !supportPass.has(assertion.semantic.verdict) && !literalExtraction) {
      outcome = definition.reviewAvailable ? "review" : "abstain";
      reasons.push("SEMANTIC_SUPPORT_NOT_FULL");
    }
    return { assertionId: assertion.assertionId, outcome, reasonCodes: [...new Set(reasons)].sort() };
  });
  if (recorded.deterministicResult.status !== "passed" || !recorded.deterministicResult.semanticEligibility) {
    assertionOutcomes.forEach((item) => {
      item.outcome = "fail";
      if (!item.reasonCodes.includes("MECHANICAL_BUNDLE_FAILURE")) item.reasonCodes.push("MECHANICAL_BUNDLE_FAILURE");
      item.reasonCodes.sort();
    });
  }
  const metricOutcomes = recorded.metrics.map((metric) => {
    const mechanical = recorded.deterministicResult.metrics.find((item) => item.observationId === metric.observationId);
    const reasons: string[] = [];
    let outcome: VerificationPolicyDecision["outcome"] = "pass";
    if (!mechanical || mechanical.status !== "passed" || !mechanical.semanticEligibility) {
      outcome = "fail";
      reasons.push("MECHANICAL_METRIC_FAILURE");
    }
    const criticalUse =
      metric.riskClass === "critical" ||
      metric.downstreamUse.some((use) => definition.criticalDownstreamUses.includes(use));
    if (outcome !== "fail" && criticalUse && !metric.criticalFactsKnown) {
      outcome = stricter(outcome, definition.unknownCriticalOutcome);
      reasons.push("UNKNOWN_CRITICAL_FACTS");
    }
    if (outcome !== "fail" && metric.conflictPresent) {
      outcome = stricter(outcome, definition.mixedEvidenceOutcome);
      reasons.push("MIXED_OR_CONFLICTING_EVIDENCE");
    }
    return { assertionId: `metric:${metric.observationId}`, outcome, reasonCodes: reasons };
  });
  assertionOutcomes.push(...metricOutcomes);
  const outcome =
    recorded.deterministicResult.status !== "passed" || !recorded.deterministicResult.semanticEligibility
      ? "fail"
      : assertionOutcomes.reduce<VerificationPolicyDecision["outcome"]>(
          (worst, item) => stricter(worst, item.outcome),
          "pass",
        );
  const reasonCodes = [
    ...new Set([
      ...assertionOutcomes.flatMap((item) => item.reasonCodes),
      ...(recorded.deterministicResult.status !== "passed" || !recorded.deterministicResult.semanticEligibility
        ? ["MECHANICAL_BUNDLE_FAILURE"]
        : []),
    ]),
  ].sort();
  return VerificationPolicyDecisionSchema.parse({
    schemaVersion: "verification-policy-decision.v1",
    policyVersion: definition.policyVersion,
    runId: recorded.runId,
    outcome,
    assertionOutcomes,
    reasonCodes,
    overrideApplied: false,
  });
}

export function replayVerificationPolicy(input: {
  readonly policyVersion: string;
  readonly policyBytes: Uint8Array;
  readonly recordedPolicyInputsBytes: Uint8Array;
}): { readonly outcome: VerificationPolicyDecision["outcome"]; readonly decision: VerificationPolicyDecision } {
  const definition = parseVerificationPolicyDefinition(input.policyBytes);
  const recorded = parseRecordedPolicyInputs(input.recordedPolicyInputsBytes);
  if (input.policyVersion !== definition.policyVersion || input.policyVersion !== recorded.policyVersion)
    throw new Error("POLICY_REPLAY_VERSION_MISMATCH");
  const decision = evaluateVerificationPolicy(definition, recorded);
  return Object.freeze({ outcome: decision.outcome, decision });
}

export interface TrustedPolicyOverrideAuthority {
  readonly principalId: string;
  readonly authorities: readonly string[];
}

export function appendAuthorizedPolicyOverride(input: {
  readonly decision: VerificationPolicyDecision;
  readonly after: VerificationPolicyDecision["outcome"];
  readonly reason: string;
  readonly authority: TrustedPolicyOverrideAuthority;
  readonly recordedAt: string;
  readonly existing: readonly VerificationPolicyOverrideRecord[];
}): readonly VerificationPolicyOverrideRecord[] {
  const decision = VerificationPolicyDecisionSchema.parse(input.decision);
  if (!input.authority.authorities.includes("verification_policy_override") || !input.authority.principalId.trim())
    throw new Error("POLICY_OVERRIDE_UNAUTHORIZED");
  if (!input.reason.trim()) throw new Error("POLICY_OVERRIDE_REASON_REQUIRED");
  if (!Number.isFinite(Date.parse(input.recordedAt))) throw new Error("POLICY_OVERRIDE_TIME_INVALID");
  const hardMechanical = decision.reasonCodes.some((code) =>
    ["MECHANICAL_ASSERTION_FAILURE", "MECHANICAL_BUNDLE_FAILURE"].includes(code),
  );
  const unknownCritical = decision.reasonCodes.includes("UNKNOWN_CRITICAL_FACTS");
  if (
    (hardMechanical && input.after !== "fail") ||
    (unknownCritical && ["pass", "pass_with_warnings"].includes(input.after))
  )
    throw new Error("POLICY_OVERRIDE_FAIL_CLOSED");
  const existing = input.existing.map((item) => VerificationPolicyOverrideRecordSchema.parse(item));
  const expectedDecisionDigest = digestCanonical(decision);
  if (existing[0]?.previousOverrideDigest !== undefined) throw new Error("POLICY_OVERRIDE_CHAIN_INVALID");
  if (
    existing.some(
      (item) =>
        item.runId !== decision.runId ||
        item.policyVersion !== decision.policyVersion ||
        item.decisionDigest !== expectedDecisionDigest,
    )
  )
    throw new Error("POLICY_OVERRIDE_DECISION_BINDING_MISMATCH");
  for (let index = 1; index < existing.length; index += 1) {
    if (
      existing[index]!.previousOverrideDigest !== digestOverride(existing[index - 1]!) ||
      existing[index]!.before !== existing[index - 1]!.after
    )
      throw new Error("POLICY_OVERRIDE_CHAIN_INVALID");
  }
  const decisionDigest = expectedDecisionDigest;
  const previousOverrideDigest = existing.length === 0 ? undefined : digestOverride(existing.at(-1)!);
  const before = existing.length === 0 ? decision.outcome : existing.at(-1)!.after;
  const overrideId = `override-${createHash("sha256").update(`${decisionDigest}:${input.authority.principalId}:${input.recordedAt}:${input.reason}:${input.after}`).digest("hex")}`;
  const record = VerificationPolicyOverrideRecordSchema.parse({
    schemaVersion: "verification-policy-override.v1",
    overrideId,
    policyVersion: decision.policyVersion,
    runId: decision.runId,
    decisionDigest,
    before,
    after: input.after,
    reason: input.reason,
    actorPrincipalId: input.authority.principalId,
    actorAuthority: "verification_policy_override",
    recordedAt: input.recordedAt,
    ...(previousOverrideDigest ? { previousOverrideDigest } : {}),
  });
  return Object.freeze([...existing, Object.freeze(record)]);
}

function digestOverride(record: VerificationPolicyOverrideRecord): `sha256:${string}` {
  return digestCanonical(record);
}

function digestCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalizeJson(value)).digest("hex")}`;
}

/** A prior immutable policy may waive only the executor's unassessed literal-extraction placeholder. */
function literalExtractionAuthorized(
  definition: VerificationPolicyDefinition,
  assertion: VerificationRecordedPolicyInputs["assertions"][number],
): boolean {
  const semantic = assertion.semantic;
  const configured = definition.literalExtraction;
  return Boolean(
    configured &&
      assertion.literalExtraction &&
      configured.assertionIds.includes(assertion.assertionId) &&
      assertion.riskClass === "low" &&
      assertion.downstreamUse.length > 0 &&
      assertion.downstreamUse.every((use) => configured.downstreamUses.some((allowed) => allowed === use)) &&
      !assertion.downstreamUse.some((use) => definition.criticalDownstreamUses.includes(use)) &&
      semantic.verdict === "pending_semantic_review" &&
      semantic.disposition === "review" &&
      !semantic.judgeIdentities.length &&
      semantic.reasonCodes.length === 1 &&
      semantic.reasonCodes[0] === "DETERMINISTIC_ONLY" &&
      !semantic.supportingFragmentIds.length &&
      !semantic.contradictingFragmentIds.length &&
      !semantic.rawProviderConfidences.length &&
      semantic.unsupportedFacets.length === 2 &&
      semantic.unsupportedFacets.includes("semantic_support") &&
      semantic.unsupportedFacets.includes("source_authority") &&
      [
        semantic.evidenceSupport,
        semantic.worldCorrectness,
        semantic.attributionFaithfulness,
        semantic.sourceAuthority,
        semantic.provenanceIntegrity,
      ].every((status) => status === "not_assessed"),
  );
}
