import { deepFreeze } from "@aiengineer/knowledge-core";
import { normalize } from "../lexical/index.js";
import { assertAdmittedSpaces, inferSpaces } from "../spaces/index.js";
import type { AdvancedRetrievalPlan, RetrievalIntent, RetrievalPolicy, RetrieveOptions } from "../types.js";

// Plan — turns a raw query and policy into the frozen AdvancedRetrievalPlan every
// later stage reads. Space and hard-filter admission happen here, once, so no stage
// downstream has to re-check authorization.
export function buildRetrievalPlan(
  query: string,
  policy: RetrievalPolicy,
  options: Pick<RetrieveOptions, "hardFilters" | "spaces" | "candidateK" | "finalK"> = {},
): AdvancedRetrievalPlan {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) throw new Error("QUERY_REQUIRED");
  const spaces = options.spaces ?? inferSpaces(normalizedQuery);
  assertAdmittedSpaces(spaces, policy.admittedSpaces);
  const filters = options.hardFilters ?? [];
  for (const filter of filters)
    if (!policy.allowedFilterFields.includes(filter.field)) throw new Error(`FILTER_NOT_ALLOWED:${filter.field}`);
  const candidateK = options.candidateK ?? Math.min(50, policy.maxCandidateK);
  const finalK = options.finalK ?? Math.min(10, policy.maxFinalK);
  if (
    !Number.isInteger(candidateK) ||
    !Number.isInteger(finalK) ||
    candidateK < 1 ||
    finalK < 1 ||
    candidateK > policy.maxCandidateK ||
    finalK > policy.maxFinalK ||
    finalK > candidateK
  )
    throw new Error("RETRIEVAL_LIMIT_EXCEEDED");
  if (!Number.isFinite(policy.rrfK) || policy.rrfK < 1) throw new Error("INVALID_RRF_POLICY");
  if (!Number.isFinite(policy.minimumCoverage) || policy.minimumCoverage < 0 || policy.minimumCoverage > 1)
    throw new Error("INVALID_COVERAGE_POLICY");
  const parts = normalizedQuery
    .split(/\s+(?:versus|vs\.?|then)\s+|[;?]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 16);
  const subqueries = (parts.length ? parts : [normalizedQuery]).map((text, index) => ({
    id: `q${index + 1}`,
    text,
    coverageRole: index === 0 ? ("required" as const) : ("supporting" as const),
  }));
  const minimumEvidenceScore = policy.minimumEvidenceScore ?? 0;
  if (!Number.isFinite(minimumEvidenceScore) || minimumEvidenceScore < 0 || minimumEvidenceScore > 1)
    throw new Error("INVALID_EVIDENCE_SCORE_POLICY");
  const minimumEvidenceTerms = policy.minimumEvidenceTerms ?? 0;
  if (!Number.isInteger(minimumEvidenceTerms) || minimumEvidenceTerms < 0)
    throw new Error("INVALID_EVIDENCE_TERMS_POLICY");
  return deepFreeze({
    policyVersionId: policy.id,
    normalizedQuery,
    intents: inferIntents(normalizedQuery),
    subqueries,
    spaces,
    hardFilters: filters,
    softBoosts: [],
    candidateK,
    finalK,
    graph: {
      // Frozen at 1 regardless of policy.maxGraphDepth — Phase 2 memo §7 item 2
      // flags this as possibly misleading (the field and test policy both say 2),
      // but it is unchanged here on purpose: this unit records findings, it does
      // not fix them.
      maxDepth: Math.min(1, policy.maxGraphDepth),
      allowedEdges: policy.allowedGraphEdges,
    },
    minimumCoverage: policy.minimumCoverage,
    minimumEvidenceScore,
    minimumEvidenceTerms,
  });
}

// Keyword heuristics only; nothing downstream depends on which heuristic produced
// the intent list, only on the list being non-empty.
export function inferIntents(query: string): RetrievalIntent[] {
  const result: RetrievalIntent[] = [];
  if (/who|company|organization|entity/.test(query)) result.push("entity_discovery");
  if (/how|code|implement|example|api/.test(query)) result.push("implementation_support");
  if (/tool|choose|compare|best/.test(query)) result.push("tool_selection");
  if (/claim|evidence|why|does|what/.test(query)) result.push("knowledge_evidence");
  return result.length ? result : ["decision_support"];
}
