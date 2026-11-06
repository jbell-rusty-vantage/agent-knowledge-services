import { canonicalJson } from "../db-read/index.js";
import type { KnowledgeSqlClient } from "../ports.js";
import { domainError } from "../schema-workspace/index.js";
import type { ProposalOf } from "./intent.js";
import { deterministicId } from "./plan.js";
import type { AffectedRef } from "./receipt.js";

export interface RecordBinding {
  readonly tenantId: string;
  readonly claimId: string;
  readonly entityId: string;
  readonly proposal: ProposalOf<"record.materialize">;
}

export function recordIdentity(binding: RecordBinding): string {
  const { proposal, tenantId, claimId, entityId } = binding;
  return deterministicId(
    "knowledge.record",
    canonicalJson({
      tenantId,
      claimId,
      entityId,
      kind: proposal.recordKind,
      title: proposal.title,
      statement: proposal.proposition,
      qualifiers: proposal.qualifiers ?? [],
      constraintKind: proposal.constraintKind,
      expression: proposal.expression,
    }),
  );
}

export function recordKeys(binding: RecordBinding): {
  recordId: string;
  compatibilityConstraintId: string;
  claimRecordKey: string;
  recordEntityKey: string;
} {
  const recordId = recordIdentity(binding);
  return {
    recordId,
    compatibilityConstraintId: recordId,
    claimRecordKey: JSON.stringify([binding.tenantId, binding.claimId, recordId]),
    recordEntityKey: JSON.stringify([binding.tenantId, recordId, binding.entityId, "subject"]),
  };
}

export async function existingRecord(client: KnowledgeSqlClient, binding: RecordBinding): Promise<string | undefined> {
  const id = recordIdentity(binding);
  const row = (
    await client.query<{ id: string }>(
      `select r.id from knowledge.record r
    join knowledge.compatibility_constraint c on c.tenant_id=r.tenant_id and c.id=r.id
    join evidence.claim_record cr on cr.tenant_id=r.tenant_id and cr.record_id=r.id and cr.claim_id=$3
    join knowledge.record_entity_link e on e.tenant_id=r.tenant_id and e.record_id=r.id and e.entity_id=$4 and e.role='subject'
    join evidence.claim claim on claim.tenant_id=r.tenant_id and claim.id=cr.claim_id and claim.status='verified'
    where r.tenant_id=$1 and r.id=$2 and r.provenance_claim_id=$3 and r.kind='compatibility_constraint'
      and r.title=$5 and r.statement=$6 and r.scope=$7::jsonb and r.assurance_level='source_inspection'
      and c.constraint_kind=$8 and c.expression=$9`,
      [
        binding.tenantId,
        id,
        binding.claimId,
        binding.entityId,
        binding.proposal.title,
        binding.proposal.proposition,
        JSON.stringify({ qualifiers: binding.proposal.qualifiers ?? [] }),
        binding.proposal.constraintKind,
        binding.proposal.expression,
      ],
    )
  ).rows[0];
  return row?.id;
}

export async function materializeRecord(
  input: RecordBinding & {
    readonly client: KnowledgeSqlClient;
    readonly receiptId: string;
  },
): Promise<{
  ids: Record<string, string>;
  /** Rows this call wrote (empty on a no-op): the K01 affected refs. */
  affected: AffectedRef[];
  /** The record's four rows, written now or already present (`noop`): the receipt targets. */
  rows: AffectedRef[];
  noop?: boolean;
}> {
  const { client, tenantId, claimId, entityId, proposal, receiptId } = input;
  const claim = (
    await client.query<{ statement: string }>(
      "select statement from evidence.claim where tenant_id=$1 and id=$2 and status='verified' for share",
      [tenantId, claimId],
    )
  ).rows[0];
  if (!claim || claim.statement !== proposal.proposition)
    throw domainError("RECORD_VERIFIED_CLAIM_REQUIRED", "Record requires its exact canonical verified claim");
  const ids = recordKeys(input);
  const recordId = ids.recordId;
  const rows: AffectedRef[] = [
    { schema: "knowledge", table: "record", id: recordId },
    { schema: "knowledge", table: "compatibility_constraint", id: recordId },
    { schema: "evidence", table: "claim_record", id: ids.claimRecordKey },
    {
      schema: "knowledge",
      table: "record_entity_link",
      id: ids.recordEntityKey,
    },
  ];
  if (await existingRecord(client, input)) return { ids, affected: [], rows, noop: true };
  await client.query(
    `insert into knowledge.record(id,tenant_id,kind,title,statement,scope,assurance_level,provenance_claim_id,created_by_receipt_id)
    values($1,$2,'compatibility_constraint',$3,$4,$5::jsonb,'source_inspection',$6,$7)`,
    [
      recordId,
      tenantId,
      proposal.title,
      proposal.proposition,
      JSON.stringify({ qualifiers: proposal.qualifiers ?? [] }),
      claimId,
      receiptId,
    ],
  );
  await client.query(
    "insert into knowledge.compatibility_constraint(id,tenant_id,constraint_kind,expression) values($1,$2,$3,$4)",
    [recordId, tenantId, proposal.constraintKind, proposal.expression],
  );
  await client.query("insert into evidence.claim_record(tenant_id,claim_id,record_id) values($1,$2,$3)", [
    tenantId,
    claimId,
    recordId,
  ]);
  await client.query(
    "insert into knowledge.record_entity_link(tenant_id,record_id,entity_id,role) values($1,$2,$3,'subject')",
    [tenantId, recordId, entityId],
  );
  return { ids, affected: rows, rows };
}
