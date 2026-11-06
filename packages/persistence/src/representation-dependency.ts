import type { TenantSqlClient } from "./postgres.js";
import { readContentRepresentationAdmission } from "./content-representation-admission.js";

const MAX_DEPENDENCIES = 1024;
type DependencyRow = {
  artifact_id: string;
  storage_state: string | null;
  representation_id: string | null;
  content_sha256: string;
  representation_class: string | null;
  withdrawn: boolean;
  has_decision: boolean;
  capture_root: boolean;
  native_reviews: { id: string; digest: string; withdrawn: boolean; has_decision: boolean }[];
  report_version_id: string | null;
};

/** Required inputs retain their transformation binding when output bytes are reused by a later representation. */
export async function readRepresentationDependencies(
  client: TenantSqlClient,
  tenantId: string,
  representationId: string,
) {
  const rows = (
    await client.query<DependencyRow>(
      `with recursive required_edges as (
      select 'artifact'::text child_kind,e.from_artifact_id child,'artifact'::text parent_kind,e.to_artifact_id parent
      from orchestration.artifact_lineage e where e.tenant_id=$1 and e.relation_kind='derived_from'
      union select 'representation',r.id,case when i.representation_id is not null then 'representation' else 'artifact' end,
        coalesce(i.representation_id,i.artifact_id,c.artifact_id)
      from content.document_representation r
      join content.transformation_input i on i.tenant_id=r.tenant_id and i.transformation_run_id=r.transformation_run_id
      left join evidence.source_capture c on c.tenant_id=i.tenant_id and c.id=i.source_capture_id where r.tenant_id=$1
      union select 'representation',r.id,'artifact',e.to_artifact_id
      from content.document_representation r join orchestration.artifact_lineage e
        on e.tenant_id=r.tenant_id and e.from_artifact_id=r.artifact_id and e.relation_kind='derived_from'
      where r.tenant_id=$1 and (e.transformation_run_id=r.transformation_run_id or e.transformation_run_id is null)
        and not exists(select 1 from content.transformation_input i
          join content.document_representation bound on bound.tenant_id=i.tenant_id and bound.id=i.representation_id
          where i.tenant_id=r.tenant_id and i.transformation_run_id=r.transformation_run_id and bound.artifact_id=e.to_artifact_id)
    ), ancestors(kind,id) as (
      select 'representation'::text,id from content.document_representation where tenant_id=$1 and id=$2
      union select e.parent_kind,e.parent from required_edges e join ancestors a on a.id=e.child and a.kind=e.child_kind where e.parent is not null
    ), bounded as (select kind,id from ancestors limit ${MAX_DEPENDENCIES + 1})
    select coalesce(a.id,b.id) artifact_id,a.storage_state,r.id representation_id,r.content_sha256,r.representation_class,
      coalesce(document.correction_state in ('retracted','withdrawn'),true) withdrawn,
      exists(select 1 from content.representation_decision decision where decision.tenant_id=$1 and decision.representation_id=r.id) has_decision,
      exists(select 1 from evidence.source_capture c where c.tenant_id=$1 and c.artifact_id=a.id and c.content_sha256=a.sha256)
        and not exists(select 1 from content.document_representation prepared where prepared.tenant_id=$1
          and prepared.artifact_id=a.id and prepared.representation_class<>'source_native') capture_root,
      coalesce((select jsonb_agg(jsonb_build_object('id',native.id,'digest',native.content_sha256,
        'withdrawn',version.correction_state in ('retracted','withdrawn'),'has_decision',
        exists(select 1 from content.representation_decision decision where decision.tenant_id=$1 and decision.representation_id=native.id)))
        from content.document_representation native join content.document_version version on version.tenant_id=native.tenant_id and version.id=native.document_version_id
        where native.tenant_id=$1 and native.artifact_id=a.id and native.representation_class='source_native'),'[]'::jsonb) native_reviews,
      report.report_version_id
    from bounded b left join content.document_representation r on r.tenant_id=$1 and b.kind='representation' and r.id=b.id
    left join orchestration.artifact a on a.tenant_id=$1 and a.id=case when b.kind='artifact' then b.id else r.artifact_id end
    left join content.document_version document on document.tenant_id=r.tenant_id and document.id=r.document_version_id
    left join research.report_artifact report on report.tenant_id=$1 and report.artifact_id=a.id
    order by b.id,r.id limit ${MAX_DEPENDENCIES + 1}`,
      [tenantId, representationId],
    )
  ).rows;
  const blocked = new Set<string>(),
    representations = new Set<string>(),
    reports = new Set<string>();
  const admission = new Map<string, boolean>();
  async function admitted(id: string, digest: string) {
    if (!admission.has(id))
      admission.set(
        id,
        (
          await readContentRepresentationAdmission(client, {
            tenantId,
            representationId: id,
            guardedDigest: `sha256:${digest}`,
          })
        ).accepted,
      );
    return admission.get(id)!;
  }
  if (!rows.length || rows.length > MAX_DEPENDENCIES) blocked.add("REPRESENTATION_DEPENDENCY_CLOSURE_INCOMPLETE");
  for (const row of rows) {
    if (row.storage_state !== "available") blocked.add(`DEPENDENCY_ARTIFACT_UNAVAILABLE:${row.artifact_id}`);
    if (row.report_version_id) {
      reports.add(row.report_version_id);
      blocked.add(`REPORT_DEPENDENCY_REVALIDATION_REQUIRED:${row.report_version_id}`);
    }
    if (row.representation_id) {
      representations.add(row.representation_id);
      const capturedInput =
        row.representation_class === "source_native" &&
        row.representation_id !== representationId &&
        row.capture_root &&
        !row.has_decision;
      if (row.withdrawn || (!capturedInput && !(await admitted(row.representation_id, row.content_sha256))))
        blocked.add(`SOURCE_REPRESENTATION_NOT_ADMITTED:${row.representation_id}`);
    } else {
      if (!row.capture_root) blocked.add(`DEPENDENCY_AUTHORITY_REQUIRED:${row.artifact_id}`);
      for (const native of row.native_reviews ?? []) {
        if (native.withdrawn || (native.has_decision && !(await admitted(native.id, native.digest))))
          blocked.add(`SOURCE_REPRESENTATION_NOT_ADMITTED:${native.id}`);
      }
    }
  }
  if (!representations.has(representationId)) blocked.add("REPRESENTATION_DEPENDENCY_ROOT_MISSING");
  return {
    eligible: blocked.size === 0,
    representationIds: [...representations].sort(),
    blocked: [...blocked].sort(),
    unsupportedReportVersionIds: [...reports].sort(),
  };
}

/** Impact discovery reports unsupported reports explicitly; it is not a recovery revalidation receipt. */
export async function readRepresentationImpact(client: TenantSqlClient, tenantId: string, representationId: string) {
  const rows = (
    await client.query<{
      artifact_id: string | null;
      auxiliary_receipt: boolean;
      representation_id: string | null;
      projection_id: string | null;
      report_version_id: string | null;
    }>(
      `
    with recursive edges as (
      select 'artifact'::text child_kind,from_artifact_id child,'artifact'::text parent_kind,to_artifact_id parent from orchestration.artifact_lineage
      where tenant_id=$1 and relation_kind='derived_from'
      union select 'representation',r.id,case when i.representation_id is not null then 'representation' else 'artifact' end,
        coalesce(i.representation_id,i.artifact_id,c.artifact_id)
      from content.document_representation r
      join content.transformation_input i on i.tenant_id=r.tenant_id and i.transformation_run_id=r.transformation_run_id
      left join evidence.source_capture c on c.tenant_id=i.tenant_id and c.id=i.source_capture_id where r.tenant_id=$1
      union select 'artifact',receipt.artifact_id,'representation',output.representation_id
      from content.transformation_output receipt join content.transformation_output output
        on output.tenant_id=receipt.tenant_id and output.transformation_run_id=receipt.transformation_run_id
      where receipt.tenant_id=$1 and receipt.role='preparation_receipt' and output.representation_id is not null
    ), descendants(kind,id) as (
      select 'representation'::text,id from content.document_representation where tenant_id=$1 and id=$2
      union select 'artifact',artifact_id from content.document_representation where tenant_id=$1 and id=$2
      union select e.child_kind,e.child from edges e join descendants d on d.id=e.parent and d.kind=e.parent_kind
    ), bounded as (select kind,id from descendants limit ${MAX_DEPENDENCIES + 1}),
    affected_artifacts as (
      select coalesce(r.artifact_id,b.id) id from bounded b
      left join content.document_representation r on r.tenant_id=$1 and b.kind='representation' and r.id=b.id
    ), report_dependencies(report_version_id) as (
      select ra.report_version_id from research.report_artifact ra join affected_artifacts b on b.id=ra.artifact_id where ra.tenant_id=$1
      union select rc.report_version_id from research.report_assertion_claim rc
      join affected_artifacts b on b.id=rc.evidence_manifest_artifact_id where rc.tenant_id=$1 and rc.role in ('supports','premise')
      union select rc.report_version_id from research.report_assertion_claim rc
      join evidence.claim_evidence_link link on link.tenant_id=rc.tenant_id and link.claim_id=rc.claim_id
      join evidence.locator loc on loc.tenant_id=link.tenant_id and loc.id=link.locator_id
      join affected_artifacts b on b.id=loc.representation_artifact_id where rc.tenant_id=$1 and rc.role in ('supports','premise')
      union select dep.report_version_id from research.report_section_dependency dep
      join report_dependencies report on report.report_version_id=dep.required_version_id
      where dep.tenant_id=$1 and dep.relation in ('requires_context','derived_from')
    ), result as (
    select coalesce(r.artifact_id,b.id) artifact_id,(exists(select 1 from bounded existing
      join content.document_representation represented on represented.tenant_id=$1 and existing.kind='representation' and represented.id=existing.id
      where b.kind='artifact' and represented.artifact_id=b.id)
      or exists(select 1 from content.transformation_output receipt
      join content.transformation_output output on output.tenant_id=receipt.tenant_id and output.transformation_run_id=receipt.transformation_run_id
      join content.document_representation represented on represented.tenant_id=output.tenant_id and represented.id=output.representation_id
      join bounded sibling on sibling.kind='representation' and sibling.id=represented.id
      where receipt.tenant_id=$1 and receipt.artifact_id=b.id and receipt.role='preparation_receipt')) auxiliary_receipt,
      r.id representation_id,p.id projection_id,report.report_version_id
    from bounded b left join content.document_representation r on r.tenant_id=$1 and b.kind='representation' and r.id=b.id
    left join retrieval.chunk_set cs on cs.tenant_id=r.tenant_id and cs.representation_id=r.id
    left join retrieval.retrieval_chunk chunk on chunk.tenant_id=cs.tenant_id and chunk.chunk_set_id=cs.id
    left join retrieval.search_projection_chunk_support support on support.tenant_id=chunk.tenant_id and support.chunk_id=chunk.id
    left join retrieval.search_projection p on p.tenant_id=support.tenant_id and p.id=support.search_projection_id
    left join research.report_artifact report on report.tenant_id=$1 and report.artifact_id=coalesce(r.artifact_id,b.id)
    union select null::uuid,false,null::uuid,null::uuid,report_version_id from report_dependencies
    ) select * from result limit ${MAX_DEPENDENCIES + 1}`,
      [tenantId, representationId],
    )
  ).rows;
  const unique = (key: "representation_id" | "projection_id" | "report_version_id") =>
    [...new Set(rows.flatMap((row) => (row[key] ? [row[key]!] : [])))].sort();
  const unsupportedReportVersionIds = unique("report_version_id");
  const unsupportedArtifactIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.artifact_id && !row.representation_id && !row.report_version_id && !row.auxiliary_receipt
          ? [row.artifact_id]
          : [],
      ),
    ),
  ].sort();
  return {
    complete:
      rows.length > 0 &&
      rows.length <= MAX_DEPENDENCIES &&
      unsupportedReportVersionIds.length === 0 &&
      unsupportedArtifactIds.length === 0,
    representationIds: unique("representation_id"),
    projectionIds: unique("projection_id"),
    unsupportedReportVersionIds,
    unsupportedArtifactIds,
    blocked: [
      ...unsupportedReportVersionIds.map((id) => `REPORT_DEPENDENCY_REVALIDATION_REQUIRED:${id}`),
      ...unsupportedArtifactIds.map((id) => `DEPENDENCY_AUTHORITY_REQUIRED:${id}`),
      ...(rows.length === 0 || rows.length > MAX_DEPENDENCIES ? ["REPRESENTATION_DEPENDENCY_CLOSURE_INCOMPLETE"] : []),
    ],
  };
}
