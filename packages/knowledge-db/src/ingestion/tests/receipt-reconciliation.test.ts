import { describe, expect, it } from "vitest";
import { reconcileReceipt } from "../receipt-reconciliation.js";
import type { IngestionReceipt } from "../receipt.js";
import type { ArtifactRecord } from "../../db-read/index.js";
import { infrastructureError } from "../../schema-workspace/index.js";

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const tenantId = id(1),
  receiptId = id(2),
  receiptArtifactId = id(3),
  intentArtifactId = id(4),
  planArtifactId = id(5);
const digest = `sha256:${"a".repeat(64)}` as const;
function fixture() {
  const receipt: IngestionReceipt = {
    schemaVersion: "knowledge-ingestion-receipt.v1",
    receiptId,
    operationIntentId: id(6),
    intentRef: { intentId: "test", intentDigest: digest, idempotencyKey: digest },
    planRef: { planId: "plan", artifactId: planArtifactId },
    outcome: "applied",
    knowledgeBatch: { knowledgeSeq: 1, inputDigest: digest },
    head: { before: 0, after: 1, rebased: false },
    proposals: [],
    subjects: [],
    claims: [],
    affectedRefs: [{ schema: "corpus", table: "entity", id: id(7) }],
    duplicateOf: null,
    priorReceiptsForIntentId: [],
    failure: null,
    storage: { receiptArtifactId, intentArtifactId, planArtifactId, storageState: "pending" },
    verify: null,
    executedAt: "2026-09-14T00:00:00.000Z",
    executorVersion: "test",
  };
  const row = {
    id: receiptId,
    intent_id: receipt.operationIntentId,
    outcome: receipt.outcome,
    affected_refs: structuredClone(receipt.affectedRefs),
    changes_summary: { receiptArtifactId, intentDigest: digest },
  };
  const records = new Map<string, ArtifactRecord>(
    [
      [receiptArtifactId, "knowledge_ingestion_receipt"],
      [intentArtifactId, "ingestion_intent"],
      [planArtifactId, "knowledge_ingestion_plan"],
    ].map(([artifactId, artifactType]) => [
      artifactId!,
      {
        artifactId: artifactId!,
        artifactType: artifactType!,
        digest,
        bucket: "test",
        objectPath: "test",
        storageState: "available",
        mediaType: "application/json",
        sizeBytes: 1,
        reused: true,
      },
    ]),
  );
  const db = {
    transaction: async (_scope: unknown, work: (client: unknown) => Promise<unknown>) =>
      work({ query: async () => ({ rows: [row] }) }),
  };
  const visited: string[] = [];
  const artifacts = {
    async reconcile(input: { artifactId: string }) {
      visited.push(input.artifactId);
      const record = records.get(input.artifactId);
      if (!record) throw infrastructureError("STORAGE_PENDING", "required bytes missing");
      return record;
    },
    async get(_tenant: string, artifactId: string) {
      return { record: records.get(artifactId), json: receipt };
    },
  };
  return {
    receipt,
    row,
    records,
    visited,
    run: () => reconcileReceipt({ db: db as never, artifacts: artifacts as never }, { tenantId, receiptId }),
  };
}

describe("ingestion receipt reconciliation", () => {
  it("proves exact affected refs and every required artifact before reporting stored", async () => {
    const value = fixture();
    expect(await value.run()).toMatchObject({
      receiptId,
      affectedRefs: value.row.affected_refs,
      storage: { storageState: "stored" },
    });
    expect(value.visited).toEqual([receiptArtifactId, intentArtifactId, planArtifactId]);
    expect(value.receipt.storage.storageState).toBe("pending");
  });
  it("rejects a row whose affected refs do not match its immutable receipt", async () => {
    const value = fixture();
    value.row.affected_refs = [];
    await expect(value.run()).rejects.toMatchObject({ code: "RECEIPT_ARTIFACT_CONFLICT" });
  });
  it("rejects conflicting request identity even when the receipt artifact exists", async () => {
    const value = fixture();
    value.row.changes_summary.intentDigest = `sha256:${"b".repeat(64)}`;
    await expect(value.run()).rejects.toMatchObject({ code: "RECEIPT_ARTIFACT_CONFLICT" });
  });
  it("does not acknowledge a receipt with missing required plan bytes", async () => {
    const value = fixture();
    value.records.delete(planArtifactId);
    await expect(value.run()).rejects.toMatchObject({ code: "STORAGE_PENDING" });
  });
  it("preserves pending status when a required artifact is local-only", async () => {
    const value = fixture();
    value.records.set(intentArtifactId, { ...value.records.get(intentArtifactId)!, storageState: "pending" });
    expect(await value.run()).toMatchObject({ storage: { storageState: "pending" } });
  });
  it("rejects dependency type substitution", async () => {
    const value = fixture();
    value.records.set(planArtifactId, {
      ...value.records.get(planArtifactId)!,
      artifactType: "knowledge_read_snapshot",
    });
    await expect(value.run()).rejects.toMatchObject({ code: "RECEIPT_DEPENDENCY_CONFLICT" });
  });
});
