import type { KnowledgeSqlClient } from "../ports.js";
import type { ReceiptTarget, ReceiptTargetAction, ReceiptTargetRole } from "./receipt.js";

type Row = Record<string, unknown>;

/**
 * Write the receipt's targets to `orchestration.operation_receipt_target` (AIDB 20261031010000) in one statement, in
 * the apply transaction after the receipt row. The entity kind is read from `catalog.entity` (the FK's source of truth);
 * an entity id that names no row in this tenant is dropped rather than failing the apply. Returns the rows as written.
 */
export async function insertReceiptTargets(
  client: KnowledgeSqlClient,
  tenantId: string,
  receiptId: string,
  targets: readonly ReceiptTarget[],
): Promise<ReceiptTarget[]> {
  if (targets.length === 0) return [];
  const rows = targets.map((target, ordinal) => ({
    ordinal,
    schema: target.schema,
    table: target.table,
    id: target.id,
    entity_id: target.entityId,
    role: target.role,
    action: target.action,
    proposal_id: target.proposalId,
    claim_id: target.claimId,
  }));
  const written = await client.query<Row>(
    `insert into orchestration.operation_receipt_target
       (tenant_id, receipt_id, ordinal, target_schema, target_table, target_id, entity_id, entity_kind, role, action, proposal_id, claim_id)
     select $1::uuid, $2::uuid, x.ordinal, x.schema, x."table", x.id, e.id, e.kind, x.role, x.action, x.proposal_id, x.claim_id
       from jsonb_to_recordset($3::jsonb) as x(ordinal int, schema text, "table" text, id text, entity_id uuid, role text,
                                               action text, proposal_id text, claim_id uuid)
       left join catalog.entity e on e.tenant_id = $1::uuid and e.id = x.entity_id
      order by x.ordinal
     returning ordinal, target_schema, target_table, target_id, entity_id::text, entity_kind, role, action, proposal_id, claim_id::text`,
    [tenantId, receiptId, JSON.stringify(rows)],
  );
  return [...written.rows]
    .sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
    .map((row) => ({
      schema: String(row.target_schema),
      table: String(row.target_table),
      id: String(row.target_id),
      role: String(row.role) as ReceiptTargetRole,
      action: String(row.action) as ReceiptTargetAction,
      proposalId: row.proposal_id === null ? null : String(row.proposal_id),
      entityId: row.entity_id === null ? null : String(row.entity_id),
      entityKind: row.entity_kind === null ? null : String(row.entity_kind),
      claimId: row.claim_id === null ? null : String(row.claim_id),
    }));
}
