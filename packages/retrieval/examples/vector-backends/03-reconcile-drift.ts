import { ExploratoryPublicationCoordinator, InMemoryPublicationRepository } from "../../src/index.js";
import type { ActivePublicationPointer, PublicationRepository, PublishExploratoryRequest } from "../../src/index.js";
import { StubPublicationInspector, baseInspection, digest, id, manifests, printJson } from "./fixtures.js";

function publishRequest(publicationId: string): PublishExploratoryRequest {
  return {
    publicationId,
    eventId: `event-${publicationId}`,
    receiptId: `receipt-${publicationId}`,
    tenantId: id(1),
    vectorStoreId: id(2),
    vectorStoreSpaceId: id(3),
    vectorSpaceVersionId: "v1",
    storeClass: "internal_exploratory",
    expectedItemCount: 2,
    manifests,
    promotionDecisionId: `decision-${publicationId}`,
    evaluationGateResultId: `gate-${publicationId}`,
    reason: "verified evaluation promotion",
  };
}

/** A hand-written stub, not the real repository: it proves a pointer can outlive its publication only for this one drift shape. */
function orphanRepository(tenantId: string, vectorStoreSpaceId: string): PublicationRepository {
  const pointer: ActivePublicationPointer = {
    tenantId,
    vectorStoreSpaceId,
    publicationId: "publication-missing",
    vectorSpaceVersionId: "v1",
    revision: 1,
    updatedAt: "2026-09-03T12:00:00Z",
  };
  return {
    transaction: async () => {
      throw new Error("not exercised by this example");
    },
    getPublication: async () => undefined,
    getActivePointer: async () => pointer,
    listEvents: async () => [],
  };
}

/**
 * Reconciliation classifies drift by cause, not just by presence: a manifest
 * mismatch is security_critical because published bytes changed after
 * verification; an evaluation regression is review_required because quality
 * moved while integrity did not; an orphan pointer is security_critical
 * because the store lost the record the pointer claims is active.
 */
export async function reconcileDriftExample() {
  const evaluationRepository = new InMemoryPublicationRepository();
  const evaluationInspector = new StubPublicationInspector();
  evaluationInspector.inspections.set("v1", baseInspection("v1"));
  const evaluationCoordinator = new ExploratoryPublicationCoordinator(evaluationRepository, evaluationInspector);
  await evaluationCoordinator.publish(publishRequest("publication-eval"));
  evaluationInspector.inspections.set("v1", baseInspection("v1", { evaluationPassed: false }));
  const evaluationReport = await evaluationCoordinator.reconcile(id(1), id(3));

  const manifestRepository = new InMemoryPublicationRepository();
  const manifestInspector = new StubPublicationInspector();
  manifestInspector.inspections.set("v1", baseInspection("v1"));
  const manifestCoordinator = new ExploratoryPublicationCoordinator(manifestRepository, manifestInspector);
  await manifestCoordinator.publish(publishRequest("publication-manifest"));
  manifestInspector.inspections.set(
    "v1",
    baseInspection("v1", { manifests: { ...manifests, embedding: digest("f") } }),
  );
  const manifestReport = await manifestCoordinator.reconcile(id(1), id(3));

  const orphanCoordinator = new ExploratoryPublicationCoordinator(
    orphanRepository(id(1), id(3)),
    new StubPublicationInspector(),
  );
  const orphanReport = await orphanCoordinator.reconcile(id(1), id(3));

  const codes = (report: { findings: readonly { code: string; classification: string }[] }) =>
    report.findings.map(({ code, classification }) => [code, classification]);

  return {
    evaluationRegression: codes(evaluationReport),
    manifestMismatch: codes(manifestReport),
    orphanPointer: codes(orphanReport),
  };
}

if (process.argv[1]?.includes("03-reconcile-drift")) reconcileDriftExample().then(printJson);
