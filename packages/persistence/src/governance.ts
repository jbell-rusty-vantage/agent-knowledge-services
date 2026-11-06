import { sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import {
  SelectedCandidateEvaluationInputSchema,
  SelectedCandidateIndexInputSchema,
  type SelectedCandidateEvaluationInput,
  type SelectedCandidateIndexInput,
} from "@aiengineer/knowledge-contracts";
import type {
  GovernedCandidateEvaluation,
  GovernedEmbeddingContext,
  GovernedEmbeddingRun,
  GovernedIndexRepository,
  GovernedProjectionProposal,
  GovernedProjectionProposalInput,
  GovernedPromotionDecisionInput,
  GovernedPublication,
  GovernedPublicationBaselineComparison,
  GovernedPublicationInput,
  GovernedPublishedAnswer,
  GovernedSelectedCandidateResult,
  PersistGovernedEmbeddingRunInput,
  PublishedQueryMode,
} from "./types.js";
import {
  assertPublicationCandidateBinding,
  assertPublicationDependenciesEligible,
  evaluateSelectedCandidate,
  queryPublishedSpace,
  readGateObservations,
  verifyPublicationBaseline,
} from "./publication-evaluation.js";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
import { operationActorIdentity, sameActorIdentity } from "./actor-identity.js";
import {
  persistSelectedProjectionProposal,
  validatePromotionSelection,
  type PromotionSelectionConfiguration,
  type PromotionSelectionArtifact,
} from "./promotion-selection.js";

type Row = Record<string, unknown>;
const hex = (value: unknown) => sha256Digest(JSON.parse(JSON.stringify(value))).slice(7);
const digest = (value: unknown) => `sha256:${hex(value)}` as const;
const vectorText = (values: readonly number[]) =>
  `[${values.map((value) => (Object.is(value, -0) ? "0" : String(value))).join(",")}]`;

function proposalFromRow(row: Row): GovernedProjectionProposal {
  const manifest = row.projection_manifest as Record<string, unknown>;
  return {
    proposalId: String(row.id),
    proposalDigest: `sha256:${String(row.proposal_sha256)}`,
    projectionIds: (manifest.projectionIds as unknown[]).map(String),
    projectionManifestDigest: String(manifest.projectionManifestDigest) as `sha256:${string}`,
    chunkSetId: String(manifest.chunkSetId),
    representationId: String(manifest.representationId),
    ...(typeof manifest.selectionDigest === "string" ? { selectionDigest: manifest.selectionDigest } : {}),
  };
}

async function candidateReceipt(
  client: TenantSqlClient,
  tenantId: string,
  binding: { operationId: string; receiptId: string },
  kind: string,
  receiptKind: string,
): Promise<Row> {
  const row = (
    await client.query<Row>(
      `select r.body,r.output_sha256 from knowledge_service.receipt r
    join knowledge_service.operation o on o.tenant_id=r.tenant_id and o.id=r.operation_id
    join knowledge_service.operation_step s on s.tenant_id=r.tenant_id and s.id=r.step_id and s.operation_id=o.id
      and s.status='succeeded' and s.input_sha256=r.input_sha256
    join knowledge_service.operation_event e on e.tenant_id=r.tenant_id and e.operation_id=o.id and e.step_id=s.id
      and e.id::text=r.body->>'eventId' and e.event_kind='step.succeeded' and e.to_state='succeeded'
      and e.guarded_sha256=r.output_sha256 and e.payload->>'outputSha256'=r.output_sha256
      and e.payload->>'fencingToken'=r.body->>'fencingToken'
    where r.tenant_id=$1 and r.id=$2 and r.operation_id=$3 and r.receipt_kind=$4 and r.outcome='succeeded'
      and o.operation_kind=$5 and o.status='succeeded'`,
      [tenantId, binding.receiptId, binding.operationId, receiptKind, kind],
    )
  ).rows[0];
  if (!row || !row.body) throw new Error("CANDIDATE_INDEX_RECEIPT_INVALID");
  const { eventId, fencingToken, ...output } = row.body as Row;
  if (
    typeof eventId !== "string" ||
    !Number.isSafeInteger(fencingToken) ||
    Number(fencingToken) < 1 ||
    hex(output) !== row.output_sha256
  )
    throw new Error("CANDIDATE_INDEX_RECEIPT_INVALID");
  return output;
}

async function candidatePhysicalRows(client: TenantSqlClient, tenantId: string, versionId: string): Promise<Row[]> {
  return (
    await client.query<Row>(
      `select v.id,v.search_projection_id,v.projection_target_id,v.content_kind,v.knowledge_seq,
      v.lifecycle,v.verification_state,v.content_sha256,v.search_text,e.embedding_run_id,e.status embedding_status,
      e.input_sha256,e.output_sha256,e.dimensions,e.search_projection_id embedding_projection_id,x.vector_space_key,x.vector_space_version_id physical_version,
      x.embedding_sha256,x.physical_embedding_sha256,extensions.vector_dims(x.embedding::extensions.vector) physical_dimensions,
      x.physical_embedding_sha256=encode(extensions.digest(x.embedding::text,'sha256'),'hex') physical_digest_verified,
      p.projection_target_id expected_target_id,case when t.target_kind='entity' then 'profile' else t.target_kind end expected_kind,
      exists(select 1 from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid
        join pg_catalog.pg_am am on am.oid=c.relam join pg_catalog.pg_opclass op on op.oid=i.indclass[0]
        where i.indrelid=x.tableoid and i.indisvalid and i.indisready and am.amname='hnsw'
          and op.opcname='halfvec_cosine_ops' and i.indpred is null and i.indexprs is null) index_ready
    from retrieval.vector_item v
    left join retrieval.embedding_item e on e.tenant_id=v.tenant_id and e.id=v.embedding_item_id
    left join retrieval.vector_item_embedding_1536 x on x.tenant_id=v.tenant_id and x.vector_item_id=v.id
    left join retrieval.search_projection p on p.tenant_id=v.tenant_id and p.id=v.search_projection_id
    left join retrieval.projection_target t on t.tenant_id=p.tenant_id and t.id=p.projection_target_id
    where v.tenant_id=$1 and v.space_version_id=$2 order by v.search_projection_id,v.id`,
      [tenantId, versionId],
    )
  ).rows;
}

/** Canonical Gate 2-3 materialization. All methods re-read immutable rows before returning replay success. */
export class PostgresGovernedIndexRepository implements GovernedIndexRepository {
  constructor(
    private readonly database: PostgresCanonicalRepository,
    private readonly selection?: PromotionSelectionConfiguration,
  ) {}

  async persistRepresentationDecision(
    tenantId: string,
    input: Parameters<GovernedIndexRepository["persistRepresentationDecision"]>[1],
  ): Promise<string> {
    return this.database.transaction(tenantId, async (client) => {
      const representation = (
        await client.query<Row>(
          `select r.*,e.id evaluation_id from content.document_representation r
        left join content.conversion_evaluation e on e.tenant_id=r.tenant_id and e.representation_id=r.id
        where r.tenant_id=$1 and r.id=$2 order by e.created_at desc nulls last limit 1`,
          [tenantId, input.representationId],
        )
      ).rows[0];
      if (!representation || String(representation.content_sha256) !== input.guardedDigest.slice(7))
        throw new Error("REPRESENTATION_GUARDED_DIGEST_MISMATCH");
      const reviewed = (
        await client.query<Row>(
          `select * from knowledge_service.review_decision where tenant_id=$1 and id=$2
        and decision_operation_id=$3 and guarded_sha256=$4`,
          [tenantId, input.knowledgeReviewDecisionId, input.operationId, input.guardedDigest.slice(7)],
        )
      ).rows[0];
      if (!reviewed || !sameActorIdentity(String(reviewed.reviewer_identity), input.reviewerIdentity))
        throw new Error("REPRESENTATION_REVIEW_PROVENANCE_MISMATCH");
      const mapped = reviewed.decision === "approve" ? "accept" : reviewed.decision;
      if (mapped !== input.decision) throw new Error("REPRESENTATION_DECISION_MISMATCH");
      const id = deterministicUuid(
        "representation-decision",
        `${input.operationId}:${input.representationId}:${input.guardedDigest}`,
      );
      await client.query(
        `insert into content.representation_decision
        (id,tenant_id,representation_id,conversion_evaluation_id,guarded_sha256,decision,reviewer_identity,policy_version,rationale,expires_at,knowledge_review_decision_id,decision_operation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(id) do nothing`,
        [
          id,
          tenantId,
          input.representationId,
          representation.evaluation_id ?? null,
          input.guardedDigest.slice(7),
          input.decision,
          String(reviewed.reviewer_identity),
          input.policyVersion,
          input.rationale,
          input.expiresAt ?? null,
          input.knowledgeReviewDecisionId,
          input.operationId,
        ],
      );
      const stored = (
        await client.query<Row>("select * from content.representation_decision where tenant_id=$1 and id=$2", [
          tenantId,
          id,
        ])
      ).rows[0];
      if (
        !stored ||
        String(stored.guarded_sha256) !== input.guardedDigest.slice(7) ||
        String(stored.decision) !== input.decision ||
        String(stored.knowledge_review_decision_id) !== input.knowledgeReviewDecisionId
      )
        throw new Error("REPRESENTATION_DECISION_REPLAY_CONFLICT");
      return id;
    });
  }

  async persistProjectionProposal(
    tenantId: string,
    input: GovernedProjectionProposalInput,
  ): Promise<GovernedProjectionProposal> {
    return this.database.transaction(tenantId, (client) =>
      persistSelectedProjectionProposal(client, tenantId, input, this.selection),
    );
  }
  async getProjectionProposal(tenantId: string, proposalId: string): Promise<GovernedProjectionProposal | undefined> {
    return this.database.transaction(tenantId, async (client) => {
      const row = (
        await client.query<Row>("select * from retrieval.content_promotion_proposal where tenant_id=$1 and id=$2", [
          tenantId,
          proposalId,
        ])
      ).rows[0];
      return row ? proposalFromRow(row) : undefined;
    });
  }

  async persistPromotionDecision(tenantId: string, input: GovernedPromotionDecisionInput): Promise<string> {
    return this.database.transaction(tenantId, async (client) => {
      const proposal = (
        await client.query<Row>("select * from retrieval.content_promotion_proposal where tenant_id=$1 and id=$2", [
          tenantId,
          input.proposalId,
        ])
      ).rows[0];
      if (!proposal || String(proposal.proposal_sha256) !== input.guardedDigest.slice(7))
        throw new Error("PROMOTION_GUARDED_DIGEST_MISMATCH");
      if (sameActorIdentity(String(proposal.proposed_by), input.reviewerIdentity))
        throw new Error("PROMOTION_SEPARATION_OF_DUTY_VIOLATION");
      const review = (
        await client.query<Row>(
          `select d.* from knowledge_service.review_decision d join knowledge_service.review_subject s
        on s.tenant_id=d.tenant_id and s.id=d.review_subject_id where d.tenant_id=$1 and d.id=$2 and d.decision_operation_id=$3
        and d.guarded_sha256=$4 and s.subject_kind='content_promotion'`,
          [tenantId, input.knowledgeReviewDecisionId, input.operationId, input.guardedDigest.slice(7)],
        )
      ).rows[0];
      const expectedReview = input.decision === "accept" ? "approve" : input.decision;
      if (
        !review ||
        !sameActorIdentity(String(review.reviewer_identity), input.reviewerIdentity) ||
        String(review.decision) !== expectedReview
      )
        throw new Error("PROMOTION_REVIEW_PROVENANCE_MISMATCH");
      const reviewerIdentity = String(review.reviewer_identity);
      const id = deterministicUuid(
        "content-promotion-decision",
        `${input.operationId}:${input.proposalId}:${input.reviewerIdentity}`,
      );
      await client.query(
        `insert into retrieval.content_promotion_decision
        (id,tenant_id,proposal_id,guarded_sha256,decision,gates,reviewer_identity,policy_version,rationale,expires_at,knowledge_review_decision_id,decision_operation_id)
        values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12) on conflict(id) do nothing`,
        [
          id,
          tenantId,
          input.proposalId,
          input.guardedDigest.slice(7),
          input.decision,
          JSON.stringify(input.gates),
          reviewerIdentity,
          input.policyVersion,
          input.rationale,
          input.expiresAt ?? null,
          input.knowledgeReviewDecisionId,
          input.operationId,
        ],
      );
      const stored = (
        await client.query<Row>("select * from retrieval.content_promotion_decision where tenant_id=$1 and id=$2", [
          tenantId,
          id,
        ])
      ).rows[0];
      if (
        !stored ||
        String(stored.guarded_sha256) !== input.guardedDigest.slice(7) ||
        String(stored.decision) !== input.decision ||
        String(stored.knowledge_review_decision_id) !== input.knowledgeReviewDecisionId
      )
        throw new Error("PROMOTION_DECISION_REPLAY_CONFLICT");
      return id;
    });
  }

  async loadEmbeddingContext(
    tenantId: string,
    vectorSpaceVersionId: string,
    promotionDecisionId: string,
    projectionIds: readonly string[],
  ): Promise<GovernedEmbeddingContext> {
    return this.database.transaction(tenantId, (client) =>
      this.readEmbeddingContext(client, { tenantId, vectorSpaceVersionId, promotionDecisionId, projectionIds }),
    );
  }

  private async readEmbeddingContext(
    client: TenantSqlClient,
    input: {
      tenantId: string;
      vectorSpaceVersionId: string;
      promotionDecisionId: string;
      projectionIds: readonly string[];
    },
  ): Promise<GovernedEmbeddingContext> {
    const { tenantId, vectorSpaceVersionId, promotionDecisionId, projectionIds } = input;
    if (!projectionIds.length || new Set(projectionIds).size !== projectionIds.length)
      throw new Error("INVALID_EMBEDDING_PROJECTION_SET");
    const version = (
      await client.query<Row>(
        `select v.*,s.slug from retrieval.vector_space_version v join retrieval.vector_space s
        on s.tenant_id=v.tenant_id and s.id=v.vector_space_id where v.tenant_id=$1 and v.id=$2`,
        [tenantId, vectorSpaceVersionId],
      )
    ).rows[0];
    if (!version || Number(version.dims) !== 1536 || String(version.precision) !== "halfvec")
      throw new Error("EMBEDDING_SPACE_CONFIGURATION_REJECTED");
    const decision = (
      await client.query<Row>(
        `select d.*,p.projection_manifest,
        exists(select 1 from knowledge_service.review_decision r
          join knowledge_service.review_subject s on s.tenant_id=r.tenant_id and s.id=r.review_subject_id
          join knowledge_service.operation o on o.tenant_id=r.tenant_id and o.id=r.decision_operation_id
          where r.tenant_id=d.tenant_id and r.id=d.knowledge_review_decision_id
            and not r.legacy_provenance and not d.legacy_provenance and not p.legacy_provenance
            and r.decision_operation_id=d.decision_operation_id and o.operation_kind='promotion_decision' and o.status='succeeded'
            and r.decision='approve' and r.reviewer_identity=d.reviewer_identity and r.reviewer_role='human_reviewer'
            and r.guarded_sha256=d.guarded_sha256 and d.guarded_sha256=p.proposal_sha256
            and s.operation_id=p.operation_id and s.subject_kind='content_promotion' and s.guarded_sha256=p.proposal_sha256
            and (s.expires_at is null or s.expires_at>now()) and s.quorum_required=1 and 'human_reviewer'=any(s.eligible_roles)
            and s.subject_ref->>'proposalId'=p.id::text
            and s.subject_ref->>'selectionDigest'=p.projection_manifest->>'selectionDigest'
            and s.subject_ref->>'selectionArtifactId'=p.projection_manifest->'selectionArtifact'->>'id') review_bound
        from retrieval.content_promotion_decision d
        join retrieval.content_promotion_proposal p on p.tenant_id=d.tenant_id and p.id=d.proposal_id
        where d.tenant_id=$1 and d.id=$2 and d.decision='accept' and (d.expires_at is null or d.expires_at>now())`,
        [tenantId, promotionDecisionId],
      )
    ).rows[0];
    if (!decision || decision.review_bound !== true) throw new Error("EMBEDDING_PROMOTION_NOT_APPROVED");
    const manifest = decision.projection_manifest as Record<string, unknown>;
    if (!this.selection || !manifest.selection || !manifest.selectionArtifact)
      throw new Error("PROMOTION_SELECTION_REQUIRED");
    const selected = await validatePromotionSelection(client, {
      selection: manifest.selection,
      artifact: manifest.selectionArtifact as PromotionSelectionArtifact,
      authority: await this.selection.selectionAuthority(client, tenantId),
      ports: this.selection.selectionPorts,
    });
    if (selected.selectionDigest !== manifest.selectionDigest) throw new Error("EMBEDDING_SELECTION_DIGEST_MISMATCH");
    const latest = (
      await client.query<Row>(
        `select id from retrieval.content_promotion_decision where tenant_id=$1 and proposal_id=$2 order by created_at desc,id desc limit 1`,
        [tenantId, decision.proposal_id],
      )
    ).rows[0];
    if (
      latest?.id !== promotionDecisionId ||
      !sameActorIdentity(String(decision.reviewer_identity), selected.selection.requiredReviewer)
    )
      throw new Error("EMBEDDING_PROMOTION_NOT_CURRENT");
    const bindings = manifest.projections as {
      memberId: string;
      projectionId: string;
      targetId: string;
      targetSpaces: string[];
      embeddingDigest: string;
    }[];
    const admitted = bindings
      .filter((binding) => binding.targetSpaces.includes(String(version.slug)))
      .map((binding) => binding.projectionId);
    if (digest([...projectionIds].sort()) !== digest([...admitted].sort()))
      throw new Error("EMBEDDING_PROJECTION_MANIFEST_MISMATCH");
    const projections = (
      await client.query<Row>(
        `select p.* from retrieval.search_projection p
        join retrieval.projection_target t on t.tenant_id=p.tenant_id and t.id=p.projection_target_id
        where p.tenant_id=$1 and p.id=any($2::uuid[]) and p.projection_procedure_id=$3
          and t.retired_at is null
        order by p.id`,
        [tenantId, projectionIds, version.projection_procedure_id],
      )
    ).rows;
    if (projections.length !== projectionIds.length) throw new Error("EMBEDDING_PROJECTION_INELIGIBLE");
    const byId = new Map(projections.map((row) => [String(row.id), row]));
    for (const row of projections) {
      const binding = bindings.find((binding) => binding.projectionId === row.id);
      const member = selected.members.find((member) => member.memberId === binding?.memberId);
      if (
        !binding ||
        !member ||
        binding.targetId !== member.target.projectionTargetId ||
        row.projection_target_id !== binding.targetId ||
        !binding.targetSpaces.includes(String(version.slug)) ||
        row.embedding_text !== member.embeddingText ||
        `sha256:${row.embedding_text_sha256}` !== sha256Digest(member.embeddingText) ||
        binding.embeddingDigest !== sha256Digest(member.embeddingText)
      )
        throw new Error("EMBEDDING_SELECTED_MEMBERSHIP_MISMATCH");
    }
    return {
      selectionDigest: selected.selectionDigest,
      selectionBudget: selected.selection.budget,
      knowledgeSeq: selected.selection.expectedKnowledgeHead,
      vectorSpaceVersionId,
      modelSlug: String(version.embedding_model),
      dimensions: Number(version.dims),
      projectionProcedureId: String(version.projection_procedure_id),
      vectorSpaceKey: String(version.slug),
      promotionDecisionId,
      inputs: projectionIds.map((projectionId) => {
        const row = byId.get(projectionId);
        if (!row) throw new Error("EMBEDDING_PROJECTION_NOT_FOUND");
        return {
          projectionId,
          text: String(row.embedding_text),
          textDigest: `sha256:${String(row.embedding_text_sha256)}`,
        };
      }),
    };
  }

  async persistEmbeddingRun(tenantId: string, input: PersistGovernedEmbeddingRunInput): Promise<GovernedEmbeddingRun> {
    return this.database.transaction(tenantId, async (client) => {
      if (!input.context.selectionDigest || !input.context.selectionBudget)
        throw new Error("PROMOTION_SELECTION_REQUIRED");
      if (!this.selection) throw new Error("PROMOTION_SELECTION_REQUIRED");
      const current = await this.readEmbeddingContext(client, {
        tenantId,
        vectorSpaceVersionId: input.context.vectorSpaceVersionId,
        promotionDecisionId: input.context.promotionDecisionId,
        projectionIds: input.context.inputs.map((item) => item.projectionId),
      });
      if (digest(current) !== digest(input.context)) throw new Error("EMBEDDING_CONTEXT_AUTHORITY_MISMATCH");
      const authority = await this.selection.selectionAuthority(client, tenantId);
      if (digest(authority.budget) !== digest(input.context.selectionBudget))
        throw new Error("EMBEDDING_BUDGET_AUTHORITY_MISMATCH");
      const costMicros = Math.ceil(input.receipt.costUsd * 1_000_000);
      if (
        !Number.isSafeInteger(input.receipt.usageTokens) ||
        input.receipt.usageTokens < 0 ||
        !Number.isFinite(input.receipt.costUsd) ||
        input.receipt.costUsd < 0 ||
        !Number.isSafeInteger(costMicros)
      )
        throw new Error("EMBEDDING_USAGE_UNKNOWN");
      if (
        input.receipt.usageTokens > input.context.selectionBudget.maxTokens ||
        costMicros > input.context.selectionBudget.maxCostMicros
      )
        throw new Error("EMBEDDING_SELECTION_BUDGET_EXCEEDED");
      const prior = (
        await client.query<Row>("select * from retrieval.embedding_run where tenant_id=$1 and operation_id=$2", [
          tenantId,
          input.operationId,
        ])
      ).rows[0];
      if (prior) {
        if (
          String(prior.id) !== input.embeddingRunId ||
          String(prior.vector_space_version_id) !== input.context.vectorSpaceVersionId ||
          String(prior.promotion_decision_id) !== input.context.promotionDecisionId ||
          String(prior.idempotency_key) !== input.idempotencyKey ||
          String(prior.adapter_version) !== input.adapterVersion ||
          String(prior.gateway_model_slug) !== input.context.modelSlug ||
          Number(prior.expected_dimensions) !== input.context.dimensions ||
          String(prior.input_manifest_sha256) !== input.receipt.inputManifestDigest.slice(7) ||
          String(prior.output_manifest_sha256) !== input.receipt.outputManifestDigest.slice(7) ||
          String(prior.status) !== "succeeded"
        )
          throw new Error("EMBEDDING_RUN_REPLAY_CONFLICT");
        const replay = await this.embeddingRunFromRow(client, tenantId, prior);
        if (replay.itemCount !== input.receipt.items.length)
          throw new Error("EMBEDDING_RUN_REPLAY_CARDINALITY_CONFLICT");
        return replay;
      }
      if (input.receipt.items.length !== input.context.inputs.length) throw new Error("EMBEDDING_ITEM_COUNT_MISMATCH");
      // Serialize aggregate settlement for this immutable selection across target spaces.
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${tenantId}:${input.context.selectionDigest}`,
      ]);
      const usage = (
        await client.query<Row>(
          `select coalesce(sum((usage->>'tokens')::bigint),0)::text tokens,
        coalesce(sum(ceil(cost_usd*1000000)),0)::text cost_micros from retrieval.embedding_run
        where tenant_id=$1 and receipt->>'selectionDigest'=$2 and operation_id<>$3`,
          [tenantId, input.context.selectionDigest, input.operationId],
        )
      ).rows[0];
      if (
        !usage ||
        BigInt(String(usage.tokens)) + BigInt(input.receipt.usageTokens) > BigInt(authority.budget.maxTokens) ||
        BigInt(String(usage.cost_micros)) + BigInt(costMicros) > BigInt(authority.budget.maxCostMicros)
      )
        throw new Error("EMBEDDING_SELECTION_BUDGET_EXCEEDED");
      await client.query(
        `insert into retrieval.embedding_run
        (id,tenant_id,vector_space_version_id,operation_id,promotion_decision_id,adapter_version,gateway_model_slug,provider_route_policy,expected_dimensions,
         input_manifest_sha256,output_manifest_sha256,idempotency_key,status,request_id,observed_provider_route,usage,latency_ms,retry_history,cost_usd,receipt,completed_at)
        values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,'succeeded',$13,$14,$15::jsonb,$16,$17::jsonb,$18,$19::jsonb,clock_timestamp())`,
        [
          input.embeddingRunId,
          tenantId,
          input.context.vectorSpaceVersionId,
          input.operationId,
          input.context.promotionDecisionId,
          input.adapterVersion,
          input.context.modelSlug,
          JSON.stringify(input.providerRoutePolicy),
          input.context.dimensions,
          input.receipt.inputManifestDigest.slice(7),
          input.receipt.outputManifestDigest.slice(7),
          input.idempotencyKey,
          input.receipt.requestId,
          input.receipt.observedProviderRoute,
          JSON.stringify({ tokens: input.receipt.usageTokens }),
          input.receipt.latencyMs,
          JSON.stringify(input.receipt.retryHistory),
          input.receipt.costUsd,
          JSON.stringify({ ...input.receipt, selectionDigest: input.context.selectionDigest }),
        ],
      );
      const vectorManifest = [] as {
        id: string;
        projectionId: string;
        content: string;
        embeddingItemId: string;
        output: string;
      }[];
      for (const [index, item] of input.receipt.items.entries()) {
        if (
          item.embedding.length !== input.context.dimensions ||
          item.embedding.some((value) => !Number.isFinite(value))
        )
          throw new Error("EMBEDDING_VECTOR_INVALID");
        const expected = input.context.inputs[index];
        if (!expected || expected.projectionId !== item.projectionId || expected.textDigest !== item.inputDigest)
          throw new Error("EMBEDDING_RECEIPT_ORDER_MISMATCH");
        const support = (
          await client.query<Row>(
            `select s.chunk_id,p.embedding_text,p.language,p.visibility,p.classification,p.projection_target_id,
            case when t.target_kind='entity' then 'profile' else t.target_kind end content_kind
          from retrieval.search_projection_chunk_support s
          join retrieval.search_projection p on p.tenant_id=s.tenant_id and p.id=s.search_projection_id
          join retrieval.projection_target t on t.tenant_id=p.tenant_id and t.id=p.projection_target_id
          where s.tenant_id=$1 and s.search_projection_id=$2 and s.ordinal=0`,
            [tenantId, item.projectionId],
          )
        ).rows[0];
        if (!support) throw new Error("EMBEDDING_SUPPORT_MISSING");
        const embeddingItemId = deterministicUuid("embedding-item", `${input.embeddingRunId}:${item.projectionId}`);
        const vectorItemId = deterministicUuid(
          "vector-item",
          `${input.context.vectorSpaceVersionId}:${item.projectionId}:${item.outputDigest}`,
        );
        await client.query(
          `insert into retrieval.embedding_item
          (id,tenant_id,embedding_run_id,search_projection_id,input_sha256,output_sha256,dimensions,cache_key,status,provider_metadata)
          values($1,$2,$3,$4,$5,$6,$7,$8,'succeeded',$9::jsonb) on conflict(id) do nothing`,
          [
            embeddingItemId,
            tenantId,
            input.embeddingRunId,
            item.projectionId,
            item.inputDigest.slice(7),
            item.outputDigest.slice(7),
            item.embedding.length,
            item.cacheKey,
            JSON.stringify({ route: input.receipt.observedProviderRoute, index }),
          ],
        );
        await client.query(
          `insert into retrieval.vector_item
          (id,tenant_id,space_version_id,retrieval_chunk_id,search_projection_id,embedding_item_id,source_version_hash,content_sha256,
           backend_location,verification_state,language,visibility,classification,lifecycle,authority_level,search_text,projection_target_id,content_kind,knowledge_seq)
          select $1,$2,$3,$4,p.id,$5,$6,p.embedding_text_sha256,'pgvector:halfvec1536','verified',p.language,p.visibility,p.classification,'active','reviewed',p.embedding_text,p.projection_target_id,$8,$9
          from retrieval.search_projection p where p.tenant_id=$2 and p.id=$7 on conflict(id) do nothing`,
          [
            vectorItemId,
            tenantId,
            input.context.vectorSpaceVersionId,
            support.chunk_id,
            embeddingItemId,
            item.inputDigest.slice(7),
            item.projectionId,
            support.content_kind,
            current.knowledgeSeq,
          ],
        );
        await client.query(
          `insert into retrieval.vector_item_embedding_1536
          (tenant_id,vector_space_key,vector_space_version_id,vector_item_id,embedding,embedding_sha256)
          values($1,$2,$3,$4,$5::extensions.halfvec(1536),$6) on conflict(vector_space_key,vector_item_id) do nothing`,
          [
            tenantId,
            input.context.vectorSpaceKey,
            input.context.vectorSpaceVersionId,
            vectorItemId,
            vectorText(item.embedding),
            item.outputDigest.slice(7),
          ],
        );
        const stored = (
          await client.query<Row>(
            `select v.space_version_id,v.retrieval_chunk_id,v.search_projection_id,v.embedding_item_id,v.source_version_hash,
          v.content_sha256,v.backend_location,v.verification_state,v.language,v.visibility,v.classification,v.lifecycle,v.authority_level,v.search_text,v.projection_target_id,v.content_kind,v.knowledge_seq,
          e.embedding_run_id,e.input_sha256,e.output_sha256,e.dimensions,e.cache_key,e.status embedding_status,
          x.vector_space_key,x.vector_space_version_id,x.embedding_sha256,x.physical_embedding_sha256,
          (x.physical_embedding_sha256=encode(extensions.digest(x.embedding::text,'sha256'),'hex')) physical_digest_verified
          from retrieval.vector_item v join retrieval.embedding_item e on e.tenant_id=v.tenant_id and e.id=v.embedding_item_id
          join retrieval.vector_item_embedding_1536 x on x.tenant_id=v.tenant_id and x.vector_item_id=v.id
          where v.tenant_id=$1 and v.id=$2`,
            [tenantId, vectorItemId],
          )
        ).rows[0];
        if (
          !stored ||
          String(stored.space_version_id) !== input.context.vectorSpaceVersionId ||
          String(stored.retrieval_chunk_id) !== String(support.chunk_id) ||
          stored.projection_target_id !== support.projection_target_id ||
          stored.content_kind !== support.content_kind ||
          Number(stored.knowledge_seq) !== current.knowledgeSeq ||
          String(stored.search_projection_id) !== item.projectionId ||
          String(stored.embedding_item_id) !== embeddingItemId ||
          String(stored.source_version_hash) !== item.inputDigest.slice(7) ||
          String(stored.content_sha256) !== item.inputDigest.slice(7) ||
          String(stored.backend_location) !== "pgvector:halfvec1536" ||
          String(stored.verification_state) !== "verified" ||
          String(stored.language ?? "") !== String(support.language ?? "") ||
          String(stored.visibility) !== String(support.visibility) ||
          String(stored.classification) !== String(support.classification) ||
          String(stored.lifecycle) !== "active" ||
          String(stored.authority_level) !== "reviewed" ||
          String(stored.search_text) !== String(support.embedding_text) ||
          String(stored.embedding_run_id) !== input.embeddingRunId ||
          String(stored.input_sha256) !== item.inputDigest.slice(7) ||
          String(stored.output_sha256) !== item.outputDigest.slice(7) ||
          Number(stored.dimensions) !== item.embedding.length ||
          String(stored.cache_key) !== item.cacheKey ||
          String(stored.embedding_status) !== "succeeded" ||
          String(stored.vector_space_key) !== input.context.vectorSpaceKey ||
          String(stored.vector_space_version_id) !== input.context.vectorSpaceVersionId ||
          String(stored.embedding_sha256) !== item.outputDigest.slice(7) ||
          stored.physical_digest_verified !== true ||
          !/^[a-f0-9]{64}$/.test(String(stored.physical_embedding_sha256))
        )
          throw new Error("VECTOR_ITEM_REPLAY_CONFLICT");
        vectorManifest.push({
          id: vectorItemId,
          projectionId: item.projectionId,
          content: item.inputDigest.slice(7),
          embeddingItemId,
          output: item.outputDigest.slice(7),
        });
      }
      const stored = (
        await client.query<Row>("select * from retrieval.embedding_run where tenant_id=$1 and id=$2", [
          tenantId,
          input.embeddingRunId,
        ])
      ).rows[0]!;
      const result = await this.embeddingRunFromRow(client, tenantId, stored);
      if (
        result.itemCount !== input.receipt.items.length ||
        result.vectorItemManifestDigest !==
          digest(vectorManifest.sort((a, b) => a.projectionId.localeCompare(b.projectionId)))
      )
        throw new Error("VECTOR_ITEM_MANIFEST_CONFLICT");
      return result;
    });
  }

  private async embeddingRunFromRow(
    client: TenantSqlClient,
    tenantId: string,
    row: Row,
  ): Promise<GovernedEmbeddingRun> {
    const items = (
      await client.query<Row>(
        `select v.id,v.search_projection_id,v.content_sha256,v.embedding_item_id,e.output_sha256
      from retrieval.vector_item v join retrieval.embedding_item e on e.tenant_id=v.tenant_id and e.id=v.embedding_item_id
      where v.tenant_id=$1 and e.embedding_run_id=$2 order by e.search_projection_id`,
        [tenantId, row.id],
      )
    ).rows;
    const manifest = items.map((item) => ({
      id: String(item.id),
      projectionId: String(item.search_projection_id),
      content: String(item.content_sha256),
      embeddingItemId: String(item.embedding_item_id),
      output: String(item.output_sha256),
    }));
    return {
      embeddingRunId: String(row.id),
      vectorSpaceVersionId: String(row.vector_space_version_id),
      itemCount: items.length,
      inputManifestDigest: `sha256:${String(row.input_manifest_sha256)}`,
      outputManifestDigest: `sha256:${String(row.output_manifest_sha256)}`,
      vectorItemManifestDigest: digest(manifest),
      status: "succeeded",
    };
  }

  async getEmbeddingRunByOperation(tenantId: string, operationId: string): Promise<GovernedEmbeddingRun | undefined> {
    return this.database.transaction(tenantId, async (client) => {
      const row = (
        await client.query<Row>("select * from retrieval.embedding_run where tenant_id=$1 and operation_id=$2", [
          tenantId,
          operationId,
        ])
      ).rows[0];
      return row ? this.embeddingRunFromRow(client, tenantId, row) : undefined;
    });
  }

  async verifySelectedCandidate(tenantId: string, raw: SelectedCandidateIndexInput) {
    const input = SelectedCandidateIndexInputSchema.parse(raw);
    if (!this.selection) throw new Error("PROMOTION_SELECTION_REQUIRED");
    const configuration = this.selection;
    return this.database.transaction(tenantId, async (client) => {
      const selected = await validatePromotionSelection(client, {
        selection: input.selection,
        artifact: input.selectionArtifact,
        authority: await configuration.selectionAuthority(client, tenantId),
        ports: configuration.selectionPorts,
      });
      const prepared = await candidateReceipt(
        client,
        tenantId,
        input.preparation,
        "promotion_proposal",
        "propose.succeeded",
      );
      const reviewed = await candidateReceipt(client, tenantId, input.review, "promotion_decision", "decide.succeeded");
      const proposal = (
        await client.query<Row>(
          `select p.*,d.decision_operation_id from retrieval.content_promotion_proposal p
        join retrieval.content_promotion_decision d on d.tenant_id=p.tenant_id and d.proposal_id=p.id
        where p.tenant_id=$1 and p.id=$2 and d.id=$3`,
          [tenantId, input.preparation.proposalId, input.review.decisionId],
        )
      ).rows[0];
      if (
        !proposal ||
        proposal.operation_id !== input.preparation.operationId ||
        proposal.decision_operation_id !== input.review.operationId ||
        digest((proposal.projection_manifest as Row).selection) !== digest(input.selection) ||
        digest((proposal.projection_manifest as Row).selectionArtifact) !== digest(input.selectionArtifact) ||
        prepared.proposalId !== input.preparation.proposalId ||
        prepared.selectionDigest !== selected.selectionDigest ||
        prepared.proposalDigest !== `sha256:${proposal.proposal_sha256}` ||
        reviewed.proposalId !== input.preparation.proposalId ||
        reviewed.decisionId !== input.review.decisionId ||
        reviewed.decision !== "accept" ||
        reviewed.guardedDigest !== prepared.proposalDigest
      )
        throw new Error("CANDIDATE_INDEX_PREPARATION_BINDING_MISMATCH");
      const spaces: {
        vectorSpaceVersionId: string;
        space: string;
        embeddingRunId: string;
        vectorIds: string[];
        physicalDigests: string[];
      }[] = [];
      for (const binding of input.embeddings) {
        const context = await this.readEmbeddingContext(client, {
          tenantId,
          vectorSpaceVersionId: binding.vectorSpaceVersionId,
          promotionDecisionId: input.review.decisionId,
          projectionIds: binding.projectionIds,
        });
        if (context.selectionDigest !== selected.selectionDigest) throw new Error("CANDIDATE_INDEX_SELECTION_MISMATCH");
        const verified = await candidateReceipt(client, tenantId, binding, "embedding_run", "verify.succeeded");
        const run = (
          await client.query<Row>(
            `select * from retrieval.embedding_run where tenant_id=$1 and id=$2
          and operation_id=$3 and vector_space_version_id=$4 and promotion_decision_id=$5 and status='succeeded'`,
            [
              tenantId,
              binding.embeddingRunId,
              binding.operationId,
              binding.vectorSpaceVersionId,
              input.review.decisionId,
            ],
          )
        ).rows[0];
        if (
          !run ||
          verified.dimensionVerified !== true ||
          verified.publishable !== false ||
          verified.embeddingRunId !== binding.embeddingRunId ||
          verified.vectorSpaceVersionId !== binding.vectorSpaceVersionId ||
          verified.itemCount !== binding.projectionIds.length ||
          verified.inputManifestDigest !== `sha256:${run.input_manifest_sha256}` ||
          verified.outputManifestDigest !== `sha256:${run.output_manifest_sha256}`
        )
          throw new Error("CANDIDATE_INDEX_EMBEDDING_BINDING_MISMATCH");
        const physical = await candidatePhysicalRows(client, tenantId, binding.vectorSpaceVersionId);
        const census = (
          await client.query<Row>(
            `select
          (select count(*) from retrieval.embedding_item where tenant_id=$1 and embedding_run_id=$2)::text embedding_count,
          (select count(*) from retrieval.vector_item_embedding_1536 where tenant_id=$1 and vector_space_version_id=$3)::text physical_count`,
            [tenantId, binding.embeddingRunId, binding.vectorSpaceVersionId],
          )
        ).rows[0];
        if (
          !census ||
          Number(census.embedding_count) !== binding.projectionIds.length ||
          Number(census.physical_count) !== binding.projectionIds.length ||
          physical.length !== binding.projectionIds.length ||
          digest(physical.map((row) => row.search_projection_id).sort()) !== digest([...binding.projectionIds].sort())
        )
          throw new Error("CANDIDATE_INDEX_MEMBERSHIP_MISMATCH");
        for (const row of physical) {
          const member = context.inputs.find((item) => item.projectionId === row.search_projection_id);
          if (
            !member ||
            row.embedding_projection_id !== row.search_projection_id ||
            row.embedding_run_id !== binding.embeddingRunId ||
            row.embedding_status !== "succeeded" ||
            row.lifecycle !== "active" ||
            row.verification_state !== "verified" ||
            row.vector_space_key !== context.vectorSpaceKey ||
            row.physical_version !== binding.vectorSpaceVersionId ||
            Number(row.dimensions) !== 1536 ||
            Number(row.physical_dimensions) !== 1536 ||
            row.input_sha256 !== member.textDigest.slice(7) ||
            row.content_sha256 !== member.textDigest.slice(7) ||
            row.search_text !== member.text ||
            row.projection_target_id !== row.expected_target_id ||
            row.content_kind !== row.expected_kind ||
            Number(row.knowledge_seq) !== context.knowledgeSeq ||
            row.output_sha256 !== row.embedding_sha256 ||
            row.physical_digest_verified !== true ||
            row.index_ready !== true
          )
            throw new Error("CANDIDATE_INDEX_PHYSICAL_BINDING_MISMATCH");
        }
        const metadata = await this.embeddingRunFromRow(client, tenantId, run);
        if (
          metadata.vectorItemManifestDigest !== verified.vectorItemManifestDigest ||
          metadata.itemCount !== physical.length
        )
          throw new Error("CANDIDATE_INDEX_RECEIPT_MANIFEST_MISMATCH");
        spaces.push({
          vectorSpaceVersionId: binding.vectorSpaceVersionId,
          space: context.vectorSpaceKey,
          embeddingRunId: binding.embeddingRunId,
          vectorIds: physical.map((row) => String(row.id)),
          physicalDigests: physical.map((row) => String(row.physical_embedding_sha256)),
        });
      }
      const expectedSpaces = [...new Set(input.selection.selected.flatMap((member) => member.targetSpaces))].sort();
      if (digest(spaces.map((space) => space.space).sort()) !== digest(expectedSpaces))
        throw new Error("CANDIDATE_INDEX_SPACE_CENSUS_MISMATCH");
      const evidence = {
        selectionDigest: selected.selectionDigest,
        selectionArtifact: input.selectionArtifact,
        preparation: input.preparation,
        review: input.review,
        embeddings: input.embeddings,
        spaces,
      };
      return {
        schemaVersion: "knowledge.selected-candidate-index-result/v1" as const,
        ...evidence,
        evidenceDigest: digest(evidence),
        indexed: true as const,
        publishable: false as const,
      };
    });
  }

  /** Independent evaluation of the exact verified candidate; it never activates anything. */
  async evaluateSelectedCandidate(
    tenantId: string,
    raw: SelectedCandidateEvaluationInput,
  ): Promise<GovernedCandidateEvaluation> {
    const request = SelectedCandidateEvaluationInputSchema.parse(raw);
    const candidate = await this.verifySelectedCandidate(tenantId, request.candidate);
    return this.database.transaction(tenantId, (client) =>
      evaluateSelectedCandidate(client, { tenantId, request, candidate }),
    );
  }

  /** Official read through the active pointer with revocation-aware eligibility. */
  async queryPublishedSpace(
    tenantId: string,
    input: {
      vectorStoreSpaceId: string;
      queryEmbedding: readonly number[];
      resultLimit?: number;
      mode: PublishedQueryMode;
    },
  ): Promise<GovernedPublishedAnswer> {
    return this.database.transaction(tenantId, (client) =>
      queryPublishedSpace(client, {
        tenantId,
        vectorStoreSpaceId: input.vectorStoreSpaceId,
        embedding: input.queryEmbedding,
        ...(input.resultLimit === undefined ? {} : { resultLimit: input.resultLimit }),
        mode: input.mode,
      }),
    );
  }

  async verifyPublicationBaseline(
    tenantId: string,
    input: { vectorStoreSpaceId: string; queries: readonly { queryId: string; embedding: readonly number[] }[] },
  ): Promise<GovernedPublicationBaselineComparison> {
    return this.database.transaction(tenantId, (client) =>
      verifyPublicationBaseline(client, {
        tenantId,
        vectorStoreSpaceId: input.vectorStoreSpaceId,
        queries: input.queries,
      }),
    );
  }

  /** Reverifies the candidate outside the staging transaction; immutable rows only. */
  private async publicationCandidate(
    tenantId: string,
    input: GovernedPublicationInput,
  ): Promise<GovernedSelectedCandidateResult | undefined> {
    if (!input.candidate) {
      // Legacy count-based publication remains available only where no selection authority is configured.
      if (this.selection) throw new Error("PUBLICATION_SELECTED_CANDIDATE_REQUIRED");
      return undefined;
    }
    const candidate = await this.verifySelectedCandidate(tenantId, input.candidate);
    if (candidate.evidenceDigest !== input.candidateEvidenceDigest || !input.evaluationDigest)
      throw new Error("PUBLICATION_CANDIDATE_DIGEST_MISMATCH");
    return candidate;
  }

  private async bindPublicationCandidate(
    client: TenantSqlClient,
    tenantId: string,
    input: GovernedPublicationInput,
    candidate: GovernedSelectedCandidateResult | undefined,
    count: number,
  ): Promise<void> {
    if (!candidate || !input.candidate) return;
    const { expectedItemCount } = await assertPublicationCandidateBinding(client, {
      tenantId,
      candidate,
      evaluationResultId: input.evaluationResultId,
      evaluationDigest: input.evaluationDigest!,
      vectorSpaceVersionId: input.vectorSpaceVersionId,
      publisherIdentity: input.publisherIdentity,
      proposedBy: input.candidate.selection.proposedBy,
      requiredReviewer: input.candidate.selection.requiredReviewer,
    });
    if (expectedItemCount !== count) throw new Error("PUBLICATION_CANDIDATE_COUNT_MISMATCH");
  }

  async stagePublication(tenantId: string, input: GovernedPublicationInput): Promise<GovernedPublication> {
    const candidate = await this.publicationCandidate(tenantId, input);
    return this.database.transaction(tenantId, async (client) => {
      const context = await this.publicationContext(
        client,
        tenantId,
        input.vectorStoreSpaceId,
        input.vectorSpaceVersionId,
        input.promotionDecisionId,
        input.evaluationResultId,
      );
      if (context.ownerIdentity !== input.expectedOwnerIdentity) throw new Error("VECTOR_STORE_OWNER_MISMATCH");
      if (sameActorIdentity(context.reviewerIdentity, input.publisherIdentity))
        throw new Error("PUBLICATION_SEPARATION_OF_DUTY_VIOLATION");
      await this.bindPublicationCandidate(client, tenantId, input, candidate, context.count);
      await client.query(
        `insert into retrieval.space_publication
        (id,tenant_id,vector_store_space_id,vector_space_version_id,vector_item_manifest_sha256,embedding_manifest_sha256,index_manifest_sha256,
         evaluation_result_id,publication_decision_id,status,expected_item_count,operation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved',$10,$11) on conflict(id) do nothing`,
        [
          input.publicationId,
          tenantId,
          input.vectorStoreSpaceId,
          input.vectorSpaceVersionId,
          context.vectorManifest.slice(7),
          context.embeddingManifest.slice(7),
          context.indexManifest.slice(7),
          input.evaluationResultId,
          input.promotionDecisionId,
          context.count,
          input.operationId,
        ],
      );
      const stored = (
        await client.query<Row>("select * from retrieval.space_publication where tenant_id=$1 and id=$2", [
          tenantId,
          input.publicationId,
        ])
      ).rows[0];
      if (
        !stored ||
        String(stored.vector_item_manifest_sha256) !== context.vectorManifest.slice(7) ||
        String(stored.embedding_manifest_sha256) !== context.embeddingManifest.slice(7) ||
        String(stored.operation_id) !== input.operationId
      )
        throw new Error("PUBLICATION_REPLAY_CONFLICT");
      return {
        publicationId: input.publicationId,
        guardedDigest: context.guardedDigest,
        vectorSpaceVersionId: input.vectorSpaceVersionId,
        expectedItemCount: context.count,
        status: String(stored.status) as "approved" | "published",
      };
    });
  }

  async publishStaged(
    tenantId: string,
    publicationId: string,
    operationId: string,
    expectedGuardedDigest: `sha256:${string}`,
    reason: string,
    publisherIdentity: string,
    idempotencyKey: string,
  ): Promise<GovernedPublication> {
    return this.database.transaction(tenantId, async (client) => {
      const staged = (
        await client.query<Row>(
          `select p.*,d.reviewer_identity,d.guarded_sha256 from retrieval.space_publication p
        join retrieval.content_promotion_decision d on d.tenant_id=p.tenant_id and d.id=p.publication_decision_id
        where p.tenant_id=$1 and p.id=$2 and p.operation_id=$3`,
          [tenantId, publicationId, operationId],
        )
      ).rows[0];
      if (!staged || String(staged.guarded_sha256) !== expectedGuardedDigest.slice(7))
        throw new Error("PUBLICATION_GUARDED_DIGEST_MISMATCH");
      if (sameActorIdentity(String(staged.reviewer_identity), publisherIdentity))
        throw new Error("PUBLICATION_SEPARATION_OF_DUTY_VIOLATION");
      const durablePublisher = await operationActorIdentity({
        client,
        tenantId,
        operationId,
        claimedIdentity: publisherIdentity,
      });
      const receipt = (
        await client.query<Row>(
          `select id from knowledge_service.receipt where tenant_id=$1 and operation_id=$2
        and receipt_kind='publish.succeeded' and outcome='succeeded' order by created_at limit 1`,
          [tenantId, operationId],
        )
      ).rows[0];
      if (!receipt) throw new Error("PUBLICATION_STAGE_RECEIPT_REQUIRED");
      // Activation is the last point where a revocation can still stop official exposure.
      if (this.selection) {
        const eligible = await assertPublicationDependenciesEligible(client, tenantId, publicationId);
        if (eligible.itemCount !== Number(staged.expected_item_count))
          throw new Error("PUBLICATION_CANDIDATE_COUNT_MISMATCH");
      }
      const switchId = String(
        (
          await client.query<Row>("select retrieval.publish_vector_space($1,$2,$3,$4,$5) id", [
            publicationId,
            expectedGuardedDigest.slice(7),
            reason,
            durablePublisher,
            idempotencyKey,
          ])
        ).rows[0]!.id,
      );
      const authorizationId = deterministicUuid("authorized-publication", `${operationId}:${switchId}`);
      await client.query(
        `insert into retrieval.authorized_publication_execution
        (id,tenant_id,operation_id,switch_receipt_id,action,guarded_sha256,publisher_identity)
        values($1,$2,$3,$4,'publish',$5,$6) on conflict(id) do nothing`,
        [authorizationId, tenantId, operationId, switchId, expectedGuardedDigest.slice(7), durablePublisher],
      );
      return {
        publicationId,
        guardedDigest: expectedGuardedDigest,
        vectorSpaceVersionId: String(staged.vector_space_version_id),
        expectedItemCount: Number(staged.expected_item_count),
        status: "published",
        switchReceiptId: switchId,
      };
    });
  }

  async verifyPublication(tenantId: string, publicationId: string): Promise<GovernedPublication> {
    return this.database.transaction(tenantId, async (client) => {
      const row = (
        await client.query<Row>(
          `select p.*,d.guarded_sha256,s.active_space_version_id,
        (select count(*) from retrieval.vector_item_embedding_1536 e where e.tenant_id=p.tenant_id and e.vector_space_version_id=p.vector_space_version_id)::int actual
        from retrieval.space_publication p join retrieval.content_promotion_decision d on d.tenant_id=p.tenant_id and d.id=p.publication_decision_id
        join retrieval.vector_store_space s on s.tenant_id=p.tenant_id and s.id=p.vector_store_space_id where p.tenant_id=$1 and p.id=$2`,
          [tenantId, publicationId],
        )
      ).rows[0];
      if (
        !row ||
        row.status !== "published" ||
        String(row.active_space_version_id) !== String(row.vector_space_version_id) ||
        Number(row.actual) !== Number(row.expected_item_count)
      )
        throw new Error("PUBLICATION_VERIFICATION_FAILED");
      return {
        publicationId,
        guardedDigest: `sha256:${String(row.guarded_sha256)}`,
        vectorSpaceVersionId: String(row.vector_space_version_id),
        expectedItemCount: Number(row.expected_item_count),
        status: "published",
      };
    });
  }

  async planRollback(
    tenantId: string,
    currentPublicationId: string,
    targetPublicationId: string,
    publisherIdentity: string,
  ): Promise<{
    guardedDigest: `sha256:${string}`;
    vectorStoreSpaceId: string;
    frozenBaseline?: readonly { queryId: string; embeddingDigest: string }[];
  }> {
    return this.database.transaction(tenantId, async (client) => {
      const rows = (
        await client.query<Row>(
          `select p.id,p.vector_store_space_id,p.status,p.evaluation_result_id,d.guarded_sha256,d.reviewer_identity from retrieval.space_publication p
        join retrieval.content_promotion_decision d on d.tenant_id=p.tenant_id and d.id=p.publication_decision_id
        where p.tenant_id=$1 and p.id=any($2::uuid[])`,
          [tenantId, [currentPublicationId, targetPublicationId]],
        )
      ).rows;
      const current = rows.find((row) => String(row.id) === currentPublicationId),
        target = rows.find((row) => String(row.id) === targetPublicationId);
      if (
        !current ||
        !target ||
        current.status !== "published" ||
        String(current.vector_store_space_id) !== String(target.vector_store_space_id)
      )
        throw new Error("ROLLBACK_TARGET_INVALID");
      if (sameActorIdentity(String(target.reviewer_identity), publisherIdentity))
        throw new Error("ROLLBACK_SEPARATION_OF_DUTY_VIOLATION");
      let frozenBaseline: { queryId: string; embeddingDigest: string }[] | undefined;
      if (this.selection) {
        await assertPublicationDependenciesEligible(client, tenantId, targetPublicationId);
        const { observations } = await readGateObservations(client, tenantId, String(target.evaluation_result_id));
        frozenBaseline = (observations.answers as { queryId: string; embeddingDigest: string }[]).map((answer) => ({
          queryId: answer.queryId,
          embeddingDigest: answer.embeddingDigest,
        }));
      }
      return {
        guardedDigest: `sha256:${String(target.guarded_sha256)}`,
        vectorStoreSpaceId: String(target.vector_store_space_id),
        ...(frozenBaseline ? { frozenBaseline } : {}),
      };
    });
  }

  async executeRollback(
    tenantId: string,
    operationId: string,
    currentPublicationId: string,
    targetPublicationId: string,
    expectedGuardedDigest: `sha256:${string}`,
    reason: string,
    publisherIdentity: string,
    idempotencyKey: string,
  ): Promise<string> {
    return this.database.transaction(tenantId, async (client) => {
      const receipt = (
        await client.query<Row>(
          `select id from knowledge_service.receipt where tenant_id=$1 and operation_id=$2
        and receipt_kind='rollback.succeeded' and outcome='succeeded'`,
          [tenantId, operationId],
        )
      ).rows[0];
      if (!receipt) throw new Error("ROLLBACK_PLAN_RECEIPT_REQUIRED");
      if (this.selection) await assertPublicationDependenciesEligible(client, tenantId, targetPublicationId);
      const durablePublisher = await operationActorIdentity({
        client,
        tenantId,
        operationId,
        claimedIdentity: publisherIdentity,
      });
      const switchId = String(
        (
          await client.query<Row>("select retrieval.rollback_vector_space($1,$2,$3,$4,$5,$6,$7) id", [
            currentPublicationId,
            targetPublicationId,
            expectedGuardedDigest.slice(7),
            reason,
            durablePublisher,
            idempotencyKey,
            operationId,
          ])
        ).rows[0]!.id,
      );
      const authorizationId = deterministicUuid("authorized-publication", `${operationId}:${switchId}`);
      await client.query(
        `insert into retrieval.authorized_publication_execution
        (id,tenant_id,operation_id,switch_receipt_id,action,guarded_sha256,publisher_identity)
        values($1,$2,$3,$4,'rollback',$5,$6) on conflict(id) do nothing`,
        [authorizationId, tenantId, operationId, switchId, expectedGuardedDigest.slice(7), durablePublisher],
      );
      return switchId;
    });
  }

  private async publicationContext(
    client: TenantSqlClient,
    tenantId: string,
    storeSpaceId: string,
    versionId: string,
    decisionId: string,
    evaluationId: string,
  ) {
    const root = (
      await client.query<Row>(
        `select ss.authority_class,vs.owner_identity,vs.store_class,v.dims,v.precision,s.class space_class,
      d.guarded_sha256,d.reviewer_identity,g.passed from retrieval.vector_store_space ss
      join retrieval.vector_store vs on vs.tenant_id=ss.tenant_id and vs.id=ss.vector_store_id
      join retrieval.vector_space s on s.tenant_id=ss.tenant_id and s.id=ss.vector_space_id
      join retrieval.vector_space_version v on v.tenant_id=ss.tenant_id and v.id=$3 and v.vector_space_id=s.id
      join retrieval.content_promotion_decision d on d.tenant_id=ss.tenant_id and d.id=$4 and d.decision='accept' and (d.expires_at is null or d.expires_at>now())
      join evaluation.promotion_gate_result g on g.tenant_id=ss.tenant_id and g.id=$5 and g.passed
      where ss.tenant_id=$1 and ss.id=$2`,
        [tenantId, storeSpaceId, versionId, decisionId, evaluationId],
      )
    ).rows[0];
    if (!root || Number(root.dims) !== 1536 || String(root.precision) !== "halfvec")
      throw new Error("PUBLICATION_GATE_CONFIGURATION_REJECTED");
    const compatible =
      (root.store_class === "official" && root.authority_class === "official" && root.space_class === "canonical") ||
      (root.store_class === "exploratory" &&
        root.authority_class === "exploratory" &&
        root.space_class === "exploratory") ||
      (root.store_class === "user_managed" && root.authority_class === "user_managed");
    if (!compatible) throw new Error("PUBLICATION_AUTHORITY_CLASS_MISMATCH");
    const rows = (
      await client.query<Row>(
        `select v.id,v.search_projection_id,v.content_sha256,v.embedding_item_id,e.output_sha256,x.embedding_sha256
      from retrieval.vector_item v join retrieval.embedding_item e on e.tenant_id=v.tenant_id and e.id=v.embedding_item_id
      join retrieval.embedding_run r on r.tenant_id=e.tenant_id and r.id=e.embedding_run_id and r.promotion_decision_id=$3
      join retrieval.vector_item_embedding_1536 x on x.tenant_id=v.tenant_id and x.vector_item_id=v.id and x.vector_space_version_id=v.space_version_id
      where v.tenant_id=$1 and v.space_version_id=$2 and v.verification_state='verified' and v.lifecycle='active'
        and exists(select 1 from retrieval.search_projection_chunk_support s where s.tenant_id=v.tenant_id and s.search_projection_id=v.search_projection_id)
      order by v.id`,
        [tenantId, versionId, decisionId],
      )
    ).rows;
    if (!rows.length) throw new Error("PUBLICATION_ITEMS_MISSING");
    const vectorManifest = digest(
      rows.map((row) => ({
        id: String(row.id),
        projectionId: String(row.search_projection_id),
        content: String(row.content_sha256),
        embeddingItemId: String(row.embedding_item_id),
        output: String(row.output_sha256),
      })),
    );
    const embeddingManifest = digest(
      rows.map((row) => ({
        vectorItemId: String(row.id),
        embeddingItemId: String(row.embedding_item_id),
        output: String(row.embedding_sha256),
      })),
    );
    const indexManifest = digest({
      backend: "pgvector-hnsw-halfvec",
      vectorSpaceVersionId: versionId,
      count: rows.length,
    });
    return {
      count: rows.length,
      vectorManifest,
      embeddingManifest,
      indexManifest,
      guardedDigest: `sha256:${String(root.guarded_sha256)}` as `sha256:${string}`,
      ownerIdentity: String(root.owner_identity),
      reviewerIdentity: String(root.reviewer_identity),
    };
  }
}
