import { z } from "zod";
import { canonicalJson, type ArtifactLedger, type ArtifactRecord } from "../db-read/index.js";
import type { KnowledgeTransactions } from "../ports.js";
import { domainError, infrastructureError } from "../schema-workspace/index.js";
import type { IngestionReceipt } from "./receipt.js";

interface ReceiptRow extends Record<string, unknown> {
  id: string;
  intent_id: string;
  outcome: string;
  affected_refs: unknown;
  changes_summary: { receiptArtifactId?: string; intentDigest?: string };
}

const ReceiptCustodySchema = z.looseObject({
  schemaVersion: z.literal("knowledge-ingestion-receipt.v1"),
  receiptId: z.string().uuid(),
  operationIntentId: z.string().uuid(),
  outcome: z.enum(["applied", "rejected", "noop", "partial"]),
  intentRef: z.looseObject({ intentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
  affectedRefs: z.array(z.object({ schema: z.string(), table: z.string(), id: z.string() })),
  storage: z.looseObject({
    receiptArtifactId: z.string().uuid(),
    intentArtifactId: z.string().uuid().optional(),
    planArtifactId: z.string().uuid().optional(),
  }),
});

/** Current byte availability is reconciled without rewriting the immutable historical receipt. */
export async function reconcileReceipt(
  dependencies: { db: KnowledgeTransactions; artifacts: ArtifactLedger },
  input: { receiptId: string; tenantId: string },
): Promise<IngestionReceipt> {
  const row = await dependencies.db.transaction(
    { tenantId: input.tenantId, role: "executor_service", readOnly: true },
    async (client) =>
      (
        await client.query<ReceiptRow>(
          `select r.id,r.intent_id,r.outcome,r.affected_refs,r.changes_summary
      from orchestration.operation_receipt r join orchestration.operation_intent i on i.id=r.intent_id
      where r.id=$1 and i.tenant_id=$2`,
          [input.receiptId, input.tenantId],
        )
      ).rows[0],
  );
  const artifactId = row?.changes_summary.receiptArtifactId;
  if (!row || !artifactId) throw domainError("RECEIPT_NOT_FOUND", `no knowledge ingestion receipt ${input.receiptId}`);
  const receiptState = await dependencies.artifacts.reconcile({ tenantId: input.tenantId, artifactId });
  const fetched = await dependencies.artifacts.get(input.tenantId, artifactId);
  const parsed = ReceiptCustodySchema.safeParse(fetched.json);
  if (!parsed.success || fetched.record.artifactType !== "knowledge_ingestion_receipt")
    throw infrastructureError("RECEIPT_ARTIFACT_INVALID", "The registered artifact is not a valid ingestion receipt");
  const receipt = parsed.data;
  if (
    receipt.receiptId !== row.id ||
    receipt.operationIntentId !== row.intent_id ||
    receipt.outcome !== row.outcome ||
    receipt.storage.receiptArtifactId !== artifactId ||
    canonicalJson(receipt.affectedRefs) !== canonicalJson(row.affected_refs) ||
    (row.changes_summary.intentDigest !== undefined &&
      row.changes_summary.intentDigest !== receipt.intentRef.intentDigest)
  ) {
    throw infrastructureError("RECEIPT_ARTIFACT_CONFLICT", "Receipt row and immutable artifact disagree");
  }
  const references: [string | undefined, string][] = [
    [receipt.storage.intentArtifactId, "ingestion_intent"],
    [receipt.storage.planArtifactId, "knowledge_ingestion_plan"],
  ];
  if (receipt.outcome !== "rejected" && references.some(([id]) => !id))
    throw infrastructureError("RECEIPT_ARTIFACT_INVALID", "Applied receipt has missing intent or plan references");
  const states: ArtifactRecord[] = [receiptState];
  for (const [id, expectedType] of references) {
    if (!id) continue;
    const state = await dependencies.artifacts.reconcile({ tenantId: input.tenantId, artifactId: id });
    if (state.artifactType !== expectedType)
      throw infrastructureError("RECEIPT_DEPENDENCY_CONFLICT", "Receipt dependency has an unexpected artifact type");
    states.push(state);
  }
  const original = fetched.json as IngestionReceipt;
  return {
    ...original,
    storage: {
      ...original.storage,
      storageState: states.every((state) => state.storageState === "available") ? "stored" : "pending",
    },
  };
}
