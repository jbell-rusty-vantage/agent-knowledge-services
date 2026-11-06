import { canonicalJson, sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
import type {
  AttachVectorStoreDocumentsInput,
  AttachedVectorStoreDocuments,
  CanonicalVectorStoreResource,
  PersistVectorStoreInput,
  VectorStoreIngestionStage,
  VectorStoreIngestionStageResult,
  VectorStoreLifecycleRepository,
  VerifyVectorStoreIngestionInput,
} from "./types.js";

const databaseStoreClass = {
  official_canonical: "official",
  internal_exploratory: "exploratory",
  user_managed: "user_managed",
} as const;
const contractStoreClass = {
  official: "official_canonical",
  exploratory: "internal_exploratory",
  user_managed: "user_managed",
} as const;

type Row = Record<string, unknown>;

export class PostgresVectorStoreLifecycleRepository implements VectorStoreLifecycleRepository {
  constructor(private readonly database: PostgresCanonicalRepository) {}

  async persistVectorStore(tenantId: string, input: PersistVectorStoreInput): Promise<CanonicalVectorStoreResource> {
    try {
      await this.database.transaction(tenantId, async (client) => {
        await client.query(
          `insert into retrieval.vector_store
          (id,tenant_id,owner_identity,store_class,slug,name,purpose,visibility,quota_profile,retention_policy,deletion_policy,created_by_operation_id,supersedes_id)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13)
          on conflict(tenant_id,created_by_operation_id) do nothing`,
          [
            input.vectorStoreId,
            tenantId,
            input.ownerIdentity,
            databaseStoreClass[input.storeClass],
            input.slug,
            input.name,
            input.purpose,
            input.visibility,
            JSON.stringify(input.quotaProfile),
            JSON.stringify(input.retentionPolicy),
            JSON.stringify(input.deletionPolicy),
            input.operationId,
            input.supersedesId ?? null,
          ],
        );
        const row = (
          await client.query<Row>(
            `select id,owner_identity,store_class,slug,name,purpose,visibility,quota_profile,retention_policy,deletion_policy,
          created_by_operation_id,supersedes_id from retrieval.vector_store where tenant_id=$1 and created_by_operation_id=$2`,
            [tenantId, input.operationId],
          )
        ).rows[0];
        if (!row) throw new Error("VECTOR_STORE_PERSISTENCE_FAILED");
        const actual = {
          vectorStoreId: String(row.id),
          operationId: String(row.created_by_operation_id),
          ownerIdentity: String(row.owner_identity),
          storeClass: String(row.store_class),
          slug: String(row.slug),
          name: String(row.name),
          purpose: String(row.purpose),
          visibility: String(row.visibility),
          quotaProfile: row.quota_profile,
          retentionPolicy: row.retention_policy,
          deletionPolicy: row.deletion_policy,
          supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
        };
        const expected = {
          vectorStoreId: input.vectorStoreId,
          operationId: input.operationId,
          ownerIdentity: input.ownerIdentity,
          storeClass: databaseStoreClass[input.storeClass],
          slug: input.slug,
          name: input.name,
          purpose: input.purpose,
          visibility: input.visibility,
          quotaProfile: input.quotaProfile,
          retentionPolicy: input.retentionPolicy,
          deletionPolicy: input.deletionPolicy,
          supersedesId: input.supersedesId ?? null,
        };
        if (canonicalJson(actual as never) !== canonicalJson(expected as never))
          throw new Error("VECTOR_STORE_REPLAY_CONFLICT");
      });
    } catch (error) {
      if (isPgUniqueViolation(error)) throw new Error("VECTOR_STORE_SLUG_CONFLICT", { cause: error });
      throw error;
    }
    const resource = await this.database.getVectorStoreResource(tenantId, input.vectorStoreId);
    if (!resource) throw new Error("VECTOR_STORE_READBACK_FAILED");
    return resource;
  }

  async attachDocuments(
    tenantId: string,
    input: AttachVectorStoreDocumentsInput,
  ): Promise<AttachedVectorStoreDocuments> {
    if (new Set(input.documents.map((item) => item.documentId)).size !== input.documents.length)
      throw new Error("VECTOR_STORE_DOCUMENT_DUPLICATE");
    return this.database
      .transaction(tenantId, async (client) => {
        const store = (
          await client.query<Row>(
            `select owner_identity,store_class,lifecycle,quota_profile
        from retrieval.vector_store where tenant_id=$1 and id=$2 for update`,
            [tenantId, input.vectorStoreId],
          )
        ).rows[0];
        if (!store) throw new Error("VECTOR_STORE_NOT_FOUND");
        if (String(store.lifecycle) !== "active") throw new Error("VECTOR_STORE_INACTIVE");
        if (String(store.owner_identity) !== input.actorIdentity && !input.controlPlaneOverride)
          throw new Error("VECTOR_STORE_OWNER_MISMATCH");
        if (String(store.store_class) === "official" && !input.controlPlaneOverride)
          throw new Error("CONTROL_PLANE_AUTHORITY_REQUIRED");

        const replayRows = (
          await client.query<Row>(
            `select id,vector_store_id,document_id,document_version_id,representation_id,requested_profile,admission_state
        from retrieval.vector_store_document where tenant_id=$1 and created_by_operation_id=$2 order by document_id`,
            [tenantId, input.operationId],
          )
        ).rows;
        if (replayRows.length > 0) {
          assertExactDocumentReplay(input, replayRows);
          return attachmentResult(input, store);
        }

        const quota = vectorStoreQuota(store.quota_profile);
        const usage = (
          await client.query<Row>(
            `select count(*)::text as document_count,
          coalesce(sum(a.size_bytes),0)::text as total_bytes,
          count(*) filter(where a.size_bytes is null)::text as unknown_byte_count
        from retrieval.vector_store_document vsd
        left join content.document_representation r on r.tenant_id=vsd.tenant_id and r.id=vsd.representation_id
        left join orchestration.artifact a on a.tenant_id=r.tenant_id and a.id=r.artifact_id
        where vsd.tenant_id=$1 and vsd.vector_store_id=$2 and vsd.lifecycle='active'`,
            [tenantId, input.vectorStoreId],
          )
        ).rows[0];
        if (!usage) throw new Error("VECTOR_STORE_USAGE_UNAVAILABLE");
        if (BigInt(String(usage.unknown_byte_count)) > 0n) throw new Error("VECTOR_STORE_BYTE_QUOTA_UNPROVABLE");
        if (BigInt(String(usage.document_count)) + BigInt(input.documents.length) > BigInt(quota.maximumDocuments))
          throw new Error("VECTOR_STORE_DOCUMENT_QUOTA_EXCEEDED");

        let requestedBytes = 0n;
        for (const item of input.documents) {
          const identity = (
            await client.query<Row>(
              `select d.lifecycle as document_lifecycle,dv.document_id,dv.correction_state,
            r.document_version_id,r.acceptance_state,a.size_bytes
          from content.document d
          join content.document_version dv on dv.tenant_id=d.tenant_id and dv.id=$3
          join content.document_representation r on r.tenant_id=d.tenant_id and r.id=$4
          join orchestration.artifact a on a.tenant_id=r.tenant_id and a.id=r.artifact_id
          where d.tenant_id=$1 and d.id=$2`,
              [tenantId, item.documentId, item.documentVersionId, item.representationId],
            )
          ).rows[0];
          if (!identity) throw new Error("VECTOR_STORE_DOCUMENT_IDENTITY_NOT_FOUND");
          if (String(identity.document_id) !== item.documentId)
            throw new Error("VECTOR_STORE_DOCUMENT_VERSION_MISMATCH");
          if (String(identity.document_version_id) !== item.documentVersionId)
            throw new Error("VECTOR_STORE_REPRESENTATION_MISMATCH");
          if (String(identity.document_lifecycle) !== "active") throw new Error("VECTOR_STORE_DOCUMENT_INACTIVE");
          if (String(identity.correction_state) !== "current")
            throw new Error("VECTOR_STORE_DOCUMENT_VERSION_NOT_CURRENT");
          if (String(identity.acceptance_state) !== "accepted")
            throw new Error("VECTOR_STORE_REPRESENTATION_NOT_ACCEPTED");
          if (identity.size_bytes === null || identity.size_bytes === undefined)
            throw new Error("VECTOR_STORE_BYTE_QUOTA_UNPROVABLE");
          requestedBytes += BigInt(String(identity.size_bytes));
          if (BigInt(String(usage.total_bytes)) + requestedBytes > BigInt(quota.maximumBytes))
            throw new Error("VECTOR_STORE_BYTE_QUOTA_EXCEEDED");

          await client.query(
            `insert into retrieval.vector_store_document
          (id,tenant_id,vector_store_id,document_id,document_version_id,representation_id,admission_state,requested_profile,created_by_operation_id)
          values($1,$2,$3,$4,$5,$6,'requested',$7::jsonb,$8)
          on conflict(tenant_id,created_by_operation_id,document_id) do nothing`,
            [
              item.id,
              tenantId,
              input.vectorStoreId,
              item.documentId,
              item.documentVersionId,
              item.representationId,
              JSON.stringify(item.requestedProfile),
              input.operationId,
            ],
          );
        }
        const inserted = (
          await client.query<Row>(
            `select id,vector_store_id,document_id,document_version_id,representation_id,requested_profile,admission_state
        from retrieval.vector_store_document where tenant_id=$1 and created_by_operation_id=$2 order by document_id`,
            [tenantId, input.operationId],
          )
        ).rows;
        assertExactDocumentReplay(input, inserted);
        return attachmentResult(input, store);
      })
      .catch((error) => {
        if (isPgUniqueViolation(error)) throw new Error("VECTOR_STORE_DOCUMENT_CONFLICT", { cause: error });
        throw error;
      });
  }

  async verifyIngestionStage(
    tenantId: string,
    input: VerifyVectorStoreIngestionInput,
    stage: VectorStoreIngestionStage,
  ): Promise<VectorStoreIngestionStageResult> {
    if (new Set(input.chains.map((chain) => chain.attachmentId)).size !== input.chains.length)
      throw new Error("VECTOR_STORE_INGESTION_DUPLICATE_ATTACHMENT");
    return this.database.transaction(tenantId, async (client) => {
      const store = (
        await client.query<Row>(
          `select owner_identity,store_class,lifecycle from retrieval.vector_store
        where tenant_id=$1 and id=$2 for update`,
          [tenantId, input.vectorStoreId],
        )
      ).rows[0];
      if (!store) throw new Error("VECTOR_STORE_NOT_FOUND");
      if (String(store.lifecycle) !== "active") throw new Error("VECTOR_STORE_INACTIVE");
      if (String(store.owner_identity) !== input.actorIdentity && !input.controlPlaneOverride)
        throw new Error("VECTOR_STORE_OWNER_MISMATCH");
      if (String(store.store_class) === "official" && !input.controlPlaneOverride)
        throw new Error("CONTROL_PLANE_AUTHORITY_REQUIRED");

      const manifest = {
        vectorStoreId: input.vectorStoreId,
        actorIdentity: input.actorIdentity,
        controlPlaneOverride: input.controlPlaneOverride,
        requestDigest: input.requestDigest,
        chains: input.chains,
      };
      await client.query(
        `insert into retrieval.vector_store_ingestion_run
        (id,tenant_id,operation_id,vector_store_id,actor_identity,request_sha256,manifest)
        values($1,$2,$3,$4,$5,$6,$7::jsonb) on conflict(tenant_id,operation_id) do nothing`,
        [
          input.ingestionRunId,
          tenantId,
          input.operationId,
          input.vectorStoreId,
          input.actorIdentity,
          input.requestDigest.slice(7),
          JSON.stringify(manifest),
        ],
      );
      const run = (
        await client.query<Row>(
          `select id,vector_store_id,actor_identity,request_sha256,manifest
        from retrieval.vector_store_ingestion_run where tenant_id=$1 and operation_id=$2`,
          [tenantId, input.operationId],
        )
      ).rows[0];
      const actualRun = run
        ? {
            vectorStoreId: String(run.vector_store_id),
            actorIdentity: String(run.actor_identity),
            requestDigest: `sha256:${String(run.request_sha256)}`,
            manifest: run.manifest,
          }
        : null;
      const expectedRun = {
        vectorStoreId: input.vectorStoreId,
        actorIdentity: input.actorIdentity,
        requestDigest: input.requestDigest,
        manifest,
      };
      if (
        !run ||
        String(run.id) !== input.ingestionRunId ||
        canonicalJson(actualRun as never) !== canonicalJson(expectedRun as never)
      )
        throw new Error("VECTOR_STORE_INGESTION_REPLAY_CONFLICT");

      const replayCheckpoint = (
        await client.query<Row>(
          `select evidence_sha256,evidence from retrieval.vector_store_ingestion_checkpoint
        where tenant_id=$1 and ingestion_run_id=$2 and stage=$3`,
          [tenantId, input.ingestionRunId, stage],
        )
      ).rows[0];
      if (replayCheckpoint) {
        const expectedEvidence = ingestionEvidence(input, stage),
          expectedDigest = sha256Digest(expectedEvidence as never);
        if (
          String(replayCheckpoint.evidence_sha256) !== expectedDigest.slice(7) ||
          canonicalJson(replayCheckpoint.evidence as never) !== canonicalJson(expectedEvidence as never)
        )
          throw new Error("VECTOR_STORE_INGESTION_CHECKPOINT_CONFLICT");
        if (stage === "indexed") await assertAttachmentsIndexed(client, tenantId, input);
        return {
          schemaVersion: "knowledge.vector-store-ingestion-stage/v1",
          ingestionRunId: input.ingestionRunId,
          vectorStoreId: input.vectorStoreId,
          stage,
          attachmentCount: input.chains.length,
          evidenceDigest: expectedDigest,
        };
      }

      const evidence: Row[] = [];
      for (const chain of input.chains) {
        await assertSucceededOperation(client, tenantId, chain.transformationOperationId, "transformation");
        await assertSucceededOperation(client, tenantId, chain.chunkSetOperationId, "chunk_set");
        await assertSucceededOperation(client, tenantId, chain.promotionProposalOperationId, "promotion_proposal");
        await assertSucceededOperation(client, tenantId, chain.promotionDecisionOperationId, "promotion_decision");
        const prepared = (
          await client.query<Row>(
            `select vsd.representation_id,t.operation_id transformation_operation_id,
            cs.id chunk_set_id,cs.frozen_config->>'operationId' chunk_operation_id,cs.status chunk_status,
            p.id proposal_id,p.operation_id proposal_operation_id,p.chunk_manifest->>'chunkSetId' proposal_chunk_set_id,
            d.id decision_id,d.decision_operation_id,d.decision,d.expires_at
          from retrieval.vector_store_document vsd
          join content.document_representation r on r.tenant_id=vsd.tenant_id and r.id=vsd.representation_id and r.acceptance_state='accepted'
          join content.transformation_run t on t.tenant_id=r.tenant_id and t.id=r.transformation_run_id
          join retrieval.chunk_set cs on cs.tenant_id=r.tenant_id and cs.representation_id=r.id
          join retrieval.content_promotion_proposal p on p.tenant_id=cs.tenant_id
          join retrieval.content_promotion_decision d on d.tenant_id=p.tenant_id and d.proposal_id=p.id
          where vsd.tenant_id=$1 and vsd.vector_store_id=$2 and vsd.id=$3 and vsd.lifecycle='active'
            and t.operation_id=$4 and cs.id=$5 and cs.frozen_config->>'operationId'=$6
            and p.id=$7 and p.operation_id=$8 and p.chunk_manifest->>'chunkSetId'=$5::text
            and d.id=$9 and d.decision_operation_id=$10`,
            [
              tenantId,
              input.vectorStoreId,
              chain.attachmentId,
              chain.transformationOperationId,
              chain.chunkSetId,
              chain.chunkSetOperationId,
              chain.promotionProposalId,
              chain.promotionProposalOperationId,
              chain.promotionDecisionId,
              chain.promotionDecisionOperationId,
            ],
          )
        ).rows[0];
        if (!prepared) throw new Error("VECTOR_STORE_INGESTION_PREPARATION_MISMATCH");
        if (String(prepared.chunk_status) !== "succeeded")
          throw new Error("VECTOR_STORE_INGESTION_CHUNK_SET_INCOMPLETE");
        if (
          String(prepared.decision) !== "accept" ||
          (prepared.expires_at && new Date(String(prepared.expires_at)).getTime() <= Date.now())
        )
          throw new Error("VECTOR_STORE_INGESTION_PROMOTION_NOT_ACCEPTED");

        if (stage !== "prepared") {
          await assertSucceededOperation(client, tenantId, chain.embeddingOperationId, "embedding_run");
          const embedded = (
            await client.query<Row>(
              `select er.id,er.vector_space_version_id,er.output_manifest_sha256,er.status,
              count(ei.*)::text item_count,count(ei.*) filter(where ei.status='succeeded')::text succeeded_count,
              count(*) filter(where not (p.projection_manifest->'projectionIds') ? ei.search_projection_id::text)::text unexpected_count,
              jsonb_array_length(p.projection_manifest->'projectionIds')::text expected_count
            from retrieval.embedding_run er
            join retrieval.content_promotion_proposal p on p.tenant_id=er.tenant_id and p.id=$7
            left join retrieval.embedding_item ei on ei.tenant_id=er.tenant_id and ei.embedding_run_id=er.id
            where er.tenant_id=$1 and er.id=$2 and er.operation_id=$3 and er.promotion_decision_id=$4
              and p.operation_id=$5 and p.chunk_manifest->>'chunkSetId'=$6::text
            group by er.id,p.projection_manifest`,
              [
                tenantId,
                chain.embeddingRunId,
                chain.embeddingOperationId,
                chain.promotionDecisionId,
                chain.promotionProposalOperationId,
                chain.chunkSetId,
                chain.promotionProposalId,
              ],
            )
          ).rows[0];
          if (!embedded || String(embedded.status) !== "succeeded" || !embedded.output_manifest_sha256)
            throw new Error("VECTOR_STORE_INGESTION_EMBEDDING_INCOMPLETE");
          if (
            String(embedded.item_count) !== String(embedded.expected_count) ||
            String(embedded.succeeded_count) !== String(embedded.expected_count) ||
            String(embedded.unexpected_count) !== "0"
          )
            throw new Error("VECTOR_STORE_INGESTION_EMBEDDING_COVERAGE_MISMATCH");

          if (stage === "indexed") {
            await assertSucceededOperation(client, tenantId, chain.publicationOperationId, "space_publication");
            const indexed = (
              await client.query<Row>(
                `select pub.id,pub.vector_space_version_id,pub.expected_item_count,
                count(distinct ei.id)::text item_count,count(distinct vi.id)::text vector_count,
                count(distinct pe.vector_item_id)::text physical_count
              from retrieval.space_publication pub
              join retrieval.vector_store_space vss on vss.tenant_id=pub.tenant_id and vss.id=pub.vector_store_space_id
                and vss.vector_store_id=$2 and vss.active_space_version_id=pub.vector_space_version_id
              join retrieval.embedding_run er on er.tenant_id=pub.tenant_id and er.id=$3
                and er.vector_space_version_id=pub.vector_space_version_id
              join retrieval.embedding_item ei on ei.tenant_id=er.tenant_id and ei.embedding_run_id=er.id
              left join retrieval.vector_item vi on vi.tenant_id=ei.tenant_id and vi.embedding_item_id=ei.id and vi.space_version_id=pub.vector_space_version_id
              left join retrieval.vector_item_embedding_1536 pe on pe.tenant_id=vi.tenant_id and pe.vector_item_id=vi.id
                and pe.vector_space_version_id=pub.vector_space_version_id
              where pub.tenant_id=$1 and pub.id=$4 and pub.operation_id=$5 and pub.publication_decision_id=$6 and pub.status='published'
              group by pub.id`,
                [
                  tenantId,
                  input.vectorStoreId,
                  chain.embeddingRunId,
                  chain.publicationId,
                  chain.publicationOperationId,
                  chain.promotionDecisionId,
                ],
              )
            ).rows[0];
            if (!indexed) throw new Error("VECTOR_STORE_INGESTION_PUBLICATION_NOT_ACTIVE");
            if (
              BigInt(String(indexed.item_count)) < 1n ||
              String(indexed.item_count) !== String(indexed.expected_item_count) ||
              String(indexed.item_count) !== String(indexed.vector_count) ||
              String(indexed.item_count) !== String(indexed.physical_count)
            )
              throw new Error("VECTOR_STORE_INGESTION_INDEX_COVERAGE_MISMATCH");
          }
        }
        evidence.push({
          attachmentId: chain.attachmentId,
          chunkSetId: chain.chunkSetId,
          promotionDecisionId: chain.promotionDecisionId,
          ...(stage !== "prepared" ? { embeddingRunId: chain.embeddingRunId } : {}),
          ...(stage === "indexed" ? { publicationId: chain.publicationId } : {}),
        });
      }

      const expectedEvidence = ingestionEvidence(input, stage);
      if (canonicalJson(evidence as never) !== canonicalJson(expectedEvidence as never))
        throw new Error("VECTOR_STORE_INGESTION_EVIDENCE_CONFLICT");
      const evidenceDigest = sha256Digest(expectedEvidence as never);
      const checkpointId = deterministicUuid("vector-store-ingestion-checkpoint", `${input.ingestionRunId}:${stage}`);
      await client.query(
        `insert into retrieval.vector_store_ingestion_checkpoint
        (id,tenant_id,ingestion_run_id,stage,evidence_sha256,evidence) values($1,$2,$3,$4,$5,$6::jsonb)
        on conflict(tenant_id,ingestion_run_id,stage) do nothing`,
        [
          checkpointId,
          tenantId,
          input.ingestionRunId,
          stage,
          evidenceDigest.slice(7),
          JSON.stringify(expectedEvidence),
        ],
      );
      const checkpoint = (
        await client.query<Row>(
          `select id,evidence_sha256,evidence from retrieval.vector_store_ingestion_checkpoint
        where tenant_id=$1 and ingestion_run_id=$2 and stage=$3`,
          [tenantId, input.ingestionRunId, stage],
        )
      ).rows[0];
      if (
        !checkpoint ||
        String(checkpoint.id) !== checkpointId ||
        String(checkpoint.evidence_sha256) !== evidenceDigest.slice(7) ||
        canonicalJson(checkpoint.evidence as never) !== canonicalJson(expectedEvidence as never)
      )
        throw new Error("VECTOR_STORE_INGESTION_CHECKPOINT_CONFLICT");
      if (stage === "indexed")
        await client.query(
          `update retrieval.vector_store_document set admission_state='indexed'
        where tenant_id=$1 and vector_store_id=$2 and id=any($3::uuid[])`,
          [tenantId, input.vectorStoreId, input.chains.map((chain) => chain.attachmentId)],
        );
      if (stage === "indexed") await assertAttachmentsIndexed(client, tenantId, input);
      return {
        schemaVersion: "knowledge.vector-store-ingestion-stage/v1",
        ingestionRunId: input.ingestionRunId,
        vectorStoreId: input.vectorStoreId,
        stage,
        attachmentCount: input.chains.length,
        evidenceDigest,
      };
    });
  }
}

async function assertSucceededOperation(
  client: TenantSqlClient,
  tenantId: string,
  operationId: string,
  kind: string,
): Promise<void> {
  const row = (
    await client.query<Row>(
      `select o.status,exists(select 1 from knowledge_service.receipt r
      where r.tenant_id=o.tenant_id and r.operation_id=o.id and r.outcome='succeeded') has_receipt
    from knowledge_service.operation o where o.tenant_id=$1 and o.id=$2 and o.operation_kind=$3`,
      [tenantId, operationId, kind],
    )
  ).rows[0];
  if (!row) throw new Error("VECTOR_STORE_INGESTION_OPERATION_MISMATCH");
  if (String(row.status) !== "succeeded" || row.has_receipt !== true)
    throw new Error("VECTOR_STORE_INGESTION_PREREQUISITE_INCOMPLETE");
}

function ingestionEvidence(input: VerifyVectorStoreIngestionInput, stage: VectorStoreIngestionStage): Row[] {
  return input.chains.map((chain) => ({
    attachmentId: chain.attachmentId,
    chunkSetId: chain.chunkSetId,
    promotionDecisionId: chain.promotionDecisionId,
    ...(stage !== "prepared" ? { embeddingRunId: chain.embeddingRunId } : {}),
    ...(stage === "indexed" ? { publicationId: chain.publicationId } : {}),
  }));
}

async function assertAttachmentsIndexed(
  client: TenantSqlClient,
  tenantId: string,
  input: VerifyVectorStoreIngestionInput,
): Promise<void> {
  const row = (
    await client.query<Row>(
      `select count(*)::text matched from retrieval.vector_store_document
    where tenant_id=$1 and vector_store_id=$2 and id=any($3::uuid[]) and admission_state='indexed' and lifecycle='active'`,
      [tenantId, input.vectorStoreId, input.chains.map((chain) => chain.attachmentId)],
    )
  ).rows[0];
  if (!row || String(row.matched) !== String(input.chains.length))
    throw new Error("VECTOR_STORE_INGESTION_INDEX_STATE_MISMATCH");
}

function vectorStoreQuota(value: unknown): { maximumDocuments: number; maximumBytes: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("VECTOR_STORE_QUOTA_INVALID");
  const record = value as Record<string, unknown>,
    maximumDocuments = record.maximumDocuments,
    maximumBytes = record.maximumBytes;
  if (
    !Number.isSafeInteger(maximumDocuments) ||
    Number(maximumDocuments) < 1 ||
    !Number.isSafeInteger(maximumBytes) ||
    Number(maximumBytes) < 1
  )
    throw new Error("VECTOR_STORE_QUOTA_INVALID");
  return { maximumDocuments: Number(maximumDocuments), maximumBytes: Number(maximumBytes) };
}

function assertExactDocumentReplay(input: AttachVectorStoreDocumentsInput, rows: readonly Row[]): void {
  const expected = input.documents
    .map((item) => ({
      id: item.id,
      vectorStoreId: input.vectorStoreId,
      documentId: item.documentId,
      documentVersionId: item.documentVersionId,
      representationId: item.representationId,
      requestedProfile: item.requestedProfile,
      admissionState: "requested",
    }))
    .sort((left, right) => left.documentId.localeCompare(right.documentId));
  const actual = rows.map((row) => ({
    id: String(row.id),
    vectorStoreId: String(row.vector_store_id),
    documentId: String(row.document_id),
    documentVersionId: String(row.document_version_id),
    representationId: String(row.representation_id),
    requestedProfile: row.requested_profile,
    admissionState: String(row.admission_state),
  }));
  if (canonicalJson(actual as never) !== canonicalJson(expected as never))
    throw new Error("VECTOR_STORE_DOCUMENT_REPLAY_CONFLICT");
}

function attachmentResult(input: AttachVectorStoreDocumentsInput, store: Row): AttachedVectorStoreDocuments {
  const storeClass = contractStoreClass[String(store.store_class) as keyof typeof contractStoreClass];
  if (!storeClass) throw new Error("VECTOR_STORE_CLASS_INVALID");
  return {
    vectorStoreId: input.vectorStoreId,
    storeClass,
    ownerIdentity: String(store.owner_identity),
    documentIds: input.documents.map((item) => item.documentId),
    attachmentIds: input.documents.map((item) => item.id),
    attachmentCount: input.documents.length,
    state: "requested",
  };
}

function isPgUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505",
  );
}
