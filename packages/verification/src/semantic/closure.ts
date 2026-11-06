import {
  SemanticAssessmentRecordSchema,
  type DeterministicVerificationResult,
  type SemanticAssessmentRecord,
} from "@aiengineer/knowledge-contracts";
import { authorizeSemanticCase, type SemanticCaseAuthorizationInput } from "./authorize.js";
import type { SemanticJudgeExecution } from "./ports.js";
import { verifySemanticCase, type SemanticJudgeAdapters } from "./verify-case.js";

export interface AssertionSemanticsInput extends SemanticCaseAuthorizationInput {
  readonly adapters: SemanticJudgeAdapters;
  readonly execution?: SemanticJudgeExecution;
}

/**
 * The full semantic step for one assertion: deterministic closure → evidence-
 * closed authorization → judging. When the mechanical gate is closed the judge
 * is never called and the record says so.
 */
export async function verifyAssertionSemantics(input: AssertionSemanticsInput): Promise<SemanticAssessmentRecord> {
  const closed = mechanicalSemanticClosure(input.deterministicResult, input.assertionId);
  if (closed) return closed;
  return verifySemanticCase(authorizeSemanticCase(input), input.adapters, input.execution);
}

/**
 * Deterministic-before-semantic: when the bundle or the assertion failed
 * mechanically, produce the closing record without consulting any model.
 * A failed locator is a `fail`; an unsupported resolver or other gate is `abstain`.
 */
export function mechanicalSemanticClosure(
  deterministic: DeterministicVerificationResult,
  assertionId: string,
): SemanticAssessmentRecord | undefined {
  const assertion = deterministic.assertions.find((item) => item.assertionId === assertionId);
  if (
    !assertion ||
    (deterministic.status === "passed" && deterministic.semanticEligibility && assertion.semanticEligibility)
  )
    return undefined;
  const unsupportedResolver = assertion.evidence.some((item) =>
    item.checks.some((check) => check.code === "SELECTOR_RESOLVER_ADMITTED"),
  );
  const locatorFailed = !unsupportedResolver && assertion.evidence.some((item) => item.status === "failed");
  return SemanticAssessmentRecordSchema.parse({
    assertionId,
    verdict: locatorFailed ? "locator_error" : "unverifiable",
    disposition: locatorFailed ? "fail" : "abstain",
    evidenceSupport: "not_assessed",
    worldCorrectness: "not_assessed",
    attributionFaithfulness: "not_assessed",
    sourceAuthority: "not_assessed",
    provenanceIntegrity: "not_satisfied",
    judgeIdentities: [],
    supportingFragmentIds: [],
    contradictingFragmentIds: [],
    unsupportedFacets: [],
    reasonCodes: ["MECHANICAL_GATE_CLOSED"],
    crossFamilySecondJudge: false,
    rawProviderConfidences: [],
  });
}
