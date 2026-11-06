import { sha256Digest } from "@aiengineer/knowledge-core";
import type {
  PersistCaptureInput,
  PersistChunkSetInput,
  PersistedCapture,
  PersistedChunkSet,
  PersistedPreparationArtifact,
  PersistedRepresentation,
  PersistRepresentationInput,
  PreparationRepository,
} from "./types.js";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
import { canonicalCaptureMethod, canonicalDocumentType } from "./preparation-vocabulary.js";

type Row = Record<string, unknown>;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
const digestHex = (value: unknown) => sha256Digest(JSON.parse(JSON.stringify(value))).slice(7);

function artifactFromRow(row: Row): PersistedPreparationArtifact {
  return {
    artifactId: String(row.artifact_id ?? row.id),
    digest: `sha256:${String(row.sha256)}`,
    mediaType: String(row.media_type),
    byteLength: Number(row.size_bytes),
    storageKey: String(row.object_path),
    artifactType: String(row.artifact_type),
    bucketClass: row.bucket_class as PersistedPreparationArtifact["bucketClass"],
    storageBucket: row.storage_bucket as PersistedPreparationArtifact["storageBucket"],
  };
}

async function persistArtifact(
  client: TenantSqlClient,
  tenantId: string,
  artifact: PersistedPreparationArtifact,
): Promise<void> {
  const registered = (
    await client.query<Row>("select * from orchestration.artifact where tenant_id=$1 and id=$2", [
      tenantId,
      artifact.artifactId,
    ])
  ).rows[0];
  if (registered) {
    if (
      registered.sha256 !== artifact.digest.slice(7) ||
      registered.media_type !== artifact.mediaType ||
      Number(registered.size_bytes) !== artifact.byteLength ||
      registered.storage_bucket !== artifact.storageBucket ||
      registered.object_path !== artifact.storageKey ||
      registered.artifact_type !== artifact.artifactType
    )
      throw new Error("ARTIFACT_METADATA_CONFLICT");
    if (registered.verification_contract_version && registered.storage_state !== "available")
      throw new Error("ARTIFACT_NOT_AVAILABLE");
    return;
  }
  await client.query(
    `insert into orchestration.artifact
    (id,tenant_id,artifact_type,sha256,bucket_class,storage_bucket,object_path,media_type,size_bytes)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(storage_bucket,object_path) where verification_contract_version is null do nothing`,
    [
      artifact.artifactId,
      tenantId,
      artifact.artifactType,
      artifact.digest.slice(7),
      artifact.bucketClass,
      artifact.storageBucket,
      artifact.storageKey,
      artifact.mediaType,
      artifact.byteLength,
    ],
  );
  const stored = (
    await client.query<Row>(
      "select * from orchestration.artifact where tenant_id=$1 and storage_bucket=$2 and object_path=$3",
      [tenantId, artifact.storageBucket, artifact.storageKey],
    )
  ).rows[0];
  if (
    !stored ||
    String(stored.id) !== artifact.artifactId ||
    String(stored.sha256) !== artifact.digest.slice(7) ||
    String(stored.artifact_type) !== artifact.artifactType ||
    Number(stored.size_bytes) !== artifact.byteLength
  ) {
    throw new Error(
      `ARTIFACT_METADATA_CONFLICT:${JSON.stringify({
        expected: {
          id: artifact.artifactId,
          sha256: artifact.digest.slice(7),
          artifactType: artifact.artifactType,
          sizeBytes: artifact.byteLength,
          storageBucket: artifact.storageBucket,
          objectPath: artifact.storageKey,
        },
        stored: stored
          ? {
              id: String(stored.id),
              sha256: String(stored.sha256),
              artifactType: String(stored.artifact_type),
              sizeBytes: Number(stored.size_bytes),
              storageBucket: String(stored.storage_bucket),
              objectPath: String(stored.object_path),
            }
          : null,
      })}`,
    );
  }
}

function captureFromRow(row: Row): PersistedCapture {
  const context = row.context as Record<string, unknown>;
  return {
    operationId: String(context.operationId),
    sourceId: String(row.source_id),
    captureId: String(row.id),
    sourceClass: row.source_class as PersistedCapture["sourceClass"],
    canonicalUrl: String(row.canonical_url),
    ...(row.publisher ? { publisher: String(row.publisher) } : {}),
    sensitivity: row.sensitivity as PersistedCapture["sensitivity"],
    artifact: artifactFromRow(row),
    captureMethod: String(context.captureMethod ?? row.capture_method),
    captureMethodVersion: String(row.capture_method_version),
    requestUrl: String(row.request_url),
    ...(row.http_status === null ? {} : { httpStatus: Number(row.http_status) }),
    observations: context.observations ?? {},
    capturedAt: iso(row.captured_at),
  };
}

/**
 * Transactional adapter for the append-only preparation graph. Object bytes are
 * sealed before these calls; each call atomically registers all relational
 * identities and verifies an idempotent replay against immutable digests.
 */
export class PostgresPreparationRepository implements PreparationRepository {
  constructor(private readonly database: PostgresCanonicalRepository) {}

  async persistCapture(tenantId: string, input: PersistCaptureInput): Promise<PersistedCapture> {
    const captureMethod = canonicalCaptureMethod(input.captureMethod);
    return this.database.transaction(tenantId, async (client) => {
      await client.query("select id from knowledge_service.operation where tenant_id=$1 and id=$2 for update", [
        tenantId,
        input.operationId,
      ]);
      await persistArtifact(client, tenantId, input.artifact);
      await client.query(
        `insert into evidence.source(id,tenant_id,source_class,canonical_url,publisher,sensitivity)
        values($1,$2,$3,$4,$5,$6) on conflict do nothing`,
        [input.sourceId, tenantId, input.sourceClass, input.canonicalUrl, input.publisher ?? null, input.sensitivity],
      );
      const source = (
        await client.query<Row>(
          "select * from evidence.source where tenant_id=$1 and (id=$2 or canonical_url=$3) order by id for update",
          [tenantId, input.sourceId, input.canonicalUrl],
        )
      ).rows[0];
      if (
        !source ||
        String(source.canonical_url) !== input.canonicalUrl ||
        String(source.source_class) !== input.sourceClass ||
        String(source.sensitivity) !== input.sensitivity
      )
        throw new Error("SOURCE_IDENTITY_CONFLICT");
      const context = {
        operationId: input.operationId,
        observations: input.observations,
        captureMethod: input.captureMethod,
      };
      const matching = (
        await client.query<Row>(
          `select id from evidence.source_capture where tenant_id=$1 and source_id=$2 and artifact_id=$3
        and content_sha256=$4 and captured_at=$5::timestamptz and capture_method=$6 and capture_method_version=$7
        and coalesce(context->>'captureMethod',capture_method)=$8 order by id`,
          [
            tenantId,
            source.id,
            input.artifact.artifactId,
            input.artifact.digest.slice(7),
            input.capturedAt,
            captureMethod,
            input.captureMethodVersion,
            input.captureMethod,
          ],
        )
      ).rows;
      if (matching.length > 1) throw new Error("CAPTURE_IDENTITY_AMBIGUOUS");
      const captureId = matching[0] ? String(matching[0].id) : input.captureId;
      if (!matching[0]) {
        await client.query(
          `insert into evidence.source_capture
        (id,tenant_id,source_id,artifact_id,content_sha256,media_type,captured_at,capture_method,capture_method_version,request_url,http_status,context,knowledge_operation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) on conflict(id) do nothing`,
          [
            input.captureId,
            tenantId,
            String(source.id),
            input.artifact.artifactId,
            input.artifact.digest.slice(7),
            input.artifact.mediaType,
            input.capturedAt,
            captureMethod,
            input.captureMethodVersion,
            input.requestUrl,
            input.httpStatus ?? null,
            JSON.stringify(context),
            input.operationId,
          ],
        );
      }
      const row = (
        await client.query<Row>(
          `select c.*,s.source_class,s.canonical_url,s.publisher,s.sensitivity,
        a.id artifact_id,a.artifact_type,a.sha256,a.bucket_class,a.storage_bucket,a.object_path,a.media_type,a.size_bytes
        from evidence.source_capture c join evidence.source s on s.tenant_id=c.tenant_id and s.id=c.source_id
        join orchestration.artifact a on a.tenant_id=c.tenant_id and a.id=c.artifact_id
        where c.tenant_id=$1 and c.id=$2`,
          [tenantId, captureId],
        )
      ).rows[0];
      if (
        !row ||
        String(row.content_sha256) !== input.artifact.digest.slice(7) ||
        String(row.source_id) !== String(source.id) ||
        String(row.artifact_id) !== input.artifact.artifactId ||
        iso(row.captured_at) !== new Date(input.capturedAt).toISOString() ||
        String(row.request_url) !== input.requestUrl ||
        (row.http_status === null ? undefined : Number(row.http_status)) !== input.httpStatus ||
        String(row.capture_method) !== captureMethod ||
        String(row.capture_method_version) !== input.captureMethodVersion ||
        String((row.context as Record<string, unknown>).captureMethod ?? row.capture_method) !== input.captureMethod
      )
        throw new Error("CAPTURE_IDEMPOTENCY_CONFLICT");
      const binding = { captureId, operationId: input.operationId, observations: input.observations };
      await client.query(
        `insert into knowledge_service.receipt
        (id,tenant_id,operation_id,receipt_kind,idempotency_key,executor_identity,input_sha256,output_sha256,outcome,body)
        values($1,$2,$1,'capture.identity-bound',$3,'preparation-repository',$4,$5,'bound',$6::jsonb)
        on conflict(tenant_id,idempotency_key) do nothing`,
        [
          input.operationId,
          tenantId,
          `capture-identity:${input.operationId}`,
          digestHex(input),
          digestHex(binding),
          JSON.stringify(binding),
        ],
      );
      const receipt = (
        await client.query<Row>("select * from knowledge_service.receipt where tenant_id=$1 and idempotency_key=$2", [
          tenantId,
          `capture-identity:${input.operationId}`,
        ])
      ).rows[0];
      if (!receipt || receipt.input_sha256 !== digestHex(input) || receipt.output_sha256 !== digestHex(binding))
        throw new Error("CAPTURE_IDEMPOTENCY_CONFLICT");
      return { ...captureFromRow(row), operationId: input.operationId, observations: input.observations };
    });
  }

  async getCaptureByOperation(tenantId: string, operationId: string): Promise<PersistedCapture | undefined> {
    return this.database.transaction(tenantId, async (client) => {
      const binding = (
        await client.query<Row>(
          "select body,output_sha256 from knowledge_service.receipt where tenant_id=$1 and idempotency_key=$2 and receipt_kind='capture.identity-bound'",
          [tenantId, `capture-identity:${operationId}`],
        )
      ).rows[0];
      const body = binding?.body as { captureId: string; operationId: string; observations: unknown } | undefined;
      if (body && (body.operationId !== operationId || binding!.output_sha256 !== digestHex(body)))
        throw new Error("CAPTURE_IDEMPOTENCY_CONFLICT");
      const row = (
        await client.query<Row>(
          `select c.*,s.source_class,s.canonical_url,s.publisher,s.sensitivity,
        a.id artifact_id,a.artifact_type,a.sha256,a.bucket_class,a.storage_bucket,a.object_path,a.media_type,a.size_bytes
        from evidence.source_capture c join evidence.source s on s.tenant_id=c.tenant_id and s.id=c.source_id
        join orchestration.artifact a on a.tenant_id=c.tenant_id and a.id=c.artifact_id
        where c.tenant_id=$1 and (($3::uuid is not null and c.id=$3) or ($3::uuid is null and c.context->>'operationId'=$2)) order by c.captured_at,c.id limit 1`,
          [tenantId, operationId, body?.captureId ?? null],
        )
      ).rows[0];
      if (body && !row) throw new Error("CAPTURE_IDENTITY_CONFLICT");
      return row
        ? { ...captureFromRow(row), ...(body ? { operationId, observations: body.observations } : {}) }
        : undefined;
    });
  }

  async persistRepresentation(tenantId: string, input: PersistRepresentationInput): Promise<PersistedRepresentation> {
    const documentType = canonicalDocumentType(input.documentKind);
    return this.database.transaction(tenantId, async (client) => {
      await persistArtifact(client, tenantId, input.sourceArtifact);
      for (const artifact of input.outputArtifacts) await persistArtifact(client, tenantId, artifact);
      await client.query(
        `insert into content.document(id,tenant_id,document_type_code,canonical_title,canonical_source_id)
        values($1,$2,$3,$4,$5) on conflict(id) do nothing`,
        [input.documentId, tenantId, documentType, input.canonicalTitle, input.canonicalSourceId],
      );
      const document = (
        await client.query<Row>("select * from content.document where tenant_id=$1 and id=$2", [
          tenantId,
          input.documentId,
        ])
      ).rows[0];
      if (
        !document ||
        String(document.document_type_code) !== documentType ||
        String(document.canonical_title) !== input.canonicalTitle ||
        String(document.canonical_source_id) !== input.canonicalSourceId
      )
        throw new Error("DOCUMENT_IDENTITY_CONFLICT");
      if (input.identifier) {
        await client.query(
          `insert into content.document_identifier(id,tenant_id,document_id,identifier_type,normalized_value,authority)
          values(util.uuidv7(),$1,$2,$3,$4,$5) on conflict(tenant_id,identifier_type,normalized_value) do nothing`,
          [
            tenantId,
            input.documentId,
            input.identifier.type,
            input.identifier.value,
            input.identifier.authority ?? null,
          ],
        );
        const identifier = (
          await client.query<Row>(
            `select document_id from content.document_identifier
          where tenant_id=$1 and identifier_type=$2 and normalized_value=$3`,
            [tenantId, input.identifier.type, input.identifier.value],
          )
        ).rows[0];
        if (!identifier || String(identifier.document_id) !== input.documentId)
          throw new Error("DOCUMENT_IDENTIFIER_CONFLICT");
      }
      await client.query(
        `insert into content.document_version(id,tenant_id,document_id,version_label,manifest_sha256)
        values($1,$2,$3,$4,$5) on conflict(id) do nothing`,
        [input.documentVersionId, tenantId, input.documentId, input.versionLabel, input.manifestDigest.slice(7)],
      );
      const version = (
        await client.query<Row>("select * from content.document_version where tenant_id=$1 and id=$2", [
          tenantId,
          input.documentVersionId,
        ])
      ).rows[0];
      if (
        !version ||
        String(version.document_id) !== input.documentId ||
        String(version.manifest_sha256) !== input.manifestDigest.slice(7)
      )
        throw new Error("DOCUMENT_VERSION_CONFLICT");
      await client.query(
        `insert into content.document_version_source_capture(tenant_id,document_version_id,source_capture_id,capture_role,identity_confidence,resolution_evidence)
        values($1,$2,$3,'primary',1,$4::jsonb) on conflict do nothing`,
        [tenantId, input.documentVersionId, input.sourceCaptureId, JSON.stringify({ deterministic: true })],
      );
      const captureLink = (
        await client.query<Row>(
          `select * from content.document_version_source_capture
        where tenant_id=$1 and document_version_id=$2 and source_capture_id=$3`,
          [tenantId, input.documentVersionId, input.sourceCaptureId],
        )
      ).rows[0];
      if (
        !captureLink ||
        String(captureLink.capture_role) !== "primary" ||
        Number(captureLink.identity_confidence) !== 1 ||
        digestHex(captureLink.resolution_evidence) !== digestHex({ deterministic: true })
      )
        throw new Error("DOCUMENT_CAPTURE_LINK_CONFLICT");
      const parameters = {
        providerKey: input.providerKey,
        providerVersion: input.providerVersion,
        profileDigest: input.profileDigest,
        documentKind: input.documentKind,
        transformationKind: "structural_conversion",
      };
      // Persisted procedure identity; not a filesystem path. Do not rename.
      await client.query(
        `insert into content.transformation_run
        (id,tenant_id,transformation_kind,contract_version,code_ref,provider_route,parameters,parameters_sha256,operation_id,status,idempotency_key,input_manifest_sha256,output_manifest_sha256,receipt,resource_observations,cost_usd,started_at,ended_at)
        values($1,$2,'structural_parse','knowledge.transformation/v1','packages/conversion',$3,$4::jsonb,$5,$6,'succeeded',$7,$8,$9,$10::jsonb,$11::jsonb,0,$12,$12) on conflict(tenant_id,idempotency_key) do nothing`,
        [
          input.transformationRunId,
          tenantId,
          `${input.providerKey}@${input.providerVersion}`,
          JSON.stringify(parameters),
          digestHex(parameters),
          input.operationId,
          `transformation:${input.operationId}`,
          input.sourceArtifact.digest.slice(7),
          digestHex(input.outputArtifacts.map((item) => item.digest)),
          JSON.stringify(input.receipt),
          JSON.stringify({ receiptDigest: input.receiptDigest, nodeCount: input.nodes.length }),
          input.completedAt,
        ],
      );
      const run = (
        await client.query<Row>("select * from content.transformation_run where tenant_id=$1 and idempotency_key=$2", [
          tenantId,
          `transformation:${input.operationId}`,
        ])
      ).rows[0];
      if (
        !run ||
        String(run.id) !== input.transformationRunId ||
        String(run.input_manifest_sha256) !== input.sourceArtifact.digest.slice(7) ||
        String(run.transformation_kind) !== "structural_parse" ||
        String(run.parameters_sha256) !== digestHex(parameters) ||
        String(run.provider_route) !== `${input.providerKey}@${input.providerVersion}` ||
        String(run.output_manifest_sha256) !== digestHex(input.outputArtifacts.map((item) => item.digest))
      )
        throw new Error("TRANSFORMATION_IDEMPOTENCY_CONFLICT");
      await client.query(
        `insert into content.document_representation
        (id,tenant_id,document_version_id,artifact_id,representation_kind,representation_class,media_type,content_sha256,acceptance_state,source_native_byte_identical)
        values($1,$2,$3,$4,'captured_source','source_native',$5,$6,'pending',true) on conflict(id) do nothing`,
        [
          input.sourceNativeRepresentationId,
          tenantId,
          input.documentVersionId,
          input.sourceArtifact.artifactId,
          input.sourceArtifact.mediaType,
          input.sourceArtifact.digest.slice(7),
        ],
      );
      const sourceNative = (
        await client.query<Row>("select * from content.document_representation where tenant_id=$1 and id=$2", [
          tenantId,
          input.sourceNativeRepresentationId,
        ])
      ).rows[0];
      if (
        !sourceNative ||
        String(sourceNative.document_version_id) !== input.documentVersionId ||
        String(sourceNative.artifact_id) !== input.sourceArtifact.artifactId ||
        String(sourceNative.content_sha256) !== input.sourceArtifact.digest.slice(7) ||
        sourceNative.source_native_byte_identical !== true ||
        String(sourceNative.representation_class) !== "source_native"
      )
        throw new Error("SOURCE_NATIVE_REPRESENTATION_CONFLICT");
      await client.query(
        `insert into content.document_representation
        (id,tenant_id,document_version_id,artifact_id,representation_kind,representation_class,media_type,content_sha256,transformation_run_id,acceptance_state,source_native_byte_identical)
        values($1,$2,$3,$4,'structural_document','structural_extraction',$5,$6,$7,'pending',false) on conflict(id) do nothing`,
        [
          input.structuralRepresentationId,
          tenantId,
          input.documentVersionId,
          input.structuralArtifactId,
          input.outputArtifacts.find((item) => item.artifactId === input.structuralArtifactId)?.mediaType ??
            "application/json",
          input.structuralArtifactDigest.slice(7),
          input.transformationRunId,
        ],
      );
      const structural = (
        await client.query<Row>("select * from content.document_representation where tenant_id=$1 and id=$2", [
          tenantId,
          input.structuralRepresentationId,
        ])
      ).rows[0];
      if (
        !structural ||
        String(structural.document_version_id) !== input.documentVersionId ||
        String(structural.artifact_id) !== input.structuralArtifactId ||
        String(structural.content_sha256) !== input.structuralArtifactDigest.slice(7) ||
        String(structural.transformation_run_id) !== input.transformationRunId ||
        String(structural.representation_class) !== "structural_extraction"
      )
        throw new Error("STRUCTURAL_REPRESENTATION_CONFLICT");
      await client.query(
        `insert into content.transformation_input(tenant_id,transformation_run_id,ordinal,role,source_capture_id)
        values($1,$2,0,'source_capture',$3) on conflict do nothing`,
        [tenantId, input.transformationRunId, input.sourceCaptureId],
      );
      await client.query(
        `insert into content.transformation_output(tenant_id,transformation_run_id,ordinal,role,representation_id)
        values($1,$2,0,'structural_representation',$3) on conflict do nothing`,
        [tenantId, input.transformationRunId, input.structuralRepresentationId],
      );
      for (const [ordinal, artifact] of input.outputArtifacts.entries())
        await client.query(
          `insert into content.transformation_output
        (tenant_id,transformation_run_id,ordinal,role,artifact_id) values($1,$2,$3,$4,$5) on conflict do nothing`,
          [tenantId, input.transformationRunId, ordinal + 1, artifact.artifactType, artifact.artifactId],
        );
      for (const artifact of input.outputArtifacts)
        await client.query(
          `insert into orchestration.artifact_lineage
        (tenant_id,from_artifact_id,to_artifact_id,relation_kind,transformation_run_id) values($1,$2,$3,'derived_from',$4) on conflict do nothing`,
          [tenantId, artifact.artifactId, input.sourceArtifact.artifactId, input.transformationRunId],
        );
      const transformationInput = (
        await client.query<Row>(
          `select * from content.transformation_input
        where tenant_id=$1 and transformation_run_id=$2 and ordinal=0`,
          [tenantId, input.transformationRunId],
        )
      ).rows[0];
      if (
        !transformationInput ||
        String(transformationInput.source_capture_id) !== input.sourceCaptureId ||
        String(transformationInput.role) !== "source_capture"
      ) {
        throw new Error("TRANSFORMATION_INPUT_CONFLICT");
      }
      const outputs = (
        await client.query<Row>(
          `select ordinal,role,artifact_id,representation_id from content.transformation_output
        where tenant_id=$1 and transformation_run_id=$2 order by ordinal`,
          [tenantId, input.transformationRunId],
        )
      ).rows;
      const expectedOutputs = [
        {
          ordinal: 0,
          role: "structural_representation",
          artifactId: null,
          representationId: input.structuralRepresentationId,
        },
        ...input.outputArtifacts.map((artifact, index) => ({
          ordinal: index + 1,
          role: artifact.artifactType,
          artifactId: artifact.artifactId,
          representationId: null,
        })),
      ];
      const normalizedOutputs = outputs.map((row) => ({
        ordinal: Number(row.ordinal),
        role: String(row.role),
        artifactId: row.artifact_id ? String(row.artifact_id) : null,
        representationId: row.representation_id ? String(row.representation_id) : null,
      }));
      if (digestHex(normalizedOutputs) !== digestHex(expectedOutputs))
        throw new Error("TRANSFORMATION_OUTPUT_CONFLICT");
      const lineages = (
        await client.query<Row>(
          `select from_artifact_id,to_artifact_id,relation_kind,transformation_run_id from orchestration.artifact_lineage
        where tenant_id=$1 and transformation_run_id=$2 order by from_artifact_id`,
          [tenantId, input.transformationRunId],
        )
      ).rows.map((row) => ({
        fromArtifactId: String(row.from_artifact_id),
        toArtifactId: String(row.to_artifact_id),
        relationKind: String(row.relation_kind),
        runId: String(row.transformation_run_id),
      }));
      const expectedLineages = [
        ...new Map(
          input.outputArtifacts.map((artifact) => [
            artifact.artifactId,
            {
              fromArtifactId: artifact.artifactId,
              toArtifactId: input.sourceArtifact.artifactId,
              relationKind: "derived_from",
              runId: input.transformationRunId,
            },
          ]),
        ).values(),
      ].sort((a, b) => a.fromArtifactId.localeCompare(b.fromArtifactId));
      if (digestHex(lineages) !== digestHex(expectedLineages)) throw new Error("ARTIFACT_LINEAGE_CONFLICT");
      for (const node of input.nodes) {
        const locator = node.locator as Record<string, unknown>;
        await client.query(
          `insert into content.document_node
          (id,tenant_id,representation_id,parent_id,ordinal,stable_local_key,node_kind,role,inline_text,selector,page_number,start_offset,end_offset,bbox,language,normalized_content_sha256)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::jsonb,$15,$16) on conflict(id) do nothing`,
          [
            node.id,
            tenantId,
            input.structuralRepresentationId,
            node.parentId ?? null,
            node.ordinal,
            node.stableLocalKey,
            node.kind,
            node.role ?? null,
            node.text,
            JSON.stringify(locator),
            locator.page ?? null,
            locator.startOffset ?? null,
            locator.endOffset ?? null,
            null,
            node.language ?? null,
            node.digest.slice(7),
          ],
        );
        const stored = (
          await client.query<Row>("select * from content.document_node where tenant_id=$1 and id=$2", [
            tenantId,
            node.id,
          ])
        ).rows[0];
        if (
          !stored ||
          String(stored.representation_id) !== input.structuralRepresentationId ||
          String(stored.normalized_content_sha256) !== node.digest.slice(7)
        )
          throw new Error("DOCUMENT_NODE_CONFLICT");
      }
      const evaluationId = input.transformationRunId;
      await client.query(
        `insert into content.conversion_evaluation
        (id,tenant_id,representation_id,evaluator_identity,procedure_version,conversion_grade,coverage,locator_coverage,findings_sha256,disposition)
        values($1,$2,$3,'knowledge_worker','conversion-inspection/v1',$4,$5,$6,$7,$8) on conflict(id) do nothing`,
        [
          evaluationId,
          tenantId,
          input.structuralRepresentationId,
          input.fidelity.grade,
          input.fidelity.coverage,
          input.fidelity.locatorCoverage,
          digestHex(input.fidelity.findings),
          input.fidelity.grade === "low" ? "quarantine" : "defer",
        ],
      );
      return (await this.#representationByOperation(client, tenantId, input.operationId))!;
    });
  }

  async getRepresentationByOperation(
    tenantId: string,
    operationId: string,
  ): Promise<PersistedRepresentation | undefined> {
    return this.database.transaction(tenantId, (client) =>
      this.#representationByOperation(client, tenantId, operationId),
    );
  }

  async #representationByOperation(
    client: TenantSqlClient,
    tenantId: string,
    operationId: string,
  ): Promise<PersistedRepresentation | undefined> {
    const row = (
      await client.query<Row>(
        `select t.id transformation_run_id,t.operation_id,t.receipt,d.id document_id,dv.id document_version_id,
      sn.id source_native_representation_id,sr.id structural_representation_id,sr.content_sha256 structural_artifact_digest,
      sr.acceptance_state,e.conversion_grade,(select count(*) from content.document_node n where n.tenant_id=sr.tenant_id and n.representation_id=sr.id) node_count
      from content.transformation_run t join content.document_representation sr on sr.tenant_id=t.tenant_id and sr.transformation_run_id=t.id
      join content.document_version dv on dv.tenant_id=sr.tenant_id and dv.id=sr.document_version_id
      join content.document d on d.tenant_id=dv.tenant_id and d.id=dv.document_id
      join content.document_representation sn on sn.tenant_id=dv.tenant_id and sn.document_version_id=dv.id and sn.representation_class='source_native'
      join content.conversion_evaluation e on e.tenant_id=sr.tenant_id and e.representation_id=sr.id
      where t.tenant_id=$1 and t.operation_id=$2 order by t.created_at,t.id limit 1`,
        [tenantId, operationId],
      )
    ).rows[0];
    return row
      ? {
          operationId: String(row.operation_id),
          transformationRunId: String(row.transformation_run_id),
          documentId: String(row.document_id),
          documentVersionId: String(row.document_version_id),
          sourceNativeRepresentationId: String(row.source_native_representation_id),
          structuralRepresentationId: String(row.structural_representation_id),
          structuralArtifactDigest: `sha256:${String(row.structural_artifact_digest)}`,
          nodeCount: Number(row.node_count),
          acceptanceState: String(row.acceptance_state),
          conversionGrade: String(row.conversion_grade),
          receipt: row.receipt,
        }
      : undefined;
  }

  async getRepresentationNodes(
    tenantId: string,
    representationId: string,
  ): Promise<readonly PersistRepresentationInput["nodes"][number][]> {
    return this.database.transaction(tenantId, async (client) =>
      (
        await client.query<Row>(
          `select * from content.document_node
      where tenant_id=$1 and representation_id=$2 order by parent_id nulls first,ordinal,id`,
          [tenantId, representationId],
        )
      ).rows.map((row) => ({
        id: String(row.id),
        tenantId,
        representationId: String(row.representation_id),
        createdAt: iso(row.created_at),
        ...(row.parent_id ? { parentId: String(row.parent_id) } : {}),
        ordinal: Number(row.ordinal),
        stableLocalKey: String(row.stable_local_key),
        kind: String(row.node_kind),
        ...(row.role ? { role: String(row.role) } : {}),
        text: String(row.inline_text ?? ""),
        ...(row.language ? { language: String(row.language) } : {}),
        digest: `sha256:${String(row.normalized_content_sha256)}`,
        locator: row.selector,
      })),
    );
  }

  async persistChunkSet(tenantId: string, input: PersistChunkSetInput): Promise<PersistedChunkSet> {
    return this.database.transaction(tenantId, async (client) => {
      await client.query(
        `insert into retrieval.chunking_procedure_version
        (id,tenant_id,slug,version,supported_content_classes,tokenizer,schema_contract,code_sha256,defaults,limits,status)
        values($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,'admitted') on conflict(tenant_id,slug,version) do nothing`,
        [
          input.procedureVersionId,
          tenantId,
          input.procedureSlug,
          input.procedureVersion,
          JSON.stringify(["structural_extraction"]),
          input.tokenizer,
          // Persisted procedure identity; not a filesystem path. Do not rename.
          JSON.stringify({ schemaVersion: "knowledge.chunk-set/v1" }),
          digestHex("packages/chunking"),
          JSON.stringify(input.profile),
          JSON.stringify({}),
        ],
      );
      const procedure = (
        await client.query<Row>(
          "select * from retrieval.chunking_procedure_version where tenant_id=$1 and slug=$2 and version=$3",
          [tenantId, input.procedureSlug, input.procedureVersion],
        )
      ).rows[0];
      if (
        !procedure ||
        String(procedure.tokenizer) !== input.tokenizer ||
        digestHex(procedure.defaults) !== digestHex(input.profile) ||
        // Persisted procedure identity; not a filesystem path. Do not rename.
        String(procedure.code_sha256) !== digestHex("packages/chunking") ||
        procedure.status !== "admitted"
      )
        throw new Error("CHUNK_PROCEDURE_CONFLICT");
      await client.query(
        `insert into retrieval.chunk_set
        (id,tenant_id,representation_id,procedure_version_id,frozen_config,tokenizer,input_manifest_sha256,output_manifest_sha256,chunk_set_sha256,status)
        values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$8,'succeeded') on conflict(tenant_id,chunk_set_sha256) do nothing`,
        [
          input.chunkSetId,
          tenantId,
          input.representationId,
          String(procedure.id),
          JSON.stringify({ operationId: input.operationId, profile: input.profile }),
          input.tokenizer,
          input.inputDigest.slice(7),
          input.outputDigest.slice(7),
        ],
      );
      const set = (
        await client.query<Row>("select * from retrieval.chunk_set where tenant_id=$1 and chunk_set_sha256=$2", [
          tenantId,
          input.outputDigest.slice(7),
        ])
      ).rows[0];
      if (
        !set ||
        String(set.id) !== input.chunkSetId ||
        String(set.representation_id) !== input.representationId ||
        String(set.input_manifest_sha256) !== input.inputDigest.slice(7)
      )
        throw new Error("CHUNK_SET_CONFLICT");
      for (const chunk of input.chunks) {
        await client.query(
          `insert into retrieval.retrieval_chunk
          (id,tenant_id,chunk_set_id,ordinal,source_text,contextual_prefix,embedding_text,source_text_sha256,contextual_prefix_sha256,embedding_text_sha256,source_token_count,embedding_token_count,retrieval_role,language,promotion_state,lifecycle)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'en','candidate','active') on conflict(id) do nothing`,
          [
            chunk.id,
            tenantId,
            input.chunkSetId,
            chunk.ordinal,
            chunk.sourceText,
            chunk.contextualPrefix,
            chunk.embeddingText,
            chunk.sourceTextDigest.slice(7),
            digestHex(chunk.contextualPrefix),
            chunk.embeddingTextDigest.slice(7),
            chunk.sourceTokenCount,
            chunk.embeddingTokenCount,
            chunk.role,
          ],
        );
        const stored = (
          await client.query<Row>("select * from retrieval.retrieval_chunk where tenant_id=$1 and id=$2", [
            tenantId,
            chunk.id,
          ])
        ).rows[0];
        if (
          !stored ||
          String(stored.chunk_set_id) !== input.chunkSetId ||
          String(stored.embedding_text_sha256) !== chunk.embeddingTextDigest.slice(7)
        )
          throw new Error("CHUNK_IDEMPOTENCY_CONFLICT");
        for (const [ordinal, span] of chunk.spans.entries()) {
          await client.query(
            `insert into retrieval.chunk_span
            (tenant_id,chunk_id,ordinal,document_node_id,start_offset,end_offset,selected_text_sha256)
            values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
            [
              tenantId,
              chunk.id,
              ordinal,
              span.nodeId,
              span.startOffset,
              span.endOffset,
              span.selectedTextDigest.slice(7),
            ],
          );
          const storedSpan = (
            await client.query<Row>(
              `select * from retrieval.chunk_span where tenant_id=$1 and chunk_id=$2 and ordinal=$3`,
              [tenantId, chunk.id, ordinal],
            )
          ).rows[0];
          if (
            !storedSpan ||
            String(storedSpan.document_node_id) !== span.nodeId ||
            Number(storedSpan.start_offset) !== span.startOffset ||
            Number(storedSpan.end_offset) !== span.endOffset ||
            String(storedSpan.selected_text_sha256) !== span.selectedTextDigest.slice(7)
          ) {
            throw new Error("CHUNK_SPAN_CONFLICT");
          }
        }
      }
      return (await this.#chunkSetByOperation(client, tenantId, input.operationId))!;
    });
  }

  async getChunkSetByOperation(tenantId: string, operationId: string): Promise<PersistedChunkSet | undefined> {
    return this.database.transaction(tenantId, (client) => this.#chunkSetByOperation(client, tenantId, operationId));
  }

  async #chunkSetByOperation(
    client: TenantSqlClient,
    tenantId: string,
    operationId: string,
  ): Promise<PersistedChunkSet | undefined> {
    const row = (
      await client.query<Row>(
        `select s.*,
      (select count(*) from retrieval.retrieval_chunk c where c.tenant_id=s.tenant_id and c.chunk_set_id=s.id) chunk_count,
      (select count(*) from retrieval.chunk_span p join retrieval.retrieval_chunk c on c.tenant_id=p.tenant_id and c.id=p.chunk_id where c.tenant_id=s.tenant_id and c.chunk_set_id=s.id) span_count
      from retrieval.chunk_set s where s.tenant_id=$1 and s.frozen_config->>'operationId'=$2 order by s.created_at,s.id limit 1`,
        [tenantId, operationId],
      )
    ).rows[0];
    return row
      ? {
          operationId,
          chunkSetId: String(row.id),
          representationId: String(row.representation_id),
          inputDigest: `sha256:${String(row.input_manifest_sha256)}`,
          outputDigest: `sha256:${String(row.output_manifest_sha256)}`,
          chunkCount: Number(row.chunk_count),
          spanCount: Number(row.span_count),
          status: String(row.status),
        }
      : undefined;
  }
}
