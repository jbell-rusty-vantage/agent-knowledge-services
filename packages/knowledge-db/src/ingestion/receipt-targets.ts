import type { KnowledgeSqlClient } from "../ports.js";
import { domainError } from "../schema-workspace/index.js";
import type { PlannedOutcome } from "./plan.js";
import type { ReceiptReportProjection, ReceiptTarget, ReceiptTargetAction, ReceiptTargetRole } from "./receipt.js";

type Row = Record<string, unknown>;

/**
 * Write the receipt's targets to `orchestration.operation_receipt_target` (AIDB 20261031010000) in one statement, in
 * the apply transaction after the receipt row. The entity kind is read from `corpus.entity` (the FK's source of truth);
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
       left join corpus.entity e on e.tenant_id = $1::uuid and e.id = x.entity_id
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

export interface ReportProjectionInput {
  readonly tenantId: string;
  readonly useDecisionId: string;
  readonly boundEffectDigest: string;
  readonly operationIntentId: string;
  readonly receiptId: string;
  readonly outcome: PlannedOutcome;
}

export interface ReportProjectionResult {
  readonly report: ReceiptReportProjection;
  /** The projection rows as receipt targets (role `projection`): created now, or reused when already projected. */
  readonly targets: readonly ReceiptTarget[];
}

interface Revision {
  readonly report_id: string;
  readonly revision: number;
  readonly report_revision_id: string;
  readonly digest: string;
  readonly run_id: string;
  readonly report_kind: string;
  readonly body_digest: string;
}

const REVISION_COLUMNS =
  "r.report_id, r.revision, r.report_revision_id, r.digest, r.run_id::text, r.report_kind, r.body_digest";

/**
 * Project the admitted exact use into `research.report_v2_*` on the AI Engineer installation (aidb_guard path), after
 * the receipt row and in the same transaction. The KS intent carries no report identity, so it is derived from the
 * component use decision: a `report` subject names the revision (`subject_id` = report_revision_id); an `assertion`
 * subject names the assertion digest, and the latest revision citing it in `assertion_refs` is chosen (recorded in
 * `resolution`/`candidateRevisions`). The AIDB guards re-check every row against the component (sealed run, snapshot
 * manifest, exact restatement), so a mismatch rolls the whole apply back with a typed KSA05/KSA07 error.
 */
export async function projectReportV2(
  client: KnowledgeSqlClient,
  input: ReportProjectionInput,
): Promise<ReportProjectionResult> {
  const { tenantId } = input;
  const decision = (
    await client.query<Row>(
      "select subject_kind, subject_id, subject_digest from knowledge_verification.use_decision where tenant_id = $1 and use_decision_id = $2",
      [tenantId, input.useDecisionId],
    )
  ).rows[0];
  if (!decision) throw domainError("UNRESOLVED_EFFECT", `no component use decision ${input.useDecisionId} to project`);
  const subjectKind = String(decision.subject_kind) as "report" | "assertion";
  const { revision, candidates } =
    subjectKind === "report"
      ? await revisionById(client, tenantId, String(decision.subject_id))
      : await latestRevisionCiting(client, tenantId, String(decision.subject_digest));
  if (!revision)
    throw domainError(
      "EXACT_REVISION_UNAVAILABLE",
      subjectKind === "report"
        ? `use decision ${input.useDecisionId} names report revision ${String(decision.subject_id)}, which is not registered`
        : `no report revision cites the decided assertion ${String(decision.subject_digest)}`,
    );
  const snapshot = (
    await client.query<Row>(
      `select manifest_digest from knowledge_verification.run_manifest
        where tenant_id = $1 and run_id = $2::uuid and manifest_kind = 'verification_snapshot' order by sequence desc limit 1`,
      [tenantId, revision.run_id],
    )
  ).rows[0];
  if (!snapshot)
    throw domainError(
      "EXACT_REVISION_UNAVAILABLE",
      `report ${revision.report_id} revision ${revision.revision}: run ${revision.run_id} has no sealed verification snapshot`,
    );
  const snapshotDigest = String(snapshot.manifest_digest);
  const revisionWritten = await client.query(
    `insert into research.report_v2_revision (tenant_id, report_id, revision, report_revision_id, report_revision_digest, run_id,
       verification_snapshot_digest, report_kind, body_digest)
     values ($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9) on conflict (tenant_id, report_id, revision) do nothing returning revision`,
    [
      tenantId,
      revision.report_id,
      revision.revision,
      revision.report_revision_id,
      revision.digest,
      revision.run_id,
      snapshotDigest,
      revision.report_kind,
      revision.body_digest,
    ],
  );
  const assertions = await client.query<Row>(
    `insert into research.report_v2_assertion (tenant_id, report_id, revision, assertion_ref_digest, assertion_id, assertion_kind)
     select $1, r.report_id, r.revision, a.digest, a.assertion_id, a.kind
       from knowledge_verification.report_revision r
       cross join lateral jsonb_array_elements(r.assertion_refs) ref
       join knowledge_verification.assertion a on a.tenant_id = r.tenant_id and a.digest = ref ->> 'digest' and a.assertion_id = ref ->> 'id'
      where r.tenant_id = $1 and r.report_id = $2 and r.revision = $3
     on conflict (tenant_id, report_id, revision, assertion_ref_digest) do nothing
     returning assertion_ref_digest`,
    [tenantId, revision.report_id, revision.revision],
  );
  const cited = Number(
    (
      await client.query<Row>(
        "select count(*)::int n from research.report_v2_assertion where tenant_id = $1 and report_id = $2 and revision = $3",
        [tenantId, revision.report_id, revision.revision],
      )
    ).rows[0]?.n ?? 0,
  );
  const assertionRefDigest = subjectKind === "assertion" ? String(decision.subject_digest) : null;
  await client.query(
    `insert into research.report_v2_ingestion (tenant_id, use_decision_id, bound_effect_digest, report_id, revision, assertion_ref_digest,
       intent_id, receipt_id, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tenantId,
      input.useDecisionId,
      input.boundEffectDigest,
      revision.report_id,
      revision.revision,
      assertionRefDigest,
      input.operationIntentId,
      input.receiptId,
      input.outcome,
    ],
  );
  const revisionKey = JSON.stringify([revision.report_id, revision.revision]);
  const projection = (table: string, id: string, action: "created" | "reused"): ReceiptTarget => ({
    schema: "research",
    table,
    id,
    role: "projection",
    action,
    proposalId: null,
    entityId: null,
    entityKind: null,
    claimId: null,
  });
  const newAssertions = new Set(assertions.rows.map((row) => String(row.assertion_ref_digest)));
  const citedDigests = (
    await client.query<Row>(
      "select assertion_ref_digest from research.report_v2_assertion where tenant_id = $1 and report_id = $2 and revision = $3 order by assertion_ref_digest",
      [tenantId, revision.report_id, revision.revision],
    )
  ).rows.map((row) => String(row.assertion_ref_digest));
  return {
    report: {
      reportId: revision.report_id,
      revision: revision.revision,
      reportRevisionId: revision.report_revision_id,
      reportRevisionDigest: revision.digest,
      runId: revision.run_id,
      verificationSnapshotDigest: snapshotDigest,
      useDecisionId: input.useDecisionId,
      subjectKind,
      assertionRefDigest,
      resolution: subjectKind === "report" ? "report_subject" : "latest_revision_citing_assertion",
      candidateRevisions: candidates,
      assertions: cited,
    },
    targets: [
      projection("report_v2_revision", revisionKey, revisionWritten.rows.length > 0 ? "created" : "reused"),
      ...citedDigests.map((digest) =>
        projection(
          "report_v2_assertion",
          JSON.stringify([revision.report_id, revision.revision, digest]),
          newAssertions.has(digest) ? "created" : "reused",
        ),
      ),
      projection("report_v2_ingestion", input.useDecisionId, "created"),
    ],
  };
}

async function revisionById(
  client: KnowledgeSqlClient,
  tenantId: string,
  reportRevisionId: string,
): Promise<{ revision: Revision | undefined; candidates: number }> {
  const row = (
    await client.query<Row>(
      `select ${REVISION_COLUMNS} from knowledge_verification.report_revision r where r.tenant_id = $1 and r.report_revision_id = $2`,
      [tenantId, reportRevisionId],
    )
  ).rows[0];
  return {
    revision: row ? toRevision(row) : undefined,
    candidates: row ? 1 : 0,
  };
}

async function latestRevisionCiting(
  client: KnowledgeSqlClient,
  tenantId: string,
  assertionDigest: string,
): Promise<{ revision: Revision | undefined; candidates: number }> {
  const rows = (
    await client.query<Row>(
      `select ${REVISION_COLUMNS} from knowledge_verification.report_revision r
        where r.tenant_id = $1 and exists (select 1 from jsonb_array_elements(r.assertion_refs) ref where ref ->> 'digest' = $2)
        order by r.registered_at desc, r.report_id, r.revision desc`,
      [tenantId, assertionDigest],
    )
  ).rows;
  const first = rows[0];
  return {
    revision: first ? toRevision(first) : undefined,
    candidates: rows.length,
  };
}

function toRevision(row: Row): Revision {
  return {
    report_id: String(row.report_id),
    revision: Number(row.revision),
    report_revision_id: String(row.report_revision_id),
    digest: String(row.digest),
    run_id: String(row.run_id),
    report_kind: String(row.report_kind),
    body_digest: String(row.body_digest),
  };
}
