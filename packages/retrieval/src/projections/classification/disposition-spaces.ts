import type { PublicKnowledgeDomain, VectorSpace } from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import type { ClassificationProposal, DomainDisposition } from "../types.js";

export const dispositionSpace: Readonly<Partial<Record<DomainDisposition, VectorSpace>>> = {
  faithful_source_section: "source_native_sections",
  engineering_claim: "engineering_claims",
  tool_capability: "tool_capabilities",
  implementation_example: "implementation_examples",
  paper_case_study: "paper_case_study_knowledge",
  entity_profile: "entity_profiles",
  model_capability: "model_capabilities",
  benchmark_intelligence: "benchmark_intelligence",
};

export function classifyProjectionSpaces(proposal: ClassificationProposal): readonly VectorSpace[] {
  if (proposal.targetContractVersion.trim().length === 0) {
    throw new Error("A target contract version is required");
  }
  if (proposal.dispositions.length === 0) {
    throw new Error("At least one domain disposition is required");
  }
  const admittedDispositions = new Set<DomainDisposition>([
    "faithful_source_section",
    "engineering_claim",
    "tool_capability",
    "implementation_example",
    "paper_case_study",
    "entity_profile",
    "model_capability",
    "benchmark_intelligence",
    "not_ingestible",
  ]);
  for (const disposition of proposal.dispositions) {
    if (!admittedDispositions.has(disposition)) {
      throw new Error(`Unknown domain disposition: ${String(disposition)}`);
    }
  }
  if (proposal.dispositions.includes("not_ingestible")) {
    if (proposal.dispositions.length !== 1) {
      throw new Error("not_ingestible cannot be combined with projection domains");
    }
    return [];
  }
  if (proposal.evidenceLocatorIds.length === 0) {
    throw new Error("Projection classification requires evidence");
  }
  if (proposal.deduplicationKeys.length === 0) {
    throw new Error("Projection classification requires deduplication keys");
  }
  const publicDispositions = proposal.dispositions.filter((item) => item !== "faithful_source_section");
  if (publicDispositions.length > 0 && proposal.unresolvedIdentityQuestions.length > 0) {
    throw new Error("Canonical projections require resolved entity identities");
  }
  return deepFreeze([
    ...new Set(
      proposal.dispositions
        .map((item) => dispositionSpace[item])
        .filter((space): space is VectorSpace => space !== undefined),
    ),
  ]);
}

export const publicProjectionSpaces: readonly PublicKnowledgeDomain[] = [
  "engineering_claims",
  "tool_capabilities",
  "implementation_examples",
  "paper_case_study_knowledge",
  "entity_profiles",
  "model_capabilities",
  "benchmark_intelligence",
];
