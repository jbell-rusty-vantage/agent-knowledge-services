import { canonicalJson, sha256Digest } from "@aiengineer/knowledge-core";
import { JsonValueSchema } from "@aiengineer/knowledge-contracts";
import type { TenantSqlClient } from "./postgres.js";
import { readContentRepresentationAdmission } from "./content-representation-admission.js";

interface ArtifactReference {
  readonly id: string;
  readonly digest: string;
}
export interface PreparedContentSummaryInput {
  readonly tenantId: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly transformationRunId: string;
  readonly representationId: string;
  readonly documentVersionId: string;
  readonly inputRepresentationId: string;
  readonly inputArtifact: ArtifactReference;
  readonly outputArtifact: ArtifactReference;
  readonly receiptArtifact: ArtifactReference;
  readonly requestDigest: string;
  readonly language?: string;
}
type Row = Record<string, unknown>;
const renderingVersion = "content-summary-literal.v1";
function requireSame(row: Row | undefined, expected: Row): void {
  if (
    !row ||
    !Object.entries(expected).every(([key, value]) => {
      const actual = JsonValueSchema.safeParse(row[key]),
        comparison = JsonValueSchema.safeParse(value);
      return actual.success && comparison.success && canonicalJson(actual.data) === canonicalJson(comparison.data);
    })
  )
    throw new Error("CONTENT_SUMMARY_PREPARATION_CONFLICT");
}

/** Persists a completed deterministic rendering; acceptance remains pending until independent review. */
export async function persistPreparedContentSummary(
  client: TenantSqlClient,
  input: PreparedContentSummaryInput,
): Promise<void> {
  await requireInputs(client, input);
  const parameters = { renderingVersion, requestDigest: input.requestDigest, receiptArtifact: input.receiptArtifact };
  const parameterDigest = sha256Digest(JsonValueSchema.parse(parameters)).slice(7);
  const receipt = {
    schemaVersion: "content-summary-preparation-result.v1",
    receiptArtifact: input.receiptArtifact,
    outputArtifact: input.outputArtifact,
    requestDigest: input.requestDigest,
    renderingVersion,
  };
  const key = `content-summary:${input.transformationRunId}`;
  await client.query(
    `insert into content.transformation_run(id,tenant_id,transformation_kind,contract_version,code_ref,parameters,parameters_sha256,
    attempt_id,status,idempotency_key,input_manifest_sha256,output_manifest_sha256,receipt,resource_observations,cost_usd,started_at,ended_at)
    values($1,$2,'summarize','knowledge.transformation/v1',$3,$4::jsonb,$5,$6,'succeeded',$7,$8,$9,$10::jsonb,'{"providerCalls":0}',0,now(),now())
    on conflict(tenant_id,idempotency_key) do nothing`,
    [
      input.transformationRunId,
      input.tenantId,
      renderingVersion,
      JSON.stringify(parameters),
      parameterDigest,
      input.attemptId,
      key,
      input.inputArtifact.digest.slice(7),
      input.outputArtifact.digest.slice(7),
      JSON.stringify(receipt),
    ],
  );
  requireSame(
    (
      await client.query<Row>("select * from content.transformation_run where tenant_id=$1 and idempotency_key=$2", [
        input.tenantId,
        key,
      ])
    ).rows[0],
    {
      id: input.transformationRunId,
      transformation_kind: "summarize",
      code_ref: renderingVersion,
      parameters_sha256: parameterDigest,
      attempt_id: input.attemptId,
      status: "succeeded",
      input_manifest_sha256: input.inputArtifact.digest.slice(7),
      output_manifest_sha256: input.outputArtifact.digest.slice(7),
      receipt,
    },
  );
  await client.query(
    `insert into content.document_representation(id,tenant_id,document_version_id,artifact_id,representation_kind,representation_class,
    media_type,language,content_sha256,transformation_run_id,acceptance_state,source_native_byte_identical)
    values($1,$2,$3,$4,'summary','semantic_projection','text/plain; charset=utf-8',$5,$6,$7,'pending',false) on conflict(id) do nothing`,
    [
      input.representationId,
      input.tenantId,
      input.documentVersionId,
      input.outputArtifact.id,
      input.language ?? null,
      input.outputArtifact.digest.slice(7),
      input.transformationRunId,
    ],
  );
  requireSame(
    (
      await client.query<Row>("select * from content.document_representation where tenant_id=$1 and id=$2", [
        input.tenantId,
        input.representationId,
      ])
    ).rows[0],
    {
      document_version_id: input.documentVersionId,
      artifact_id: input.outputArtifact.id,
      representation_kind: "summary",
      representation_class: "semantic_projection",
      media_type: "text/plain; charset=utf-8",
      language: input.language ?? null,
      content_sha256: input.outputArtifact.digest.slice(7),
      transformation_run_id: input.transformationRunId,
      source_native_byte_identical: false,
    },
  );
  await persistLineage(client, input);
}

async function requireInputs(client: TenantSqlClient, input: PreparedContentSummaryInput): Promise<void> {
  const attempt = (
    await client.query<Row>(
      `select a.id from orchestration.attempt a join orchestration.work_item w on w.tenant_id=a.tenant_id and w.id=a.work_item_id
    where a.tenant_id=$1 and a.id=$2 and w.mission_id=$3`,
      [input.tenantId, input.attemptId, input.missionId],
    )
  ).rows[0];
  if (!attempt) throw new Error("CONTENT_SUMMARY_ATTEMPT_REQUIRED");
  const representation = (
    await client.query<Row>(
      `select id from content.document_representation where tenant_id=$1 and id=$2
    and document_version_id=$3 and artifact_id=$4 and content_sha256=$5
    and representation_class in ('source_native','faithful_normalization','structural_extraction')`,
      [
        input.tenantId,
        input.inputRepresentationId,
        input.documentVersionId,
        input.inputArtifact.id,
        input.inputArtifact.digest.slice(7),
      ],
    )
  ).rows[0];
  if (!representation || input.representationId === input.inputRepresentationId)
    throw new Error("CONTENT_SUMMARY_FAITHFUL_INPUT_REQUIRED");
  const admission = await readContentRepresentationAdmission(client, {
    tenantId: input.tenantId,
    representationId: input.inputRepresentationId,
    guardedDigest: input.inputArtifact.digest,
  });
  if (!admission.accepted) throw new Error("CONTENT_SUMMARY_FAITHFUL_INPUT_REQUIRED");
  for (const [artifact, type] of [
    [input.outputArtifact, "content_summary_text"],
    [input.receiptArtifact, "content_summary_preparation_receipt"],
  ] as const) {
    const row = (
      await client.query<Row>(
        "select id from orchestration.artifact where tenant_id=$1 and id=$2 and sha256=$3 and artifact_type=$4 and storage_state='available'",
        [input.tenantId, artifact.id, artifact.digest.slice(7), type],
      )
    ).rows[0];
    if (!row) throw new Error("CONTENT_SUMMARY_RETAINED_OUTPUT_REQUIRED");
  }
}

async function persistLineage(client: TenantSqlClient, input: PreparedContentSummaryInput): Promise<void> {
  await client.query(
    `insert into content.transformation_input(tenant_id,transformation_run_id,ordinal,role,representation_id)
    values($1,$2,0,'faithful_source',$3) on conflict(tenant_id,transformation_run_id,ordinal) do nothing`,
    [input.tenantId, input.transformationRunId, input.inputRepresentationId],
  );
  await client.query(
    `insert into content.transformation_output(tenant_id,transformation_run_id,ordinal,role,representation_id)
    values($1,$2,0,'summary_representation',$3) on conflict(tenant_id,transformation_run_id,ordinal) do nothing`,
    [input.tenantId, input.transformationRunId, input.representationId],
  );
  await client.query(
    `insert into content.transformation_output(tenant_id,transformation_run_id,ordinal,role,artifact_id)
    values($1,$2,1,'preparation_receipt',$3) on conflict(tenant_id,transformation_run_id,ordinal) do nothing`,
    [input.tenantId, input.transformationRunId, input.receiptArtifact.id],
  );
  const sources = (
    await client.query<Row>(
      "select ordinal,role,artifact_id,representation_id,source_capture_id from content.transformation_input where tenant_id=$1 and transformation_run_id=$2 order by ordinal",
      [input.tenantId, input.transformationRunId],
    )
  ).rows;
  const outputs = (
    await client.query<Row>(
      "select ordinal,role,artifact_id,representation_id from content.transformation_output where tenant_id=$1 and transformation_run_id=$2 order by ordinal",
      [input.tenantId, input.transformationRunId],
    )
  ).rows;
  if (sources.length !== 1 || outputs.length !== 2) throw new Error("CONTENT_SUMMARY_LINEAGE_CONFLICT");
  requireSame(sources[0], {
    ordinal: 0,
    role: "faithful_source",
    artifact_id: null,
    representation_id: input.inputRepresentationId,
    source_capture_id: null,
  });
  requireSame(outputs[0], {
    ordinal: 0,
    role: "summary_representation",
    artifact_id: null,
    representation_id: input.representationId,
  });
  requireSame(outputs[1], {
    ordinal: 1,
    role: "preparation_receipt",
    artifact_id: input.receiptArtifact.id,
    representation_id: null,
  });
  await client.query(
    `insert into orchestration.artifact_lineage(tenant_id,from_artifact_id,to_artifact_id,relation_kind,transformation_run_id)
    values($1,$2,$3,'derived_from',$4) on conflict do nothing`,
    [input.tenantId, input.outputArtifact.id, input.inputArtifact.id, input.transformationRunId],
  );
  const edge = (
    await client.query<Row>(
      `select transformation_run_id from orchestration.artifact_lineage
    where tenant_id=$1 and from_artifact_id=$2 and to_artifact_id=$3 and relation_kind='derived_from'`,
      [input.tenantId, input.outputArtifact.id, input.inputArtifact.id],
    )
  ).rows;
  // The canonical unique key cannot record two distinct transformations for the same artifact pair.
  if (edge.length !== 1 || edge[0]!.transformation_run_id !== input.transformationRunId)
    throw new Error("CONTENT_SUMMARY_ARTIFACT_LINEAGE_CONFLICT");
}
