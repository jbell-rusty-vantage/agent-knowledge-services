import type { RetrievalPlan, VectorSpace } from "@aiengineer/knowledge-contracts";
import { DomainInvariantError } from "@aiengineer/knowledge-core";

export interface RetrievalPolicy {
  allowedSpaces: readonly VectorSpace[];
  allowedFilterFields: readonly string[];
  maximumCandidateK: number;
  maximumFinalK: number;
  maximumGraphDepth: number;
}
export function validateRetrievalPlan(plan: RetrievalPlan, policy: RetrievalPolicy): RetrievalPlan {
  const unauthorizedSpace = plan.spaces.find((space) => !policy.allowedSpaces.includes(space));
  if (unauthorizedSpace)
    throw new DomainInvariantError("UNAUTHORIZED_SPACE", `Space ${unauthorizedSpace} is not authorized`);
  const invalidFilter = [...plan.hardFilters, ...plan.softBoosts].find(
    ({ field }) => !policy.allowedFilterFields.includes(field),
  );
  if (invalidFilter)
    throw new DomainInvariantError("UNAUTHORIZED_FILTER", `Filter ${invalidFilter.field} is not admitted`);
  if (
    plan.candidateK > policy.maximumCandidateK ||
    plan.finalK > policy.maximumFinalK ||
    plan.graph.maxDepth > policy.maximumGraphDepth
  )
    throw new DomainInvariantError("LIMIT_EXCEEDED", "Retrieval plan exceeds policy limits");
  return plan;
}
