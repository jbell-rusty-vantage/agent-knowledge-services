import {
  JsonValueSchema,
  SelectedCandidateEvaluationInputSchema,
  type SelectedCandidateEvaluationInput,
} from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import type { TenantSqlClient } from "./postgres.js";
import { readContentRepresentationAdmission } from "./content-representation-admission.js";
import { readRepresentationDependencies } from "./representation-dependency.js";
import { sameActorIdentity } from "./actor-identity.js";
import type {
  GovernedCandidateEvaluation,
  GovernedPublishedAnswer,
  GovernedPublicationBaselineComparison,
  GovernedSelectedCandidateResult,
  PublishedQueryMode,
} from "./types.js";

type Row = Record<string, unknown>;
const hex = (value: unknown) => sha256Digest(JsonValueSchema.parse(value)).slice(7);
const digest = (value: unknown) => `sha256:${hex(value)}` as const;
const halfvec = (values: readonly number[]) =>
  `[${values.map((value) => (Object.is(value, -0) ? "0" : String(value))).join(",")}]`;
function fail(code: string): never {
  throw new Error(code);
}

function vectorBindings(vectorIds: readonly string[], physicalDigests: readonly string[]) {
  if (vectorIds.length !== physicalDigests.length) fail("PUBLICATION_VECTOR_BINDING_INVALID");
  return vectorIds
    .map((vectorItemId, index) => ({ vectorItemId, physicalDigest: physicalDigests[index]! }))
    .sort((left, right) => left.vectorItemId.localeCompare(right.vectorItemId));
}

function physicalBindings(rows: readonly Row[]) {
  return vectorBindings(
    rows.map((row) => String(row.vector_item_id)),
    rows.map((row) => String(row.physical_embedding_sha256)),
  );
}

export const CANDIDATE_EVALUATION_GATE = "selected-candidate-activation";
const CANDIDATE_EVALUATION_GATE_VERSION = 2;
const GATE_DEFINITION = Object.freeze({
  schemaVersion: "knowledge.selected-candidate-gate/v2",
  requires: [
    "exact_candidate_membership",
    "physical_index_ready",
    "finite_ordered_embeddings",
    "vector_id_digest_binding",
    "required_dependency_eligibility",
    "independent_evaluation",
    "exact_versus_ann_equivalence",
  ],
});

/**
 * Physical candidate rows for one space version, with the checks publication
 * needs: real index readiness, finite components, and receipt-ordered items.
 */
async function physicalCandidateRows(client: TenantSqlClient, tenantId: string, versionId: string): Promise<Row[]> {
  return (
    await client.query<Row>(
      `select v.id vector_item_id,v.search_projection_id,v.lifecycle,v.verification_state,
      e.embedding_run_id,e.status embedding_status,e.input_sha256,e.provider_metadata->>'index' ordinal,
      p.embedding_text_sha256,x.vector_space_key,x.physical_embedding_sha256,
      extensions.vector_dims(x.embedding::extensions.vector) dimensions,
      (select bool_and(component = component and abs(component::float8) < 'Infinity'::float8)
        from unnest(x.embedding::extensions.vector::real[]) component) finite,
      x.physical_embedding_sha256=encode(extensions.digest(x.embedding::text,'sha256'),'hex') physical_digest_verified,
      exists(select 1 from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid
        join pg_catalog.pg_am am on am.oid=c.relam join pg_catalog.pg_opclass op on op.oid=i.indclass[0]
        where i.indrelid=x.tableoid and i.indisvalid and i.indisready and am.amname='hnsw'
          and op.opcname='halfvec_cosine_ops' and i.indpred is null and i.indexprs is null) index_ready
    from retrieval.vector_item v
    join retrieval.embedding_item e on e.tenant_id=v.tenant_id and e.id=v.embedding_item_id
    join retrieval.vector_item_embedding_1536 x on x.tenant_id=v.tenant_id and x.vector_item_id=v.id
    join retrieval.search_projection p on p.tenant_id=v.tenant_id and p.id=v.search_projection_id
    where v.tenant_id=$1 and v.space_version_id=$2 order by v.search_projection_id,v.id`,
      [tenantId, versionId],
    )
  ).rows;
}

function assertPhysicalIntegrity(
  rows: readonly Row[],
  projectionIds: readonly string[],
  embeddingRunId: string,
  space: string,
): void {
  if (
    rows.length !== projectionIds.length ||
    digest(rows.map((row) => String(row.search_projection_id)).sort()) !== digest([...projectionIds].sort())
  )
    fail("PUBLICATION_CANDIDATE_MEMBERSHIP_MISMATCH");
  const ordinals = new Set<number>();
  for (const row of rows) {
    const ordinal = Number(row.ordinal);
    if (
      row.embedding_run_id !== embeddingRunId ||
      row.embedding_status !== "succeeded" ||
      row.lifecycle !== "active" ||
      row.verification_state !== "verified" ||
      row.vector_space_key !== space ||
      Number(row.dimensions) !== 1536 ||
      row.finite !== true ||
      row.physical_digest_verified !== true ||
      row.input_sha256 !== row.embedding_text_sha256
    )
      fail("PUBLICATION_CANDIDATE_VECTOR_INVALID");
    if (row.index_ready !== true) fail("PUBLICATION_PHYSICAL_INDEX_NOT_READY");
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= rows.length || ordinals.has(ordinal))
      fail("PUBLICATION_CANDIDATE_ORDER_INVALID");
    ordinals.add(ordinal);
  }
}

export interface PublishedItem {
  readonly vectorItemId: string;
  readonly searchProjectionId: string;
  readonly score: number;
}

const QUERY_EMBEDDING_DIMENSIONS = 1536;
const ANN_HNSW_EF_SEARCH = 200;

/**
 * Transaction-local planner isolation for one ranked arm. Complementary
 * settings are restored with SET LOCAL before the arm's own constraints, so
 * exact cannot leave ANN on a sequential-scan-only plan (or the reverse).
 */
export async function applyPublishedQueryPlanner(client: TenantSqlClient, mode: PublishedQueryMode): Promise<void> {
  if (mode === "ann") {
    await client.query("set local enable_indexscan=on");
    await client.query("set local enable_bitmapscan=on");
    await client.query("set local enable_seqscan=off");
    await client.query(`set local hnsw.ef_search=${ANN_HNSW_EF_SEARCH}`);
    return;
  }
  await client.query("set local enable_seqscan=on");
  await client.query("set local hnsw.ef_search to default");
  await client.query("set local enable_indexscan=off");
  await client.query("set local enable_bitmapscan=off");
}

/** Every EXPLAIN row, not the first line alone. */
export function explainedPlanText(rows: readonly Row[]): string {
  return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
}

function planUsesHnswAccess(plan: string): boolean {
  const text = plan.toLowerCase();
  return text.split("\n").some((line) => /^\s*(?:->\s*)?index scan (?:backward )?using \S*hnsw\S* on\s/.test(line));
}

export function publishedRecallAtK(
  exactItems: readonly Pick<PublishedItem, "vectorItemId">[],
  annItems: readonly Pick<PublishedItem, "vectorItemId">[],
): number {
  if (exactItems.length === 0) return 0;
  const exactIds = new Set(exactItems.map((item) => item.vectorItemId));
  return annItems.filter((item) => exactIds.has(item.vectorItemId)).length / exactItems.length;
}

const VECTOR_SPACE_PARTITIONS = Object.freeze({
  engineering_claims: "retrieval.vector_item_embedding_1536_engineering_claims",
  tool_capabilities: "retrieval.vector_item_embedding_1536_tool_capabilities",
  implementation_examples: "retrieval.vector_item_embedding_1536_implementation_examples",
  paper_case_study_knowledge: "retrieval.vector_item_embedding_1536_paper_case_study_knowledge",
  entity_profiles: "retrieval.vector_item_embedding_1536_entity_profiles",
  model_capabilities: "retrieval.vector_item_embedding_1536_model_capabilities",
  benchmark_intelligence: "retrieval.vector_item_embedding_1536_benchmark_intelligence",
  entity_timeline: "retrieval.vector_item_embedding_1536_entity_timeline",
  market_intelligence: "retrieval.vector_item_embedding_1536_market_intelligence",
  document_summaries: "retrieval.vector_item_embedding_1536_document_summaries",
  source_native_sections: "retrieval.vector_item_embedding_1536_source_native_sections",
});

function embeddingPartition(space: string): string {
  const table = VECTOR_SPACE_PARTITIONS[space as keyof typeof VECTOR_SPACE_PARTITIONS];
  if (!table) fail("PUBLICATION_VECTOR_SPACE_UNKNOWN");
  return table;
}

export interface RankedPublishedItemsInput {
  readonly tenantId: string;
  readonly versionId: string;
  readonly embedding: readonly number[];
  readonly resultLimit: number;
  readonly mode: PublishedQueryMode;
  readonly vectorSpaceKey: string;
}

/**
 * One ranked read of a physical space. `ann` forces the real HNSW index; `exact`
 * forces a full scan of the same rows. The chosen plan is returned, never assumed.
 * ANN reads the space partition first: the parent table plus a join does not
 * choose HNSW, even with seqscan off and a vector_space_key predicate.
 */
export async function rankedItems(
  client: TenantSqlClient,
  input: RankedPublishedItemsInput,
): Promise<{ items: PublishedItem[]; plan: string }> {
  if (input.embedding.length !== QUERY_EMBEDDING_DIMENSIONS) fail("PUBLICATION_QUERY_DIMENSIONS_INVALID");
  if (input.embedding.some((value) => !Number.isFinite(value))) fail("PUBLICATION_QUERY_VECTOR_INVALID");
  const partition = embeddingPartition(input.vectorSpaceKey);
  await applyPublishedQueryPlanner(client, input.mode);
  const sql = `select x.vector_item_id,v.search_projection_id,
      1-(x.embedding operator(extensions.<=>) $2::extensions.halfvec(1536)) score
    from (
      select vector_item_id,tenant_id,embedding
      from ${partition}
      where tenant_id=$1 and vector_space_version_id=$3
      order by embedding operator(extensions.<=>) $2::extensions.halfvec(1536)
      limit $4
    ) x
    join retrieval.vector_item v on v.tenant_id=x.tenant_id and v.id=x.vector_item_id
    where v.lifecycle='active'
    order by x.embedding operator(extensions.<=>) $2::extensions.halfvec(1536),x.vector_item_id`;
  const values = [input.tenantId, halfvec(input.embedding), input.versionId, input.resultLimit];
  const plan = explainedPlanText((await client.query<Row>(`explain (format text) ${sql}`, values)).rows);
  if (input.mode === "ann" && !planUsesHnswAccess(plan)) fail("PUBLICATION_ANN_PLAN_NOT_HNSW");
  const rows = (await client.query<Row>(sql, values)).rows;
  return {
    items: rows.map((row) => ({
      vectorItemId: String(row.vector_item_id),
      searchProjectionId: String(row.search_projection_id),
      score: Number(row.score),
    })),
    plan,
  };
}

interface DependencyState {
  readonly eligible: boolean;
  readonly revoked: readonly string[];
}

/**
 * Required-dependency eligibility for one physical item. Revoking a source
 * representation, retiring a target or superseding a summary gates it on the
 * next official query; no cached admission survives the newer decision.
 */
async function itemEligibility(
  client: TenantSqlClient,
  tenantId: string,
  vectorItemId: string,
): Promise<DependencyState> {
  const revoked: string[] = [];
  const rows = (
    await client.query<Row>(
      `select distinct r.id representation_id,r.content_sha256,
      t.retired_at,t.target_kind,t.summary_id,t.record_id,t.claim_id,
      s.lifecycle summary_lifecycle,s.representation_id summary_representation_id,c.status claim_status,rc.status record_claim_status
    from retrieval.vector_item v
    join retrieval.search_projection p on p.tenant_id=v.tenant_id and p.id=v.search_projection_id
    join retrieval.projection_target t on t.tenant_id=p.tenant_id and t.id=p.projection_target_id
    join retrieval.search_projection_chunk_support sup on sup.tenant_id=p.tenant_id and sup.search_projection_id=p.id
    join retrieval.retrieval_chunk rch on rch.tenant_id=sup.tenant_id and rch.id=sup.chunk_id
    join retrieval.chunk_set cs on cs.tenant_id=rch.tenant_id and cs.id=rch.chunk_set_id
    join content.document_representation r on r.tenant_id=cs.tenant_id and r.id=cs.representation_id
    left join content.document_summary s on s.tenant_id=t.tenant_id and s.id=t.summary_id
    left join evidence.claim c on c.tenant_id=t.tenant_id and c.id=t.claim_id
    left join knowledge.record kr on kr.tenant_id=t.tenant_id and kr.id=t.record_id
    left join evidence.claim rc on rc.tenant_id=kr.tenant_id and rc.id=kr.provenance_claim_id
    where v.tenant_id=$1 and v.id=$2`,
      [tenantId, vectorItemId],
    )
  ).rows;
  if (!rows.length) return { eligible: false, revoked: ["MISSING_DEPENDENCY_CLOSURE"] };
  for (const row of rows) {
    if (row.retired_at !== null) revoked.push("PROJECTION_TARGET_RETIRED");
    if (row.target_kind === "summary" && row.summary_lifecycle !== "active") revoked.push("SUMMARY_NOT_ACTIVE");
    if (row.target_kind === "claim" && row.claim_status !== "verified") revoked.push("CLAIM_NOT_VERIFIED");
    if (row.target_kind === "record" && row.record_claim_status !== "verified")
      revoked.push("RECORD_CLAIM_NOT_VERIFIED");
    const admission = await readContentRepresentationAdmission(client, {
      tenantId,
      representationId: String(row.representation_id),
      guardedDigest: `sha256:${String(row.content_sha256)}`,
    });
    if (!admission.accepted) revoked.push(`SOURCE_REPRESENTATION_NOT_ADMITTED:${String(row.representation_id)}`);
    for (const representationId of [row.representation_id, row.summary_representation_id].filter(
      (value) => typeof value === "string",
    )) {
      const dependencies = await readRepresentationDependencies(client, tenantId, String(representationId));
      revoked.push(...dependencies.blocked);
    }
  }
  const unique = [...new Set(revoked)].sort();
  return { eligible: unique.length === 0, revoked: unique };
}

export interface EvaluateSelectedCandidateInput {
  readonly tenantId: string;
  readonly request: SelectedCandidateEvaluationInput;
  readonly candidate: GovernedSelectedCandidateResult;
}

/**
 * Independent evaluation of the exact verified candidate. Membership, physical
 * readiness and dependency eligibility are rechecked here; the recorded gate
 * result is the only thing publication may later rely on.
 */
export async function evaluateSelectedCandidate(
  client: TenantSqlClient,
  input: EvaluateSelectedCandidateInput,
): Promise<GovernedCandidateEvaluation> {
  const request = SelectedCandidateEvaluationInputSchema.parse(input.request);
  const { tenantId, candidate } = input;
  if (candidate.evidenceDigest !== request.candidateEvidenceDigest) fail("EVALUATION_CANDIDATE_DIGEST_MISMATCH");
  const selection = request.candidate.selection;
  if (
    sameActorIdentity(request.evaluatorIdentity, selection.proposedBy) ||
    sameActorIdentity(request.evaluatorIdentity, selection.requiredReviewer)
  )
    fail("EVALUATION_SEPARATION_OF_DUTY_VIOLATION");
  const datasetId = deterministicUuid("selected-candidate-eval-dataset", `${tenantId}:${candidate.evidenceDigest}`);
  const gateVersionId = deterministicUuid("selected-candidate-gate", `${tenantId}:${hex(GATE_DEFINITION)}`);
  await client.query(
    `insert into evaluation.eval_dataset(id,tenant_id,slug,purpose,description)
    values($1,$2,$3,'Frozen selected-candidate activation dataset',$4) on conflict(id) do nothing`,
    [
      datasetId,
      tenantId,
      `selected-candidate-${candidate.evidenceDigest.slice(7, 39)}`,
      `Exact selected membership for selection ${candidate.selectionDigest}`,
    ],
  );
  await client.query(
    `insert into evaluation.promotion_gate_version(id,tenant_id,slug,version,definition,definition_sha256)
    values($1,$2,$3,$4,$5::jsonb,$6) on conflict(id) do nothing`,
    [
      gateVersionId,
      tenantId,
      CANDIDATE_EVALUATION_GATE,
      CANDIDATE_EVALUATION_GATE_VERSION,
      JSON.stringify(GATE_DEFINITION),
      hex(GATE_DEFINITION),
    ],
  );

  const spaces: GovernedCandidateEvaluation["spaces"][number][] = [];
  for (const space of candidate.spaces) {
    const binding = request.candidate.embeddings.find(
      (item) => item.vectorSpaceVersionId === space.vectorSpaceVersionId,
    );
    if (!binding) fail("EVALUATION_CANDIDATE_SPACE_MISSING");
    const physical = await physicalCandidateRows(client, tenantId, space.vectorSpaceVersionId);
    assertPhysicalIntegrity(physical, binding.projectionIds, space.embeddingRunId, space.space);
    if (digest(physicalBindings(physical)) !== digest(vectorBindings(space.vectorIds, space.physicalDigests)))
      fail("EVALUATION_CANDIDATE_PHYSICAL_MISMATCH");
    for (const row of physical) {
      const eligibility = await itemEligibility(client, tenantId, String(row.vector_item_id));
      if (!eligibility.eligible) fail(`EVALUATION_DEPENDENCY_INELIGIBLE:${eligibility.revoked.join(",")}`);
    }
    const answers: GovernedCandidateEvaluation["spaces"][number]["answers"][number][] = [];
    let plan = "";
    let minimumRecall = 1;
    for (const query of request.queries) {
      const exact = await rankedItems(client, {
        tenantId,
        versionId: space.vectorSpaceVersionId,
        embedding: query.embedding,
        resultLimit: request.resultLimit,
        mode: "exact",
        vectorSpaceKey: space.space,
      });
      const ann = await rankedItems(client, {
        tenantId,
        versionId: space.vectorSpaceVersionId,
        embedding: query.embedding,
        resultLimit: request.resultLimit,
        mode: "ann",
        vectorSpaceKey: space.space,
      });
      const recallAtK = publishedRecallAtK(exact.items, ann.items);
      if (recallAtK < request.minimumRecallAtK) fail("EVALUATION_ANN_RECALL_BELOW_MINIMUM");
      minimumRecall = Math.min(minimumRecall, recallAtK);
      plan = ann.plan;
      answers.push({
        queryId: query.queryId,
        embeddingDigest: digest([...query.embedding]),
        recallAtK,
        exact: exact.items,
        ann: ann.items,
      });
    }
    const evaluationIdentity = `${tenantId}:${candidate.evidenceDigest}:${space.vectorSpaceVersionId}:${gateVersionId}`;
    const evalRunId = deterministicUuid("selected-candidate-eval-run", evaluationIdentity);
    const observations = {
      schemaVersion: "knowledge.selected-candidate-gate-observations/v1",
      candidateEvidenceDigest: candidate.evidenceDigest,
      selectionDigest: candidate.selectionDigest,
      evaluatorIdentity: request.evaluatorIdentity,
      vectorSpaceVersionId: space.vectorSpaceVersionId,
      space: space.space,
      projectionIds: [...binding.projectionIds].sort(),
      vectorIds: [...space.vectorIds].sort(),
      physicalDigests: [...space.physicalDigests].sort(),
      embeddingRunId: space.embeddingRunId,
      vectorBindings: physicalBindings(physical),
      resultLimit: request.resultLimit,
      minimumRecallAtK: request.minimumRecallAtK,
      annPlan: plan,
      answers,
    };
    const resultId = deterministicUuid("selected-candidate-gate-result", evaluationIdentity);
    const baselineId = deterministicUuid("selected-candidate-baseline", evaluationIdentity);
    const caseId = deterministicUuid(
      "selected-candidate-eval-case",
      `${tenantId}:${candidate.evidenceDigest}:${space.vectorSpaceVersionId}`,
    );
    await client.query(
      `insert into evaluation.eval_case(id,tenant_id,dataset_id,external_key,input,expected,metadata)
      values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb) on conflict(id) do nothing`,
      [
        caseId,
        tenantId,
        datasetId,
        `${space.space}:${space.vectorSpaceVersionId}`,
        JSON.stringify({
          queries: answers.map((answer) => ({ queryId: answer.queryId, embeddingDigest: answer.embeddingDigest })),
        }),
        JSON.stringify({ vectorIds: observations.vectorIds }),
        JSON.stringify({ selectionDigest: candidate.selectionDigest }),
      ],
    );
    await client.query(
      `insert into evaluation.eval_run(id,tenant_id,dataset_id,space_version_id,config,code_ref)
      values($1,$2,$3,$4,$5::jsonb,'packages/persistence/src/publication-evaluation.ts') on conflict(id) do nothing`,
      [
        evalRunId,
        tenantId,
        datasetId,
        space.vectorSpaceVersionId,
        JSON.stringify({
          evaluatorIdentity: request.evaluatorIdentity,
          candidateEvidenceDigest: candidate.evidenceDigest,
        }),
      ],
    );
    await client.query(
      `insert into evaluation.eval_run_case_output(id,tenant_id,eval_run_id,eval_case_id,candidates,answer,output_sha256)
      values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) on conflict(id) do nothing`,
      [
        deterministicUuid("selected-candidate-eval-output", `${evalRunId}:${caseId}`),
        tenantId,
        evalRunId,
        caseId,
        JSON.stringify(answers.map((answer) => ({ queryId: answer.queryId, exact: answer.exact }))),
        JSON.stringify(answers.map((answer) => ({ queryId: answer.queryId, ann: answer.ann }))),
        hex(answers),
      ],
    );
    await client.query(
      `insert into evaluation.promotion_gate_result
      (id,tenant_id,gate_version_id,eval_run_id,passed,false_acceptance_count,observations,result_sha256)
      values($1,$2,$3,$4,true,0,$5::jsonb,$6) on conflict(id) do nothing`,
      [resultId, tenantId, gateVersionId, evalRunId, JSON.stringify(observations), hex(observations)],
    );
    await client.query(
      `insert into evaluation.regression_baseline(id,tenant_id,name,gate_result_id,vector_space_version_id,baseline_sha256)
      values($1,$2,$3,$4,$5,$6) on conflict(id) do nothing`,
      [
        baselineId,
        tenantId,
        `selected-candidate:${space.space}:${candidate.evidenceDigest.slice(7, 23)}`,
        resultId,
        space.vectorSpaceVersionId,
        hex(answers),
      ],
    );
    const stored = (
      await client.query<Row>(
        `select g.passed,g.result_sha256,g.observations,b.baseline_sha256
      from evaluation.promotion_gate_result g
      join evaluation.regression_baseline b on b.tenant_id=g.tenant_id and b.gate_result_id=g.id and b.id=$3
      where g.tenant_id=$1 and g.id=$2`,
        [tenantId, resultId, baselineId],
      )
    ).rows[0];
    if (
      !stored ||
      stored.passed !== true ||
      stored.result_sha256 !== hex(observations) ||
      digest(stored.observations) !== digest(observations) ||
      stored.baseline_sha256 !== hex(answers)
    )
      fail("EVALUATION_RESULT_REPLAY_CONFLICT");
    spaces.push({
      vectorSpaceVersionId: space.vectorSpaceVersionId,
      space: space.space,
      evalRunId,
      evaluationResultId: resultId,
      resultDigest: digest(observations),
      baselineId,
      itemCount: physical.length,
      annPlan: plan,
      recallAtK: minimumRecall,
      answers,
    });
  }
  const evaluation = {
    schemaVersion: "knowledge.selected-candidate-evaluation-result/v1" as const,
    candidateEvidenceDigest: candidate.evidenceDigest,
    selectionDigest: candidate.selectionDigest,
    evaluatorIdentity: request.evaluatorIdentity,
    passed: true as const,
    spaces,
  };
  return { ...evaluation, evaluationDigest: digest(evaluation) };
}

/** Immutable gate observations recorded by `evaluateSelectedCandidate`. */
export async function readGateObservations(
  client: TenantSqlClient,
  tenantId: string,
  evaluationResultId: string,
): Promise<{ observations: Row; resultDigest: `sha256:${string}` }> {
  const row = (
    await client.query<Row>(
      `select g.observations,g.passed,g.result_sha256,v.slug gate_slug
    from evaluation.promotion_gate_result g
    join evaluation.promotion_gate_version v on v.tenant_id=g.tenant_id and v.id=g.gate_version_id
    where g.tenant_id=$1 and g.id=$2`,
      [tenantId, evaluationResultId],
    )
  ).rows[0];
  if (
    !row ||
    row.passed !== true ||
    row.gate_slug !== CANDIDATE_EVALUATION_GATE ||
    hex(row.observations) !== row.result_sha256
  )
    fail("PUBLICATION_EVALUATION_GATE_INVALID");
  return { observations: row.observations as Row, resultDigest: `sha256:${String(row.result_sha256)}` };
}

export interface PublicationCandidateBindingInput {
  readonly tenantId: string;
  readonly candidate: GovernedSelectedCandidateResult;
  readonly evaluationResultId: string;
  readonly evaluationDigest: string;
  readonly vectorSpaceVersionId: string;
  readonly publisherIdentity: string;
  readonly proposedBy: string;
  readonly requiredReviewer: string;
}

/**
 * Publication may activate only the exact evaluated candidate. Separation of
 * duties covers proposer, reviewer, evaluator and publisher.
 */
export async function assertPublicationCandidateBinding(
  client: TenantSqlClient,
  input: PublicationCandidateBindingInput,
): Promise<{ expectedItemCount: number }> {
  const { observations, resultDigest } = await readGateObservations(client, input.tenantId, input.evaluationResultId);
  if (resultDigest !== input.evaluationDigest) fail("PUBLICATION_EVALUATION_DIGEST_MISMATCH");
  const space = input.candidate.spaces.find((item) => item.vectorSpaceVersionId === input.vectorSpaceVersionId);
  if (!space) fail("PUBLICATION_CANDIDATE_SPACE_MISSING");
  if (
    observations.candidateEvidenceDigest !== input.candidate.evidenceDigest ||
    observations.selectionDigest !== input.candidate.selectionDigest ||
    observations.vectorSpaceVersionId !== input.vectorSpaceVersionId ||
    digest(observations.vectorBindings ?? null) !== digest(vectorBindings(space.vectorIds, space.physicalDigests)) ||
    digest(observations.vectorIds) !== digest([...space.vectorIds].sort()) ||
    digest(observations.physicalDigests) !== digest([...space.physicalDigests].sort())
  )
    fail("PUBLICATION_EVALUATION_CANDIDATE_MISMATCH");
  const evaluator = String(observations.evaluatorIdentity);
  if (
    [input.proposedBy, input.requiredReviewer, evaluator].some((identity) =>
      sameActorIdentity(identity, input.publisherIdentity),
    ) ||
    sameActorIdentity(evaluator, input.proposedBy) ||
    sameActorIdentity(evaluator, input.requiredReviewer)
  )
    fail("PUBLICATION_SEPARATION_OF_DUTY_VIOLATION");
  const physical = await physicalCandidateRows(client, input.tenantId, input.vectorSpaceVersionId);
  assertPhysicalIntegrity(physical, observations.projectionIds as string[], space.embeddingRunId, space.space);
  if (digest(physicalBindings(physical)) !== digest(observations.vectorBindings ?? null))
    fail("PUBLICATION_EVALUATED_VECTOR_DRIFT");
  for (const row of physical) {
    const eligibility = await itemEligibility(client, input.tenantId, String(row.vector_item_id));
    if (!eligibility.eligible) fail(`PUBLICATION_DEPENDENCY_INELIGIBLE:${eligibility.revoked.join(",")}`);
  }
  return { expectedItemCount: physical.length };
}

/**
 * Re-checks one staged or target publication against its own evaluated gate
 * immediately before a pointer switch. A dependency revoked since evaluation
 * stops activation and rollback, not only future queries.
 */
export async function assertPublicationDependenciesEligible(
  client: TenantSqlClient,
  tenantId: string,
  publicationId: string,
): Promise<{ itemCount: number }> {
  const row = (
    await client.query<Row>(
      `select vector_space_version_id,evaluation_result_id
    from retrieval.space_publication where tenant_id=$1 and id=$2`,
      [tenantId, publicationId],
    )
  ).rows[0];
  if (!row || !row.evaluation_result_id) fail("PUBLICATION_EVALUATION_REQUIRED");
  const { observations } = await readGateObservations(client, tenantId, String(row.evaluation_result_id));
  if (observations.vectorSpaceVersionId !== String(row.vector_space_version_id))
    fail("PUBLICATION_EVALUATION_SPACE_MISMATCH");
  const physical = await physicalCandidateRows(client, tenantId, String(row.vector_space_version_id));
  assertPhysicalIntegrity(
    physical,
    observations.projectionIds as string[],
    String(observations.embeddingRunId),
    String(observations.space),
  );
  if (digest(physicalBindings(physical)) !== digest(observations.vectorBindings ?? null))
    fail("PUBLICATION_EVALUATED_VECTOR_DRIFT");
  for (const item of physical) {
    const eligibility = await itemEligibility(client, tenantId, String(item.vector_item_id));
    if (!eligibility.eligible) fail(`PUBLICATION_DEPENDENCY_INELIGIBLE:${eligibility.revoked.join(",")}`);
  }
  return { itemCount: physical.length };
}

export interface PublishedQueryInput {
  readonly tenantId: string;
  readonly vectorStoreSpaceId: string;
  readonly embedding: readonly number[];
  readonly resultLimit?: number;
  readonly mode: PublishedQueryMode;
}

/**
 * Official read through the active publication pointer. Items whose required
 * dependencies were revoked are gated immediately; the recorded set stays
 * available only as explicitly labelled historical access.
 */
export async function queryPublishedSpace(
  client: TenantSqlClient,
  input: PublishedQueryInput,
): Promise<GovernedPublishedAnswer> {
  const pointer = (
    await client.query<Row>(
      `select s.active_space_version_id,p.id publication_id,p.status,p.expected_item_count,vs.slug
    from retrieval.vector_store_space s
    join retrieval.vector_space vs on vs.tenant_id=s.tenant_id and vs.id=s.vector_space_id
    left join retrieval.space_publication p on p.tenant_id=s.tenant_id and p.vector_store_space_id=s.id
      and p.vector_space_version_id=s.active_space_version_id and p.status='published'
    where s.tenant_id=$1 and s.id=$2`,
      [input.tenantId, input.vectorStoreSpaceId],
    )
  ).rows[0];
  if (!pointer || !pointer.active_space_version_id || !pointer.publication_id)
    fail("PUBLICATION_ACTIVE_POINTER_MISSING");
  const versionId = String(pointer.active_space_version_id);
  const ranked = await rankedItems(client, {
    tenantId: input.tenantId,
    versionId,
    embedding: input.embedding,
    resultLimit: input.resultLimit ?? 20,
    mode: input.mode,
    vectorSpaceKey: String(pointer.slug),
  });
  const items: PublishedItem[] = [];
  const gated: { vectorItemId: string; revoked: readonly string[] }[] = [];
  for (const item of ranked.items) {
    const eligibility = await itemEligibility(client, input.tenantId, item.vectorItemId);
    if (eligibility.eligible) items.push(item);
    else gated.push({ vectorItemId: item.vectorItemId, revoked: eligibility.revoked });
  }
  return {
    publicationId: String(pointer.publication_id),
    vectorSpaceVersionId: versionId,
    mode: input.mode,
    annPlan: ranked.plan,
    items,
    gated,
    historical: ranked.items,
  };
}

export interface PublicationBaselineInput {
  readonly tenantId: string;
  readonly vectorStoreSpaceId: string;
  readonly queries: readonly { readonly queryId: string; readonly embedding: readonly number[] }[];
}

/**
 * Rollback proof: the restored pointer must reproduce the evaluated baseline
 * answer set for the same frozen queries, with dependency gating reapplied.
 */
export async function verifyPublicationBaseline(
  client: TenantSqlClient,
  input: PublicationBaselineInput,
): Promise<GovernedPublicationBaselineComparison> {
  if (input.queries.length === 0 || new Set(input.queries.map((query) => query.queryId)).size !== input.queries.length)
    fail("PUBLICATION_BASELINE_QUERY_MISMATCH");
  const row = (
    await client.query<Row>(
      `select p.id,p.evaluation_result_id,p.vector_space_version_id,p.vector_store_space_id,p.status,
      s.active_space_version_id from retrieval.vector_store_space s
    join retrieval.space_publication p on p.tenant_id=s.tenant_id and p.vector_store_space_id=s.id
      and p.vector_space_version_id=s.active_space_version_id and p.status='published'
    where s.tenant_id=$1 and s.id=$2`,
      [input.tenantId, input.vectorStoreSpaceId],
    )
  ).rows[0];
  if (!row || !row.evaluation_result_id) fail("PUBLICATION_BASELINE_TARGET_INVALID");
  const publicationId = String(row.id);
  const { observations } = await readGateObservations(client, input.tenantId, String(row.evaluation_result_id));
  const recorded = observations.answers as {
    queryId: string;
    embeddingDigest: string;
    exact: PublishedItem[];
    ann: PublishedItem[];
  }[];
  if (
    !Array.isArray(recorded) ||
    recorded.length !== input.queries.length ||
    new Set(recorded.map((answer) => answer.queryId)).size !== recorded.length ||
    input.queries.some(
      (query) =>
        !recorded.some(
          (answer) => answer.queryId === query.queryId && answer.embeddingDigest === digest([...query.embedding]),
        ),
    )
  )
    fail("PUBLICATION_BASELINE_QUERY_MISMATCH");
  const differences: string[] = [];
  for (const query of input.queries) {
    const baseline = recorded.find((answer) => answer.queryId === query.queryId);
    if (!baseline || baseline.embeddingDigest !== digest([...query.embedding]))
      fail("PUBLICATION_BASELINE_QUERY_MISMATCH");
    for (const mode of ["exact", "ann"] as const) {
      const answer = await queryPublishedSpace(client, {
        tenantId: input.tenantId,
        vectorStoreSpaceId: input.vectorStoreSpaceId,
        embedding: query.embedding,
        resultLimit: Number(observations.resultLimit),
        mode,
      });
      if (answer.publicationId !== publicationId) fail("PUBLICATION_BASELINE_POINTER_MISMATCH");
      const expected = baseline[mode].map((item) => item.vectorItemId);
      const actual = answer.items.map((item) => item.vectorItemId);
      if (digest(expected) !== digest(actual)) differences.push(`${query.queryId}:${mode}`);
    }
  }
  return {
    publicationId,
    vectorSpaceVersionId: String(row.vector_space_version_id),
    equivalent: differences.length === 0,
    differences,
  };
}
