import type { RetrievalWorldScope } from "@aiengineer/knowledge-contracts";

// Canonical retrieval repository port. Persistence implements it with SQL and
// re-exports these shapes under their historical names.

export interface HybridSearchRequest {
  readonly tenantId: string;
  readonly vectorSpaceVersionId: string;
  readonly queryText: string;
  readonly queryEmbedding: readonly number[];
  readonly filters?: Readonly<Record<string, string>>;
  readonly resultLimit?: number;
  readonly candidateLimit?: number;
  readonly rrfK?: number;
  readonly knowledgeSeq?: number;
  readonly worldScope?: RetrievalWorldScope;
  readonly entityIds?: readonly string[];
  readonly publicationId?: string;
}

export interface HybridSearchResult {
  readonly vectorItemId: string;
  readonly searchProjectionId?: string;
  readonly searchText: string;
  readonly sourceKind?: string;
  readonly fusedScore: number;
  readonly channelScores: unknown;
}

export interface ActiveRetrievalTarget {
  readonly vectorSpaceVersionId: string;
  readonly vectorSpace: string;
  readonly embeddingModel: string;
  readonly dimensions: number;
  readonly projectionProcedureId: string;
  readonly authority: "canonical" | "exploratory" | "user_managed";
}

export interface RetrievalPolicySnapshot {
  readonly id: string;
  readonly version: number;
  readonly policy: unknown;
  readonly targets: readonly ActiveRetrievalTarget[];
}

export interface RetrievalEvidenceRecord {
  readonly vectorItemId: string;
  readonly searchProjectionId: string;
  readonly projectionProcedureId: string;
  readonly canonicalRecord: {
    readonly kind: string;
    readonly schemaVersion: string;
    readonly recordId: string;
    readonly tenantId: string;
  };
  readonly sourceText: string;
  readonly authority: "canonical" | "exploratory" | "user_managed";
  readonly assurance: "high" | "medium" | "low";
  readonly freshnessAt: string;
  readonly locator?: {
    readonly representationId: string;
    readonly nodeId?: string;
    readonly startOffset?: number;
    readonly endOffset?: number;
    readonly quoteDigest?: `sha256:${string}`;
  };
  readonly artifactReference?: {
    readonly artifactId: string;
    readonly tenantId: string;
    readonly digest: `sha256:${string}`;
    readonly mediaType: string;
    readonly byteLength?: number;
  };
}

export interface PersistRetrievalExecutionInput {
  readonly operationId: string;
  readonly requestSha256: string;
  readonly planId: string;
  readonly policyVersionNumber: number;
  readonly activeVectorSpaceVersionIds: readonly string[];
  readonly packet: unknown;
  readonly stageTimings: unknown;
  readonly fusionParameters: unknown;
  readonly rerankerId?: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly vectorItemId: string;
    readonly stageScores: unknown;
    readonly finalScore: number;
    readonly rank: number;
    readonly sources: readonly {
      readonly id: string;
      readonly channel: "vector" | "lexical" | "exact" | "graph" | "rerank";
      readonly searchProjectionId?: string;
      readonly sourceRank: number;
      readonly score: number;
      readonly explanation: unknown;
    }[];
  }[];
}

/** Bounds for one canonical support traversal; every limit fails closed rather than truncating silently. */
export const RETRIEVAL_SUPPORT_LIMITS = {
  maximumCandidates: 200,
  maximumPathsPerCandidate: 32,
  maximumRows: 4_096,
  maximumCaptureBytes: 4_000_000,
} as const;

export type RetrievalTargetKind = "entity" | "record" | "chunk" | "claim" | "summary";

export interface RetrievalSupportPathRow {
  readonly claimId: string;
  readonly claimStatus: "verified" | "superseded";
  readonly verificationRunId: string;
  readonly assessmentVerdict: "directly_supported" | "supported_with_qualification" | "derived_verified";
  readonly admissionDigest: `sha256:${string}`;
  readonly locatorId: string;
  readonly selectorDigest: `sha256:${string}`;
  readonly selectedContentDigest: `sha256:${string}`;
  readonly captureId: string;
  readonly sourceFamilyId: string;
  readonly representationId: string;
  readonly captureArtifact: {
    readonly artifactId: string;
    readonly tenantId: string;
    readonly digest: `sha256:${string}`;
    readonly mediaType: string;
    readonly byteLength: number;
  };
  readonly qualifiers: readonly string[];
}

export interface ResolvedRetrievalSupport {
  readonly vectorItemId: string;
  readonly searchProjectionId: string;
  readonly target: {
    readonly kind: RetrievalTargetKind;
    readonly canonicalId: string;
    readonly projectionTargetId: string;
  };
  readonly paths: readonly RetrievalSupportPathRow[];
  readonly sourceFamilyIds: readonly string[];
  readonly graphPaths: readonly (readonly string[])[];
  readonly contradictionIds: readonly string[];
  readonly supersedesIds: readonly string[];
  readonly truncated: boolean;
}

export interface RetrievalSupportRequest {
  readonly tenantId: string;
  readonly vectorItemIds: readonly string[];
  readonly knowledgeSeq: number;
}

/** The step lease fields retrieval execution reads; the repository returns its own richer lease. */
export interface RetrievalOperationLease {
  readonly stepKey: string;
}

/** Everything canonical retrieval execution needs from storage; implemented by PostgresCanonicalRepository. */
export interface CanonicalRetrievalRepository {
  getRetrievalRunResource(
    tenantId: string,
    runId: string,
  ): Promise<{ readonly id: string; readonly evidencePacketIds: readonly string[] } | undefined>;
  getEvidencePacket(tenantId: string, packetId: string): Promise<unknown | undefined>;
  resolveRetrievalPolicy(
    tenantId: string,
    policyVersionId: string,
    requestedSpaces: readonly string[],
  ): Promise<RetrievalPolicySnapshot>;
  retrievalKnowledgeClock(tenantId: string, requested?: number): Promise<number>;
  retrievalPublications(
    tenantId: string,
    vectorSpaceVersionIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  hybridSearch(request: HybridSearchRequest): Promise<readonly HybridSearchResult[]>;
  getRetrievalEvidenceRecords(
    tenantId: string,
    vectorItemIds: readonly string[],
  ): Promise<readonly RetrievalEvidenceRecord[]>;
  resolveRetrievalSupport(input: RetrievalSupportRequest): Promise<readonly ResolvedRetrievalSupport[]>;
  storeRetrievalExecution(tenantId: string, input: PersistRetrievalExecutionInput): Promise<string>;
  listSteps(
    tenantId: string,
    operationId: string,
  ): Promise<readonly { readonly stepKey: string; readonly status: string }[]>;
  claimOperation(
    tenantId: string,
    operationId: string,
    holderIdentity: string,
  ): Promise<RetrievalOperationLease | undefined>;
  completeStep(
    tenantId: string,
    lease: RetrievalOperationLease,
    receipt: { id: string; idempotencyKey: string; receiptKind: string; executorIdentity: string; output: unknown },
  ): Promise<unknown>;
  failStep(
    tenantId: string,
    lease: RetrievalOperationLease,
    failure: { id: string; idempotencyKey: string; executorIdentity: string; errorClass: string; retryable: boolean },
  ): Promise<unknown>;
}
