export interface RescueBudget {
  readonly maximumCalls: number;
  readonly maximumFragments: number;
  readonly maximumCharacters: number;
}

export interface RescueCandidate {
  readonly candidateId: string;
  readonly sourceUri: string;
  readonly exactText: string;
  readonly sourceFamilyId: string;
}

export interface BoundedEvidenceRescuePort {
  search(input: {
    readonly query: string;
    readonly maximumFragments: number;
    readonly maximumCharacters: number;
  }): Promise<readonly RescueCandidate[]>;
}

export async function proposeUncitedEvidenceRescue(
  query: string,
  budget: RescueBudget,
  port: BoundedEvidenceRescuePort,
): Promise<{
  readonly status: "pending_mechanical_admission";
  readonly callsUsed: number;
  readonly candidates: readonly RescueCandidate[];
}> {
  if (!query.trim() || query.length > 2_000) throw new Error("RESCUE_QUERY_INVALID");
  if (
    !Number.isInteger(budget.maximumCalls) ||
    budget.maximumCalls < 1 ||
    budget.maximumCalls > 3 ||
    !Number.isInteger(budget.maximumFragments) ||
    budget.maximumFragments < 1 ||
    budget.maximumFragments > 16 ||
    !Number.isInteger(budget.maximumCharacters) ||
    budget.maximumCharacters < 1 ||
    budget.maximumCharacters > 64_000
  )
    throw new Error("RESCUE_BUDGET_INVALID");
  const candidates = await port.search({
    query,
    maximumFragments: budget.maximumFragments,
    maximumCharacters: budget.maximumCharacters,
  });
  if (candidates.length > budget.maximumFragments) throw new Error("RESCUE_FRAGMENT_BUDGET_EXCEEDED");
  const ids = new Set<string>();
  let characters = 0;
  for (const candidate of candidates) {
    if (
      !candidate.candidateId.trim() ||
      ids.has(candidate.candidateId) ||
      !candidate.sourceUri.trim() ||
      !candidate.sourceFamilyId.trim() ||
      !candidate.exactText.trim()
    )
      throw new Error("RESCUE_CANDIDATE_INVALID");
    ids.add(candidate.candidateId);
    characters += candidate.exactText.length;
  }
  if (characters > budget.maximumCharacters) throw new Error("RESCUE_CHARACTER_BUDGET_EXCEEDED");
  return Object.freeze({
    status: "pending_mechanical_admission",
    callsUsed: 1,
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate }))),
  });
}
