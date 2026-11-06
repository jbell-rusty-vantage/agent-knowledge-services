import type { Actor, ModelAuthoredProposal, PromotionDecision } from "@aiengineer/knowledge-contracts";
import { DomainInvariantError } from "./errors.js";

export function assertDecisionAuthority(proposal: ModelAuthoredProposal, decision: PromotionDecision): void {
  if (decision.proposalId !== proposal.id || decision.guardedProposalDigest !== proposal.digest)
    throw new DomainInvariantError("STALE_GUARDED_DIGEST", "Decision does not guard the exact proposal digest");
  if (decision.stage !== proposal.proposalStage)
    throw new DomainInvariantError(
      "GATE_SEPARATION_VIOLATION",
      "A decision can satisfy only its declared promotion gate",
    );
  if (decision.decider.kind === "model")
    throw new DomainInvariantError("AUTHORITY_DENIED", "Model actors cannot execute promotion decisions");
  if (decision.decider.id === proposal.author.id)
    throw new DomainInvariantError(
      "SEPARATION_OF_DUTY_VIOLATION",
      "A proposal author cannot decide the same guarded proposal",
    );
}
export function assertCanonicalPublicationAuthority(actor: Actor): void {
  if (!(actor.kind === "human" || (actor.kind === "service" && actor.serviceIdentity === "knowledge_api")))
    throw new DomainInvariantError("AUTHORITY_DENIED", "Actor cannot publish canonical vector items");
}
