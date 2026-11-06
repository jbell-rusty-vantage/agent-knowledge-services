import type { TenantSqlClient } from "./postgres.js";
import { readRepresentationDependencies } from "./representation-dependency.js";

/** Call only after authenticating these exact handles against the signed native source set. */
export async function assertSignedReportSourceDependencies(
  client: TenantSqlClient,
  tenantId: string,
  sources: readonly { artifactId: string; digest: string }[],
): Promise<void> {
  if (sources.length > 512) throw new Error("REPORT_SOURCE_DEPENDENCY_LIMIT");
  if (!sources.length) return;
  if (sources.some((source) => !/^sha256:[a-f0-9]{64}$/.test(source.digest)))
    throw new Error("REPORT_SOURCE_DEPENDENCY_UNAVAILABLE");
  const ids = sources.map((source) => source.artifactId),
    digests = sources.map((source) => source.digest.slice(7));
  const rows = (
    await client.query<{ artifact_id: string | null; requested_id: string; representation_id: string | null }>(
      `
    select source.id requested_id,a.id artifact_id,r.id representation_id
    from unnest($2::uuid[],$3::text[]) source(id,digest)
    left join orchestration.artifact a on a.tenant_id=$1 and a.id=source.id and a.sha256=source.digest and a.storage_state='available'
    left join content.document_representation r on r.tenant_id=$1 and r.artifact_id=a.id and r.content_sha256=source.digest
      and (r.representation_class<>'source_native' or exists(select 1 from content.representation_decision d
        where d.tenant_id=r.tenant_id and d.representation_id=r.id)
        or exists(select 1 from content.document_version version where version.tenant_id=r.tenant_id
          and version.id=r.document_version_id and version.correction_state in ('retracted','withdrawn')))
    limit 1025`,
      [tenantId, ids, digests],
    )
  ).rows;
  if (
    rows.length > 1024 ||
    rows.some((row) => !row.artifact_id) ||
    new Set(rows.map((row) => row.requested_id)).size !== new Set(ids).size
  )
    throw new Error("REPORT_SOURCE_DEPENDENCY_UNAVAILABLE");
  for (const representationId of new Set(
    rows.flatMap((row) => (row.representation_id ? [row.representation_id] : [])),
  )) {
    const dependencies = await readRepresentationDependencies(client, tenantId, representationId);
    if (!dependencies.eligible)
      throw new Error(`REPORT_SOURCE_DEPENDENCY_INELIGIBLE:${dependencies.blocked.join(",")}`);
  }
}
