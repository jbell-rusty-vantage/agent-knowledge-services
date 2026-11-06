import type { SourceLocator, VectorSpace } from "@aiengineer/knowledge-contracts";

export type RetrievalIntent =
  | "entity_discovery"
  | "knowledge_evidence"
  | "decision_support"
  | "implementation_support"
  | "tool_selection"
  | "implementation_lookup";
export type FilterValue = string | number | boolean | readonly (string | number | boolean)[];
export interface RetrievalFilter {
  readonly field: string;
  readonly op: "eq" | "neq" | "in" | "contains" | "gte" | "lte";
  readonly value: FilterValue;
}
export interface RetrievalSubquery {
  readonly id: string;
  readonly text: string;
  readonly coverageRole: "required" | "supporting" | "optional";
}
export interface AdvancedRetrievalPlan {
  readonly policyVersionId: string;
  readonly normalizedQuery: string;
  readonly intents: readonly RetrievalIntent[];
  readonly subqueries: readonly RetrievalSubquery[];
  readonly spaces: readonly VectorSpace[];
  readonly hardFilters: readonly RetrievalFilter[];
  readonly softBoosts: readonly RetrievalFilter[];
  readonly candidateK: number;
  readonly finalK: number;
  readonly graph: {
    readonly maxDepth: number;
    readonly allowedEdges: readonly string[];
  };
  readonly minimumCoverage: number;
  readonly minimumEvidenceScore: number;
  readonly minimumEvidenceTerms: number;
}
export interface RetrievalPolicy {
  readonly id: string;
  readonly admittedSpaces: readonly VectorSpace[];
  readonly allowedFilterFields: readonly string[];
  readonly allowedGraphEdges: readonly string[];
  readonly allowedVisibilities?: readonly string[];
  readonly maxCandidateK: number;
  readonly maxFinalK: number;
  readonly maxGraphDepth: number;
  readonly maxGraphNodes: number;
  readonly rrfK: number;
  readonly channelWeights: Readonly<Partial<Record<RetrievalChannel, number>>>;
  readonly maxPerSource: number;
  readonly contextRadius: number;
  readonly minimumCoverage: number;
  readonly minimumEvidenceScore?: number;
  readonly minimumEvidenceTerms?: number;
}
export interface RetrievalRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectionId: string;
  readonly projectionVersionId: string;
  readonly space: VectorSpace;
  readonly targetKind: string;
  readonly targetSchemaVersion: string;
  readonly text: string;
  readonly identifiers?: readonly string[];
  readonly vector?: readonly number[];
  readonly fields: Readonly<Record<string, FilterValue>>;
  readonly locators: readonly SourceLocator[];
  readonly artifactIds?: readonly string[];
  readonly authority: "canonical" | "exploratory" | "user_managed";
  readonly assurance: "high" | "medium" | "low";
  readonly freshnessAt: string;
  readonly promoted: boolean;
  readonly lifecycle?: "active" | "inactive" | "tombstoned";
  readonly sourceId: string;
  readonly parentId?: string;
  readonly ordinal?: number;
  readonly contradictionIds?: readonly string[];
  readonly supersedesIds?: readonly string[];
  readonly flags?: Partial<RetrievalFlags>;
}
export interface RetrievalFlags {
  readonly contradicted: boolean;
  readonly corrected: boolean;
  readonly retracted: boolean;
  readonly deprecated: boolean;
  readonly superseded: boolean;
}
export interface GraphEdge {
  readonly fromId: string;
  readonly toId: string;
  readonly kind: string;
  readonly verified: boolean;
  readonly rationale?: string;
  readonly provenance?: readonly string[];
  readonly locatorDigest?: string;
}
export type RetrievalChannel = "exact" | "trigram" | "fts" | "semantic" | "graph" | "rerank";
export interface StageContribution {
  readonly channel: RetrievalChannel;
  readonly rank: number;
  readonly rawScore: number;
  readonly rrfContribution: number;
  readonly explanation: string;
  readonly graphPath?: readonly string[];
}
export interface RetrievedCandidate {
  readonly record: RetrievalRecord;
  readonly contributions: readonly StageContribution[];
  readonly matchedConstraints: readonly string[];
  readonly penalties: readonly string[];
  readonly score: number;
  readonly finalRank: number;
  readonly contextOnly: boolean;
  readonly coveredSubqueryIds: readonly string[];
}
export interface EvidenceMember {
  readonly memberId: string;
  readonly recordId: string;
  readonly projectionId: string;
  readonly space: VectorSpace;
  readonly locators: readonly SourceLocator[];
  readonly contributions: readonly StageContribution[];
  readonly graphPaths: readonly (readonly string[])[];
  readonly matchedConstraints: readonly string[];
  readonly penalties: readonly string[];
  readonly authority: RetrievalRecord["authority"];
  readonly assurance: RetrievalRecord["assurance"];
  readonly freshAt: string;
  readonly contradictionIds: readonly string[];
  readonly supersedesIds: readonly string[];
  readonly coveredSubqueryIds: readonly string[];
  readonly contextOnly: boolean;
  readonly finalScore: number;
  readonly finalRank: number;
}
export interface ImmutableEvidencePacket {
  readonly id: string;
  readonly tenantId: string;
  readonly retrievalRunId: string;
  readonly digest: `sha256:${string}`;
  readonly createdAt: string;
  readonly normalizedQuery: string;
  readonly plan: AdvancedRetrievalPlan;
  readonly members: readonly EvidenceMember[];
  readonly omittedResults: readonly { recordId?: string; reason: string }[];
  readonly coverage: readonly { subqueryId: string; coverage: number }[];
  readonly abstention: {
    readonly recommended: boolean;
    readonly reason?: string;
  };
  readonly degradedMode: boolean;
  readonly stageLatenciesMs: Readonly<Record<string, number>>;
  readonly receiptId: string;
}
export interface Reranker {
  readonly version: string;
  rerank(query: string, records: readonly RetrievalRecord[]): Promise<readonly { recordId: string; score: number }[]>;
}
export interface RetrievalStages {
  readonly exact: boolean;
  readonly trigram: boolean;
  readonly fts: boolean;
  readonly semantic: boolean;
  readonly graph: boolean;
  readonly rerank: boolean;
  readonly diversity: boolean;
  readonly context: boolean;
}
export interface RetrieveOptions {
  readonly tenantId: string;
  readonly policy: RetrievalPolicy;
  readonly records: readonly RetrievalRecord[];
  readonly graphEdges?: readonly GraphEdge[];
  readonly queryVector?: readonly number[];
  readonly hardFilters?: readonly RetrievalFilter[];
  readonly spaces?: readonly VectorSpace[];
  readonly candidateK?: number;
  readonly finalK?: number;
  readonly reranker?: Reranker;
  readonly now?: string;
  readonly retrievalRunId?: string;
  readonly stages?: Partial<RetrievalStages>;
}
