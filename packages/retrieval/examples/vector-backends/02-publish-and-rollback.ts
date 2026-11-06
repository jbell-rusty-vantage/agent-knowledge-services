import { ExploratoryPublicationCoordinator, InMemoryPublicationRepository } from "../../src/index.js";
import type { PublishExploratoryRequest } from "../../src/index.js";
import { StubPublicationInspector, baseInspection, id, manifests, printJson } from "./fixtures.js";

function publishRequest(version: string, publicationId: string, eventId: string): PublishExploratoryRequest {
  return {
    publicationId,
    eventId,
    receiptId: `receipt-${publicationId}`,
    tenantId: id(1),
    vectorStoreId: id(2),
    vectorStoreSpaceId: id(3),
    vectorSpaceVersionId: version,
    storeClass: "internal_exploratory",
    expectedItemCount: 2,
    manifests,
    promotionDecisionId: `decision-${publicationId}`,
    evaluationGateResultId: `gate-${publicationId}`,
    reason: "verified evaluation promotion",
  };
}

/**
 * A publish is verified against a stub inspection before the pointer moves, a
 * replay of the same request is idempotent (returns the same record, does not
 * append a second event), and a rollback switches the pointer to an intact
 * predecessor without deleting the version it rolls back from.
 */
export async function publishAndRollbackExample() {
  const repository = new InMemoryPublicationRepository();
  const inspector = new StubPublicationInspector();
  inspector.inspections.set("v1", baseInspection("v1"));
  inspector.inspections.set("v2", baseInspection("v2"));
  const coordinator = new ExploratoryPublicationCoordinator(
    repository,
    inspector,
    () => new Date("2026-09-03T12:00:00Z"),
  );

  const first = await coordinator.publish(publishRequest("v1", "publication-1", "event-1"));
  const replay = await coordinator.publish(publishRequest("v1", "publication-1", "event-1"));
  const second = await coordinator.publish(publishRequest("v2", "publication-2", "event-2"));
  const pointerAfterRollback = await coordinator.rollback({
    eventId: "event-3",
    receiptId: "rollback-receipt",
    tenantId: id(1),
    vectorStoreSpaceId: id(3),
    targetPublicationId: "publication-1",
    reason: "recall regression",
  });

  return {
    idempotentReplay: replay === first,
    eventsRecorded: (await repository.listEvents(id(1), id(3))).length,
    predecessorId: second.predecessorId,
    activeAfterRollback: pointerAfterRollback.publicationId,
  };
}

if (process.argv[1]?.includes("02-publish-and-rollback")) publishAndRollbackExample().then(printJson);
