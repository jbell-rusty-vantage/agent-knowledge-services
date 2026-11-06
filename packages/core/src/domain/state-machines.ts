import { DomainInvariantError } from "./errors.js";

export const KNOWLEDGE_SERVICE_NAME = "knowledge-services" as const;
export const knowledgeOperationStates = [
  "proposed",
  "queued",
  "running",
  "needs_review",
  "quarantined",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type KnowledgeOperationState = (typeof knowledgeOperationStates)[number];
export const promotionStates = [
  "candidate",
  "inspected",
  "validated",
  "evaluation_pending",
  "review_required",
  "rejected",
  "approved",
  "published",
  "superseded",
  "withdrawn",
] as const;
export type PromotionState = (typeof promotionStates)[number];
export const publicationStates = [
  "draft",
  "evaluated",
  "approved",
  "publishing",
  "published",
  "superseded",
  "withdrawn",
] as const;
export type PublicationState = (typeof publicationStates)[number];

const operationTransitions: Record<KnowledgeOperationState, readonly KnowledgeOperationState[]> = {
  proposed: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["needs_review", "quarantined", "succeeded", "failed", "cancelled"],
  needs_review: ["queued", "succeeded", "failed", "cancelled"],
  quarantined: ["queued", "failed", "cancelled"],
  succeeded: ["superseded"],
  failed: ["queued", "superseded"],
  cancelled: ["queued", "superseded"],
  superseded: [],
};
const promotionTransitions: Record<PromotionState, readonly PromotionState[]> = {
  candidate: ["inspected", "rejected"],
  inspected: ["validated", "rejected", "candidate"],
  validated: ["evaluation_pending", "rejected"],
  evaluation_pending: ["review_required", "rejected", "approved"],
  review_required: ["approved", "rejected", "candidate"],
  rejected: [],
  approved: ["published", "withdrawn"],
  published: ["superseded", "withdrawn"],
  superseded: [],
  withdrawn: [],
};
const publicationTransitions: Record<PublicationState, readonly PublicationState[]> = {
  draft: ["evaluated", "withdrawn"],
  evaluated: ["approved", "draft", "withdrawn"],
  approved: ["publishing", "withdrawn"],
  publishing: ["published", "evaluated", "withdrawn"],
  published: ["superseded", "withdrawn"],
  superseded: [],
  withdrawn: [],
};

export interface TransitionGuard {
  expectedRowVersion: number;
  actualRowVersion: number;
  expectedDigest: string;
  actualDigest: string;
}
function transition<S extends string>(
  kind: string,
  map: Record<S, readonly S[]>,
  from: S,
  to: S,
  guard: TransitionGuard,
) {
  if (guard.expectedRowVersion !== guard.actualRowVersion || guard.expectedDigest !== guard.actualDigest)
    throw new DomainInvariantError("STALE_GUARD", `${kind} transition guard is stale`);
  if (!map[from].includes(to))
    throw new DomainInvariantError("INVALID_STATE_TRANSITION", `Cannot transition ${kind} from ${from} to ${to}`);
  return { previousState: from, resultingState: to, nextRowVersion: guard.actualRowVersion + 1 } as const;
}
export const transitionOperation = (
  from: KnowledgeOperationState,
  to: KnowledgeOperationState,
  guard: TransitionGuard,
) => transition("operation", operationTransitions, from, to, guard);
export const transitionPromotion = (from: PromotionState, to: PromotionState, guard: TransitionGuard) =>
  transition("promotion", promotionTransitions, from, to, guard);
export const transitionPublication = (from: PublicationState, to: PublicationState, guard: TransitionGuard) =>
  transition("publication", publicationTransitions, from, to, guard);
