import { CANONICAL_EMBEDDING_DIMENSIONS, VectorBackendError } from "../types.js";
import type { ActivePublicationPointer } from "../spaces/version.js";
import { freezePublication, freezeReport } from "./repository.js";
import type {
  ExploratoryPublication,
  PublicationInspector,
  PublicationReconciliationReport,
  PublicationRepository,
  PublishExploratoryRequest,
  ReconciliationFinding,
  RollbackPublicationRequest,
} from "./types.js";
import { collectInspectionFindings, verifyInspection } from "./verification.js";

// rollback stays here rather than moving beside the pointer types it mutates
// (spaces/version.ts): it shares one repository.transaction and the
// verifyInspection invariant with publish, and splitting the method would
// fracture that transactional invariant to satisfy a folder name (P2-3).
export class ExploratoryPublicationCoordinator {
  constructor(
    private readonly repository: PublicationRepository,
    private readonly inspector: PublicationInspector,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publish(request: PublishExploratoryRequest): Promise<ExploratoryPublication> {
    validatePublishRequest(request);
    const inspection = await this.inspector.inspect(request.vectorSpaceVersionId);
    const verificationDigest = verifyInspection(
      request.vectorSpaceVersionId,
      request.expectedItemCount,
      request.manifests,
      inspection,
      request.candidateEvidenceDigest,
    );
    const publishedAt = this.now().toISOString();

    return this.repository.transaction((transaction) => {
      const existing = transaction.getPublication(request.tenantId, request.publicationId);
      if (existing !== undefined) {
        if (
          existing.verificationDigest !== verificationDigest ||
          existing.vectorSpaceVersionId !== request.vectorSpaceVersionId ||
          existing.vectorStoreId !== request.vectorStoreId ||
          existing.vectorStoreSpaceId !== request.vectorStoreSpaceId ||
          existing.promotionDecisionId !== request.promotionDecisionId ||
          existing.evaluationGateResultId !== request.evaluationGateResultId ||
          existing.receiptId !== request.receiptId
        ) {
          throw new VectorBackendError(
            "IDEMPOTENCY_CONFLICT",
            `Publication ${request.publicationId} already exists with different verified content`,
          );
        }
        return existing;
      }
      const active = transaction.getActivePointer(request.tenantId, request.vectorStoreSpaceId);
      const publication = freezePublication({
        id: request.publicationId,
        tenantId: request.tenantId,
        vectorStoreId: request.vectorStoreId,
        vectorStoreSpaceId: request.vectorStoreSpaceId,
        vectorSpaceVersionId: request.vectorSpaceVersionId,
        storeClass: request.storeClass,
        expectedItemCount: request.expectedItemCount,
        dimensions: CANONICAL_EMBEDDING_DIMENSIONS,
        manifests: request.manifests,
        promotionDecisionId: request.promotionDecisionId,
        evaluationGateResultId: request.evaluationGateResultId,
        ...(request.candidateEvidenceDigest === undefined
          ? {}
          : { candidateEvidenceDigest: request.candidateEvidenceDigest }),
        ...(active === undefined ? {} : { predecessorId: active.publicationId }),
        state: "published",
        verificationDigest,
        receiptId: request.receiptId,
        publishedAt,
      });
      const pointer = Object.freeze({
        tenantId: request.tenantId,
        vectorStoreSpaceId: request.vectorStoreSpaceId,
        publicationId: publication.id,
        vectorSpaceVersionId: publication.vectorSpaceVersionId,
        revision: (active?.revision ?? 0) + 1,
        updatedAt: publishedAt,
      });
      transaction.insertPublication(publication);
      transaction.setActivePointer(pointer);
      transaction.appendEvent(
        Object.freeze({
          id: request.eventId,
          tenantId: request.tenantId,
          vectorStoreSpaceId: request.vectorStoreSpaceId,
          kind: "publication.activated",
          ...(active === undefined ? {} : { fromPublicationId: active.publicationId }),
          toPublicationId: publication.id,
          reason: request.reason,
          receiptId: request.receiptId,
          occurredAt: publishedAt,
        }),
      );
      return publication;
    });
  }

  async rollback(request: RollbackPublicationRequest): Promise<ActivePublicationPointer> {
    if (request.reason.trim().length === 0)
      throw new VectorBackendError("INVALID_ROLLBACK", "Rollback requires a reason");
    const target = await this.repository.getPublication(request.tenantId, request.targetPublicationId);
    if (
      target === undefined ||
      target.vectorStoreSpaceId !== request.vectorStoreSpaceId ||
      target.state !== "published"
    ) {
      throw new VectorBackendError(
        "INVALID_ROLLBACK_TARGET",
        "Rollback target is not an intact publication for this tenant and store space",
      );
    }
    const inspection = await this.inspector.inspect(target.vectorSpaceVersionId);
    verifyInspection(
      target.vectorSpaceVersionId,
      target.expectedItemCount,
      target.manifests,
      inspection,
      target.candidateEvidenceDigest,
    );
    const occurredAt = this.now().toISOString();
    return this.repository.transaction((transaction) => {
      const active = transaction.getActivePointer(request.tenantId, request.vectorStoreSpaceId);
      if (active === undefined)
        throw new VectorBackendError("NO_ACTIVE_PUBLICATION", "Cannot rollback without an active publication");
      if (active.publicationId === target.id) return active;
      const pointer = Object.freeze({
        tenantId: request.tenantId,
        vectorStoreSpaceId: request.vectorStoreSpaceId,
        publicationId: target.id,
        vectorSpaceVersionId: target.vectorSpaceVersionId,
        revision: active.revision + 1,
        updatedAt: occurredAt,
      });
      transaction.setActivePointer(pointer);
      transaction.appendEvent(
        Object.freeze({
          id: request.eventId,
          tenantId: request.tenantId,
          vectorStoreSpaceId: request.vectorStoreSpaceId,
          kind: "publication.rolled_back",
          fromPublicationId: active.publicationId,
          toPublicationId: target.id,
          reason: request.reason,
          receiptId: request.receiptId,
          occurredAt,
        }),
      );
      return pointer;
    });
  }

  async reconcile(tenantId: string, vectorStoreSpaceId: string): Promise<PublicationReconciliationReport> {
    const pointer = await this.repository.getActivePointer(tenantId, vectorStoreSpaceId);
    if (pointer === undefined)
      return freezeReport(undefined, [
        {
          code: "MISSING_ACTIVE_POINTER",
          classification: "review_required",
          detail: "No active publication pointer exists",
        },
      ]);
    const publication = await this.repository.getPublication(tenantId, pointer.publicationId);
    if (publication === undefined)
      return freezeReport(pointer.publicationId, [
        {
          code: "ORPHAN_ACTIVE_POINTER",
          classification: "security_critical",
          detail: "Active pointer references a missing publication",
        },
      ]);
    const findings: ReconciliationFinding[] = [];
    if (publication.vectorSpaceVersionId !== pointer.vectorSpaceVersionId)
      findings.push({
        code: "POINTER_VERSION_MISMATCH",
        classification: "security_critical",
        detail: "Pointer and publication vector-space versions differ",
      });
    try {
      const inspection = await this.inspector.inspect(publication.vectorSpaceVersionId);
      collectInspectionFindings(publication, inspection, findings);
    } catch (error) {
      findings.push({
        code: "INSPECTION_FAILED",
        classification: "retryable",
        detail: error instanceof Error ? error.message : "Publication inspection failed",
      });
    }
    return freezeReport(publication.id, findings);
  }
}

function validatePublishRequest(request: PublishExploratoryRequest): void {
  if (request.storeClass !== "internal_exploratory")
    throw new VectorBackendError(
      "AUTHORITY_CLASS_VIOLATION",
      "This coordinator only publishes internal exploratory stores",
    );
  if (!Number.isInteger(request.expectedItemCount) || request.expectedItemCount < 0)
    throw new VectorBackendError("INVALID_ITEM_COUNT", "Expected item count must be a non-negative integer");
  if (request.reason.trim().length === 0)
    throw new VectorBackendError("INVALID_PUBLICATION", "Publication requires a reason");
}
