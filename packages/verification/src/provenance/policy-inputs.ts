import {
  VerificationRecordedPolicyInputsSchema,
  type DeterministicVerificationResult,
  type Assertion,
  type VerificationArtifactHandle,
  type VerificationBundle,
  type VerificationRecordedPolicyInputs,
} from "@aiengineer/knowledge-contracts";
import { digestCanonicalJson, sha256Digest } from "../canonical/index.js";

export function validateRecordedPolicyInputsArtifact(input: {
  readonly handle: VerificationArtifactHandle;
  readonly bytes: Uint8Array;
  readonly bundle: VerificationBundle;
  readonly deterministicResult: DeterministicVerificationResult;
  readonly runId: string;
  readonly policyVersion: string;
}): VerificationRecordedPolicyInputs {
  if (input.bytes.byteLength !== input.handle.byteLength) throw new Error("POLICY_INPUTS_BYTE_LENGTH_MISMATCH");
  if (sha256Digest(input.bytes) !== input.handle.digest) throw new Error("POLICY_INPUTS_DIGEST_MISMATCH");
  let parsed: VerificationRecordedPolicyInputs;
  try {
    parsed = VerificationRecordedPolicyInputsSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)),
    );
  } catch {
    throw new Error("RECORDED_POLICY_INPUTS_INVALID");
  }
  if (
    parsed.runId !== input.runId ||
    parsed.policyVersion !== input.policyVersion ||
    digestCanonicalJson(parsed.deterministicResult) !== digestCanonicalJson(input.deterministicResult)
  )
    throw new Error("RECORDED_POLICY_INPUTS_BINDING_MISMATCH");
  const bundleAssertions = new Map(input.bundle.assertions.map((assertion) => [assertion.assertionId, assertion]));
  if (
    parsed.assertions.length !== bundleAssertions.size ||
    new Set(parsed.assertions.map((assertion) => assertion.assertionId)).size !== parsed.assertions.length
  )
    throw new Error("POLICY_INPUT_ASSERTION_COVERAGE_MISMATCH");
  for (const assertion of parsed.assertions) {
    const declared = bundleAssertions.get(assertion.assertionId);
    if (
      !declared ||
      assertion.riskClass !== declared.riskClass ||
      digestCanonicalJson(assertion.downstreamUse) !== digestCanonicalJson(declared.downstreamUse)
    )
      throw new Error("POLICY_INPUT_ASSERTION_BINDING_MISMATCH");
    if (assertion.literalExtraction && !isLiteralExtractionAssertion(declared))
      throw new Error("POLICY_LITERAL_EXTRACTION_BINDING_MISMATCH");
    if (
      assertion.semantic.judgeIdentities.length > 0 &&
      declared.value !== undefined &&
      assertion.semantic.assertionValueDigest !== digestCanonicalJson(declared.value)
    )
      throw new Error("POLICY_SEMANTIC_VALUE_BINDING_MISMATCH");
    if (assertion.semantic.assertionId !== assertion.assertionId)
      throw new Error("POLICY_INPUT_SEMANTIC_ASSERTION_MISMATCH");
    const fragmentIds = new Set(declared.evidence.map((edge) => edge.fragment.fragmentId));
    if (
      [...assertion.semantic.supportingFragmentIds, ...assertion.semantic.contradictingFragmentIds].some(
        (id) => !fragmentIds.has(id),
      )
    )
      throw new Error("POLICY_INPUT_SEMANTIC_FRAGMENT_UNKNOWN");
  }
  const metricIds = new Set(input.bundle.metricObservations.map((metric) => metric.observationId));
  if (
    parsed.metrics.length !== metricIds.size ||
    new Set(parsed.metrics.map((metric) => metric.observationId)).size !== parsed.metrics.length ||
    parsed.metrics.some((metric) => !metricIds.has(metric.observationId))
  )
    throw new Error("POLICY_INPUT_METRIC_COVERAGE_MISMATCH");
  for (const assessment of parsed.sourceAssessments) {
    const assertion = bundleAssertions.get(assessment.assertionId);
    if (!assertion || !assertion.evidence.some((edge) => edge.fragment.fragmentId === assessment.fragmentId))
      throw new Error("POLICY_INPUT_SOURCE_FRAGMENT_UNKNOWN");
  }
  return parsed;
}

/** Only a verbatim source value, with no added entity, qualifier, or inferred meaning, is mechanical extraction. */
export function isLiteralExtractionAssertion(assertion: Assertion): boolean {
  return (
    assertion.kind === "claim" &&
    ["attribute", "measurement", "provenance"].includes(assertion.claimType ?? "") &&
    assertion.riskClass === "low" &&
    assertion.derivation === "direct" &&
    typeof assertion.value === "string" &&
    assertion.proposition === assertion.value &&
    !assertion.qualifiers.length &&
    !assertion.entityBindings.length &&
    assertion.evidence.length > 0 &&
    assertion.evidence.every(
      (edge) =>
        edge.role === "supports" &&
        edge.fragment.selector.kind === "text_quote" &&
        edge.fragment.selector.normalization === "none" &&
        edge.fragment.selector.quote === assertion.value,
    )
  );
}
