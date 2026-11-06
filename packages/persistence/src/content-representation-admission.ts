import type { TenantSqlClient } from "./postgres.js";

export interface ContentRepresentationAdmission {
  readonly accepted: boolean;
  readonly decisionId: string | null;
  readonly decision: string | null;
}
type Row = Record<string, unknown>;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function independentProducer(row: Row): boolean {
  if (!nonempty(row.producer_actor)) return false;
  const summary = row.representation_kind === "summary" || row.transformation_kind === "summarize";
  if (summary && row.transformation_kind !== "summarize") return false;
  if (!summary && row.producer_actor === row.review_identity) return false;
  if (!summary && row.reviewer_attempt_id === null) return true;
  if (
    !nonempty(row.producer_attempt_id) ||
    row.producer_attempt_id !== row.transformation_attempt_id ||
    !nonempty(row.producer_deployment_id)
  )
    return false;
  if (row.review_identity === row.producer_attempt_id || row.review_identity === row.producer_deployment_id)
    return false;
  // A standalone human review has no runtime attempt; its actor and eligible role remain authoritative.
  if (row.reviewer_attempt_id === null) return true;
  return (
    nonempty(row.reviewer_attempt_id) &&
    row.reviewer_resolved_attempt_id === row.reviewer_attempt_id &&
    nonempty(row.reviewer_deployment_id) &&
    row.reviewer_attempt_id !== row.producer_attempt_id &&
    row.reviewer_deployment_id !== row.producer_deployment_id
  );
}

/** The immutable representation label predates review. Only its latest independent decision admits bytes. */
export async function readContentRepresentationAdmission(
  client: TenantSqlClient,
  input: {
    tenantId: string;
    representationId: string;
    guardedDigest: string;
  },
): Promise<ContentRepresentationAdmission> {
  const row = (
    await client.query<Row>(
      `with latest as (
      select * from content.representation_decision where tenant_id=$1 and representation_id=$2
      order by created_at desc,id desc limit 1
    ) select d.*,r.id review_id,r.legacy_provenance review_legacy,r.guarded_sha256 review_digest,
      r.decision review_decision,r.reviewer_identity review_identity,r.reviewer_role,r.decision_operation_id review_operation_id,
      s.subject_kind,s.subject_ref,s.guarded_sha256 subject_digest,s.eligible_roles,s.quorum_required,
      s.operation_id subject_operation_id,v.content_sha256 representation_digest,v.representation_kind,t.operation_id producing_operation_id,
      t.transformation_kind,t.attempt_id transformation_attempt_id,pa.id producer_attempt_id,pa.agent_deployment_id producer_deployment_id,
      o.attempt_id reviewer_attempt_id,ra.id reviewer_resolved_attempt_id,ra.agent_deployment_id reviewer_deployment_id,
      (d.expires_at is null or d.expires_at>now()) decision_current,
      (s.expires_at is null or s.expires_at>now()) subject_current,
      o.id operation_id,o.actor_identity operation_actor,o.operation_kind,o.status operation_status,
      p.actor_identity producer_actor
    from latest d left join knowledge_service.review_decision r on r.tenant_id=d.tenant_id and r.id=d.knowledge_review_decision_id
    left join knowledge_service.review_subject s on s.tenant_id=r.tenant_id and s.id=r.review_subject_id
    left join knowledge_service.operation o on o.tenant_id=d.tenant_id and o.id=d.decision_operation_id
    left join knowledge_service.operation p on p.tenant_id=s.tenant_id and p.id=s.operation_id
    left join content.document_representation v on v.tenant_id=d.tenant_id and v.id=d.representation_id
    left join content.transformation_run t on t.tenant_id=v.tenant_id and t.id=v.transformation_run_id
    left join orchestration.attempt pa on pa.tenant_id=t.tenant_id and pa.id=t.attempt_id
    left join orchestration.attempt ra on ra.tenant_id=o.tenant_id and ra.id=o.attempt_id`,
      [input.tenantId, input.representationId],
    )
  ).rows[0];
  if (!row) return { accepted: false, decisionId: null, decision: null };
  const subject = row.subject_ref as Row | null;
  const guarded = input.guardedDigest.slice(7);
  const accepted =
    /^sha256:[a-f0-9]{64}$/.test(input.guardedDigest) &&
    row.tenant_id === input.tenantId &&
    row.representation_id === input.representationId &&
    row.decision === "accept" &&
    row.legacy_provenance === false &&
    row.review_legacy === false &&
    row.guarded_sha256 === guarded &&
    row.review_digest === guarded &&
    row.subject_digest === guarded &&
    row.representation_digest === guarded &&
    row.review_id === row.knowledge_review_decision_id &&
    row.review_decision === "approve" &&
    row.review_operation_id === row.decision_operation_id &&
    row.operation_id === row.decision_operation_id &&
    row.operation_kind === "representation_decision" &&
    row.operation_status === "succeeded" &&
    row.reviewer_identity === row.review_identity &&
    row.operation_actor === row.review_identity &&
    independentProducer(row) &&
    (row.producing_operation_id === null || row.producing_operation_id === row.subject_operation_id) &&
    ["conversion", "representation"].includes(String(row.subject_kind)) &&
    subject?.representationId === input.representationId &&
    subject.artifactDigest === input.guardedDigest &&
    row.quorum_required === 1 &&
    Array.isArray(row.eligible_roles) &&
    row.eligible_roles.includes(row.reviewer_role) &&
    row.decision_current === true &&
    row.subject_current === true;
  return { accepted, decisionId: String(row.id), decision: String(row.decision) };
}
