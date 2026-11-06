import type { JsonValue } from "@aiengineer/knowledge-contracts";

export type OperationStatus =
  | "proposed"
  | "queued"
  | "running"
  | "needs_review"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "quarantined"
  | "superseded";

export interface CanonicalOperation {
  readonly id: string;
  readonly tenantId: string;
  readonly operationKind: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly status: OperationStatus;
  readonly rowVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CanonicalOperationRecord extends CanonicalOperation {
  readonly ownershipMode: "standalone" | "mission_control" | "eve";
  readonly externalRunId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly actorIdentity: string;
  readonly request: unknown;
}

export interface CanonicalOperationEvent {
  readonly id: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

export interface CanonicalOperationControl {
  readonly actorIdentity: string;
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface CreateCanonicalOperation {
  readonly id: string;
  readonly tenantId: string;
  readonly operationKind: string;
  readonly idempotencyKey: string;
  readonly ownershipMode?: "standalone" | "mission_control" | "eve";
  readonly externalRunId?: string;
  readonly missionId?: string;
  readonly workItemId?: string;
  readonly attemptId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly actorIdentity: string;
  readonly capabilityVersionId?: string;
  readonly request: unknown;
  readonly steps: readonly {
    readonly id: string;
    readonly key: string;
    readonly kind: string;
    readonly input: unknown;
    readonly maxAttempts?: number;
  }[];
}

export interface CanonicalStep {
  readonly id: string;
  readonly tenantId: string;
  readonly operationId: string;
  readonly stepKey: string;
  readonly stepKind: string;
  readonly inputSha256: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly rowVersion: number;
  readonly input?: unknown;
}

export interface LeasedStep extends CanonicalStep {
  readonly holderIdentity: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
}

export interface CanonicalReceipt {
  readonly id: string;
  readonly operationId: string;
  readonly stepId?: string;
  readonly receiptKind: string;
  readonly idempotencyKey: string;
  readonly inputSha256: string;
  readonly outputSha256?: string;
  readonly outcome: string;
  readonly body: unknown;
  readonly createdAt: string;
}

/** API-safe metadata for an immutable object in the canonical artifact registry. */
export interface CanonicalArtifactResource {
  readonly artifactId: string;
  readonly tenantId: string;
  readonly artifactType: string;
  readonly schemaVersion: number;
  readonly digest: string;
  readonly bucketClass: string;
  readonly mediaType?: string;
  readonly byteLength?: number;
  readonly supersededById?: string;
  readonly createdAt: string;
}

export interface CanonicalVectorStoreResource {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerIdentity: string;
  readonly storeClass: "official_canonical" | "internal_exploratory" | "user_managed";
  readonly slug: string;
  readonly name: string;
  readonly purpose: string;
  readonly visibility: "private" | "tenant" | "public";
  readonly lifecycle: "active" | "suspended" | "superseded" | "deleted";
  readonly quotaProfile: unknown;
  readonly retentionPolicy: unknown;
  readonly deletionPolicy: unknown;
  readonly createdByAttemptId?: string;
  readonly supersedesId?: string;
  readonly createdAt: string;
  readonly documentCount: number;
  readonly spaces: readonly {
    readonly id: string;
    readonly vectorSpaceId: string;
    readonly activeSpaceVersionId?: string;
    readonly authorityClass: "official" | "exploratory" | "user_managed";
    readonly createdAt: string;
  }[];
  readonly spacesTruncated: boolean;
}

export interface PersistVectorStoreInput {
  readonly operationId: string;
  readonly vectorStoreId: string;
  readonly ownerIdentity: string;
  readonly storeClass: "official_canonical" | "internal_exploratory" | "user_managed";
  readonly slug: string;
  readonly name: string;
  readonly purpose: string;
  readonly visibility: "private" | "tenant" | "public";
  readonly quotaProfile: JsonValue;
  readonly retentionPolicy: JsonValue;
  readonly deletionPolicy: JsonValue;
  readonly supersedesId?: string;
}

export interface VectorStoreLifecycleRepository {
  persistVectorStore(tenantId: string, input: PersistVectorStoreInput): Promise<CanonicalVectorStoreResource>;
  attachDocuments(tenantId: string, input: AttachVectorStoreDocumentsInput): Promise<AttachedVectorStoreDocuments>;
  verifyIngestionStage(
    tenantId: string,
    input: VerifyVectorStoreIngestionInput,
    stage: VectorStoreIngestionStage,
  ): Promise<VectorStoreIngestionStageResult>;
}

export interface AttachVectorStoreDocumentsInput {
  readonly operationId: string;
  readonly vectorStoreId: string;
  readonly actorIdentity: string;
  readonly controlPlaneOverride: boolean;
  readonly documents: readonly {
    readonly id: string;
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly representationId: string;
    readonly requestedProfile: JsonValue;
  }[];
}
export interface AttachedVectorStoreDocuments {
  readonly vectorStoreId: string;
  readonly storeClass: "official_canonical" | "internal_exploratory" | "user_managed";
  readonly ownerIdentity: string;
  readonly documentIds: readonly string[];
  readonly attachmentIds: readonly string[];
  readonly attachmentCount: number;
  readonly state: "requested";
}

export type VectorStoreIngestionStage = "prepared" | "embedded" | "indexed";
export interface VectorStoreIngestionChain {
  readonly attachmentId: string;
  readonly transformationOperationId: string;
  readonly chunkSetId: string;
  readonly chunkSetOperationId: string;
  readonly promotionProposalId: string;
  readonly promotionProposalOperationId: string;
  readonly promotionDecisionId: string;
  readonly promotionDecisionOperationId: string;
  readonly embeddingRunId: string;
  readonly embeddingOperationId: string;
  readonly publicationId: string;
  readonly publicationOperationId: string;
}
export interface VerifyVectorStoreIngestionInput {
  readonly operationId: string;
  readonly ingestionRunId: string;
  readonly vectorStoreId: string;
  readonly actorIdentity: string;
  readonly controlPlaneOverride: boolean;
  readonly requestDigest: `sha256:${string}`;
  readonly chains: readonly VectorStoreIngestionChain[];
}
export interface VectorStoreIngestionStageResult {
  readonly schemaVersion: "knowledge.vector-store-ingestion-stage/v1";
  readonly ingestionRunId: string;
  readonly vectorStoreId: string;
  readonly stage: VectorStoreIngestionStage;
  readonly attachmentCount: number;
  readonly evidenceDigest: `sha256:${string}`;
}

/** A receipt addressed by its own immutable identity, never by operation id. */
export interface CanonicalReceiptResource extends CanonicalReceipt {
  readonly tenantId: string;
  readonly executorIdentity: string;
  readonly inputDigest: string;
  readonly outputDigest?: string;
}

export interface CanonicalRetrievalRunResource {
  readonly id: string;
  readonly tenantId: string;
  readonly plan: {
    readonly id: string;
    readonly queryIntent: string;
    readonly decomposition: unknown;
    readonly spaces: unknown;
    readonly filters: unknown;
    readonly policyVersion: number;
    readonly validated: boolean;
    readonly validationErrors?: unknown;
    readonly createdAt: string;
  };
  readonly stageTimings: unknown;
  readonly fusionParameters: unknown;
  readonly rerankerId?: string;
  readonly executedAt: string;
  readonly evidencePacketIds: readonly string[];
}

export interface CanonicalRetrievalExplanationResource {
  readonly retrievalRunId: string;
  readonly stageTimings: unknown;
  readonly fusionParameters: unknown;
  readonly rerankerId?: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly vectorItemId?: string;
    readonly lexicalReference?: string;
    readonly stageScores: unknown;
    readonly finalScore?: number;
    readonly rank?: number;
    readonly sources: readonly {
      readonly channel: string;
      readonly searchProjectionId?: string;
      readonly vectorItemId?: string;
      readonly sourceRank: number;
      readonly score: number;
      readonly explanation: unknown;
    }[];
  }[];
  readonly truncated: boolean;
}

export interface CanonicalEvaluationReportResource {
  readonly id: string;
  readonly tenantId: string;
  readonly datasetId: string;
  readonly targetKind: string;
  readonly configuration: unknown;
  readonly codeReference?: string;
  readonly executedAt: string;
  readonly metrics: readonly {
    readonly id: string;
    readonly metricDefinitionId: string;
    readonly caseId?: string;
    readonly value?: number;
    readonly details: unknown;
    readonly createdAt: string;
  }[];
  readonly gates: readonly {
    readonly id: string;
    readonly gateVersionId: string;
    readonly passed: boolean;
    readonly falseAcceptanceCount: number;
    readonly observations: unknown;
    readonly resultDigest: string;
    readonly createdAt: string;
  }[];
}

export interface CanonicalEvaluationFailuresResource {
  readonly evaluationRunId: string;
  readonly failures: readonly {
    readonly caseId: string;
    readonly metrics: unknown;
    readonly falseAcceptance: boolean;
    readonly falseRejection: boolean;
    readonly output?: unknown;
  }[];
  readonly truncated: boolean;
}

export interface PendingOutboxMessage {
  readonly id: string;
  readonly operationId: string;
  readonly eventId: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly payloadSha256: string;
  readonly deliveryAttempts: number;
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly claimedAt: string;
  readonly visibilityExpiresAt: string;
}

export interface OutboxClaim {
  readonly id: string;
  readonly claimOwner: string;
  readonly claimToken: string;
}

export interface ReviewSubjectInput {
  readonly id: string;
  readonly operationId: string;
  readonly subjectKind:
    | "source_vetting"
    | "conversion"
    | "representation"
    | "domain_mapping"
    | "chunking"
    | "projection"
    | "content_promotion"
    | "publication"
    | "regression_waiver"
    | "injection_security"
    | "retrieval_anomaly";
  readonly subjectRef: unknown;
  readonly guardedSha256: string;
  readonly eligibleRoles: readonly string[];
  readonly quorumRequired?: number;
  readonly expiresAt?: string;
}

export interface ReviewDecisionInput {
  readonly id: string;
  readonly reviewSubjectId: string;
  readonly guardedSha256: string;
  readonly reviewerIdentity: string;
  readonly reviewerRole: string;
  readonly decision: "approve" | "reject" | "defer" | "request_changes";
  readonly rationale: string;
  readonly decisionOperationId: string;
}

export interface GovernedProjectionProposalInput {
  readonly selection?: import("@aiengineer/knowledge-contracts").PromotionSelection;
  readonly selectionArtifact?: import("./promotion-selection.js").PromotionSelectionArtifact;
  readonly operationId: string;
  readonly chunkSetId: string;
  readonly representationDecisionId: string;
  readonly projectionProcedureId: string;
  readonly purpose: string;
  readonly contextualPrefix: string;
  readonly language?: string;
  readonly visibility: string;
  readonly classification: string;
  readonly targetDomains: readonly string[];
  readonly expectedValue: string;
  readonly risks: readonly string[];
  readonly exclusions: readonly string[];
  readonly reason: string;
  readonly proposedBy: string;
}

export interface GovernedProjectionProposal {
  readonly selectionDigest?: string;
  readonly proposalId: string;
  readonly proposalDigest: `sha256:${string}`;
  readonly projectionIds: readonly string[];
  readonly projectionManifestDigest: `sha256:${string}`;
  readonly chunkSetId: string;
  readonly representationId: string;
}

export interface GovernedPromotionDecisionInput {
  readonly operationId: string;
  readonly proposalId: string;
  readonly guardedDigest: `sha256:${string}`;
  readonly knowledgeReviewDecisionId: string;
  readonly reviewerIdentity: string;
  readonly decision: "accept" | "reject" | "defer" | "request_changes";
  readonly gates: unknown;
  readonly policyVersion: string;
  readonly rationale: string;
  readonly expiresAt?: string;
}

export interface GovernedEmbeddingInput {
  readonly projectionId: string;
  readonly text: string;
  readonly textDigest: `sha256:${string}`;
}

export interface GovernedEmbeddingContext {
  readonly knowledgeSeq?: number;
  readonly selectionDigest?: string;
  readonly selectionBudget?: import("@aiengineer/knowledge-contracts").PromotionSelection["budget"];
  readonly vectorSpaceVersionId: string;
  readonly modelSlug: string;
  readonly dimensions: number;
  readonly projectionProcedureId: string;
  readonly vectorSpaceKey: string;
  readonly promotionDecisionId: string;
  readonly inputs: readonly GovernedEmbeddingInput[];
}

export interface PersistGovernedEmbeddingRunInput {
  readonly operationId: string;
  readonly embeddingRunId: string;
  readonly context: GovernedEmbeddingContext;
  readonly idempotencyKey: string;
  readonly adapterVersion: string;
  readonly providerRoutePolicy: unknown;
  readonly receipt: {
    readonly requestId: string;
    readonly observedProviderRoute: string;
    readonly inputManifestDigest: `sha256:${string}`;
    readonly outputManifestDigest: `sha256:${string}`;
    readonly usageTokens: number;
    readonly costUsd: number;
    readonly latencyMs: number;
    readonly retryHistory: unknown;
    readonly items: readonly {
      readonly projectionId: string;
      readonly inputDigest: `sha256:${string}`;
      readonly outputDigest: `sha256:${string}`;
      readonly cacheKey: string;
      readonly embedding: readonly number[];
    }[];
  };
}

export interface GovernedEmbeddingRun {
  readonly embeddingRunId: string;
  readonly vectorSpaceVersionId: string;
  readonly itemCount: number;
  readonly inputManifestDigest: `sha256:${string}`;
  readonly outputManifestDigest: `sha256:${string}`;
  readonly vectorItemManifestDigest: `sha256:${string}`;
  readonly status: "succeeded";
}

export type PublishedQueryMode = "exact" | "ann";

export interface GovernedSelectedCandidateSpace {
  readonly vectorSpaceVersionId: string;
  readonly space: string;
  readonly embeddingRunId: string;
  readonly vectorIds: readonly string[];
  readonly physicalDigests: readonly string[];
}

export interface GovernedSelectedCandidateResult {
  readonly schemaVersion: "knowledge.selected-candidate-index-result/v1";
  readonly selectionDigest: string;
  readonly evidenceDigest: `sha256:${string}`;
  readonly spaces: readonly GovernedSelectedCandidateSpace[];
  readonly indexed: true;
  readonly publishable: false;
}

export interface GovernedRankedItem {
  readonly vectorItemId: string;
  readonly searchProjectionId: string;
  readonly score: number;
}

export interface GovernedCandidateAnswer {
  readonly queryId: string;
  readonly embeddingDigest: `sha256:${string}`;
  readonly recallAtK: number;
  readonly exact: readonly GovernedRankedItem[];
  readonly ann: readonly GovernedRankedItem[];
}

export interface GovernedCandidateEvaluation {
  readonly schemaVersion: "knowledge.selected-candidate-evaluation-result/v1";
  readonly candidateEvidenceDigest: `sha256:${string}`;
  readonly selectionDigest: string;
  readonly evaluatorIdentity: string;
  readonly passed: true;
  readonly evaluationDigest: `sha256:${string}`;
  readonly spaces: readonly {
    readonly vectorSpaceVersionId: string;
    readonly space: string;
    readonly evalRunId: string;
    readonly evaluationResultId: string;
    readonly resultDigest: `sha256:${string}`;
    readonly baselineId: string;
    readonly itemCount: number;
    readonly annPlan: string;
    readonly recallAtK: number;
    readonly answers: readonly GovernedCandidateAnswer[];
  }[];
}

export interface GovernedPublishedAnswer {
  readonly publicationId: string;
  readonly vectorSpaceVersionId: string;
  readonly mode: PublishedQueryMode;
  readonly annPlan: string;
  readonly items: readonly GovernedRankedItem[];
  readonly gated: readonly { readonly vectorItemId: string; readonly revoked: readonly string[] }[];
  readonly historical: readonly GovernedRankedItem[];
}

export interface GovernedPublicationBaselineComparison {
  readonly publicationId: string;
  readonly vectorSpaceVersionId: string;
  readonly equivalent: boolean;
  readonly differences: readonly string[];
}

export interface GovernedPublicationInput {
  readonly operationId: string;
  readonly publicationId: string;
  readonly vectorStoreSpaceId: string;
  readonly vectorSpaceVersionId: string;
  readonly promotionDecisionId: string;
  readonly evaluationResultId: string;
  readonly expectedOwnerIdentity: string;
  readonly publisherIdentity: string;
  /** Required whenever the repository holds selection authority: activation binds the exact evaluated candidate. */
  readonly candidate?: import("@aiengineer/knowledge-contracts").SelectedCandidateIndexInput;
  readonly candidateEvidenceDigest?: string;
  readonly evaluationDigest?: string;
}

export interface GovernedPublication {
  readonly publicationId: string;
  readonly guardedDigest: `sha256:${string}`;
  readonly vectorSpaceVersionId: string;
  readonly expectedItemCount: number;
  readonly status: "approved" | "published";
  readonly switchReceiptId?: string;
}

export interface GovernedIndexRepository {
  verifySelectedCandidate(
    tenantId: string,
    input: import("@aiengineer/knowledge-contracts").SelectedCandidateIndexInput,
  ): Promise<GovernedSelectedCandidateResult>;
  evaluateSelectedCandidate(
    tenantId: string,
    input: import("@aiengineer/knowledge-contracts").SelectedCandidateEvaluationInput,
  ): Promise<GovernedCandidateEvaluation>;
  queryPublishedSpace(
    tenantId: string,
    input: {
      vectorStoreSpaceId: string;
      queryEmbedding: readonly number[];
      resultLimit?: number;
      mode: PublishedQueryMode;
    },
  ): Promise<GovernedPublishedAnswer>;
  verifyPublicationBaseline(
    tenantId: string,
    input: { vectorStoreSpaceId: string; queries: readonly { queryId: string; embedding: readonly number[] }[] },
  ): Promise<GovernedPublicationBaselineComparison>;
  persistRepresentationDecision(
    tenantId: string,
    input: {
      operationId: string;
      representationId: string;
      guardedDigest: `sha256:${string}`;
      knowledgeReviewDecisionId: string;
      reviewerIdentity: string;
      decision: "accept" | "reject" | "quarantine" | "defer" | "request_changes";
      policyVersion: string;
      rationale: string;
      expiresAt?: string;
    },
  ): Promise<string>;
  persistProjectionProposal(
    tenantId: string,
    input: GovernedProjectionProposalInput,
  ): Promise<GovernedProjectionProposal>;
  getProjectionProposal(tenantId: string, proposalId: string): Promise<GovernedProjectionProposal | undefined>;
  persistPromotionDecision(tenantId: string, input: GovernedPromotionDecisionInput): Promise<string>;
  loadEmbeddingContext(
    tenantId: string,
    vectorSpaceVersionId: string,
    promotionDecisionId: string,
    projectionIds: readonly string[],
  ): Promise<GovernedEmbeddingContext>;
  persistEmbeddingRun(tenantId: string, input: PersistGovernedEmbeddingRunInput): Promise<GovernedEmbeddingRun>;
  getEmbeddingRunByOperation(tenantId: string, operationId: string): Promise<GovernedEmbeddingRun | undefined>;
  stagePublication(tenantId: string, input: GovernedPublicationInput): Promise<GovernedPublication>;
  publishStaged(
    tenantId: string,
    publicationId: string,
    operationId: string,
    expectedGuardedDigest: `sha256:${string}`,
    reason: string,
    publisherIdentity: string,
    idempotencyKey: string,
  ): Promise<GovernedPublication>;
  verifyPublication(tenantId: string, publicationId: string): Promise<GovernedPublication>;
  planRollback(
    tenantId: string,
    currentPublicationId: string,
    targetPublicationId: string,
    publisherIdentity: string,
  ): Promise<{
    guardedDigest: `sha256:${string}`;
    vectorStoreSpaceId: string;
    frozenBaseline?: readonly { queryId: string; embeddingDigest: string }[];
  }>;
  executeRollback(
    tenantId: string,
    operationId: string,
    currentPublicationId: string,
    targetPublicationId: string,
    expectedGuardedDigest: `sha256:${string}`,
    reason: string,
    publisherIdentity: string,
    idempotencyKey: string,
  ): Promise<string>;
}

// Retrieval repository port shapes are owned by application; re-exported under their historical names.
export type {
  ActiveRetrievalTarget,
  HybridSearchRequest,
  HybridSearchResult,
  PersistRetrievalExecutionInput,
  RetrievalEvidenceRecord,
  RetrievalPolicySnapshot,
} from "@aiengineer/knowledge-application";
import type {
  HybridSearchRequest,
  HybridSearchResult,
  PersistRetrievalExecutionInput,
  RetrievalEvidenceRecord,
  RetrievalPolicySnapshot,
} from "@aiengineer/knowledge-application";

export interface OperationsRepository {
  createOperation(input: CreateCanonicalOperation): Promise<CanonicalOperation>;
  getOperation(tenantId: string, operationId: string): Promise<CanonicalOperation | undefined>;
  getOperationRecord(tenantId: string, operationId: string): Promise<CanonicalOperationRecord | undefined>;
  listOperations(tenantId: string, limit?: number): Promise<readonly CanonicalOperationRecord[]>;
  listOperationEvents(
    tenantId: string,
    operationId: string,
    afterSequence?: number,
    limit?: number,
  ): Promise<readonly CanonicalOperationEvent[] | undefined>;
  listSteps(tenantId: string, operationId: string): Promise<readonly CanonicalStep[]>;
  cancelOperation(
    tenantId: string,
    operationId: string,
    control: CanonicalOperationControl,
  ): Promise<CanonicalOperationRecord | undefined>;
  retryOperation(
    tenantId: string,
    operationId: string,
    control: CanonicalOperationControl,
  ): Promise<CanonicalOperationRecord | undefined>;
  reconcileOperation(tenantId: string, operationId: string): Promise<CanonicalOperationRecord | undefined>;
  reconcileOperations(tenantId: string, limit?: number): Promise<number>;
}

export interface LeaseRepository {
  claimNext(
    tenantId: string,
    holderIdentity: string,
    leaseMs?: number,
    eligibleOperationKinds?: readonly string[],
  ): Promise<LeasedStep | undefined>;
  claimOperation(
    tenantId: string,
    operationId: string,
    holderIdentity: string,
    leaseMs?: number,
  ): Promise<LeasedStep | undefined>;
  heartbeat(
    tenantId: string,
    lease: Pick<LeasedStep, "id" | "leaseToken" | "fencingToken">,
    leaseMs?: number,
  ): Promise<LeasedStep>;
  completeStep(
    tenantId: string,
    lease: LeasedStep,
    receipt: { id: string; idempotencyKey: string; receiptKind: string; executorIdentity: string; output: unknown },
  ): Promise<CanonicalReceipt>;
  failStep(
    tenantId: string,
    lease: LeasedStep,
    failure: {
      id: string;
      idempotencyKey: string;
      executorIdentity: string;
      errorClass: string;
      retryable: boolean;
      retryDelayMs?: number;
    },
  ): Promise<CanonicalReceipt>;
}

export interface OutboxRepository {
  claimOutbox(
    tenantId: string,
    claimOwner: string,
    limit?: number,
    visibilityTimeoutMs?: number,
  ): Promise<readonly PendingOutboxMessage[]>;
  claimOperationOutbox(
    tenantId: string,
    operationId: string,
    claimOwner: string,
    limit?: number,
    visibilityTimeoutMs?: number,
  ): Promise<readonly PendingOutboxMessage[]>;
  extendOutboxClaim(tenantId: string, claim: OutboxClaim, visibilityTimeoutMs?: number): Promise<string>;
  ackOutbox(tenantId: string, claim: OutboxClaim): Promise<void>;
  nackOutbox(tenantId: string, claim: OutboxClaim, errorClass: string, retryDelayMs?: number): Promise<void>;
  markOutboxPublished(tenantId: string, claim: OutboxClaim): Promise<void>;
  markOutboxFailed(tenantId: string, claim: OutboxClaim, errorClass: string, retryDelayMs?: number): Promise<void>;
}

export interface ReceiptRepository {
  listReceipts(tenantId: string, operationId: string): Promise<readonly CanonicalReceipt[]>;
}

export interface ResourceReadRepository {
  getVectorStoreResource(tenantId: string, vectorStoreId: string): Promise<CanonicalVectorStoreResource | undefined>;
  getArtifactResource(tenantId: string, artifactId: string): Promise<CanonicalArtifactResource | undefined>;
  getReceiptResource(tenantId: string, receiptId: string): Promise<CanonicalReceiptResource | undefined>;
  getRetrievalRunResource(tenantId: string, runId: string): Promise<CanonicalRetrievalRunResource | undefined>;
  getRetrievalExplanationResource(
    tenantId: string,
    runId: string,
  ): Promise<CanonicalRetrievalExplanationResource | undefined>;
  getEvaluationReportResource(tenantId: string, runId: string): Promise<CanonicalEvaluationReportResource | undefined>;
  getEvaluationFailuresResource(
    tenantId: string,
    runId: string,
  ): Promise<CanonicalEvaluationFailuresResource | undefined>;
  operationBelongsToVectorStore(tenantId: string, vectorStoreId: string, operationId: string): Promise<boolean>;
}

export interface ReviewRepository {
  createReviewSubject(tenantId: string, input: ReviewSubjectInput): Promise<string>;
  recordReviewDecision(tenantId: string, input: ReviewDecisionInput): Promise<string>;
}

export interface VectorPublicationRepository {
  publishVectorSpace(
    tenantId: string,
    input: {
      publicationId: string;
      expectedGuardedSha256: string;
      reason: string;
      actorIdentity: string;
      idempotencyKey: string;
    },
  ): Promise<string>;
  rollbackVectorSpace(
    tenantId: string,
    input: {
      currentPublicationId: string;
      targetPublicationId: string;
      expectedGuardedSha256: string;
      reason: string;
      actorIdentity: string;
      idempotencyKey: string;
      operationId: string;
    },
  ): Promise<string>;
}

export interface RetrievalRepository {
  resolveRetrievalPolicy(
    tenantId: string,
    policyVersionId: string,
    requestedSpaces: readonly string[],
  ): Promise<RetrievalPolicySnapshot>;
  hybridSearch(request: HybridSearchRequest): Promise<readonly HybridSearchResult[]>;
  getRetrievalEvidenceRecords(
    tenantId: string,
    vectorItemIds: readonly string[],
  ): Promise<readonly RetrievalEvidenceRecord[]>;
  storeRetrievalExecution(tenantId: string, input: PersistRetrievalExecutionInput): Promise<string>;
  annNearest(
    request: Omit<HybridSearchRequest, "queryText" | "filters" | "candidateLimit" | "rrfK">,
  ): Promise<readonly { vectorItemId: string; score: number }[]>;
  exactNearest(
    request: Omit<HybridSearchRequest, "queryText" | "filters" | "candidateLimit" | "rrfK">,
  ): Promise<readonly { vectorItemId: string; score: number }[]>;
  storeEvidencePacket(
    tenantId: string,
    input: { planId: string; runId: string; packetId: string; packet: unknown },
  ): Promise<string>;
  getEvidencePacket(tenantId: string, packetId: string): Promise<unknown | undefined>;
}

export interface PersistedPreparationArtifact {
  readonly artifactId: string;
  readonly digest: `sha256:${string}`;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly storageKey: string;
  readonly artifactType: string;
  readonly bucketClass: "source_captures" | "candidate" | "accepted" | "ledger" | "published";
  readonly storageBucket: "source-captures" | "content-derivatives" | "ai-engineer-cloud-bucket";
}

export interface PersistCaptureInput {
  readonly operationId: string;
  readonly sourceId: string;
  readonly captureId: string;
  readonly sourceClass: "web_page" | "api" | "repository" | "pdf" | "transcript" | "dataset" | "registry" | "other";
  readonly canonicalUrl: string;
  readonly publisher?: string;
  readonly sensitivity: "public" | "restricted" | "confidential";
  readonly artifact: PersistedPreparationArtifact;
  readonly captureMethod: string;
  readonly captureMethodVersion: string;
  readonly requestUrl: string;
  readonly httpStatus?: number;
  readonly observations: unknown;
  readonly capturedAt: string;
}

export interface PersistedCapture extends PersistCaptureInput {}

export interface PersistRepresentationInput {
  readonly operationId: string;
  readonly transformationRunId: string;
  readonly sourceCaptureId: string;
  readonly sourceArtifact: PersistedPreparationArtifact;
  readonly documentId: string;
  readonly documentKind: string;
  readonly canonicalTitle: string;
  readonly canonicalSourceId: string;
  readonly identifier?: {
    readonly type: "url" | "doi" | "arxiv" | "openreview" | "isbn" | "repository" | "media_id" | "other";
    readonly value: string;
    readonly authority?: string;
  };
  readonly documentVersionId: string;
  readonly versionLabel: string;
  readonly manifestDigest: `sha256:${string}`;
  readonly sourceNativeRepresentationId: string;
  readonly structuralRepresentationId: string;
  readonly providerKey: string;
  readonly providerVersion: string;
  readonly profileDigest: `sha256:${string}`;
  readonly requestDigest: `sha256:${string}`;
  readonly receiptDigest: `sha256:${string}`;
  readonly outputArtifacts: readonly PersistedPreparationArtifact[];
  readonly structuralArtifactId: string;
  readonly structuralArtifactDigest: `sha256:${string}`;
  readonly nodes: readonly {
    readonly id: string;
    readonly tenantId: string;
    readonly representationId: string;
    readonly createdAt: string;
    readonly parentId?: string;
    readonly ordinal: number;
    readonly stableLocalKey: string;
    readonly kind: string;
    readonly role?: string;
    readonly text: string;
    readonly language?: string;
    readonly digest: `sha256:${string}`;
    readonly locator: unknown;
  }[];
  readonly fidelity: {
    readonly grade: "high" | "medium" | "low";
    readonly coverage: number;
    readonly locatorCoverage: number;
    readonly findings: unknown;
  };
  readonly receipt: unknown;
  readonly completedAt: string;
}

export interface PersistedRepresentation {
  readonly operationId: string;
  readonly transformationRunId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly sourceNativeRepresentationId: string;
  readonly structuralRepresentationId: string;
  readonly structuralArtifactDigest: `sha256:${string}`;
  readonly nodeCount: number;
  readonly acceptanceState: string;
  readonly conversionGrade: string;
  readonly receipt: unknown;
}

export interface PersistChunkSetInput {
  readonly operationId: string;
  readonly representationId: string;
  readonly procedureVersionId: string;
  readonly procedureSlug: string;
  readonly procedureVersion: string;
  readonly tokenizer: string;
  readonly profile: unknown;
  readonly inputDigest: `sha256:${string}`;
  readonly outputDigest: `sha256:${string}`;
  readonly chunkSetId: string;
  readonly chunks: readonly {
    readonly id: string;
    readonly ordinal: number;
    readonly sourceText: string;
    readonly contextualPrefix: string;
    readonly embeddingText: string;
    readonly sourceTextDigest: `sha256:${string}`;
    readonly embeddingTextDigest: `sha256:${string}`;
    readonly sourceTokenCount: number;
    readonly embeddingTokenCount: number;
    readonly role: string;
    readonly spans: readonly {
      readonly nodeId: string;
      readonly startOffset: number;
      readonly endOffset: number;
      readonly selectedTextDigest: `sha256:${string}`;
    }[];
  }[];
}

export interface PersistedChunkSet {
  readonly operationId: string;
  readonly chunkSetId: string;
  readonly representationId: string;
  readonly inputDigest: `sha256:${string}`;
  readonly outputDigest: `sha256:${string}`;
  readonly chunkCount: number;
  readonly spanCount: number;
  readonly status: string;
}

export interface PreparationRepository {
  persistCapture(tenantId: string, input: PersistCaptureInput): Promise<PersistedCapture>;
  getCaptureByOperation(tenantId: string, operationId: string): Promise<PersistedCapture | undefined>;
  persistRepresentation(tenantId: string, input: PersistRepresentationInput): Promise<PersistedRepresentation>;
  getRepresentationByOperation(tenantId: string, operationId: string): Promise<PersistedRepresentation | undefined>;
  getRepresentationNodes(
    tenantId: string,
    representationId: string,
  ): Promise<readonly PersistRepresentationInput["nodes"][number][]>;
  persistChunkSet(tenantId: string, input: PersistChunkSetInput): Promise<PersistedChunkSet>;
  getChunkSetByOperation(tenantId: string, operationId: string): Promise<PersistedChunkSet | undefined>;
}
