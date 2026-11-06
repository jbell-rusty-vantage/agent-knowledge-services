import { describe, expect, it, vi } from "vitest";
import { createCheckpointOwnerReconciler } from "./checkpoints-owners.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const resourceId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const digest = `sha256:${"a".repeat(64)}` as const;

function fixture(owner: "verification" | "publication" = "verification") {
  const record = { requestSha256: digest.slice(7), operationKind: owner, status: "succeeded" };
  const handle = { artifactId, digest };
  const query = vi.fn(async () => ({ rows: [{ id: resourceId, verifier_attempt_id: operationId }] }));
  const dependencies = {
    database: {
      getOperationRecord: vi.fn(async () => record),
      listReceipts: vi.fn(async () => [{ body: { resultArtifactId: artifactId } }]),
      transaction: vi.fn(async (_tenant: string, callback: (client: { query: typeof query }) => unknown) =>
        callback({ query }),
      ),
    },
    publications: { verifyPublication: vi.fn(async () => ({ publicationId: resourceId, status: "published" })) },
    artifacts: { reconcile: vi.fn(async () => ({ digest })) },
    custody: { resolve: vi.fn(async () => undefined) },
    store: { putJson: vi.fn(async () => ({ handle })) },
  };
  const reconciler = createCheckpointOwnerReconciler(
    dependencies as unknown as Parameters<typeof createCheckpointOwnerReconciler>[0],
  );
  const request = {
    tenantId,
    scope: {
      tenantId,
      runId: "run",
      producerAttemptId: "producer",
      sessionId: "session",
      sandboxId: "sandbox",
      namespace: "notes",
    },
    operation: { owner, operationId, requestDigest: digest },
  };
  return { dependencies, record, query, run: () => reconciler.reconcile(request) };
}

describe("checkpoint existing owner reconciliation", () => {
  it("settles a verification owner on its terminal operation and receipts and verifies receipt artifacts", async () => {
    const test = fixture();
    expect(await test.run()).toMatchObject({ state: "settled", outcome: "succeeded" });
    // SV-17: no evidence.verification_run readback; the withdrawn AIDB run table is never queried.
    expect(test.query).not.toHaveBeenCalled();
    expect(test.dependencies.artifacts.reconcile).toHaveBeenCalledWith({ tenantId, artifactId });
  });

  it.each(["verification", "publication"] as const)(
    "leaves pending %s untouched without owner execution",
    async (owner) => {
      const test = fixture(owner);
      test.record.status = "running";
      expect(await test.run()).toMatchObject({ state: "unresolved" });
      expect(test.query).not.toHaveBeenCalled();
      expect(test.dependencies.publications.verifyPublication).not.toHaveBeenCalled();
      expect(test.dependencies.store.putJson).not.toHaveBeenCalled();
    },
  );

  it("rejects changed request identity before owner reconciliation", async () => {
    const test = fixture();
    test.record.requestSha256 = "b".repeat(64);
    expect(await test.run()).toMatchObject({ state: "unresolved" });
    expect(test.query).not.toHaveBeenCalled();
  });

  it("does not acknowledge a terminal operation whose receipt artifact bytes are missing", async () => {
    const test = fixture();
    test.dependencies.artifacts.reconcile.mockRejectedValueOnce(new Error("STORAGE_PENDING"));
    await expect(test.run()).rejects.toThrow("STORAGE_PENDING");
    expect(test.dependencies.store.putJson).not.toHaveBeenCalled();
  });

  it("binds publication verification to the original operation lookup", async () => {
    const test = fixture("publication");
    expect(await test.run()).toMatchObject({ state: "settled", outcome: "succeeded" });
    expect(test.query).toHaveBeenCalledWith(expect.stringContaining("operation_id=$2"), [tenantId, operationId]);
    expect(test.dependencies.publications.verifyPublication).toHaveBeenCalledWith(tenantId, resourceId);
  });

  it("refuses publication when its existing owner verification fails", async () => {
    const test = fixture("publication");
    test.dependencies.publications.verifyPublication.mockRejectedValueOnce(
      new Error("PUBLICATION_VERIFICATION_FAILED"),
    );
    await expect(test.run()).rejects.toThrow("PUBLICATION_VERIFICATION_FAILED");
    expect(test.dependencies.store.putJson).not.toHaveBeenCalled();
  });
});
