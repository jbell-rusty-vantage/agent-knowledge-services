import { sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import type { PostgresCanonicalRepository } from "./postgres.js";

export interface ExploratoryFixtureRecord {
  readonly sourceRecordId: string;
  readonly projectionId: string;
  readonly text: string;
  readonly embedding: readonly number[];
  readonly videoId: string;
  readonly claimId: string;
  readonly freshnessAt: string;
}

export interface ExploratoryArtifactReference {
  readonly videoId: string;
  readonly artifactId: string;
  readonly digest: string;
  readonly storageBucket: string;
  readonly objectPath: string;
}

export interface StageExploratoryVersionInput {
  readonly namespace: string;
  readonly tenantId: string;
  readonly version: number;
  readonly records: readonly ExploratoryFixtureRecord[];
  readonly artifacts: readonly ExploratoryArtifactReference[];
  readonly reason: string;
  readonly proposedBy: string;
  readonly reviewerIdentity: string;
  readonly rebuildOfReceiptId?: string;
}

export interface StagedExploratoryVersion {
  readonly version: number;
  readonly vectorSpaceVersionId: string;
  readonly vectorStoreSpaceId: string;
  readonly publicationId: string;
  readonly guardedSha256: string;
  readonly expectedItemCount: number;
  readonly vectorItemManifestSha256: string;
  readonly embeddingManifestSha256: string;
  readonly indexManifestSha256: string;
}

const hexDigest = (value: unknown) => sha256Digest(JSON.parse(JSON.stringify(value))).slice(7);
const id = (namespace: string, key: string) =>
  deterministicUuid("canonical-exploratory-fixture", `${namespace}:${key}`);
const vectorText = (vector: readonly number[]) => `[${vector.join(",")}]`;

/**
 * Deterministic, idempotent local fixture loader for the three admitted
 * internal_exploratory bundles. This deliberately maps to the canonical
 * `exploratory` authority class and cannot create an official store.
 */
export async function stageExploratoryVersion(
  database: PostgresCanonicalRepository,
  input: StageExploratoryVersionInput,
): Promise<StagedExploratoryVersion> {
  if (input.records.length !== 41 || new Set(input.records.map((item) => item.videoId)).size !== 3)
    throw new Error("EXACT_THREE_BUNDLE_FIXTURE_REQUIRED");
  if (input.records.some((item) => item.embedding.length !== 1_536)) throw new Error("INVALID_EMBEDDING_DIMENSIONS");
  if (!input.namespace.trim() || input.version < 1 || !Number.isInteger(input.version))
    throw new Error("INVALID_FIXTURE_VERSION");

  const missionId = id(input.namespace, "mission");
  const workItemId = id(input.namespace, "work-item");
  const attemptId = id(input.namespace, "attempt");
  const procedureId = id(input.namespace, "projection-procedure");
  const vectorSpaceId = id(input.namespace, "vector-space");
  const vectorSpaceVersionId = id(input.namespace, `vector-space-version:${input.version}`);
  const vectorStoreId = id(input.namespace, "vector-store");
  const vectorStoreSpaceId = id(input.namespace, "vector-store-space");
  const datasetId = id(input.namespace, "eval-dataset");
  const evalRunId = id(input.namespace, `eval-run:${input.version}`);
  const gateVersionId = id(input.namespace, "gate-version");
  const gateResultId = id(input.namespace, `gate-result:${input.version}`);
  const proposalId = id(input.namespace, `promotion-proposal:${input.version}`);
  const decisionId = id(input.namespace, `promotion-decision:${input.version}`);
  const publicationId = id(input.namespace, `publication:${input.version}`);
  const proposalOperationId = id(input.namespace, `promotion-proposal-operation:${input.version}`);
  const decisionOperationId = id(input.namespace, `promotion-decision-operation:${input.version}`);
  const publicationOperationId = id(input.namespace, `publication-operation:${input.version}`);
  const reviewSubjectId = id(input.namespace, `promotion-review-subject:${input.version}`);
  const knowledgeReviewDecisionId = id(input.namespace, `promotion-review-decision:${input.version}`);
  const retrievalPolicyId = id(input.namespace, "retrieval-policy");
  const retrievalPolicyVersionId = id(input.namespace, "retrieval-policy-version:1");
  const vectorItems = input.records.map((record) => ({
    ...record,
    vectorItemId: id(input.namespace, `vector-item:${input.version}:${record.sourceRecordId}`),
  }));
  const vectorItemManifestSha256 = hexDigest(
    vectorItems.map((item) => ({
      id: item.vectorItemId,
      projectionId: item.projectionId,
      content: hexDigest(item.text),
    })),
  );
  const embeddingManifestSha256 = hexDigest(
    vectorItems.map((item) => ({ id: item.vectorItemId, embedding: hexDigest(item.embedding) })),
  );
  const indexManifestSha256 = hexDigest({
    backend: "pgvector-hnsw-halfvec",
    version: input.version,
    count: vectorItems.length,
  });
  const proposal = {
    storeClass: "internal_exploratory",
    canonicalStoreClass: "exploratory",
    fixture: "embedding-bundle-seed-2026-09-01",
    version: input.version,
    artifacts: input.artifacts,
    vectorItemManifestSha256,
    embeddingManifestSha256,
    indexManifestSha256,
    ...(input.rebuildOfReceiptId ? { rebuildOfReceiptId: input.rebuildOfReceiptId } : {}),
  };
  const guardedSha256 = hexDigest(proposal);

  await database.transaction(input.tenantId, async (client) => {
    await client.query(
      `insert into knowledge_service.operation
      (id,tenant_id,operation_kind,idempotency_key,correlation_id,actor_identity,request,request_sha256)
      values
      ($1,$2,'promotion_proposal',$3,$4,$5,$6::jsonb,$7),
      ($8,$2,'promotion_decision',$9,$4,$10,$11::jsonb,$12),
      ($13,$2,'space_publication',$14,$4,$15,$16::jsonb,$17)
      on conflict(id) do nothing`,
      [
        proposalOperationId,
        input.tenantId,
        `fixture:${input.namespace}:proposal:${input.version}`,
        missionId,
        input.proposedBy,
        JSON.stringify({ fixture: true, kind: "promotion_proposal", version: input.version }),
        hexDigest({ fixture: true, kind: "promotion_proposal", version: input.version }),
        decisionOperationId,
        `fixture:${input.namespace}:decision:${input.version}`,
        input.reviewerIdentity,
        JSON.stringify({ fixture: true, kind: "promotion_decision", version: input.version }),
        hexDigest({ fixture: true, kind: "promotion_decision", version: input.version }),
        publicationOperationId,
        `fixture:${input.namespace}:publication:${input.version}`,
        `control-plane:${input.namespace}`,
        JSON.stringify({ fixture: true, kind: "space_publication", version: input.version }),
        hexDigest({ fixture: true, kind: "space_publication", version: input.version }),
      ],
    );
    await client.query(
      "insert into orchestration.mission(id,tenant_id,goal) values($1,$2,$3) on conflict(id) do nothing",
      [missionId, input.tenantId, "Gate 6 local canonical durability fixture"],
    );
    await client.query(
      "insert into orchestration.work_item(id,tenant_id,mission_id,kind) values($1,$2,$3,'build_vectors') on conflict(id) do nothing",
      [workItemId, input.tenantId, missionId],
    );
    await client.query(
      "insert into orchestration.attempt(id,tenant_id,work_item_id,attempt_no,agent_deployment_id) values($1,$2,$3,1,$4) on conflict(id) do nothing",
      [attemptId, input.tenantId, workItemId, "knowledge-persistence-local-proof"],
    );
    await client.query(
      `insert into retrieval.projection_procedure(id,slug,version,description,code_ref,implementation_sha256)
      values($1,$2,1,$3,$4,$5) on conflict(id) do nothing`,
      [
        procedureId,
        `${input.namespace}-engineering-claims`,
        `Deterministic engineering-claim fixture projection`,
        `packages/application/src/preparation.ts`,
        hexDigest("engineering-claims-procedure-v1"),
      ],
    );
    await client.query(
      "insert into retrieval.vector_space(id,tenant_id,slug,purpose,class) values($1,$2,$3,$4,'exploratory') on conflict(id) do nothing",
      [
        vectorSpaceId,
        input.tenantId,
        `${input.namespace}-engineering-guidance`,
        `Maintained DoD engineering guidance query`,
      ],
    );
    await client.query(
      `insert into retrieval.vector_space_version
      (id,tenant_id,vector_space_id,version,embedding_model,dims,projection_procedure_id,backend,precision,index_configuration,provider_routing_policy)
      values($1,$2,$3,$4,'deterministic-fake/local-proof',1536,$5,'pgvector','halfvec',$6::jsonb,$7::jsonb) on conflict(id) do nothing`,
      [
        vectorSpaceVersionId,
        input.tenantId,
        vectorSpaceId,
        input.version,
        procedureId,
        JSON.stringify({ type: "hnsw", operator: "halfvec_cosine_ops" }),
        JSON.stringify({ localOnly: true }),
      ],
    );
    await client.query(
      `insert into retrieval.vector_store
      (id,tenant_id,owner_identity,store_class,slug,name,purpose,visibility,quota_profile,retention_policy,deletion_policy)
      values($1,$2,$3,'exploratory',$4,$5,$6,'internal',$7::jsonb,$8::jsonb,$9::jsonb) on conflict(id) do nothing`,
      [
        vectorStoreId,
        input.tenantId,
        input.proposedBy,
        `${input.namespace}-three-bundle`,
        `Gate 6 three-bundle exploratory store`,
        `Local durability and recovery proof`,
        JSON.stringify({ maximumItems: 100 }),
        JSON.stringify({ policy: "proof-retained" }),
        JSON.stringify({ mode: "tenant_scoped_explicit" }),
      ],
    );
    await client.query(
      "insert into retrieval.retrieval_policy(id,tenant_id,slug,purpose,lifecycle) values($1,$2,$3,$4,'active') on conflict(id) do nothing",
      [
        retrievalPolicyId,
        input.tenantId,
        `${input.namespace}-api-retrieval`,
        `Bounded local exploratory hybrid retrieval`,
      ],
    );
    await client.query(
      `insert into retrieval.retrieval_policy_version(id,tenant_id,retrieval_policy_id,version,policy,policy_schema,policy_sha256,status)
      values($1,$2,$3,1,$4::jsonb,$5::jsonb,$6,'active') on conflict(id) do nothing`,
      [
        retrievalPolicyVersionId,
        input.tenantId,
        retrievalPolicyId,
        JSON.stringify({
          admittedSpaces: [
            "engineering_claims",
            "tool_capabilities",
            "implementation_examples",
            "paper_case_study_knowledge",
            "entity_profiles",
            "model_capabilities",
            "benchmark_intelligence",
            "source_native_sections",
          ],
          allowedFilterFields: [
            "language",
            "visibility",
            "classification",
            "source_kind",
            "authority_level",
            "freshness_after",
          ],
          allowedVisibilities: ["internal"],
          maxCandidateK: 100,
          maxFinalK: 20,
          rrfK: 60,
          minimumCoverage: 0,
          providerRoute: ["local-proof"],
          maximumRerankCandidates: 20,
          maxPerSource: 3,
          contextRadius: 0,
        }),
        JSON.stringify({ schemaVersion: "retrieval-runtime-policy/v1" }),
        hexDigest({ namespace: input.namespace, version: 1 }),
      ],
    );
    await client.query(
      `insert into retrieval.vector_store_space(id,tenant_id,vector_store_id,vector_space_id,authority_class)
      values($1,$2,$3,$4,'exploratory') on conflict(id) do nothing`,
      [vectorStoreSpaceId, input.tenantId, vectorStoreId, vectorSpaceId],
    );

    for (const item of vectorItems) {
      const claimRecordId = id(input.namespace, `claim:${item.sourceRecordId}`);
      const targetId = id(input.namespace, `projection-target:${item.sourceRecordId}`);
      await client.query(
        `insert into evidence.claim(id,tenant_id,claim_type,statement,structured,status,producer_attempt_id)
        values($1,$2,'recommendation',$3,$4::jsonb,'proposed',$5) on conflict(id) do nothing`,
        [
          claimRecordId,
          input.tenantId,
          item.text,
          JSON.stringify({ fixtureClaimId: item.claimId, videoId: item.videoId, storeClass: "internal_exploratory" }),
          attemptId,
        ],
      );
      await client.query(
        `insert into retrieval.projection_target(id,tenant_id,target_kind,schema_version,canonical_table,canonical_record_id,eligibility_validator)
        values($1,$2,'claim',1,'evidence.claim',$3,'util.current_tenant_id()') on conflict(id) do nothing`,
        [targetId, input.tenantId, claimRecordId],
      );
      const artifact = input.artifacts.find((candidate) => candidate.videoId === item.videoId);
      if (!artifact) throw new Error(`FIXTURE_ARTIFACT_NOT_FOUND:${item.videoId}`);
      const documentId = id(input.namespace, `document:${artifact.videoId}`),
        documentVersionId = id(input.namespace, `document-version:${input.version}:${artifact.videoId}`),
        representationId = id(input.namespace, `representation:${input.version}:${artifact.videoId}`),
        nodeId = id(input.namespace, `node:${input.version}:${item.sourceRecordId}`);
      await client.query(
        "insert into content.document(id,tenant_id,document_kind,canonical_title) values($1,$2,'research_bundle',$3) on conflict(id) do nothing",
        [documentId, input.tenantId, `Exploratory bundle ${artifact.videoId}`],
      );
      await client.query(
        "insert into content.document_version(id,tenant_id,document_id,version_label,manifest_sha256) values($1,$2,$3,$4,$5) on conflict(id) do nothing",
        [documentVersionId, input.tenantId, documentId, `fixture-v${input.version}`, artifact.digest.slice(7)],
      );
      await client.query(
        `insert into content.document_representation(id,tenant_id,document_version_id,artifact_id,representation_kind,representation_class,media_type,content_sha256,acceptance_state,source_native_byte_identical)
        values($1,$2,$3,$4,'json','source_native','application/json',$5,'accepted',true) on conflict(id) do nothing`,
        [representationId, input.tenantId, documentVersionId, artifact.artifactId, artifact.digest.slice(7)],
      );
      await client.query(
        `insert into content.document_node(id,tenant_id,representation_id,ordinal,stable_local_key,node_kind,inline_text,start_offset,end_offset,normalized_content_sha256)
        values($1,$2,$3,$4,$5,'paragraph',$6,0,$7,$8) on conflict(id) do nothing`,
        [
          nodeId,
          input.tenantId,
          representationId,
          vectorItems.indexOf(item),
          `claim:${item.sourceRecordId}`,
          item.text,
          Math.max(1, item.text.length),
          hexDigest(item.text),
        ],
      );
      await client.query(
        `insert into retrieval.search_projection
        (id,tenant_id,projection_target_id,projection_procedure_id,purpose,source_text,embedding_text,source_text_sha256,contextual_prefix_sha256,embedding_text_sha256,support_manifest,language,content_kind,visibility,classification,promotion_state,generator_identity,prompt_schema_version)
        values($1,$2,$3,$4,'engineering_guidance',$5,$5,$6,$7,$6,$8::jsonb,'en','engineering_claim','internal','internal','candidate',$9,'fixture-v1') on conflict(id) do nothing`,
        [
          item.projectionId,
          input.tenantId,
          targetId,
          procedureId,
          item.text,
          hexDigest(item.text),
          hexDigest(""),
          JSON.stringify([{ artifactIds: [artifact.artifactId], representationId, nodeId, videoId: item.videoId }]),
          input.proposedBy,
        ],
      );
      await client.query(
        `insert into retrieval.vector_item
        (id,tenant_id,space_version_id,claim_id,search_projection_id,content_sha256,backend_location,verification_state,language,visibility,classification,lifecycle,authority_level,freshness_at,search_text)
        values($1,$2,$3,$4,$5,$6,'pgvector:halfvec1536','verified','en','internal','internal','active','exploratory',$7,$8) on conflict(id) do nothing`,
        [
          item.vectorItemId,
          input.tenantId,
          vectorSpaceVersionId,
          claimRecordId,
          item.projectionId,
          hexDigest(item.text),
          item.freshnessAt,
          item.text,
        ],
      );
      await client.query(
        `insert into retrieval.vector_item_embedding_1536
        (tenant_id,vector_space_key,vector_space_version_id,vector_item_id,embedding,embedding_sha256)
        values($1,$2,$3,$4,$5::extensions.halfvec(1536),$6) on conflict(vector_space_key,vector_item_id) do nothing`,
        [
          input.tenantId,
          `${input.namespace}-v${input.version}`,
          vectorSpaceVersionId,
          item.vectorItemId,
          vectorText(item.embedding),
          hexDigest(item.embedding),
        ],
      );
    }

    await client.query(
      "insert into evaluation.eval_dataset(id,tenant_id,slug,purpose) values($1,$2,$3,$4) on conflict(id) do nothing",
      [datasetId, input.tenantId, `${input.namespace}-maintained-dod`, `Maintained Gate 6 definition-of-done query`],
    );
    await client.query(
      "insert into evaluation.eval_run(id,tenant_id,dataset_id,space_version_id,config) values($1,$2,$3,$4,$5::jsonb) on conflict(id) do nothing",
      [
        evalRunId,
        input.tenantId,
        datasetId,
        vectorSpaceVersionId,
        JSON.stringify({
          fixture: "exact-three-bundle",
          version: input.version,
          codeRef: "scripts/canonical-fixture.ts",
        }),
      ],
    );
    await client.query(
      "insert into evaluation.promotion_gate_version(id,tenant_id,slug,version,definition,definition_sha256) values($1,$2,$3,1,$4::jsonb,$5) on conflict(id) do nothing",
      [
        gateVersionId,
        input.tenantId,
        `${input.namespace}-local-proof`,
        JSON.stringify({ requiredCount: 41, storeClass: "internal_exploratory" }),
        hexDigest({ requiredCount: 41, storeClass: "internal_exploratory" }),
      ],
    );
    await client.query(
      `insert into evaluation.promotion_gate_result(id,tenant_id,gate_version_id,eval_run_id,passed,false_acceptance_count,observations,result_sha256)
      values($1,$2,$3,$4,true,0,$5::jsonb,$6) on conflict(id) do nothing`,
      [
        gateResultId,
        input.tenantId,
        gateVersionId,
        evalRunId,
        JSON.stringify({ localOnly: true, records: 41 }),
        hexDigest({ passed: true, records: 41 }),
      ],
    );
    await client.query(
      `insert into retrieval.content_promotion_proposal
      (id,tenant_id,proposal_sha256,source_manifest,chunk_manifest,projection_manifest,target_domains,expected_value,risks,exclusions,procedures,reason,proposed_by,operation_id)
      values($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12,$13,$14) on conflict(id) do nothing`,
      [
        proposalId,
        input.tenantId,
        hexDigest(proposal),
        JSON.stringify({ artifacts: input.artifacts }),
        JSON.stringify({ fixture: true }),
        JSON.stringify({ count: 41, digest: vectorItemManifestSha256 }),
        ["engineering_claims"],
        "local durability proof",
        ["not canonical knowledge"],
        ["official publication"],
        JSON.stringify({ projectionProcedureId: procedureId }),
        input.reason,
        input.proposedBy,
        proposalOperationId,
      ],
    );
    await client.query(
      `insert into knowledge_service.review_subject
      (id,tenant_id,operation_id,subject_kind,subject_ref,guarded_sha256,eligible_roles)
      values($1,$2,$3,'content_promotion',$4::jsonb,$5,array['human_reviewer']) on conflict(id) do nothing`,
      [
        reviewSubjectId,
        input.tenantId,
        proposalOperationId,
        JSON.stringify({ proposalId, fixture: true }),
        guardedSha256,
      ],
    );
    await client.query(
      `insert into knowledge_service.review_decision
      (id,tenant_id,review_subject_id,guarded_sha256,reviewer_identity,reviewer_role,decision,rationale,decision_operation_id)
      values($1,$2,$3,$4,$5,'human_reviewer','approve',$6,$7)
      on conflict(tenant_id,review_subject_id,reviewer_identity) do nothing`,
      [
        knowledgeReviewDecisionId,
        input.tenantId,
        reviewSubjectId,
        guardedSha256,
        input.reviewerIdentity,
        "Fixture reviewer service approves only this isolated exploratory version",
        decisionOperationId,
      ],
    );
    await client.query(
      `insert into retrieval.content_promotion_decision
      (id,tenant_id,proposal_id,guarded_sha256,decision,gates,reviewer_identity,policy_version,rationale,knowledge_review_decision_id,decision_operation_id)
      values($1,$2,$3,$4,'accept',$5::jsonb,$6,'local-proof-v1',$7,$8,$9) on conflict(id) do nothing`,
      [
        decisionId,
        input.tenantId,
        proposalId,
        guardedSha256,
        JSON.stringify({ localExploratory: true, gateResultId }),
        input.reviewerIdentity,
        "Approved only for isolated local exploratory durability proof",
        knowledgeReviewDecisionId,
        decisionOperationId,
      ],
    );
    await client.query(
      `insert into retrieval.space_publication
      (id,tenant_id,vector_store_space_id,vector_space_version_id,vector_item_manifest_sha256,embedding_manifest_sha256,index_manifest_sha256,evaluation_result_id,publication_decision_id,status,expected_item_count,operation_id)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved',$10,$11) on conflict(id) do nothing`,
      [
        publicationId,
        input.tenantId,
        vectorStoreSpaceId,
        vectorSpaceVersionId,
        vectorItemManifestSha256,
        embeddingManifestSha256,
        indexManifestSha256,
        gateResultId,
        decisionId,
        vectorItems.length,
        publicationOperationId,
      ],
    );

    const counts = (
      await client.query<{ items: string; embeddings: string }>(
        `select
      (select count(*) from retrieval.vector_item where tenant_id=$1 and space_version_id=$2)::text items,
      (select count(*) from retrieval.vector_item_embedding_1536 where tenant_id=$1 and vector_space_version_id=$2)::text embeddings`,
        [input.tenantId, vectorSpaceVersionId],
      )
    ).rows[0]!;
    if (Number(counts.items) !== 41 || Number(counts.embeddings) !== 41)
      throw new Error("FIXTURE_CARDINALITY_MISMATCH");
  });

  return {
    version: input.version,
    vectorSpaceVersionId,
    vectorStoreSpaceId,
    publicationId,
    guardedSha256,
    expectedItemCount: 41,
    vectorItemManifestSha256,
    embeddingManifestSha256,
    indexManifestSha256,
  };
}
