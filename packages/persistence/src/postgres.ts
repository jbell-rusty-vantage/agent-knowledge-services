import { Pool, type PoolConfig, type QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";
import {
  EvidencePacketMemberSchema,
  EvidencePacketSchema,
  RetrievalCitationReplaySchema,
  RetrievalWorldScopeSchema,
  type EvidencePacket,
  type RetrievalCitationReplay as RetrievalCitationReplayResult,
} from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import { operationActorIdentity } from "./actor-identity.js";
import {
  RetrievalCitationReplay,
  RetrievalSupportResolver,
  type ReadRetrievalArtifact,
  type ResolvedRetrievalSupport,
  type RetrievalSupportRequest,
} from "./retrieval-evidence.js";
import type {
  CanonicalOperation,
  CanonicalOperationControl,
  CanonicalOperationEvent,
  CanonicalOperationRecord,
  CanonicalReceipt,
  CanonicalStep,
  CreateCanonicalOperation,
  HybridSearchRequest,
  HybridSearchResult,
  LeasedStep,
  OutboxRepository,
  PendingOutboxMessage,
  ReceiptRepository,
  RetrievalRepository,
  ReviewDecisionInput,
  ReviewRepository,
  ReviewSubjectInput,
  OperationsRepository,
  LeaseRepository,
  VectorPublicationRepository,
  OutboxClaim,
  ResourceReadRepository,
  CanonicalArtifactResource,
  CanonicalVectorStoreResource,
  CanonicalReceiptResource,
  CanonicalRetrievalRunResource,
  CanonicalRetrievalExplanationResource,
  CanonicalEvaluationReportResource,
  CanonicalEvaluationFailuresResource,
  PersistRetrievalExecutionInput,
  RetrievalEvidenceRecord,
  RetrievalPolicySnapshot,
} from "./types.js";

export interface PostgresPersistenceConfig {
  readonly connectionString: string;
  readonly maximumPoolSize?: number;
  readonly connectionTimeoutMs?: number;
  /** Refuse anything except the local Supabase direct database endpoint. Used by acceptance drills. */
  readonly localOnly?: boolean;
}

export interface TenantSqlClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

type Row = Record<string, unknown>;
const digestHex = (value: unknown) => sha256Digest(JSON.parse(JSON.stringify(value))).slice(7);
const halfvec = (values: readonly number[]) => `[${values.join(",")}]`;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

const packetMemberReferenceColumns = new Map<string, string>([
  ["claim", "claim_id"],
  ["evidence.claim", "claim_id"],
  ["technical_problem", "technical_problem_id"],
  ["knowledge.technical_problem", "technical_problem_id"],
  ["solution_pattern", "solution_pattern_id"],
  ["knowledge.solution_pattern", "solution_pattern_id"],
  ["advanced_usage_pattern", "advanced_usage_pattern_id"],
  ["knowledge.advanced_usage_pattern", "advanced_usage_pattern_id"],
  ["implementation_example", "implementation_example_id"],
  ["knowledge.implementation_example", "implementation_example_id"],
  ["failure_mode", "failure_mode_id"],
  ["knowledge.failure_mode", "failure_mode_id"],
  ["benchmark_result", "benchmark_result_id"],
  ["knowledge.benchmark_result", "benchmark_result_id"],
  ["compatibility_constraint", "compatibility_constraint_id"],
  ["knowledge.compatibility_constraint", "compatibility_constraint_id"],
  ["operational_practice", "operational_practice_id"],
  ["knowledge.operational_practice", "operational_practice_id"],
  ["security_consideration", "security_consideration_id"],
  ["knowledge.security_consideration", "security_consideration_id"],
]);

function assertPacketDigest(packet: EvidencePacket): void {
  const { digest, ...core } = packet;
  if (sha256Digest(JSON.parse(JSON.stringify(core))) !== digest) throw new Error("EVIDENCE_PACKET_DIGEST_MISMATCH");
}

function outboxMessage(row: Row): PendingOutboxMessage {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    eventId: String(row.event_id),
    topic: String(row.topic),
    payload: row.payload,
    payloadSha256: String(row.payload_sha256),
    deliveryAttempts: Number(row.delivery_attempts),
    claimOwner: String(row.claim_owner),
    claimToken: String(row.claim_token),
    claimedAt: iso(row.claimed_at),
    visibilityExpiresAt: iso(row.visibility_expires_at),
  };
}

function verifyConnectionTarget(config: PostgresPersistenceConfig): void {
  const url = new URL(config.connectionString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("POSTGRES_URL_DENIED");
  if (config.localOnly && (!new Set(["127.0.0.1", "localhost"]).has(url.hostname) || url.port !== "54322")) {
    throw new Error("LOCAL_POSTGRES_REQUIRED");
  }
}

function operation(row: Row): CanonicalOperation {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    operationKind: String(row.operation_kind),
    idempotencyKey: String(row.idempotency_key),
    requestSha256: String(row.request_sha256),
    status: row.status as CanonicalOperation["status"],
    rowVersion: Number(row.row_version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function operationRecord(row: Row): CanonicalOperationRecord {
  return {
    ...operation(row),
    ownershipMode: row.ownership_mode as CanonicalOperationRecord["ownershipMode"],
    ...(row.external_run_id ? { externalRunId: String(row.external_run_id) } : {}),
    correlationId: String(row.correlation_id),
    ...(row.causation_id ? { causationId: String(row.causation_id) } : {}),
    actorIdentity: String(row.actor_identity),
    request: row.request,
  };
}

function step(row: Row): CanonicalStep {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    operationId: String(row.operation_id),
    stepKey: String(row.step_key),
    stepKind: String(row.step_kind),
    inputSha256: String(row.input_sha256),
    status: String(row.status),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    rowVersion: Number(row.row_version),
    ...(row.input === undefined ? {} : { input: row.input }),
  };
}

function leasedStep(row: Row): LeasedStep {
  return {
    ...step(row),
    holderIdentity: String(row.holder_identity),
    leaseToken: String(row.lease_token),
    fencingToken: Number(row.fencing_token),
    expiresAt: iso(row.expires_at),
  };
}

function receipt(row: Row): CanonicalReceipt {
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    ...(row.step_id ? { stepId: String(row.step_id) } : {}),
    receiptKind: String(row.receipt_kind),
    idempotencyKey: String(row.idempotency_key),
    inputSha256: String(row.input_sha256),
    ...(row.output_sha256 ? { outputSha256: String(row.output_sha256) } : {}),
    outcome: String(row.outcome),
    body: row.body,
    createdAt: iso(row.created_at),
  };
}

export class PostgresCanonicalRepository
  implements
    OperationsRepository,
    LeaseRepository,
    OutboxRepository,
    ReceiptRepository,
    ReviewRepository,
    VectorPublicationRepository,
    RetrievalRepository,
    ResourceReadRepository
{
  readonly #pool: Pool;

  constructor(config: PostgresPersistenceConfig) {
    verifyConnectionTarget(config);
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      max: config.maximumPoolSize ?? 10,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
      application_name: "ai-engineer-knowledge-persistence",
    };
    this.#pool = new Pool(poolConfig);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async transaction<T>(tenantId: string, work: (client: TenantSqlClient) => Promise<T>): Promise<T> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId) ||
      tenantId === "00000000-0000-0000-0000-000000000000"
    )
      throw new Error("INVALID_TENANT_CONTEXT");
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id',$1,true)", [tenantId]);
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createOperation(input: CreateCanonicalOperation): Promise<CanonicalOperation> {
    return this.transaction(input.tenantId, async (client) => {
      const requestSha256 = digestHex(input.request);
      const existing = await client.query<Row>(
        "select * from knowledge_service.operation where tenant_id=$1 and idempotency_key=$2 for update",
        [input.tenantId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (
          existing.rows[0].request_sha256 !== requestSha256 ||
          existing.rows[0].operation_kind !== input.operationKind
        )
          throw new Error("IDEMPOTENCY_CONFLICT");
        return operation(existing.rows[0]);
      }
      const reusedIdentity = await client.query<Row>(
        "select id from knowledge_service.operation where tenant_id=$1 and id=$2 for update",
        [input.tenantId, input.id],
      );
      if (reusedIdentity.rows[0]) throw new Error("IDEMPOTENCY_CONFLICT");
      const inserted = await client.query<Row>(
        `insert into knowledge_service.operation
        (id,tenant_id,operation_kind,idempotency_key,ownership_mode,external_run_id,mission_id,work_item_id,attempt_id,correlation_id,causation_id,actor_identity,capability_version_id,request,request_sha256)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15) returning *`,
        [
          input.id,
          input.tenantId,
          input.operationKind,
          input.idempotencyKey,
          input.ownershipMode ?? "standalone",
          input.externalRunId ?? null,
          input.missionId ?? null,
          input.workItemId ?? null,
          input.attemptId ?? null,
          input.correlationId,
          input.causationId ?? null,
          input.actorIdentity,
          input.capabilityVersionId ?? null,
          JSON.stringify(input.request),
          requestSha256,
        ],
      );
      for (const [index, item] of input.steps.entries()) {
        await client.query(
          `insert into knowledge_service.operation_step
          (id,tenant_id,operation_id,step_key,step_kind,input,input_sha256,max_attempts,available_at)
          values($1,$2,$3,$4,$5,$6::jsonb,$7,$8,clock_timestamp()+($9::text||' milliseconds')::interval)`,
          [
            item.id,
            input.tenantId,
            input.id,
            item.key,
            item.kind,
            JSON.stringify(item.input),
            digestHex(item.input),
            item.maxAttempts ?? 3,
            index,
          ],
        );
      }
      await this.#appendEvent(
        client,
        input.tenantId,
        input.id,
        undefined,
        "operation.created",
        undefined,
        "queued",
        input.actorIdentity,
        input.correlationId,
        input.causationId,
        requestSha256,
        { requestSha256, stepCount: input.steps.length },
      );
      return operation(inserted.rows[0]!);
    });
  }

  async getOperation(tenantId: string, operationId: string): Promise<CanonicalOperation | undefined> {
    return this.transaction(tenantId, async (client) => {
      const result = await client.query<Row>("select * from knowledge_service.operation where tenant_id=$1 and id=$2", [
        tenantId,
        operationId,
      ]);
      return result.rows[0] ? operation(result.rows[0]) : undefined;
    });
  }

  async getOperationRecord(tenantId: string, operationId: string): Promise<CanonicalOperationRecord | undefined> {
    return this.transaction(tenantId, async (client) => {
      const result = await client.query<Row>("select * from knowledge_service.operation where tenant_id=$1 and id=$2", [
        tenantId,
        operationId,
      ]);
      return result.rows[0] ? operationRecord(result.rows[0]) : undefined;
    });
  }

  async getArtifactResource(tenantId: string, artifactId: string): Promise<CanonicalArtifactResource | undefined> {
    return this.transaction(tenantId, async (client) => {
      const row = (
        await client.query<Row>(
          `select id,tenant_id,artifact_type,schema_version,sha256,bucket_class,media_type,size_bytes,superseded_by_id,created_at
        from orchestration.artifact where tenant_id=$1 and id=$2`,
          [tenantId, artifactId],
        )
      ).rows[0];
      if (!row) return undefined;
      const byteLength = row.size_bytes === null ? undefined : Number(row.size_bytes);
      if (
        !/^[a-f0-9]{64}$/.test(String(row.sha256)) ||
        (byteLength !== undefined && (!Number.isSafeInteger(byteLength) || byteLength < 0))
      ) {
        throw new Error("RESOURCE_INTEGRITY_CONFLICT");
      }
      return {
        artifactId: String(row.id),
        tenantId: String(row.tenant_id),
        artifactType: String(row.artifact_type),
        schemaVersion: Number(row.schema_version),
        digest: `sha256:${String(row.sha256)}`,
        bucketClass: String(row.bucket_class),
        ...(row.media_type ? { mediaType: String(row.media_type) } : {}),
        ...(byteLength === undefined ? {} : { byteLength }),
        ...(row.superseded_by_id ? { supersededById: String(row.superseded_by_id) } : {}),
        createdAt: iso(row.created_at),
      };
    });
  }

  async getVectorStoreResource(
    tenantId: string,
    vectorStoreId: string,
  ): Promise<CanonicalVectorStoreResource | undefined> {
    return this.transaction(tenantId, async (client) => {
      const row = (
        await client.query<Row>(
          `select id,tenant_id,owner_identity,store_class,slug,name,purpose,visibility,lifecycle,quota_profile,retention_policy,deletion_policy,created_by_attempt_id,supersedes_id,created_at
        from retrieval.vector_store where tenant_id=$1 and id=$2`,
          [tenantId, vectorStoreId],
        )
      ).rows[0];
      if (!row) return undefined;
      const storeClasses: Record<string, CanonicalVectorStoreResource["storeClass"]> = {
        official: "official_canonical",
        exploratory: "internal_exploratory",
        user_managed: "user_managed",
      };
      const storeClass = storeClasses[String(row.store_class)];
      if (
        !storeClass ||
        !["private", "tenant", "public"].includes(String(row.visibility)) ||
        !["active", "suspended", "superseded", "deleted"].includes(String(row.lifecycle))
      )
        throw new Error("RESOURCE_INTEGRITY_CONFLICT");
      const spaces = (
        await client.query<Row>(
          `select id,vector_space_id,active_space_version_id,authority_class,created_at from retrieval.vector_store_space where tenant_id=$1 and vector_store_id=$2 order by created_at,id limit 101`,
          [tenantId, vectorStoreId],
        )
      ).rows;
      if (spaces.some((space) => !["official", "exploratory", "user_managed"].includes(String(space.authority_class))))
        throw new Error("RESOURCE_INTEGRITY_CONFLICT");
      const count = Number(
        (
          await client.query<Row>(
            `select count(*)::int document_count from retrieval.vector_store_document where tenant_id=$1 and vector_store_id=$2`,
            [tenantId, vectorStoreId],
          )
        ).rows[0]?.document_count ?? 0,
      );
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("RESOURCE_INTEGRITY_CONFLICT");
      return {
        id: String(row.id),
        tenantId: String(row.tenant_id),
        ownerIdentity: String(row.owner_identity),
        storeClass,
        slug: String(row.slug),
        name: String(row.name),
        purpose: String(row.purpose),
        visibility: String(row.visibility) as CanonicalVectorStoreResource["visibility"],
        lifecycle: String(row.lifecycle) as CanonicalVectorStoreResource["lifecycle"],
        quotaProfile: row.quota_profile,
        retentionPolicy: row.retention_policy,
        deletionPolicy: row.deletion_policy,
        ...(row.created_by_attempt_id ? { createdByAttemptId: String(row.created_by_attempt_id) } : {}),
        ...(row.supersedes_id ? { supersedesId: String(row.supersedes_id) } : {}),
        createdAt: iso(row.created_at),
        documentCount: count,
        spacesTruncated: spaces.length > 100,
        spaces: spaces.slice(0, 100).map((space) => ({
          id: String(space.id),
          vectorSpaceId: String(space.vector_space_id),
          ...(space.active_space_version_id ? { activeSpaceVersionId: String(space.active_space_version_id) } : {}),
          authorityClass: String(space.authority_class) as "official" | "exploratory" | "user_managed",
          createdAt: iso(space.created_at),
        })),
      };
    });
  }

  async getReceiptResource(tenantId: string, receiptId: string): Promise<CanonicalReceiptResource | undefined> {
    return this.transaction(tenantId, async (client) => {
      const row = (
        await client.query<Row>(
          `select r.*,case when r.output_sha256 is null then true else exists(
          select 1 from knowledge_service.operation_event e where e.tenant_id=r.tenant_id and e.operation_id=r.operation_id
          and e.id=nullif(r.body->>'eventId','')::uuid and e.guarded_sha256=r.output_sha256
        ) end output_event_verified
        from knowledge_service.receipt r where r.tenant_id=$1 and r.id=$2`,
          [tenantId, receiptId],
        )
      ).rows[0];
      if (!row) return undefined;
      if (
        !/^[a-f0-9]{64}$/.test(String(row.input_sha256)) ||
        (row.output_sha256 !== null && !/^[a-f0-9]{64}$/.test(String(row.output_sha256)))
      ) {
        throw new Error("RESOURCE_INTEGRITY_CONFLICT");
      }
      if (!Boolean(row.output_event_verified)) throw new Error("RESOURCE_INTEGRITY_CONFLICT");
      return {
        ...receipt(row),
        tenantId: String(row.tenant_id),
        executorIdentity: String(row.executor_identity),
        inputDigest: `sha256:${String(row.input_sha256)}`,
        ...(row.output_sha256 ? { outputDigest: `sha256:${String(row.output_sha256)}` } : {}),
      };
    });
  }

  async getRetrievalRunResource(tenantId: string, runId: string): Promise<CanonicalRetrievalRunResource | undefined> {
    return this.transaction(tenantId, async (client) => this.#getRetrievalRunResource(client, tenantId, runId));
  }

  async getRetrievalExplanationResource(
    tenantId: string,
    runId: string,
  ): Promise<CanonicalRetrievalExplanationResource | undefined> {
    return this.transaction(tenantId, async (client) => {
      const run = await this.#getRetrievalRunResource(client, tenantId, runId);
      if (!run) return undefined;
      const candidateRows = (
        await client.query<Row>(
          `select id,vector_item_id,lexical_ref,stage_scores,final_score,rank
        from retrieval.retrieval_candidate where tenant_id=$1 and run_id=$2
        order by rank nulls last,id limit 101`,
          [tenantId, runId],
        )
      ).rows;
      const visibleRows = candidateRows.slice(0, 100);
      const candidateIds = visibleRows.map((candidate) => String(candidate.id));
      const sourceRows =
        candidateIds.length === 0
          ? []
          : (
              await client.query<Row>(
                `select retrieval_candidate_id,channel,search_projection_id,vector_item_id,source_rank,score,explanation
        from retrieval.retrieval_candidate_source where tenant_id=$1 and retrieval_candidate_id=any($2::uuid[])
        order by retrieval_candidate_id,channel,source_rank,id limit 1001`,
                [tenantId, candidateIds],
              )
            ).rows;
      if (sourceRows.length > 1_000) throw new Error("RESOURCE_RESPONSE_LIMIT_EXCEEDED");
      const sources = new Map<string, CanonicalRetrievalExplanationResource["candidates"][number]["sources"]>();
      for (const source of sourceRows) {
        const candidateId = String(source.retrieval_candidate_id);
        sources.set(candidateId, [
          ...(sources.get(candidateId) ?? []),
          {
            channel: String(source.channel),
            ...(source.search_projection_id ? { searchProjectionId: String(source.search_projection_id) } : {}),
            ...(source.vector_item_id ? { vectorItemId: String(source.vector_item_id) } : {}),
            sourceRank: Number(source.source_rank),
            score: Number(source.score),
            explanation: source.explanation,
          },
        ]);
      }
      return {
        retrievalRunId: run.id,
        stageTimings: run.stageTimings,
        fusionParameters: run.fusionParameters,
        ...(run.rerankerId ? { rerankerId: run.rerankerId } : {}),
        truncated: candidateRows.length > 100,
        candidates: visibleRows.map((candidate) => ({
          id: String(candidate.id),
          ...(candidate.vector_item_id ? { vectorItemId: String(candidate.vector_item_id) } : {}),
          ...(candidate.lexical_ref ? { lexicalReference: String(candidate.lexical_ref) } : {}),
          stageScores: candidate.stage_scores,
          ...(candidate.final_score === null ? {} : { finalScore: Number(candidate.final_score) }),
          ...(candidate.rank === null ? {} : { rank: Number(candidate.rank) }),
          sources: sources.get(String(candidate.id)) ?? [],
        })),
      };
    });
  }

  async getEvaluationReportResource(
    tenantId: string,
    runId: string,
  ): Promise<CanonicalEvaluationReportResource | undefined> {
    return this.transaction(tenantId, async (client) => {
      const run = (
        await client.query<Row>(
          `select id,tenant_id,dataset_id,target_kind,config,code_ref,executed_at
        from evaluation.eval_run where tenant_id=$1 and id=$2`,
          [tenantId, runId],
        )
      ).rows[0];
      if (!run) return undefined;
      const metrics = (
        await client.query<Row>(
          `select id,metric_definition_id,eval_case_id,value,details,created_at
        from evaluation.metric_observation where tenant_id=$1 and eval_run_id=$2 order by created_at,id limit 1000`,
          [tenantId, runId],
        )
      ).rows;
      const gates = (
        await client.query<Row>(
          `select id,gate_version_id,passed,false_acceptance_count,observations,result_sha256,created_at
        from evaluation.promotion_gate_result where tenant_id=$1 and eval_run_id=$2 order by created_at,id limit 100`,
          [tenantId, runId],
        )
      ).rows;
      return {
        id: String(run.id),
        tenantId: String(run.tenant_id),
        datasetId: String(run.dataset_id),
        targetKind: String(run.target_kind),
        configuration: run.config,
        ...(run.code_ref ? { codeReference: String(run.code_ref) } : {}),
        executedAt: iso(run.executed_at),
        metrics: metrics.map((metric) => ({
          id: String(metric.id),
          metricDefinitionId: String(metric.metric_definition_id),
          ...(metric.eval_case_id ? { caseId: String(metric.eval_case_id) } : {}),
          ...(metric.value === null ? {} : { value: Number(metric.value) }),
          details: metric.details,
          createdAt: iso(metric.created_at),
        })),
        gates: gates.map((gate) => ({
          id: String(gate.id),
          gateVersionId: String(gate.gate_version_id),
          passed: Boolean(gate.passed),
          falseAcceptanceCount: Number(gate.false_acceptance_count),
          observations: gate.observations,
          resultDigest: `sha256:${String(gate.result_sha256)}`,
          createdAt: iso(gate.created_at),
        })),
      };
    });
  }

  async getEvaluationFailuresResource(
    tenantId: string,
    runId: string,
  ): Promise<CanonicalEvaluationFailuresResource | undefined> {
    return this.transaction(tenantId, async (client) => {
      const exists = (
        await client.query<Row>("select id from evaluation.eval_run where tenant_id=$1 and id=$2", [tenantId, runId])
      ).rows[0];
      if (!exists) return undefined;
      const rows = (
        await client.query<Row>(
          `select s.case_id,s.metrics,s.false_acceptance,s.false_rejection,o.answer,o.plan,o.candidates,o.packets
        from evaluation.eval_score s join evaluation.eval_run r on r.id=s.run_id and r.tenant_id=$1
        left join evaluation.eval_run_case_output o on o.tenant_id=r.tenant_id and o.eval_run_id=r.id and o.eval_case_id=s.case_id
        where s.run_id=$2 and (s.passed is false or s.false_acceptance or s.false_rejection)
        order by s.case_id limit 101`,
          [tenantId, runId],
        )
      ).rows;
      return {
        evaluationRunId: runId,
        truncated: rows.length > 100,
        failures: rows.slice(0, 100).map((failure) => ({
          caseId: String(failure.case_id),
          metrics: failure.metrics,
          falseAcceptance: Boolean(failure.false_acceptance),
          falseRejection: Boolean(failure.false_rejection),
          ...([failure.answer, failure.plan, failure.candidates, failure.packets].every((item) => item === null)
            ? {}
            : {
                output: {
                  answer: failure.answer,
                  plan: failure.plan,
                  candidates: failure.candidates,
                  packets: failure.packets,
                },
              }),
        })),
      };
    });
  }

  async operationBelongsToVectorStore(tenantId: string, vectorStoreId: string, operationId: string): Promise<boolean> {
    return this.transaction(tenantId, async (client) =>
      Boolean(
        (
          await client.query<Row>(
            `select id from knowledge_service.operation
      where tenant_id=$1 and id=$2 and coalesce(request->'input'->>'vectorStoreId',request->'input'->>'vector_store_id')=$3`,
            [tenantId, operationId, vectorStoreId],
          )
        ).rows[0],
      ),
    );
  }

  async #getRetrievalRunResource(
    client: TenantSqlClient,
    tenantId: string,
    runId: string,
  ): Promise<CanonicalRetrievalRunResource | undefined> {
    const row = (
      await client.query<Row>(
        `select r.id,r.tenant_id,r.stage_timings,r.fusion_params,r.reranker_id,r.executed_at,
      p.id plan_id,p.query_intent,p.decomposition,p.spaces,p.filters,p.policy_version,p.validated,p.validation_errors,p.created_at plan_created_at
      from retrieval.retrieval_run r join retrieval.retrieval_plan p on p.tenant_id=r.tenant_id and p.id=r.plan_id
      where r.tenant_id=$1 and r.id=$2`,
        [tenantId, runId],
      )
    ).rows[0];
    if (!row) return undefined;
    const packetRows = (
      await client.query<Row>(
        "select id from retrieval.evidence_packet where tenant_id=$1 and run_id=$2 order by created_at,id limit 101",
        [tenantId, runId],
      )
    ).rows;
    if (packetRows.length > 100) throw new Error("RESOURCE_RESPONSE_LIMIT_EXCEEDED");
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      plan: {
        id: String(row.plan_id),
        queryIntent: String(row.query_intent),
        decomposition: row.decomposition,
        spaces: row.spaces,
        filters: row.filters,
        policyVersion: Number(row.policy_version),
        validated: Boolean(row.validated),
        ...(row.validation_errors === null ? {} : { validationErrors: row.validation_errors }),
        createdAt: iso(row.plan_created_at),
      },
      stageTimings: row.stage_timings,
      fusionParameters: row.fusion_params,
      ...(row.reranker_id ? { rerankerId: String(row.reranker_id) } : {}),
      executedAt: iso(row.executed_at),
      evidencePacketIds: packetRows.map((packet) => String(packet.id)),
    };
  }

  async listOperations(tenantId: string, limit = 100): Promise<readonly CanonicalOperationRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("INVALID_OPERATION_LIST_LIMIT");
    return this.transaction(tenantId, async (client) =>
      (
        await client.query<Row>(
          "select * from knowledge_service.operation where tenant_id=$1 order by created_at desc,id desc limit $2",
          [tenantId, limit],
        )
      ).rows.map(operationRecord),
    );
  }

  async listOperationEvents(
    tenantId: string,
    operationId: string,
    afterSequence = 0,
    limit = 100,
  ): Promise<readonly CanonicalOperationEvent[] | undefined> {
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1_000
    )
      throw new Error("INVALID_OPERATION_EVENT_PAGE");
    return this.transaction(tenantId, async (client) => {
      const exists = (
        await client.query<Row>("select id from knowledge_service.operation where tenant_id=$1 and id=$2", [
          tenantId,
          operationId,
        ])
      ).rows[0];
      if (!exists) return undefined;
      const rows = (
        await client.query<Row>(
          `select * from (
        select id,operation_id,event_kind,occurred_at,payload,row_number() over(order by occurred_at,id) sequence
        from knowledge_service.operation_event where tenant_id=$1 and operation_id=$2
      ) events where sequence>$3 order by sequence limit $4`,
          [tenantId, operationId, afterSequence, limit],
        )
      ).rows;
      return rows.map((row) => ({
        id: String(row.id),
        operationId: String(row.operation_id),
        sequence: Number(row.sequence),
        type: String(row.event_kind),
        occurredAt: iso(row.occurred_at),
        payload: row.payload,
      }));
    });
  }

  async listSteps(tenantId: string, operationId: string): Promise<readonly CanonicalStep[]> {
    return this.transaction(tenantId, async (client) =>
      (
        await client.query<Row>(
          `select * from knowledge_service.operation_step where tenant_id=$1 and operation_id=$2
      order by case when input #>> '{step,ordinal}' ~ '^[0-9]+$' then (input #>> '{step,ordinal}')::integer else 2147483647 end,created_at,id`,
          [tenantId, operationId],
        )
      ).rows.map(step),
    );
  }

  async cancelOperation(
    tenantId: string,
    operationId: string,
    control: CanonicalOperationControl,
  ): Promise<CanonicalOperationRecord | undefined> {
    return this.transaction(tenantId, async (client) => {
      const stored = (
        await client.query<Row>("select * from knowledge_service.operation where tenant_id=$1 and id=$2 for update", [
          tenantId,
          operationId,
        ])
      ).rows[0];
      if (!stored) return undefined;
      const current = String(stored.status);
      if (current === "succeeded" || current === "cancelled") return operationRecord(stored);
      if (current === "failed" || current === "superseded") throw new Error("INVALID_STATE_TRANSITION");
      await client.query(
        `update knowledge_service.lease l set released_at=clock_timestamp()
        from knowledge_service.operation_step s where l.tenant_id=$1 and l.operation_step_id=s.id
        and s.operation_id=$2 and l.released_at is null`,
        [tenantId, operationId],
      );
      const updated = (
        await client.query<Row>(
          `update knowledge_service.operation set status='cancelled',completed_at=clock_timestamp()
        where tenant_id=$1 and id=$2 returning *`,
          [tenantId, operationId],
        )
      ).rows[0]!;
      await this.#appendEvent(
        client,
        tenantId,
        operationId,
        undefined,
        "operation.cancelled",
        current,
        "cancelled",
        control.actorIdentity,
        control.correlationId,
        control.causationId,
        undefined,
        {},
      );
      return operationRecord(updated);
    });
  }

  async retryOperation(
    tenantId: string,
    operationId: string,
    control: CanonicalOperationControl,
  ): Promise<CanonicalOperationRecord | undefined> {
    return this.transaction(tenantId, async (client) => {
      const stored = (
        await client.query<Row>("select * from knowledge_service.operation where tenant_id=$1 and id=$2 for update", [
          tenantId,
          operationId,
        ])
      ).rows[0];
      if (!stored) return undefined;
      if (stored.status !== "failed") throw new Error("INVALID_STATE_TRANSITION");
      await client.query(
        `update knowledge_service.operation_step set status='queued',max_attempts=max_attempts+greatest(max_attempts,1),available_at=clock_timestamp(),completed_at=null
        where tenant_id=$1 and operation_id=$2 and status='failed'`,
        [tenantId, operationId],
      );
      const updated = (
        await client.query<Row>(
          `update knowledge_service.operation set status='queued',completed_at=null
        where tenant_id=$1 and id=$2 returning *`,
          [tenantId, operationId],
        )
      ).rows[0]!;
      await this.#appendEvent(
        client,
        tenantId,
        operationId,
        undefined,
        "operation.retried",
        "failed",
        "queued",
        control.actorIdentity,
        control.correlationId,
        control.causationId,
        undefined,
        { retryCycle: Number(updated.row_version) },
      );
      return operationRecord(updated);
    });
  }

  async reconcileOperation(tenantId: string, operationId: string): Promise<CanonicalOperationRecord | undefined> {
    return this.transaction(tenantId, async (client) => {
      const stored = (
        await client.query<Row>("select * from knowledge_service.operation where tenant_id=$1 and id=$2 for update", [
          tenantId,
          operationId,
        ])
      ).rows[0];
      if (!stored) return undefined;
      if (!["succeeded", "failed", "cancelled", "superseded"].includes(String(stored.status)))
        await this.#reconcileOperation(client, tenantId, operationId);
      const current = (
        await client.query<Row>("select * from knowledge_service.operation where tenant_id=$1 and id=$2", [
          tenantId,
          operationId,
        ])
      ).rows[0]!;
      return operationRecord(current);
    });
  }

  async reconcileOperations(tenantId: string, limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("INVALID_RECONCILE_LIMIT");
    return this.transaction(tenantId, async (client) => {
      const rows = (
        await client.query<Row>(
          `select id from knowledge_service.operation where tenant_id=$1
        and status in ('queued','running') order by updated_at,id limit $2 for update skip locked`,
          [tenantId, limit],
        )
      ).rows;
      for (const row of rows) await this.#reconcileOperation(client, tenantId, String(row.id));
      return rows.length;
    });
  }

  async claimNext(
    tenantId: string,
    holderIdentity: string,
    leaseMs = 30_000,
    eligibleOperationKinds?: readonly string[],
  ): Promise<LeasedStep | undefined> {
    if (eligibleOperationKinds?.some((kind) => !kind.trim())) throw new Error("INVALID_ELIGIBLE_OPERATION_KIND");
    return this.#claim(tenantId, holderIdentity, leaseMs, undefined, eligibleOperationKinds);
  }
  async claimOperation(
    tenantId: string,
    operationId: string,
    holderIdentity: string,
    leaseMs = 30_000,
  ): Promise<LeasedStep | undefined> {
    return this.#claim(tenantId, holderIdentity, leaseMs, operationId);
  }

  async #claim(
    tenantId: string,
    holderIdentity: string,
    leaseMs: number,
    operationId?: string,
    eligibleOperationKinds?: readonly string[],
  ): Promise<LeasedStep | undefined> {
    if (!holderIdentity.trim() || leaseMs < 1 || leaseMs > 3_600_000) throw new Error("INVALID_LEASE_REQUEST");
    return this.transaction(tenantId, async (client) => {
      const selected = await client.query<Row>(
        `select s.* from knowledge_service.operation_step s
        join knowledge_service.operation o on o.tenant_id=s.tenant_id and o.id=s.operation_id
        left join knowledge_service.lease l on l.tenant_id=s.tenant_id and l.operation_step_id=s.id
        where s.tenant_id=$1 and ($2::uuid is null or s.operation_id=$2)
          and ($3::text[] is null or o.operation_kind=any($3::text[]))
          and s.status in ('queued','running') and s.available_at<=clock_timestamp()
          and s.attempt_count<s.max_attempts and (l.id is null or l.released_at is not null or l.expires_at<=clock_timestamp())
          and o.status not in ('succeeded','failed','cancelled','superseded')
          and not exists (
            select 1 from knowledge_service.operation_step predecessor
            where predecessor.tenant_id=s.tenant_id and predecessor.operation_id=s.operation_id and predecessor.status<>'succeeded'
              and case
                when predecessor.input #>> '{step,ordinal}' ~ '^[0-9]+$' and s.input #>> '{step,ordinal}' ~ '^[0-9]+$'
                  then (predecessor.input #>> '{step,ordinal}')::integer < (s.input #>> '{step,ordinal}')::integer
                else (predecessor.created_at,predecessor.id) < (s.created_at,s.id)
              end
          )
        order by s.available_at,s.created_at,s.id for update of s skip locked limit 1`,
        [tenantId, operationId ?? null, eligibleOperationKinds ?? null],
      );
      const candidate = selected.rows[0];
      if (!candidate) return undefined;
      const updated = (
        await client.query<Row>(
          `update knowledge_service.operation_step set status='running',attempt_count=attempt_count+1
        where tenant_id=$1 and id=$2 returning *`,
          [tenantId, candidate.id],
        )
      ).rows[0]!;
      const lease = (
        await client.query<Row>(
          `insert into knowledge_service.lease
        (tenant_id,operation_step_id,holder_identity,expires_at) values($1,$2,$3,clock_timestamp()+($4::text||' milliseconds')::interval)
        on conflict(tenant_id,operation_step_id) do update set holder_identity=excluded.holder_identity,lease_token=gen_random_uuid(),
          fencing_token=default,acquired_at=clock_timestamp(),heartbeat_at=clock_timestamp(),
          expires_at=clock_timestamp()+($4::text||' milliseconds')::interval,released_at=null
        returning *`,
          [tenantId, candidate.id, holderIdentity, leaseMs],
        )
      ).rows[0]!;
      const op = (
        await client.query<Row>("select * from knowledge_service.operation where tenant_id=$1 and id=$2 for update", [
          tenantId,
          candidate.operation_id,
        ])
      ).rows[0]!;
      if (op.status === "queued")
        await client.query("update knowledge_service.operation set status='running' where tenant_id=$1 and id=$2", [
          tenantId,
          candidate.operation_id,
        ]);
      await this.#appendEvent(
        client,
        tenantId,
        String(candidate.operation_id),
        String(candidate.id),
        "step.leased",
        String(candidate.status),
        "running",
        holderIdentity,
        String(op.correlation_id),
        op.causation_id ? String(op.causation_id) : undefined,
        String(updated.input_sha256),
        { fencingToken: Number(lease.fencing_token), attemptCount: Number(updated.attempt_count) },
      );
      return leasedStep({ ...updated, ...lease, id: updated.id });
    });
  }

  async heartbeat(
    tenantId: string,
    current: Pick<LeasedStep, "id" | "leaseToken" | "fencingToken">,
    leaseMs = 30_000,
  ): Promise<LeasedStep> {
    return this.transaction(tenantId, async (client) => {
      const result = await client.query<Row>(
        `update knowledge_service.lease set heartbeat_at=clock_timestamp(),expires_at=clock_timestamp()+($5::text||' milliseconds')::interval
        where tenant_id=$1 and operation_step_id=$2 and lease_token=$3 and fencing_token=$4 and released_at is null and expires_at>clock_timestamp()
        returning *`,
        [tenantId, current.id, current.leaseToken, current.fencingToken, leaseMs],
      );
      if (!result.rows[0]) throw new Error("STALE_LEASE");
      const stored = (
        await client.query<Row>("select * from knowledge_service.operation_step where tenant_id=$1 and id=$2", [
          tenantId,
          current.id,
        ])
      ).rows[0]!;
      return leasedStep({ ...stored, ...result.rows[0], id: stored.id });
    });
  }

  async completeStep(
    tenantId: string,
    current: LeasedStep,
    input: { id: string; idempotencyKey: string; receiptKind: string; executorIdentity: string; output: unknown },
  ): Promise<CanonicalReceipt> {
    current = structuredClone(current);
    input = structuredClone(input);
    const result = await this.transaction(
      tenantId,
      async (client): Promise<{ receipt?: CanonicalReceipt; conflict?: true }> => {
        const outputSha256 = digestHex(input.output);
        // Structured extraction publication/accounting use this same operation-first
        // order. A terminal mutation must not race cancellation or publication.
        const extraction =
          current.stepKey === "extract_and_register"
            ? (
                await client.query<Row>(
                  "select id,status from knowledge_service.operation where tenant_id=$1 and id=$2 and operation_kind='verification_structured_extraction' for update",
                  [tenantId, current.operationId],
                )
              ).rows[0]
            : undefined;
        if (current.stepKey === "extract_and_register" && (!extraction || current.tenantId !== tenantId))
          throw new Error("STRUCTURED_EXTRACTION_TERMINAL_OPERATION_MISMATCH");
        const prior = await client.query<Row>(
          "select * from knowledge_service.receipt where tenant_id=$1 and idempotency_key=$2",
          [tenantId, input.idempotencyKey],
        );
        if (prior.rows[0]) {
          const stored = prior.rows[0];
          const conflicts =
            String(stored.operation_id) !== current.operationId ||
            String(stored.step_id) !== current.id ||
            String(stored.receipt_kind) !== input.receiptKind ||
            String(stored.input_sha256) !== current.inputSha256 ||
            String(stored.output_sha256) !== outputSha256 ||
            String(stored.outcome) !== "succeeded";
          if (!conflicts) return { receipt: receipt(stored) };

          await this.#lockValidLease(client, tenantId, current);
          const activeStep = (
            await client.query<Row>(
              "select * from knowledge_service.operation_step where tenant_id=$1 and id=$2 for update",
              [tenantId, current.id],
            )
          ).rows[0]!;
          await client.query(
            "update knowledge_service.operation_step set status='failed',completed_at=clock_timestamp() where tenant_id=$1 and id=$2",
            [tenantId, current.id],
          );
          await client.query(
            "update knowledge_service.lease set released_at=clock_timestamp() where tenant_id=$1 and operation_step_id=$2 and lease_token=$3 and fencing_token=$4",
            [tenantId, current.id, current.leaseToken, current.fencingToken],
          );
          const activeOperation = (
            await client.query<Row>(
              "select * from knowledge_service.operation where tenant_id=$1 and id=$2 for update",
              [tenantId, activeStep.operation_id],
            )
          ).rows[0]!;
          await this.#appendEvent(
            client,
            tenantId,
            String(activeStep.operation_id),
            current.id,
            "step.failed",
            "running",
            "failed",
            input.executorIdentity,
            String(activeOperation.correlation_id),
            activeOperation.causation_id ? String(activeOperation.causation_id) : undefined,
            outputSha256,
            { errorClass: "IDEMPOTENCY_CONFLICT", conflictingReceiptId: String(stored.id) },
          );
          await this.#reconcileOperation(client, tenantId, String(activeStep.operation_id));
          return { conflict: true };
        }
        const locked = await this.#lockValidLease(client, tenantId, current);
        const storedStep = (
          await client.query<Row>(
            "select * from knowledge_service.operation_step where tenant_id=$1 and id=$2 for update",
            [tenantId, current.id],
          )
        ).rows[0]!;
        if (extraction) {
          if (
            extraction.status !== "running" ||
            storedStep.operation_id !== current.operationId ||
            storedStep.input_sha256 !== current.inputSha256 ||
            locked.holder_identity !== current.holderIdentity
          )
            throw new Error("STRUCTURED_EXTRACTION_TERMINAL_CLAIM_MISMATCH");
          await client.query("select set_config('verification.structured_extraction_terminal_claim',$1,true)", [
            JSON.stringify({
              operationId: current.operationId,
              stepId: current.id,
              leaseToken: current.leaseToken,
              fencingToken: current.fencingToken,
              holderIdentity: current.holderIdentity,
              receiptId: input.id,
              idempotencyKey: input.idempotencyKey,
              executorIdentity: input.executorIdentity,
              outputSha256,
            }),
          ]);
        }
        await client.query(
          "update knowledge_service.operation_step set status='succeeded',completed_at=clock_timestamp() where tenant_id=$1 and id=$2",
          [tenantId, current.id],
        );
        await client.query(
          "update knowledge_service.lease set released_at=clock_timestamp() where tenant_id=$1 and operation_step_id=$2 and lease_token=$3 and fencing_token=$4",
          [tenantId, current.id, current.leaseToken, current.fencingToken],
        );
        const op = (
          await client.query<Row>("select * from knowledge_service.operation where tenant_id=$1 and id=$2 for update", [
            tenantId,
            storedStep.operation_id,
          ])
        ).rows[0]!;
        const eventId = await this.#appendEvent(
          client,
          tenantId,
          String(storedStep.operation_id),
          current.id,
          "step.succeeded",
          "running",
          "succeeded",
          input.executorIdentity,
          String(op.correlation_id),
          op.causation_id ? String(op.causation_id) : undefined,
          outputSha256,
          { outputSha256, fencingToken: locked.fencing_token },
        );
        const inserted = await client.query<Row>(
          `insert into knowledge_service.receipt
        (id,tenant_id,operation_id,step_id,receipt_kind,idempotency_key,executor_identity,input_sha256,output_sha256,outcome,body)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,'succeeded',$10::jsonb) returning *`,
          [
            input.id,
            tenantId,
            storedStep.operation_id,
            current.id,
            input.receiptKind,
            input.idempotencyKey,
            input.executorIdentity,
            storedStep.input_sha256,
            outputSha256,
            JSON.stringify({ ...asObject(input.output), eventId, fencingToken: Number(locked.fencing_token) }),
          ],
        );
        await this.#reconcileOperation(client, tenantId, String(storedStep.operation_id));
        return { receipt: receipt(inserted.rows[0]!) };
      },
    );
    if (result.conflict) throw new Error("IDEMPOTENCY_CONFLICT");
    return result.receipt!;
  }

  /** Completes one signed captured failure; this path never queues a retry. */
  async failStructuredExtractionStep(
    tenantId: string,
    current: LeasedStep,
    input: { id: string; idempotencyKey: string; executorIdentity: string; output: unknown },
  ): Promise<CanonicalReceipt> {
    current = structuredClone(current);
    input = structuredClone(input);
    return this.transaction(tenantId, async (client): Promise<CanonicalReceipt> => {
      const outputSha256 = digestHex(input.output);
      // Keep captured failure publication, cancellation and terminal failure serialized.
      const extraction =
        current.stepKey === "extract_and_register"
          ? (
              await client.query<Row>(
                "select id,status from knowledge_service.operation where tenant_id=$1 and id=$2 and operation_kind='verification_structured_extraction' for update",
                [tenantId, current.operationId],
              )
            ).rows[0]
          : undefined;
      if (current.stepKey !== "extract_and_register" || !extraction || current.tenantId !== tenantId)
        throw new Error("STRUCTURED_EXTRACTION_FAILURE_TERMINAL_OPERATION_MISMATCH");
      const expected = (
        await client.query<Row>("select orchestration.structured_extraction_failure_result_body($1,$2) body", [
          tenantId,
          current.operationId,
        ])
      ).rows[0]?.body;
      if (!expected || digestHex(expected) !== outputSha256)
        throw new Error("STRUCTURED_EXTRACTION_FAILURE_TERMINAL_OUTPUT_MISMATCH");
      const prior = await client.query<Row>(
        "select * from knowledge_service.receipt where tenant_id=$1 and idempotency_key=$2",
        [tenantId, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        const stored = prior.rows[0];
        const conflicts =
          String(stored.operation_id) !== current.operationId ||
          String(stored.step_id) !== current.id ||
          String(stored.receipt_kind) !== "extract_and_register.failed" ||
          String(stored.input_sha256) !== current.inputSha256 ||
          String(stored.output_sha256) !== outputSha256 ||
          String(stored.outcome) !== "failed";
        if (!conflicts && String(stored.executor_identity) === input.executorIdentity) return receipt(stored);

        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      const locked = await this.#lockValidLease(client, tenantId, current);
      const storedStep = (
        await client.query<Row>(
          "select * from knowledge_service.operation_step where tenant_id=$1 and id=$2 for update",
          [tenantId, current.id],
        )
      ).rows[0]!;
      if (extraction) {
        if (
          extraction.status !== "running" ||
          storedStep.operation_id !== current.operationId ||
          storedStep.input_sha256 !== current.inputSha256 ||
          locked.holder_identity !== current.holderIdentity
        )
          throw new Error("STRUCTURED_EXTRACTION_FAILURE_TERMINAL_CLAIM_MISMATCH");
        await client.query("select set_config('verification.structured_extraction_failure_terminal_claim',$1,true)", [
          JSON.stringify({
            operationId: current.operationId,
            stepId: current.id,
            leaseToken: current.leaseToken,
            fencingToken: current.fencingToken,
            holderIdentity: current.holderIdentity,
            receiptId: input.id,
            idempotencyKey: input.idempotencyKey,
            executorIdentity: input.executorIdentity,
            outputSha256,
          }),
        ]);
      }
      await client.query(
        "update knowledge_service.operation_step set status='failed',completed_at=clock_timestamp() where tenant_id=$1 and id=$2",
        [tenantId, current.id],
      );
      await client.query(
        "update knowledge_service.lease set released_at=clock_timestamp() where tenant_id=$1 and operation_step_id=$2 and lease_token=$3 and fencing_token=$4",
        [tenantId, current.id, current.leaseToken, current.fencingToken],
      );
      const op = (
        await client.query<Row>("select * from knowledge_service.operation where tenant_id=$1 and id=$2 for update", [
          tenantId,
          storedStep.operation_id,
        ])
      ).rows[0]!;
      const eventId = await this.#appendEvent(
        client,
        tenantId,
        String(storedStep.operation_id),
        current.id,
        "step.failed",
        "running",
        "failed",
        input.executorIdentity,
        String(op.correlation_id),
        op.causation_id ? String(op.causation_id) : undefined,
        outputSha256,
        { outputSha256, fencingToken: locked.fencing_token },
      );
      const inserted = await client.query<Row>(
        `insert into knowledge_service.receipt
        (id,tenant_id,operation_id,step_id,receipt_kind,idempotency_key,executor_identity,input_sha256,output_sha256,outcome,body)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,'failed',$10::jsonb) returning *`,
        [
          input.id,
          tenantId,
          storedStep.operation_id,
          current.id,
          "extract_and_register.failed",
          input.idempotencyKey,
          input.executorIdentity,
          storedStep.input_sha256,
          outputSha256,
          JSON.stringify({ ...asObject(input.output), eventId, fencingToken: Number(locked.fencing_token) }),
        ],
      );
      await this.#reconcileOperation(client, tenantId, String(storedStep.operation_id));
      return receipt(inserted.rows[0]!);
    });
  }

  async failStep(
    tenantId: string,
    current: LeasedStep,
    input: {
      id: string;
      idempotencyKey: string;
      executorIdentity: string;
      errorClass: string;
      retryable: boolean;
      retryDelayMs?: number;
    },
  ): Promise<CanonicalReceipt> {
    current = structuredClone(current);
    input = structuredClone(input);
    return this.transaction(tenantId, async (client) => {
      const extraction =
        current.stepKey === "extract_and_register"
          ? (
              await client.query<Row>(
                "select id,status from knowledge_service.operation where tenant_id=$1 and id=$2 and operation_kind='verification_structured_extraction' for update",
                [tenantId, current.operationId],
              )
            ).rows[0]
          : undefined;
      if (current.stepKey === "extract_and_register" && (!extraction || current.tenantId !== tenantId))
        throw new Error("STRUCTURED_EXTRACTION_TERMINAL_OPERATION_MISMATCH");
      if (
        extraction &&
        (
          await client.query<Row>(
            "select operation_id from orchestration.verification_structured_extraction_failure where tenant_id=$1 and operation_id=$2",
            [tenantId, current.operationId],
          )
        ).rows[0]
      )
        throw new Error("STRUCTURED_EXTRACTION_CAPTURED_FAILURE_REQUIRES_TERMINAL");
      const prior = await client.query<Row>(
        "select * from knowledge_service.receipt where tenant_id=$1 and idempotency_key=$2",
        [tenantId, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        const stored = prior.rows[0];
        const body = asObject(stored.body);
        if (
          String(stored.operation_id) !== current.operationId ||
          String(stored.step_id) !== current.id ||
          String(stored.receipt_kind) !== "failure" ||
          String(stored.input_sha256) !== current.inputSha256 ||
          String(stored.outcome) !== "failed" ||
          body.errorClass !== input.errorClass ||
          body.retryable !== (input.retryable && current.attemptCount < current.maxAttempts)
        )
          throw new Error("IDEMPOTENCY_CONFLICT");
        return receipt(stored);
      }
      const locked = await this.#lockValidLease(client, tenantId, current);
      const storedStep = (
        await client.query<Row>(
          "select * from knowledge_service.operation_step where tenant_id=$1 and id=$2 for update",
          [tenantId, current.id],
        )
      ).rows[0]!;
      if (
        extraction &&
        (extraction.status !== "running" ||
          storedStep.operation_id !== current.operationId ||
          storedStep.input_sha256 !== current.inputSha256 ||
          locked.holder_identity !== current.holderIdentity)
      )
        throw new Error("STRUCTURED_EXTRACTION_TERMINAL_CLAIM_MISMATCH");
      const attemptsExhausted = Number(storedStep.attempt_count) >= Number(storedStep.max_attempts);
      const nextState = input.retryable && !attemptsExhausted ? "queued" : "failed";
      await client.query(
        `update knowledge_service.operation_step set status=$3,available_at=clock_timestamp()+($4::text||' milliseconds')::interval,
        completed_at=case when $3='failed' then clock_timestamp() else null end where tenant_id=$1 and id=$2`,
        [tenantId, current.id, nextState, input.retryDelayMs ?? 0],
      );
      await client.query(
        "update knowledge_service.lease set released_at=clock_timestamp() where tenant_id=$1 and operation_step_id=$2 and lease_token=$3 and fencing_token=$4",
        [tenantId, current.id, current.leaseToken, current.fencingToken],
      );
      const op = (
        await client.query<Row>("select * from knowledge_service.operation where tenant_id=$1 and id=$2 for update", [
          tenantId,
          storedStep.operation_id,
        ])
      ).rows[0]!;
      const body = {
        errorClass: input.errorClass,
        retryable: input.retryable && !attemptsExhausted,
        attemptsExhausted,
        fencingToken: current.fencingToken,
      };
      await this.#appendEvent(
        client,
        tenantId,
        String(storedStep.operation_id),
        current.id,
        "step.failed",
        "running",
        nextState,
        input.executorIdentity,
        String(op.correlation_id),
        op.causation_id ? String(op.causation_id) : undefined,
        digestHex(body),
        body,
      );
      const inserted = await client.query<Row>(
        `insert into knowledge_service.receipt
        (id,tenant_id,operation_id,step_id,receipt_kind,idempotency_key,executor_identity,input_sha256,outcome,body)
        values($1,$2,$3,$4,'failure',$5,$6,$7,'failed',$8::jsonb) returning *`,
        [
          input.id,
          tenantId,
          storedStep.operation_id,
          current.id,
          input.idempotencyKey,
          input.executorIdentity,
          storedStep.input_sha256,
          JSON.stringify(body),
        ],
      );
      await this.#reconcileOperation(client, tenantId, String(storedStep.operation_id));
      return receipt(inserted.rows[0]!);
    });
  }

  async claimOutbox(
    tenantId: string,
    claimOwner: string,
    limit = 50,
    visibilityTimeoutMs = 30_000,
  ): Promise<readonly PendingOutboxMessage[]> {
    return this.#claimOutbox(tenantId, claimOwner, limit, visibilityTimeoutMs);
  }

  async claimOperationOutbox(
    tenantId: string,
    operationId: string,
    claimOwner: string,
    limit = 50,
    visibilityTimeoutMs = 30_000,
  ): Promise<readonly PendingOutboxMessage[]> {
    return this.#claimOutbox(tenantId, claimOwner, limit, visibilityTimeoutMs, operationId);
  }

  async #claimOutbox(
    tenantId: string,
    claimOwner: string,
    limit: number,
    visibilityTimeoutMs: number,
    operationId?: string,
  ): Promise<readonly PendingOutboxMessage[]> {
    return this.transaction(tenantId, async (client) => {
      const result = await client.query<Row>("select * from knowledge_service.claim_outbox($1,$2,$3,$4)", [
        claimOwner,
        limit,
        visibilityTimeoutMs,
        operationId ?? null,
      ]);
      return result.rows.map(outboxMessage);
    });
  }

  async extendOutboxClaim(tenantId: string, claim: OutboxClaim, visibilityTimeoutMs = 30_000): Promise<string> {
    return this.transaction(tenantId, async (client) =>
      iso(
        (
          await client.query<Row>("select knowledge_service.extend_outbox_claim($1,$2,$3,$4) visibility_expires_at", [
            claim.id,
            claim.claimOwner,
            claim.claimToken,
            visibilityTimeoutMs,
          ])
        ).rows[0]!.visibility_expires_at,
      ),
    );
  }

  async ackOutbox(tenantId: string, claim: OutboxClaim): Promise<void> {
    await this.transaction(tenantId, async (client) => {
      await client.query("select knowledge_service.ack_outbox($1,$2,$3)", [
        claim.id,
        claim.claimOwner,
        claim.claimToken,
      ]);
    });
  }

  async nackOutbox(tenantId: string, claim: OutboxClaim, errorClass: string, retryDelayMs = 0): Promise<void> {
    await this.transaction(tenantId, async (client) => {
      await client.query("select knowledge_service.nack_outbox($1,$2,$3,$4,$5)", [
        claim.id,
        claim.claimOwner,
        claim.claimToken,
        errorClass,
        retryDelayMs,
      ]);
    });
  }

  async markOutboxPublished(tenantId: string, claim: OutboxClaim): Promise<void> {
    await this.ackOutbox(tenantId, claim);
  }
  async markOutboxFailed(tenantId: string, claim: OutboxClaim, errorClass: string, retryDelayMs = 0): Promise<void> {
    await this.nackOutbox(tenantId, claim, errorClass, retryDelayMs);
  }

  async listReceipts(tenantId: string, operationId: string): Promise<readonly CanonicalReceipt[]> {
    return this.transaction(tenantId, async (client) =>
      (
        await client.query<Row>(
          "select * from knowledge_service.receipt where tenant_id=$1 and operation_id=$2 order by created_at,id",
          [tenantId, operationId],
        )
      ).rows.map(receipt),
    );
  }

  async createReviewSubject(tenantId: string, input: ReviewSubjectInput): Promise<string> {
    return this.transaction(tenantId, async (client) => {
      await client.query(
        `insert into knowledge_service.review_subject(id,tenant_id,operation_id,subject_kind,subject_ref,guarded_sha256,eligible_roles,quorum_required,expires_at)
        values($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) on conflict(id) do nothing`,
        [
          input.id,
          tenantId,
          input.operationId,
          input.subjectKind,
          JSON.stringify(input.subjectRef),
          input.guardedSha256,
          input.eligibleRoles,
          input.quorumRequired ?? 1,
          input.expiresAt ?? null,
        ],
      );
      const stored = (
        await client.query<Row>("select * from knowledge_service.review_subject where tenant_id=$1 and id=$2", [
          tenantId,
          input.id,
        ])
      ).rows[0];
      if (!stored || stored.guarded_sha256 !== input.guardedSha256) throw new Error("IDEMPOTENCY_CONFLICT");
      return String(stored.id);
    });
  }

  async recordReviewDecision(tenantId: string, input: ReviewDecisionInput): Promise<string> {
    return this.transaction(tenantId, async (client) => {
      const subject = (
        await client.query<Row>("select * from knowledge_service.review_subject where tenant_id=$1 and id=$2", [
          tenantId,
          input.reviewSubjectId,
        ])
      ).rows[0];
      if (
        !subject ||
        subject.guarded_sha256 !== input.guardedSha256 ||
        !(subject.eligible_roles as string[]).includes(input.reviewerRole)
      )
        throw new Error("REVIEW_AUTHORITY_OR_DIGEST_MISMATCH");
      const reviewerIdentity = await operationActorIdentity({
        client,
        tenantId,
        operationId: input.decisionOperationId,
        claimedIdentity: input.reviewerIdentity,
      });
      await client.query(
        `insert into knowledge_service.review_decision(id,tenant_id,review_subject_id,guarded_sha256,reviewer_identity,reviewer_role,decision,rationale,decision_operation_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(tenant_id,review_subject_id,reviewer_identity) do nothing`,
        [
          input.id,
          tenantId,
          input.reviewSubjectId,
          input.guardedSha256,
          reviewerIdentity,
          input.reviewerRole,
          input.decision,
          input.rationale,
          input.decisionOperationId,
        ],
      );
      const stored = (
        await client.query<Row>(
          "select * from knowledge_service.review_decision where tenant_id=$1 and review_subject_id=$2 and reviewer_identity=$3",
          [tenantId, input.reviewSubjectId, reviewerIdentity],
        )
      ).rows[0];
      if (
        !stored ||
        stored.guarded_sha256 !== input.guardedSha256 ||
        stored.decision !== input.decision ||
        String(stored.decision_operation_id) !== input.decisionOperationId
      )
        throw new Error("IDEMPOTENCY_CONFLICT");
      return String(stored.id);
    });
  }

  async publishVectorSpace(
    tenantId: string,
    input: {
      publicationId: string;
      expectedGuardedSha256: string;
      reason: string;
      actorIdentity: string;
      idempotencyKey: string;
    },
  ): Promise<string> {
    return this.transaction(tenantId, async (client) =>
      String(
        (
          await client.query<Row>("select retrieval.publish_vector_space($1,$2,$3,$4,$5) id", [
            input.publicationId,
            input.expectedGuardedSha256,
            input.reason,
            input.actorIdentity,
            input.idempotencyKey,
          ])
        ).rows[0]!.id,
      ),
    );
  }

  async rollbackVectorSpace(
    tenantId: string,
    input: {
      currentPublicationId: string;
      targetPublicationId: string;
      expectedGuardedSha256: string;
      reason: string;
      actorIdentity: string;
      idempotencyKey: string;
      operationId: string;
    },
  ): Promise<string> {
    return this.transaction(tenantId, async (client) =>
      String(
        (
          await client.query<Row>("select retrieval.rollback_vector_space($1,$2,$3,$4,$5,$6,$7) id", [
            input.currentPublicationId,
            input.targetPublicationId,
            input.expectedGuardedSha256,
            input.reason,
            input.actorIdentity,
            input.idempotencyKey,
            input.operationId,
          ])
        ).rows[0]!.id,
      ),
    );
  }

  async resolveRetrievalPolicy(
    tenantId: string,
    policyVersionId: string,
    requestedSpaces: readonly string[],
  ): Promise<RetrievalPolicySnapshot> {
    if (
      requestedSpaces.length < 1 ||
      requestedSpaces.length > 8 ||
      new Set(requestedSpaces).size !== requestedSpaces.length
    )
      throw new Error("INVALID_RETRIEVAL_SPACES");
    return this.transaction(tenantId, async (client) => {
      const policy = (
        await client.query<Row>(
          `select pv.id,pv.version,pv.policy
        from retrieval.retrieval_policy_version pv join retrieval.retrieval_policy p
          on p.tenant_id=pv.tenant_id and p.id=pv.retrieval_policy_id
        where pv.tenant_id=$1 and pv.id=$2 and pv.status='active' and p.lifecycle='active'`,
          [tenantId, policyVersionId],
        )
      ).rows[0];
      if (!policy) throw new Error("RETRIEVAL_POLICY_NOT_ACTIVE");
      const targets = (
        await client.query<Row>(
          `select distinct on (domain.domain)
          domain.domain vector_space,vsv.id vector_space_version_id,vsv.embedding_model,vsv.dims,
          vsv.projection_procedure_id,ss.authority_class,p.published_at
        from retrieval.vector_store_space ss
        join retrieval.space_publication p on p.tenant_id=ss.tenant_id and p.vector_store_space_id=ss.id
          and p.vector_space_version_id=ss.active_space_version_id and p.status='published'
        join retrieval.vector_space_version vsv on vsv.tenant_id=p.tenant_id and vsv.id=p.vector_space_version_id
          and vsv.publication_lifecycle='published'
        join retrieval.content_promotion_decision d on d.tenant_id=p.tenant_id and d.id=p.publication_decision_id
          and d.decision='accept' and (d.expires_at is null or d.expires_at>clock_timestamp())
        join retrieval.content_promotion_proposal pp on pp.tenant_id=d.tenant_id and pp.id=d.proposal_id
        cross join lateral unnest(pp.target_domains) domain(domain)
        where ss.tenant_id=$1 and domain.domain=any($2::text[])
        order by domain.domain,p.published_at desc,p.id desc`,
          [tenantId, requestedSpaces],
        )
      ).rows;
      return {
        id: String(policy.id),
        version: Number(policy.version),
        policy: policy.policy,
        targets: targets.map((target) => ({
          vectorSpaceVersionId: String(target.vector_space_version_id),
          vectorSpace: String(target.vector_space),
          embeddingModel: String(target.embedding_model),
          dimensions: Number(target.dims),
          projectionProcedureId: String(target.projection_procedure_id),
          authority:
            String(target.authority_class) === "official"
              ? "canonical"
              : (target.authority_class as "exploratory" | "user_managed"),
        })),
      };
    });
  }

  async retrievalKnowledgeClock(tenantId: string, requested?: number): Promise<number> {
    if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 0))
      throw new Error("INVALID_RETRIEVAL_KNOWLEDGE_CLOCK");
    return this.transaction(tenantId, async (client) => {
      const head = (
        await client.query<Row>("select knowledge_seq from temporal.knowledge_head where tenant_id=$1", [tenantId])
      ).rows[0];
      const current = Number(head?.knowledge_seq);
      if (!Number.isSafeInteger(current) || current < 0) throw new Error("RETRIEVAL_KNOWLEDGE_HEAD_REQUIRED");
      if (requested !== undefined && requested > current) throw new Error("RETRIEVAL_FUTURE_KNOWLEDGE_CLOCK");
      return requested ?? current;
    });
  }

  async hybridSearch(input: HybridSearchRequest): Promise<readonly HybridSearchResult[]> {
    if (input.queryEmbedding.length !== 1_536 || input.queryEmbedding.some((value) => !Number.isFinite(value)))
      throw new Error("INVALID_EMBEDDING_DIMENSIONS");
    const world = input.worldScope === undefined ? undefined : RetrievalWorldScopeSchema.parse(input.worldScope);
    const historical = input.knowledgeSeq !== undefined;
    if (!historical && (world || input.entityIds?.length || input.publicationId))
      throw new Error("RETRIEVAL_KNOWLEDGE_CLOCK_REQUIRED");
    if (historical && (!Number.isSafeInteger(input.knowledgeSeq) || input.knowledgeSeq! < 0))
      throw new Error("INVALID_RETRIEVAL_KNOWLEDGE_CLOCK");
    if (input.entityIds && (input.entityIds.length > 128 || new Set(input.entityIds).size !== input.entityIds.length))
      throw new Error("INVALID_RETRIEVAL_ENTITY_SCOPE");
    const sql = historical
      ? "select * from api.hybrid_knowledge_search_history_1536($1,$2,$3::extensions.halfvec(1536),$4::jsonb,$5,$6,$7,$8::bigint,$9::uuid[],$10::timestamptz,$11::timestamptz,$12::timestamptz,$13::uuid)"
      : "select * from api.hybrid_knowledge_search_1536($1,$2,$3::extensions.halfvec(1536),$4::jsonb,$5,$6,$7)";
    const parameters: unknown[] = [
      input.vectorSpaceVersionId,
      input.queryText,
      halfvec(input.queryEmbedding),
      JSON.stringify(input.filters ?? {}),
      input.resultLimit ?? 20,
      input.candidateLimit ?? 100,
      input.rrfK ?? 60,
    ];
    if (historical)
      parameters.push(
        input.knowledgeSeq,
        input.entityIds?.length ? input.entityIds : null,
        world?.kind === "at" ? world.at : null,
        world?.kind === "overlap" ? world.from : null,
        world?.kind === "overlap" ? world.to : null,
        input.publicationId ?? null,
      );
    return this.transaction(input.tenantId, async (client) =>
      (await client.query<Row>(sql, parameters)).rows.map((row) => ({
        vectorItemId: String(row.vector_item_id),
        ...(row.search_projection_id ? { searchProjectionId: String(row.search_projection_id) } : {}),
        searchText: String(row.search_text),
        ...(row.source_kind ? { sourceKind: String(row.source_kind) } : {}),
        fusedScore: Number(row.fused_score),
        channelScores: row.channel_scores,
      })),
    );
  }

  async getRetrievalEvidenceRecords(
    tenantId: string,
    vectorItemIds: readonly string[],
  ): Promise<readonly RetrievalEvidenceRecord[]> {
    if (vectorItemIds.length > 1_000 || new Set(vectorItemIds).size !== vectorItemIds.length)
      throw new Error("INVALID_RETRIEVAL_CANDIDATE_IDS");
    if (vectorItemIds.length === 0) return [];
    return this.transaction(tenantId, async (client) => {
      const rows = (
        await client.query<Row>(
          `select vi.id vector_item_id,vi.search_projection_id,vi.search_text,vi.authority_level,
          vi.verification_state,vi.freshness_at,vs.class::text space_class,
          coalesce(kr.kind,pt.target_kind) canonical_kind,
          coalesce(pt.entity_id,pt.record_id,pt.chunk_id,pt.claim_id,pt.summary_id) canonical_id,
          sp.projection_procedure_id,support.representation_id,support.node_id,support.start_offset,support.end_offset,
          support.normalized_content_sha256,support.artifact_id,support.artifact_sha256,support.media_type,support.size_bytes
        from retrieval.vector_item vi
        join retrieval.search_projection sp on sp.tenant_id=vi.tenant_id and sp.id=vi.search_projection_id
        join retrieval.projection_target pt on pt.tenant_id=sp.tenant_id and pt.id=sp.projection_target_id and pt.retired_at is null
        join retrieval.vector_space_version vsv on vsv.tenant_id=vi.tenant_id and vsv.id=vi.space_version_id
        join retrieval.vector_space vs on vs.tenant_id=vsv.tenant_id and vs.id=vsv.vector_space_id
        left join knowledge.record kr on kr.tenant_id=pt.tenant_id and kr.id=pt.record_id
        left join lateral (
          select cs.representation_id,span.document_node_id node_id,span.start_offset,span.end_offset,
            span.selected_text_sha256 normalized_content_sha256,
            a.id artifact_id,a.sha256 artifact_sha256,a.media_type,a.size_bytes
          from retrieval.search_projection_chunk_support s
          join retrieval.retrieval_chunk rc on rc.tenant_id=s.tenant_id and rc.id=s.chunk_id and rc.lifecycle='active'
          join retrieval.chunk_set cs on cs.tenant_id=rc.tenant_id and cs.id=rc.chunk_set_id and cs.status='succeeded'
          join retrieval.chunk_span span on span.tenant_id=rc.tenant_id and span.chunk_id=rc.id
          join content.document_representation dr on dr.tenant_id=cs.tenant_id and dr.id=cs.representation_id
          join orchestration.artifact a on a.tenant_id=dr.tenant_id and a.id=dr.artifact_id and a.storage_state='available'
          where s.tenant_id=vi.tenant_id and s.search_projection_id=vi.search_projection_id
            and retrieval.history_representation_authorized(cs.representation_id)
          order by s.ordinal,span.ordinal limit 1
        ) support on true
        where vi.tenant_id=$1 and vi.id=any($2::uuid[]) and vi.lifecycle='active'
        order by array_position($2::uuid[],vi.id)`,
          [tenantId, vectorItemIds],
        )
      ).rows;
      return rows.map((row) => ({
        vectorItemId: String(row.vector_item_id),
        searchProjectionId: String(row.search_projection_id),
        projectionProcedureId: String(row.projection_procedure_id),
        sourceText: String(row.search_text),
        canonicalRecord: {
          kind: String(row.canonical_kind),
          schemaVersion: "v1",
          recordId: String(row.canonical_id),
          tenantId,
        },
        authority: String(row.space_class) === "canonical" ? "canonical" : "exploratory",
        assurance:
          String(row.verification_state) !== "verified"
            ? "low"
            : String(row.space_class) === "canonical"
              ? "high"
              : "medium",
        freshnessAt: iso(row.freshness_at ?? new Date(0)),
        ...(row.representation_id
          ? {
              locator: {
                representationId: String(row.representation_id),
                nodeId: String(row.node_id),
                ...(row.start_offset === null ? {} : { startOffset: Number(row.start_offset) }),
                ...(row.end_offset === null ? {} : { endOffset: Number(row.end_offset) }),
                quoteDigest: `sha256:${String(row.normalized_content_sha256)}` as const,
              },
            }
          : {}),
        ...(row.artifact_id
          ? {
              artifactReference: {
                artifactId: String(row.artifact_id),
                tenantId,
                digest: `sha256:${String(row.artifact_sha256)}` as const,
                mediaType: String(row.media_type),
                byteLength: Number(row.size_bytes),
              },
            }
          : {}),
      }));
    });
  }

  /**
   * Resolves the publication each requested vector-space version is currently authorized to
   * answer from. Historical queries read an authorized index of belief; they never waive
   * present authorization, so a withdrawn publication simply has no entry here.
   */
  async retrievalPublications(
    tenantId: string,
    vectorSpaceVersionIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (vectorSpaceVersionIds.length === 0) return new Map();
    if (vectorSpaceVersionIds.length > 8 || new Set(vectorSpaceVersionIds).size !== vectorSpaceVersionIds.length)
      throw new Error("INVALID_RETRIEVAL_PUBLICATION_REQUEST");
    return this.transaction(tenantId, async (client) => {
      const rows = (
        await client.query<Row>(
          `select version_id,retrieval.history_publication_authorized(version_id,null) publication_id
        from unnest($1::uuid[]) version_id`,
          [vectorSpaceVersionIds],
        )
      ).rows;
      return new Map(
        rows
          .filter((row) => row.publication_id !== null)
          .map((row) => [String(row.version_id), String(row.publication_id)]),
      );
    });
  }

  /** Bounded canonical support traversal for one retrieval answer. */
  async resolveRetrievalSupport(input: RetrievalSupportRequest): Promise<readonly ResolvedRetrievalSupport[]> {
    return this.transaction(input.tenantId, async (client) => new RetrievalSupportResolver(client).resolve(input));
  }

  /**
   * Replays every citation a persisted packet carries from remote custody.
   *
   * The packet stays immutable: a dependency that has since been revoked, a missing
   * object or altered bytes are reported as typed failures next to the citations that
   * still reconstruct, instead of rewriting or hiding the recorded answer.
   */
  async replayEvidencePacketCitations(
    tenantId: string,
    packetId: string,
    readArtifact: ReadRetrievalArtifact,
  ): Promise<RetrievalCitationReplayResult> {
    const packet = await this.transaction(tenantId, (client) => this.#getEvidencePacket(client, tenantId, packetId));
    if (!packet) throw new Error("EVIDENCE_PACKET_NOT_FOUND");
    const citations: unknown[] = [],
      failures: unknown[] = [];
    await this.transaction(tenantId, async (client) => {
      const replay = new RetrievalCitationReplay(client, readArtifact);
      for (const member of packet.members)
        for (const path of member.support?.paths ?? []) {
          try {
            if (!(await this.#supportStillAuthorized(client, path.claimId, path.representationId)))
              throw new Error("RETRIEVAL_SUPPORT_REVOKED");
            const replayed = await replay.replay({
              tenantId,
              locatorId: path.locatorId,
              selectorDigest: path.selectorDigest,
              selectedContentDigest: path.selectedContentDigest,
            });
            if (
              replayed.captureId !== path.captureId ||
              replayed.sourceFamilyId !== path.sourceFamilyId ||
              replayed.captureArtifactId !== path.captureArtifact.artifactId
            )
              throw new Error("RETRIEVAL_CITATION_LINEAGE_MISMATCH");
            citations.push({ memberId: member.memberId, ...replayed });
          } catch (error) {
            failures.push({
              memberId: member.memberId,
              locatorId: path.locatorId,
              code: error instanceof Error ? error.message.split(":", 1)[0]! : "RETRIEVAL_CITATION_REPLAY_FAILED",
            });
          }
        }
    });
    return RetrievalCitationReplaySchema.parse({
      schemaVersion: "knowledge.retrieval-citation-replay/v1",
      evidencePacketId: packet.id,
      retrievalRunId: packet.retrievalRunId,
      packetDigest: packet.digest,
      citations,
      failures,
      replayedAt: new Date().toISOString(),
    });
  }

  async #supportStillAuthorized(client: TenantSqlClient, claimId: string, representationId: string): Promise<boolean> {
    const row = (
      await client.query<Row>(
        `select retrieval.history_claim_authorized($1::uuid) claim,
      retrieval.history_representation_authorized($2::uuid) representation`,
        [claimId, representationId],
      )
    ).rows[0];
    return row?.claim === true && row.representation === true;
  }

  async storeRetrievalExecution(tenantId: string, input: PersistRetrievalExecutionInput): Promise<string> {
    const value = EvidencePacketSchema.parse(input.packet);
    if (value.tenantId !== tenantId || value.retrievalRunId !== input.operationId)
      throw new Error("RETRIEVAL_EXECUTION_IDENTITY_MISMATCH");
    if (
      new Set(input.activeVectorSpaceVersionIds).size !== input.activeVectorSpaceVersionIds.length ||
      new Set(input.candidates.map((candidate) => candidate.id)).size !== input.candidates.length ||
      new Set(input.candidates.flatMap((candidate) => candidate.sources.map((source) => source.id))).size !==
        input.candidates.flatMap((candidate) => candidate.sources).length
    )
      throw new Error("INVALID_RETRIEVAL_EXECUTION_IDENTITIES");
    assertPacketDigest(value);
    return this.transaction(tenantId, async (client) => {
      const active = await client.query<Row>(
        `select vsv.id from retrieval.vector_store_space ss
        join retrieval.space_publication p on p.tenant_id=ss.tenant_id and p.vector_store_space_id=ss.id
          and p.vector_space_version_id=ss.active_space_version_id and p.status='published'
        join retrieval.vector_space_version vsv on vsv.tenant_id=p.tenant_id and vsv.id=p.vector_space_version_id and vsv.publication_lifecycle='published'
        where ss.tenant_id=$1 and vsv.id=any($2::uuid[])`,
        [tenantId, input.activeVectorSpaceVersionIds],
      );
      if (active.rows.length !== input.activeVectorSpaceVersionIds.length)
        throw new Error("RETRIEVAL_PUBLICATION_CHANGED");
      await client.query(
        `insert into retrieval.retrieval_plan(id,tenant_id,query_intent,decomposition,spaces,filters,policy_version,validated)
        values($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,true) on conflict(id) do nothing`,
        [
          input.planId,
          tenantId,
          value.normalizedQuery,
          JSON.stringify(value.plan.subqueries),
          JSON.stringify(value.plan.spaces),
          JSON.stringify(value.plan.hardFilters),
          input.policyVersionNumber,
        ],
      );
      const storedPlan = (
        await client.query<Row>(
          "select query_intent,decomposition,spaces,filters,policy_version,validated,validation_errors from retrieval.retrieval_plan where tenant_id=$1 and id=$2",
          [tenantId, input.planId],
        )
      ).rows[0];
      if (
        !storedPlan ||
        String(storedPlan.query_intent) !== value.normalizedQuery ||
        digestHex(storedPlan.decomposition) !== digestHex(value.plan.subqueries) ||
        digestHex(storedPlan.spaces) !== digestHex(value.plan.spaces) ||
        digestHex(storedPlan.filters) !== digestHex(value.plan.hardFilters) ||
        Number(storedPlan.policy_version) !== input.policyVersionNumber ||
        storedPlan.validated !== true ||
        storedPlan.validation_errors !== null
      )
        throw new Error("IDEMPOTENCY_CONFLICT");
      await client.query(
        `insert into retrieval.retrieval_run(id,tenant_id,plan_id,stage_timings,fusion_params,reranker_id,operation_id,request_sha256)
        values($1,$2,$3,$4::jsonb,$5::jsonb,$6,$1,$7) on conflict(id) do nothing`,
        [
          input.operationId,
          tenantId,
          input.planId,
          JSON.stringify(input.stageTimings),
          JSON.stringify(input.fusionParameters),
          input.rerankerId ?? null,
          input.requestSha256,
        ],
      );
      const storedRun = (
        await client.query<Row>(
          "select plan_id,request_sha256,stage_timings,fusion_params,reranker_id from retrieval.retrieval_run where tenant_id=$1 and id=$2",
          [tenantId, input.operationId],
        )
      ).rows[0];
      if (
        !storedRun ||
        String(storedRun.plan_id) !== input.planId ||
        String(storedRun.request_sha256) !== input.requestSha256 ||
        digestHex(storedRun.stage_timings) !== digestHex(input.stageTimings) ||
        digestHex(storedRun.fusion_params) !== digestHex(input.fusionParameters) ||
        (storedRun.reranker_id === null ? undefined : String(storedRun.reranker_id)) !== input.rerankerId
      )
        throw new Error("IDEMPOTENCY_CONFLICT");
      for (const candidate of input.candidates) {
        await client.query(
          `insert into retrieval.retrieval_candidate(id,tenant_id,run_id,vector_item_id,stage_scores,final_score,rank)
          values($1,$2,$3,$4,$5::jsonb,$6,$7) on conflict(id) do nothing`,
          [
            candidate.id,
            tenantId,
            input.operationId,
            candidate.vectorItemId,
            JSON.stringify(candidate.stageScores),
            candidate.finalScore,
            candidate.rank,
          ],
        );
        const stored = (
          await client.query<Row>(
            "select vector_item_id,stage_scores,final_score,rank from retrieval.retrieval_candidate where tenant_id=$1 and id=$2",
            [tenantId, candidate.id],
          )
        ).rows[0];
        if (
          !stored ||
          String(stored.vector_item_id) !== candidate.vectorItemId ||
          digestHex(stored.stage_scores) !== digestHex(candidate.stageScores) ||
          Number(stored.final_score) !== candidate.finalScore ||
          Number(stored.rank) !== candidate.rank
        )
          throw new Error("IDEMPOTENCY_CONFLICT");
        for (const source of candidate.sources) {
          await client.query(
            `insert into retrieval.retrieval_candidate_source(id,tenant_id,retrieval_candidate_id,channel,search_projection_id,vector_item_id,source_rank,score,explanation)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) on conflict(id) do nothing`,
            [
              source.id,
              tenantId,
              candidate.id,
              source.channel,
              source.searchProjectionId ?? null,
              candidate.vectorItemId,
              source.sourceRank,
              source.score,
              JSON.stringify(source.explanation),
            ],
          );
          const storedSource = (
            await client.query<Row>(
              "select retrieval_candidate_id,channel,search_projection_id,vector_item_id,source_rank,score,explanation from retrieval.retrieval_candidate_source where tenant_id=$1 and id=$2",
              [tenantId, source.id],
            )
          ).rows[0];
          if (
            !storedSource ||
            String(storedSource.retrieval_candidate_id) !== candidate.id ||
            String(storedSource.channel) !== source.channel ||
            (storedSource.search_projection_id === null ? undefined : String(storedSource.search_projection_id)) !==
              source.searchProjectionId ||
            String(storedSource.vector_item_id) !== candidate.vectorItemId ||
            Number(storedSource.source_rank) !== source.sourceRank ||
            Number(storedSource.score) !== source.score ||
            digestHex(storedSource.explanation) !== digestHex(source.explanation)
          )
            throw new Error("IDEMPOTENCY_CONFLICT");
        }
        const storedSourceIds = (
          await client.query<Row>(
            "select id from retrieval.retrieval_candidate_source where tenant_id=$1 and retrieval_candidate_id=$2 order by id",
            [tenantId, candidate.id],
          )
        ).rows.map((row) => String(row.id));
        if (digestHex(storedSourceIds) !== digestHex(candidate.sources.map((source) => source.id).sort()))
          throw new Error("IDEMPOTENCY_CONFLICT");
      }
      const storedCandidateIds = (
        await client.query<Row>(
          "select id from retrieval.retrieval_candidate where tenant_id=$1 and run_id=$2 order by id",
          [tenantId, input.operationId],
        )
      ).rows.map((row) => String(row.id));
      if (digestHex(storedCandidateIds) !== digestHex(input.candidates.map((candidate) => candidate.id).sort()))
        throw new Error("IDEMPOTENCY_CONFLICT");
      await client.query(
        `insert into retrieval.evidence_packet
        (id,tenant_id,run_id,packet,packet_schema_version,normalized_query,authorization_context,omitted_results,coverage,abstention,event_ids,receipt_ids,created_at)
        values($1,$2,$3,$4::jsonb,1,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::uuid[],$11::uuid[],$12) on conflict(id) do nothing`,
        [
          value.id,
          tenantId,
          input.operationId,
          JSON.stringify(value),
          value.normalizedQuery,
          JSON.stringify(value.authorization),
          JSON.stringify(value.omittedResults),
          JSON.stringify(value.coverage),
          JSON.stringify(value.abstention),
          value.eventIds,
          value.receiptIds,
          value.createdAt,
        ],
      );
      const storedPacket = (
        await client.query<Row>("select packet from retrieval.evidence_packet where tenant_id=$1 and id=$2", [
          tenantId,
          value.id,
        ])
      ).rows[0];
      if (!storedPacket || digestHex(storedPacket.packet) !== digestHex(value)) throw new Error("IDEMPOTENCY_CONFLICT");
      for (const member of value.members) await this.#storePacketMember(client, tenantId, value.id, member);
      const reconstructed = await this.#getEvidencePacket(client, tenantId, value.id);
      if (!reconstructed || digestHex(reconstructed) !== digestHex(value))
        throw new Error("EVIDENCE_PACKET_NORMALIZATION_MISMATCH");
      return value.id;
    });
  }

  async annNearest(
    input: Omit<HybridSearchRequest, "queryText" | "filters" | "candidateLimit" | "rrfK">,
  ): Promise<readonly { vectorItemId: string; score: number }[]> {
    if (input.queryEmbedding.length !== 1_536) throw new Error("INVALID_EMBEDDING_DIMENSIONS");
    return this.transaction(input.tenantId, async (client) =>
      (
        await client.query<Row>(
          `select vector_item_id,1-(embedding operator(extensions.<=>) $2::extensions.halfvec(1536)) score
      from retrieval.vector_item_embedding_1536 where tenant_id=$1 and vector_space_version_id=$3 order by embedding operator(extensions.<=>) $2::extensions.halfvec(1536),vector_item_id limit $4`,
          [input.tenantId, halfvec(input.queryEmbedding), input.vectorSpaceVersionId, input.resultLimit ?? 20],
        )
      ).rows.map((row) => ({ vectorItemId: String(row.vector_item_id), score: Number(row.score) })),
    );
  }

  async exactNearest(
    input: Omit<HybridSearchRequest, "queryText" | "filters" | "candidateLimit" | "rrfK">,
  ): Promise<readonly { vectorItemId: string; score: number }[]> {
    if (input.queryEmbedding.length !== 1_536) throw new Error("INVALID_EMBEDDING_DIMENSIONS");
    return this.transaction(input.tenantId, async (client) => {
      await client.query("set local enable_indexscan=off");
      await client.query("set local enable_bitmapscan=off");
      const rows = (
        await client.query<Row>(
          `select vector_item_id,1-(embedding operator(extensions.<=>) $2::extensions.halfvec(1536)) score
        from retrieval.vector_item_embedding_1536 where tenant_id=$1 and vector_space_version_id=$3 order by embedding operator(extensions.<=>) $2::extensions.halfvec(1536),vector_item_id limit $4`,
          [input.tenantId, halfvec(input.queryEmbedding), input.vectorSpaceVersionId, input.resultLimit ?? 20],
        )
      ).rows;
      return rows.map((row) => ({ vectorItemId: String(row.vector_item_id), score: Number(row.score) }));
    });
  }

  async storeEvidencePacket(
    tenantId: string,
    input: { planId: string; runId: string; packetId: string; packet: unknown },
  ): Promise<string> {
    const value = EvidencePacketSchema.parse(input.packet);
    if (value.tenantId !== tenantId || value.id !== input.packetId || value.retrievalRunId !== input.runId)
      throw new Error("EVIDENCE_PACKET_IDENTITY_MISMATCH");
    assertPacketDigest(value);
    return this.transaction(tenantId, async (client) => {
      await client.query(
        `insert into retrieval.retrieval_plan(id,tenant_id,query_intent,decomposition,spaces,filters,policy_version,validated)
        values($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,1,true) on conflict(id) do nothing`,
        [
          input.planId,
          tenantId,
          value.normalizedQuery,
          JSON.stringify(value.plan.subqueries),
          JSON.stringify(value.plan.spaces),
          JSON.stringify(value.plan.hardFilters),
        ],
      );
      await client.query(
        `insert into retrieval.retrieval_run(id,tenant_id,plan_id,stage_timings,fusion_params,reranker_id)
        values($1,$2,$3,$4::jsonb,$5::jsonb,$6) on conflict(id) do nothing`,
        [
          input.runId,
          tenantId,
          input.planId,
          JSON.stringify({ persisted: true }),
          JSON.stringify({ rrf: true }),
          "deterministic-fallback",
        ],
      );
      const storedRun = (
        await client.query<Row>(
          `select r.plan_id,p.query_intent,p.decomposition,p.spaces,p.filters
        from retrieval.retrieval_run r join retrieval.retrieval_plan p on p.tenant_id=r.tenant_id and p.id=r.plan_id
        where r.tenant_id=$1 and r.id=$2`,
          [tenantId, input.runId],
        )
      ).rows[0];
      if (
        !storedRun ||
        String(storedRun.plan_id) !== input.planId ||
        String(storedRun.query_intent) !== value.normalizedQuery ||
        digestHex(storedRun.decomposition) !== digestHex(value.plan.subqueries) ||
        digestHex(storedRun.spaces) !== digestHex(value.plan.spaces) ||
        digestHex(storedRun.filters) !== digestHex(value.plan.hardFilters)
      )
        throw new Error("EVIDENCE_PACKET_PLAN_RUN_CONFLICT");
      await client.query(
        `insert into retrieval.evidence_packet
        (id,tenant_id,run_id,packet,packet_schema_version,normalized_query,authorization_context,omitted_results,coverage,abstention,event_ids,receipt_ids,created_at)
        values($1,$2,$3,$4::jsonb,1,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::uuid[],$11::uuid[],$12) on conflict(id) do nothing`,
        [
          input.packetId,
          tenantId,
          input.runId,
          JSON.stringify(value),
          value.normalizedQuery,
          JSON.stringify(value.authorization),
          JSON.stringify(value.omittedResults),
          JSON.stringify(value.coverage),
          JSON.stringify(value.abstention),
          value.eventIds,
          value.receiptIds,
          value.createdAt,
        ],
      );
      const stored = (
        await client.query<Row>(
          "select packet,packet_schema_version from retrieval.evidence_packet where tenant_id=$1 and id=$2",
          [tenantId, input.packetId],
        )
      ).rows[0];
      if (!stored || Number(stored.packet_schema_version) !== 1 || digestHex(stored.packet) !== digestHex(value))
        throw new Error("EVIDENCE_PACKET_CONFLICT");
      for (const member of value.members) await this.#storePacketMember(client, tenantId, input.packetId, member);
      const reconstructed = await this.#getEvidencePacket(client, tenantId, input.packetId);
      if (!reconstructed || digestHex(reconstructed) !== digestHex(value))
        throw new Error("EVIDENCE_PACKET_NORMALIZATION_MISMATCH");
      return input.packetId;
    });
  }

  async getEvidencePacket(tenantId: string, packetId: string): Promise<unknown | undefined> {
    return this.transaction(tenantId, async (client) => this.#getEvidencePacket(client, tenantId, packetId));
  }

  async #storePacketMember(
    client: TenantSqlClient,
    tenantId: string,
    packetId: string,
    member: EvidencePacket["members"][number],
  ): Promise<void> {
    const identity: [string, unknown][] = [];
    let vectorItem: Row | undefined;
    const canonicalReferenceColumn = member.canonicalRecord
      ? packetMemberReferenceColumns.get(member.canonicalRecord.kind)
      : undefined;
    if (member.canonicalRecord && canonicalReferenceColumn) {
      if (member.canonicalRecord.tenantId !== tenantId) throw new Error("EVIDENCE_PACKET_MEMBER_TENANT_MISMATCH");
      identity.push([canonicalReferenceColumn, member.canonicalRecord.recordId]);
      const supportedClaim =
        canonicalReferenceColumn === "claim_id" &&
        (member.support?.paths.some((path) => path.claimId === member.canonicalRecord!.recordId) ?? false);
      vectorItem = supportedClaim
        ? (
            await client.query<Row>(
              "select id from retrieval.vector_item where tenant_id=$1 and search_projection_id=$2 order by id limit 1",
              [tenantId, member.matchedProjectionId],
            )
          ).rows[0]
        : (
            await client.query<Row>(
              `select vi.id from retrieval.vector_item vi
        join retrieval.projection_target pt on pt.tenant_id=vi.tenant_id and pt.id=vi.projection_target_id
        where vi.tenant_id=$1 and vi.search_projection_id=$2
          and coalesce(pt.entity_id,pt.record_id,pt.chunk_id,pt.claim_id,pt.summary_id)=$3
        order by vi.id limit 1`,
              [tenantId, member.matchedProjectionId, member.canonicalRecord.recordId],
            )
          ).rows[0];
      if (!vectorItem) throw new Error("EVIDENCE_PACKET_VECTOR_ITEM_NOT_FOUND");
    } else {
      const locator = member.locators[0];
      if (!member.faithfulSectionRepresentationId)
        throw new Error(
          member.canonicalRecord
            ? `UNSUPPORTED_EVIDENCE_MEMBER_KIND:${member.canonicalRecord.kind}`
            : "UNSUPPORTED_EVIDENCE_MEMBER_REFERENCE",
        );
      if (!locator || locator.representationId !== member.faithfulSectionRepresentationId)
        throw new Error("EVIDENCE_PACKET_SOURCE_REPRESENTATION_MISMATCH");
      identity.push(["source_representation_id", locator.representationId]);
      if (locator.nodeId) identity.push(["source_document_node_id", locator.nodeId]);
      vectorItem = (
        await client.query<Row>(
          "select id from retrieval.vector_item where tenant_id=$1 and search_projection_id=$2 order by id limit 1",
          [tenantId, member.matchedProjectionId],
        )
      ).rows[0];
    }
    const parameters: unknown[] = [
      member.memberId,
      tenantId,
      packetId,
      ...identity.map(([, value]) => value),
      vectorItem?.id ?? null,
      member.matchedProjectionId,
      JSON.stringify(member.locators),
      JSON.stringify(member.scores),
      member.channelExplanations,
      JSON.stringify(member.graphPaths),
      member.authority,
      member.assurance,
      member.freshAt,
      member.contradictionIds,
      member.supersedesIds,
      member.coveredSubqueryIds,
      JSON.stringify(member.artifactReferences),
      JSON.stringify(member),
    ];
    let parameter = 4 + identity.length;
    await client.query(
      `insert into retrieval.packet_member
      (id,tenant_id,packet_id,${identity.map(([column]) => column).join(",")},vector_item_id,search_projection_id,locators,scores,channel_explanations,graph_paths,authority,assurance,fresh_at,contradiction_ids,supersedes_ids,covered_subquery_ids,artifact_references,member_payload)
      values($1,$2,$3,${identity.map((_, index) => `$${index + 4}`).join(",")},$${parameter++},$${parameter++},$${parameter++}::jsonb,$${parameter++}::jsonb,$${parameter++}::text[],$${parameter++}::jsonb,$${parameter++},$${parameter++},$${parameter++},$${parameter++}::uuid[],$${parameter++}::uuid[],$${parameter++}::text[],$${parameter++}::jsonb,$${parameter++}::jsonb)
      on conflict(id) do nothing`,
      parameters,
    );
    const stored = (
      await client.query<Row>(
        "select member_payload from retrieval.packet_member where tenant_id=$1 and packet_id=$2 and id=$3",
        [tenantId, packetId, member.memberId],
      )
    ).rows[0];
    if (!stored || digestHex(stored.member_payload) !== digestHex(member))
      throw new Error("EVIDENCE_PACKET_MEMBER_CONFLICT");
  }

  async #getEvidencePacket(
    client: TenantSqlClient,
    tenantId: string,
    packetId: string,
  ): Promise<EvidencePacket | undefined> {
    const row = (
      await client.query<Row>(
        `select packet,packet_sha256,packet_schema_version,created_at,run_id,normalized_query,authorization_context,
      omitted_results,coverage,abstention,event_ids,receipt_ids from retrieval.evidence_packet where tenant_id=$1 and id=$2`,
        [tenantId, packetId],
      )
    ).rows[0];
    if (!row) return undefined;
    if (Number(row.packet_schema_version) !== 1 || !/^[a-f0-9]{64}$/.test(String(row.packet_sha256)))
      throw new Error("EVIDENCE_PACKET_SCHEMA_MISMATCH");
    const envelope = EvidencePacketSchema.parse(row.packet);
    assertPacketDigest(envelope);
    const memberIds = envelope.members.map(({ memberId }) => memberId);
    const rows =
      memberIds.length === 0
        ? []
        : (
            await client.query<Row>(
              `select * from retrieval.packet_member
      where tenant_id=$1 and packet_id=$2 order by array_position($3::uuid[],id)`,
              [tenantId, packetId, memberIds],
            )
          ).rows;
    if (rows.length !== memberIds.length) throw new Error("EVIDENCE_PACKET_MEMBER_CARDINALITY_MISMATCH");
    const members = rows.map((memberRow) => {
      if (!/^[a-f0-9]{64}$/.test(String(memberRow.member_sha256)))
        throw new Error("EVIDENCE_PACKET_MEMBER_DIGEST_MISSING");
      const payload = EvidencePacketMemberSchema.parse(memberRow.member_payload);
      const referenceColumn = payload.canonicalRecord
        ? packetMemberReferenceColumns.get(payload.canonicalRecord.kind)
        : undefined;
      if (payload.canonicalRecord && referenceColumn) {
        if (String(memberRow[referenceColumn]) !== payload.canonicalRecord.recordId)
          throw new Error("EVIDENCE_PACKET_MEMBER_REFERENCE_MISMATCH");
      } else {
        const locator = payload.locators[0];
        if (
          !payload.faithfulSectionRepresentationId ||
          !locator ||
          String(memberRow.source_representation_id) !== payload.faithfulSectionRepresentationId ||
          locator.representationId !== payload.faithfulSectionRepresentationId ||
          (locator.nodeId !== undefined && String(memberRow.source_document_node_id) !== locator.nodeId)
        )
          throw new Error("EVIDENCE_PACKET_SOURCE_REPRESENTATION_MISMATCH");
      }
      const normalized = EvidencePacketMemberSchema.parse({
        ...payload,
        memberId: String(memberRow.id),
        matchedProjectionId: String(memberRow.search_projection_id),
        locators: memberRow.locators,
        scores: memberRow.scores,
        channelExplanations: memberRow.channel_explanations,
        graphPaths: memberRow.graph_paths,
        authority: memberRow.authority,
        assurance: memberRow.assurance,
        freshAt: iso(memberRow.fresh_at),
        contradictionIds: memberRow.contradiction_ids,
        supersedesIds: memberRow.supersedes_ids,
        coveredSubqueryIds: memberRow.covered_subquery_ids,
        artifactReferences: memberRow.artifact_references,
      });
      if (digestHex(normalized) !== digestHex(payload)) throw new Error("EVIDENCE_PACKET_MEMBER_INTEGRITY_MISMATCH");
      return normalized;
    });
    const reconstructed = EvidencePacketSchema.parse({
      ...envelope,
      id: packetId,
      tenantId,
      retrievalRunId: String(row.run_id),
      createdAt: iso(row.created_at),
      normalizedQuery: row.normalized_query,
      authorization: row.authorization_context,
      omittedResults: row.omitted_results,
      coverage: row.coverage,
      abstention: row.abstention,
      eventIds: row.event_ids,
      receiptIds: row.receipt_ids,
      members,
    });
    assertPacketDigest(reconstructed);
    return reconstructed;
  }

  async recordArtifact(
    tenantId: string,
    input: {
      artifactId: string;
      artifactType: string;
      sha256: string;
      bucketClass: string;
      storageBucket: string;
      objectPath: string;
      mediaType: string;
      sizeBytes: number;
    },
  ): Promise<string> {
    return this.transaction(tenantId, async (client) => {
      await client.query(
        `insert into orchestration.artifact(id,tenant_id,artifact_type,sha256,bucket_class,storage_bucket,object_path,media_type,size_bytes)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(storage_bucket,object_path) where verification_contract_version is null do nothing`,
        [
          input.artifactId,
          tenantId,
          input.artifactType,
          input.sha256,
          input.bucketClass,
          input.storageBucket,
          input.objectPath,
          input.mediaType,
          input.sizeBytes,
        ],
      );
      const stored = (
        await client.query<Row>(
          "select * from orchestration.artifact where tenant_id=$1 and storage_bucket=$2 and object_path=$3",
          [tenantId, input.storageBucket, input.objectPath],
        )
      ).rows[0];
      if (!stored || stored.sha256 !== input.sha256 || Number(stored.size_bytes) !== input.sizeBytes)
        throw new Error("ARTIFACT_METADATA_CONFLICT");
      return String(stored.id);
    });
  }

  async #lockValidLease(client: TenantSqlClient, tenantId: string, current: LeasedStep): Promise<Row> {
    const result = await client.query<Row>(
      `select * from knowledge_service.lease where tenant_id=$1 and operation_step_id=$2 and lease_token=$3 and fencing_token=$4
      and released_at is null and expires_at>clock_timestamp() for update`,
      [tenantId, current.id, current.leaseToken, current.fencingToken],
    );
    if (!result.rows[0]) throw new Error("STALE_LEASE");
    return result.rows[0];
  }

  async #appendEvent(
    client: TenantSqlClient,
    tenantId: string,
    operationId: string,
    stepId: string | undefined,
    eventKind: string,
    fromState: string | undefined,
    toState: string | undefined,
    actorIdentity: string,
    correlationId: string,
    causationId: string | undefined,
    guardedSha256: string | undefined,
    payload: unknown,
  ): Promise<string> {
    const eventId = randomUUID();
    await client.query(
      `insert into knowledge_service.operation_event(id,tenant_id,operation_id,step_id,event_kind,from_state,to_state,actor_identity,correlation_id,causation_id,guarded_sha256,payload)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        eventId,
        tenantId,
        operationId,
        stepId ?? null,
        eventKind,
        fromState ?? null,
        toState ?? null,
        actorIdentity,
        correlationId,
        causationId ?? null,
        guardedSha256 ?? null,
        JSON.stringify(payload),
      ],
    );
    const outboxPayload = { eventId, operationId, eventKind, payload };
    await client.query(
      `insert into knowledge_service.outbox(id,tenant_id,operation_id,event_id,topic,payload,payload_sha256)
      values($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        deterministicUuid("canonical-outbox", eventId),
        tenantId,
        operationId,
        eventId,
        `knowledge.${eventKind}`,
        JSON.stringify(outboxPayload),
        digestHex(outboxPayload),
      ],
    );
    return eventId;
  }

  async #reconcileOperation(client: TenantSqlClient, tenantId: string, operationId: string): Promise<void> {
    const counts = (
      await client.query<Row>(
        `select count(*) filter(where status='failed') failed,count(*) filter(where status='running') running,
      count(*) filter(where status not in ('succeeded','failed')) remaining
      from knowledge_service.operation_step where tenant_id=$1 and operation_id=$2`,
        [tenantId, operationId],
      )
    ).rows[0]!;
    const failed = Number(counts.failed);
    const running = Number(counts.running);
    const remaining = Number(counts.remaining);
    const status = failed > 0 ? "failed" : remaining === 0 ? "succeeded" : running > 0 ? "running" : "queued";
    await client.query(
      `update knowledge_service.operation set status=$3,completed_at=case when $3 in ('succeeded','failed') then clock_timestamp() else null end
      where tenant_id=$1 and id=$2 and status is distinct from $3`,
      [tenantId, operationId, status],
    );
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { output: value };
}
