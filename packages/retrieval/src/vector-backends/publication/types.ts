import { CANONICAL_EMBEDDING_DIMENSIONS } from "../types.js";
import type { ActivePublicationPointer, PublicationEvent, PublicationState } from "../spaces/version.js";

export type Digest = `sha256:${string}`;

export interface PublicationManifests {
  readonly source: Digest;
  readonly representation: Digest;
  readonly chunkSet: Digest;
  readonly projection: Digest;
  readonly vectorItem: Digest;
  readonly embedding: Digest;
  readonly index: Digest;
  readonly retrievalPolicy: Digest;
  readonly evaluation: Digest;
}

export interface PublicationInspection {
  readonly vectorSpaceVersionId: string;
  readonly itemCount: number;
  readonly dimensions: number;
  readonly precision: "halfvec" | "vector" | string;
  readonly manifests: PublicationManifests;
  readonly indexReady: boolean;
  readonly authorizationPassed: boolean;
  readonly evaluationPassed: boolean;
  readonly sampleSearchPassed: boolean;
  /** Set for evaluated selected candidates; absent for the legacy counted chain. */
  readonly candidateEvidenceDigest?: Digest;
  readonly requiredDependenciesEligible?: boolean;
}

export interface PublicationInspector {
  inspect(vectorSpaceVersionId: string): Promise<PublicationInspection>;
}

export interface ExploratoryPublication {
  readonly id: string;
  readonly tenantId: string;
  readonly vectorStoreId: string;
  readonly vectorStoreSpaceId: string;
  readonly vectorSpaceVersionId: string;
  readonly storeClass: "internal_exploratory";
  readonly expectedItemCount: number;
  readonly dimensions: typeof CANONICAL_EMBEDDING_DIMENSIONS;
  readonly manifests: PublicationManifests;
  readonly promotionDecisionId: string;
  readonly evaluationGateResultId: string;
  readonly candidateEvidenceDigest?: Digest;
  readonly predecessorId?: string;
  readonly state: PublicationState;
  readonly verificationDigest: Digest;
  readonly receiptId: string;
  readonly publishedAt: string;
}

export interface PublishExploratoryRequest {
  readonly publicationId: string;
  readonly eventId: string;
  readonly receiptId: string;
  readonly tenantId: string;
  readonly vectorStoreId: string;
  readonly vectorStoreSpaceId: string;
  readonly vectorSpaceVersionId: string;
  readonly storeClass: "internal_exploratory";
  readonly expectedItemCount: number;
  readonly manifests: PublicationManifests;
  readonly promotionDecisionId: string;
  readonly evaluationGateResultId: string;
  /** Binds activation to one immutable evaluated candidate; omission keeps the legacy counted chain. */
  readonly candidateEvidenceDigest?: Digest;
  readonly reason: string;
}

export interface RollbackPublicationRequest {
  readonly eventId: string;
  readonly receiptId: string;
  readonly tenantId: string;
  readonly vectorStoreSpaceId: string;
  readonly targetPublicationId: string;
  readonly reason: string;
}

export interface PublicationTransaction {
  getPublication(tenantId: string, publicationId: string): ExploratoryPublication | undefined;
  getActivePointer(tenantId: string, vectorStoreSpaceId: string): ActivePublicationPointer | undefined;
  insertPublication(publication: ExploratoryPublication): void;
  setActivePointer(pointer: ActivePublicationPointer): void;
  appendEvent(event: PublicationEvent): void;
}

export interface PublicationRepository {
  transaction<T>(operation: (transaction: PublicationTransaction) => T | Promise<T>): Promise<T>;
  getPublication(tenantId: string, publicationId: string): Promise<ExploratoryPublication | undefined>;
  getActivePointer(tenantId: string, vectorStoreSpaceId: string): Promise<ActivePublicationPointer | undefined>;
  listEvents(tenantId: string, vectorStoreSpaceId: string): Promise<readonly PublicationEvent[]>;
}

export interface ReconciliationFinding {
  readonly code: string;
  readonly classification: "repairable" | "retryable" | "review_required" | "security_critical";
  readonly detail: string;
}

export interface PublicationReconciliationReport {
  readonly healthy: boolean;
  readonly publicationId?: string;
  readonly findings: readonly ReconciliationFinding[];
}
