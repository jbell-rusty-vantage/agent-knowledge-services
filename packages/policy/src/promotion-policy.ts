import type { ModelAuthoredProposal, PromotionDecision, PromotionGateResult } from "@aiengineer/knowledge-contracts";
import { assertDecisionAuthority, DomainInvariantError } from "@aiengineer/knowledge-core";

export function validatePromotionDecision(
  proposal: ModelAuthoredProposal,
  decision: PromotionDecision,
  gates: readonly PromotionGateResult[],
): void {
  assertDecisionAuthority(proposal, decision);
  const gateIds = new Set(gates.map(({ id }) => id));
  if (decision.gateResultIds.some((id) => !gateIds.has(id)))
    throw new DomainInvariantError("MISSING_GATE", "Decision references an unavailable gate result");
  if (decision.decision === "accept" && (decision.gateResultIds.length === 0 || gates.some(({ passed }) => !passed)))
    throw new DomainInvariantError("FAILED_GATE", "Acceptance requires all referenced gates to pass");
}
