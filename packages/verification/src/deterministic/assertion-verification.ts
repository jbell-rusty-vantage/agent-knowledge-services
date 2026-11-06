import type { Assertion, DeterministicVerificationResult, VerificationBundle } from "@aiengineer/knowledge-contracts";
import { CHECK, Checks, combineCheckStatus } from "./checks.js";
import type { EvidenceEdgeVerifier } from "./evidence-edge.js";
import type { RuntimeSeparation } from "./runtime-separation.js";

export type AssertionResult = DeterministicVerificationResult["assertions"][number];

export interface AssertionContext {
  readonly producer: VerificationBundle["producer"];
  readonly separation: RuntimeSeparation;
  readonly verifyEvidence: EvidenceEdgeVerifier;
}

/**
 * An assertion is semantically eligible only when it is atomic, produced by the
 * bundle's producer under established separation, and every evidence edge
 * resolved mechanically. The verdict is always left to the semantic layer.
 */
export function verifyAssertion(context: AssertionContext, assertion: Assertion): AssertionResult {
  const evidence = assertion.evidence.map(context.verifyEvidence);
  const { producer, separation } = context;
  const checks = new Checks(assertion.assertionId)
    .require(
      CHECK.ASSERTION_PRODUCER_MATCH,
      assertion.producer.deploymentId === producer.deploymentId &&
        assertion.producer.attemptId === producer.attemptId &&
        assertion.producer.capabilityVersion === producer.capabilityVersion,
      "Assertion producer must match the bundle producer.",
    )
    .require(
      CHECK.RUNTIME_PRINCIPAL_BINDING_MATCH,
      separation.bindingMatches,
      "Declared deployment IDs must match runtime principal bindings.",
    )
    .require(CHECK.PRODUCER_VERIFIER_INDEPENDENT, separation.established, {
      pass: "Producer and verifier runtime principals are distinct.",
      fail: "Producer/verifier deployment separation was not established from runtime principal bindings.",
    })
    .require(CHECK.ASSERTION_ATOMIC, assertion.atomic, {
      pass: "Assertion is atomic.",
      fail: "Composite assertion requires decomposition.",
    })
    .require(CHECK.EVIDENCE_PRESENT, evidence.length > 0, `${evidence.length} evidence reference(s) supplied.`);
  const evidenceStatus = combineEvidenceStatus(evidence.map((item) => item.contract.status));
  checks.add({
    code: CHECK.EVIDENCE_MECHANICALLY_VALID,
    status: evidenceStatus,
    deterministic: true,
    severity: "hard",
    detail: "All evidence must pass deterministic resolution before semantics.",
    targetId: assertion.assertionId,
  });
  const status = combineCheckStatus([...checks.items, ...evidence.flatMap((item) => item.contract.checks)]);
  return {
    assertionId: assertion.assertionId,
    status,
    semanticEligibility: status === "passed",
    verdict: "pending_semantic_review",
    evidence: evidence.map((item) => item.contract),
    checks: [...checks.items],
  };
}

/** All passed → passed; any failed → failed; otherwise the edges need review. */
function combineEvidenceStatus(statuses: readonly AssertionResult["status"][]): AssertionResult["status"] {
  if (statuses.every((status) => status === "passed")) return "passed";
  if (statuses.some((status) => status === "failed")) return "failed";
  return "review_required";
}
