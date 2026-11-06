import { describe, expect, it } from "vitest";
import { ExploratoryPublicationCoordinator } from "./coordinator.js";
import { InMemoryPublicationRepository } from "./repository.js";
import type { ActivePublicationPointer } from "../spaces/version.js";
import type {
  PublicationInspection,
  PublicationInspector,
  PublicationManifests,
  PublicationRepository,
  PublishExploratoryRequest,
} from "./types.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const manifests: PublicationManifests = {
  source: digest("1"),
  representation: digest("2"),
  chunkSet: digest("3"),
  projection: digest("4"),
  vectorItem: digest("5"),
  embedding: digest("6"),
  index: digest("7"),
  retrievalPolicy: digest("8"),
  evaluation: digest("9"),
};

class MutableInspector implements PublicationInspector {
  readonly inspections = new Map<string, PublicationInspection>();
  async inspect(vectorSpaceVersionId: string) {
    const inspection = this.inspections.get(vectorSpaceVersionId);
    if (!inspection) throw new Error("missing version");
    return inspection;
  }
}

function inspection(
  vectorSpaceVersionId: string,
  overrides: Partial<PublicationInspection> = {},
): PublicationInspection {
  return {
    vectorSpaceVersionId,
    itemCount: 2,
    dimensions: 1_536,
    precision: "halfvec",
    manifests,
    indexReady: true,
    authorizationPassed: true,
    evaluationPassed: true,
    sampleSearchPassed: true,
    ...overrides,
  };
}

function request(version: string, publicationId: string, eventId: string): PublishExploratoryRequest {
  return {
    publicationId,
    eventId,
    receiptId: `receipt-${publicationId}`,
    tenantId: "tenant-1",
    vectorStoreId: "store-1",
    vectorStoreSpaceId: "space-1",
    vectorSpaceVersionId: version,
    storeClass: "internal_exploratory",
    expectedItemCount: 2,
    manifests,
    promotionDecisionId: `decision-${publicationId}`,
    evaluationGateResultId: `gate-${publicationId}`,
    reason: "verified evaluation promotion",
  };
}

describe("ExploratoryPublicationCoordinator", () => {
  it("verifies and atomically advances a versioned publication pointer", async () => {
    const repository = new InMemoryPublicationRepository();
    const inspector = new MutableInspector();
    inspector.inspections.set("v1", inspection("v1"));
    const coordinator = new ExploratoryPublicationCoordinator(
      repository,
      inspector,
      () => new Date("2026-09-03T12:00:00Z"),
    );
    const published = await coordinator.publish(request("v1", "publication-1", "event-1"));
    expect(published).toMatchObject({ vectorSpaceVersionId: "v1", state: "published", dimensions: 1_536 });
    expect(await repository.getActivePointer("tenant-1", "space-1")).toMatchObject({
      publicationId: "publication-1",
      revision: 1,
    });
    expect(await coordinator.publish(request("v1", "publication-1", "event-duplicate"))).toBe(published);
    expect(await repository.listEvents("tenant-1", "space-1")).toHaveLength(1);
    await expect(
      coordinator.publish({ ...request("v1", "publication-1", "event-conflict"), vectorStoreSpaceId: "space-2" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("leaves no partial state when verification fails", async () => {
    const repository = new InMemoryPublicationRepository();
    const inspector = new MutableInspector();
    inspector.inspections.set("bad", inspection("bad", { itemCount: 1, sampleSearchPassed: false }));
    const coordinator = new ExploratoryPublicationCoordinator(repository, inspector);
    await expect(coordinator.publish(request("bad", "publication-bad", "event-bad"))).rejects.toMatchObject({
      code: "PUBLICATION_VERIFICATION_FAILED",
    });
    expect(await repository.getActivePointer("tenant-1", "space-1")).toBeUndefined();
    expect(await repository.getPublication("tenant-1", "publication-bad")).toBeUndefined();
  });

  it("rejects an idempotent replay whose verified content differs, e.g. a different receipt", async () => {
    const repository = new InMemoryPublicationRepository();
    const inspector = new MutableInspector();
    inspector.inspections.set("v1", inspection("v1"));
    const coordinator = new ExploratoryPublicationCoordinator(repository, inspector);
    await coordinator.publish(request("v1", "publication-1", "event-1"));
    await expect(
      coordinator.publish({ ...request("v1", "publication-1", "event-2"), receiptId: "receipt-different" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects a reused event id across different publications for the same tenant", async () => {
    const repository = new InMemoryPublicationRepository();
    const inspector = new MutableInspector();
    inspector.inspections.set("v1", inspection("v1"));
    inspector.inspections.set("v2", inspection("v2"));
    const coordinator = new ExploratoryPublicationCoordinator(repository, inspector);
    await coordinator.publish(request("v1", "publication-1", "shared-event"));
    await expect(coordinator.publish(request("v2", "publication-2", "shared-event"))).rejects.toMatchObject({
      code: "DUPLICATE_EVENT",
    });
  });

  it("rolls back by pointer switch without deleting versions and emits a reason-bearing event", async () => {
    const repository = new InMemoryPublicationRepository();
    const inspector = new MutableInspector();
    inspector.inspections.set("v1", inspection("v1"));
    inspector.inspections.set("v2", inspection("v2"));
    const timestamps = [
      new Date("2026-09-03T12:00:00Z"),
      new Date("2026-09-03T12:01:00Z"),
      new Date("2026-09-03T12:02:00Z"),
    ];
    const coordinator = new ExploratoryPublicationCoordinator(repository, inspector, () => timestamps.shift()!);
    await coordinator.publish(request("v1", "publication-1", "event-1"));
    const second = await coordinator.publish(request("v2", "publication-2", "event-2"));
    expect(second.predecessorId).toBe("publication-1");
    const pointer = await coordinator.rollback({
      eventId: "event-3",
      receiptId: "rollback-receipt",
      tenantId: "tenant-1",
      vectorStoreSpaceId: "space-1",
      targetPublicationId: "publication-1",
      reason: "recall regression",
    });
    expect(pointer).toMatchObject({ publicationId: "publication-1", vectorSpaceVersionId: "v1", revision: 3 });
    expect(await repository.getPublication("tenant-1", "publication-2")).toBe(second);
    expect((await repository.listEvents("tenant-1", "space-1")).at(-1)).toMatchObject({
      kind: "publication.rolled_back",
      reason: "recall regression",
    });
  });

  it("rejects a rollback target that belongs to another vectorStoreSpaceId", async () => {
    const repository = new InMemoryPublicationRepository();
    const inspector = new MutableInspector();
    inspector.inspections.set("v1", inspection("v1"));
    const coordinator = new ExploratoryPublicationCoordinator(repository, inspector);
    await coordinator.publish(request("v1", "publication-1", "event-1"));
    await expect(
      coordinator.rollback({
        eventId: "event-2",
        receiptId: "rollback-receipt",
        tenantId: "tenant-1",
        vectorStoreSpaceId: "space-other",
        targetPublicationId: "publication-1",
        reason: "wrong space",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROLLBACK_TARGET" });
  });

  it("treats a rollback to the already-active publication as a no-op returning the current pointer", async () => {
    const repository = new InMemoryPublicationRepository();
    const inspector = new MutableInspector();
    inspector.inspections.set("v1", inspection("v1"));
    const coordinator = new ExploratoryPublicationCoordinator(repository, inspector);
    await coordinator.publish(request("v1", "publication-1", "event-1"));
    const before = await repository.getActivePointer("tenant-1", "space-1");
    const pointer = await coordinator.rollback({
      eventId: "event-2",
      receiptId: "rollback-receipt",
      tenantId: "tenant-1",
      vectorStoreSpaceId: "space-1",
      targetPublicationId: "publication-1",
      reason: "no-op rollback",
    });
    expect(pointer).toEqual(before);
    expect(await repository.listEvents("tenant-1", "space-1")).toHaveLength(1);
  });

  it("reconciles counts, manifests, format, index, authorization, evaluation, and sample search", async () => {
    const repository = new InMemoryPublicationRepository();
    const inspector = new MutableInspector();
    inspector.inspections.set("v1", inspection("v1"));
    const coordinator = new ExploratoryPublicationCoordinator(repository, inspector);
    await coordinator.publish(request("v1", "publication-1", "event-1"));
    expect(await coordinator.reconcile("tenant-1", "space-1")).toMatchObject({ healthy: true, findings: [] });
    inspector.inspections.set("v1", inspection("v1", { itemCount: 1, authorizationPassed: false, indexReady: false }));
    const report = await coordinator.reconcile("tenant-1", "space-1");
    expect(report.healthy).toBe(false);
    expect(report.findings.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["COUNT_MISMATCH", "INDEX_NOT_READY", "AUTHORIZATION_CHECK_FAILED"]),
    );
  });

  it("reports MISSING_ACTIVE_POINTER as review_required when no pointer exists", async () => {
    const repository = new InMemoryPublicationRepository();
    const inspector = new MutableInspector();
    const coordinator = new ExploratoryPublicationCoordinator(repository, inspector);
    const report = await coordinator.reconcile("tenant-1", "space-never-published");
    expect(report).toMatchObject({
      healthy: false,
      findings: [{ code: "MISSING_ACTIVE_POINTER", classification: "review_required" }],
    });
  });

  it("reports ORPHAN_ACTIVE_POINTER as security_critical when the pointer references a missing publication", async () => {
    const pointer: ActivePublicationPointer = {
      tenantId: "tenant-1",
      vectorStoreSpaceId: "space-1",
      publicationId: "publication-missing",
      vectorSpaceVersionId: "v1",
      revision: 1,
      updatedAt: "2026-09-03T12:00:00Z",
    };
    const orphanRepository: PublicationRepository = {
      transaction: async () => {
        throw new Error("not used");
      },
      getPublication: async () => undefined,
      getActivePointer: async () => pointer,
      listEvents: async () => [],
    };
    const inspector = new MutableInspector();
    const coordinator = new ExploratoryPublicationCoordinator(orphanRepository, inspector);
    const report = await coordinator.reconcile("tenant-1", "space-1");
    expect(report).toMatchObject({
      healthy: false,
      publicationId: "publication-missing",
      findings: [{ code: "ORPHAN_ACTIVE_POINTER", classification: "security_critical" }],
    });
  });
});
