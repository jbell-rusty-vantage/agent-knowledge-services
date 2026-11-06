import {
  VerificationArtifactHandleSchema,
  VerificationStructuredExtractionExecutionSchema,
  type VerificationArtifactHandle,
  type VerificationStructuredExtractionExecution,
} from "@aiengineer/knowledge-contracts";
import { structuredExtractionExecutionTransformationSignature } from "@aiengineer/knowledge-application";
import { canonicalizeJson, digestCanonicalJson, sha256Digest } from "@aiengineer/knowledge-verification";
import { deepFreeze } from "@aiengineer/knowledge-core";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
import type { LeasedStep } from "./types.js";

type Row = Record<string, unknown>;
type Digest = `sha256:${string}`;
export interface StructuredExtractionExecutionBinding {
  readonly tenantId: string;
  readonly operationId: string;
  readonly operationStepId: string;
  readonly producerAttemptId: string;
  readonly requestDigest: Digest;
  readonly stepInputDigest: Digest;
  readonly profileArtifactId: string;
  readonly profileDigest: Digest;
  readonly executionArtifactId: string;
  readonly executionDigest: Digest;
  readonly runtimeDigest: Digest;
  readonly mode: "synthetic_transport" | "live_provider";
  readonly dirtyArtifactId: string | null;
  readonly dirtyDigest: Digest | null;
  readonly createdAt: string;
  readonly boundAt: string;
}
const hex = (value: string) => value.slice(7);
const digest = (value: unknown): Digest => `sha256:${String(value)}`;
const iso = (value: unknown) => new Date(value as string).toISOString();
function snapshot(row: Row): StructuredExtractionExecutionBinding {
  return deepFreeze({
    tenantId: String(row.tenant_id),
    operationId: String(row.operation_id),
    operationStepId: String(row.operation_step_id),
    producerAttemptId: String(row.producer_attempt_id),
    requestDigest: digest(row.request_sha256),
    stepInputDigest: digest(row.step_input_sha256),
    profileArtifactId: String(row.profile_artifact_id),
    profileDigest: digest(row.profile_sha256),
    executionArtifactId: String(row.execution_artifact_id),
    executionDigest: digest(row.execution_sha256),
    runtimeDigest: digest(row.runtime_sha256),
    mode: row.execution_mode as StructuredExtractionExecutionBinding["mode"],
    dirtyArtifactId: row.dirty_artifact_id === null ? null : String(row.dirty_artifact_id),
    dirtyDigest: row.dirty_sha256 === null ? null : digest(row.dirty_sha256),
    createdAt: iso(row.execution_created_at),
    boundAt: iso(row.bound_at),
  });
}
function leaseSnapshot(input: LeasedStep): LeasedStep {
  const value = structuredClone(input),
    uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (
    ![value.tenantId, value.operationId, value.id, value.leaseToken].every((v) => uuid.test(v)) ||
    value.stepKey !== "extract_and_register" ||
    value.status !== "running" ||
    !value.holderIdentity?.trim() ||
    !Number.isSafeInteger(value.fencingToken) ||
    value.fencingToken < 1 ||
    !/^[0-9a-f]{64}$/u.test(value.inputSha256)
  )
    throw new Error("STRUCTURED_EXTRACTION_EXECUTION_LEASE_INVALID");
  return deepFreeze(value);
}
async function live(client: TenantSqlClient, lease: LeasedStep): Promise<Row> {
  const operation = (
    await client.query<Row>(
      "select id,attempt_id,request_sha256 from knowledge_service.operation where tenant_id=$1 and id=$2 and operation_kind='verification_structured_extraction' and status='running' for update",
      [lease.tenantId, lease.operationId],
    )
  ).rows[0];
  if (!operation) throw new Error("STRUCTURED_EXTRACTION_EXECUTION_OPERATION_NOT_ACTIVE");
  const step = (
    await client.query<Row>(
      "select s.id from knowledge_service.operation_step s join knowledge_service.lease l on l.tenant_id=s.tenant_id and l.operation_step_id=s.id where s.tenant_id=$1 and s.operation_id=$2 and s.id=$3 and s.status='running' and s.step_key='extract_and_register' and s.input_sha256=$4 and l.lease_token=$5 and l.fencing_token=$6 and l.holder_identity=$7 and l.released_at is null and l.expires_at>clock_timestamp() for update of s,l",
      [
        lease.tenantId,
        lease.operationId,
        lease.id,
        lease.inputSha256,
        lease.leaseToken,
        lease.fencingToken,
        lease.holderIdentity,
      ],
    )
  ).rows[0];
  if (!step) throw new Error("STRUCTURED_EXTRACTION_EXECUTION_STALE_LEASE");
  await client.query("select set_config('verification.structured_extraction_claim',$1,true)", [
    JSON.stringify({
      stepId: lease.id,
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
      holderIdentity: lease.holderIdentity,
    }),
  ]);
  return operation;
}

/** Immutable original execution custody. A new binding is prohibited once any provider reservation exists. */
export class PostgresStructuredExtractionExecutionStore {
  constructor(private readonly database: Pick<PostgresCanonicalRepository, "transaction">) {}
  async bind(input: {
    readonly lease: LeasedStep;
    readonly execution: VerificationStructuredExtractionExecution;
    readonly artifact: VerificationArtifactHandle;
  }): Promise<StructuredExtractionExecutionBinding> {
    const lease = leaseSnapshot(input.lease),
      execution = deepFreeze(VerificationStructuredExtractionExecutionSchema.parse(input.execution)),
      artifact = deepFreeze(VerificationArtifactHandleSchema.parse(input.artifact));
    const bytes = new TextEncoder().encode(canonicalizeJson(execution)),
      payloadDigest = sha256Digest(bytes),
      runtimeDigest = digestCanonicalJson(execution.runtime),
      dirty = execution.runtime.code.dirtyStateArtifact;
    const parents = [execution.profileArtifact.artifactId, ...(dirty ? [dirty.artifactId] : [])];
    const signature = structuredExtractionExecutionTransformationSignature({
      payloadDigest,
      tenantId: execution.tenantId,
      operationId: execution.operationId,
      operationStepId: execution.operationStepId,
      producerAttemptId: execution.producerAttemptId,
      requestDigest: execution.requestDigest as Digest,
      stepInputDigest: execution.stepInputDigest as Digest,
      profileDigest: execution.profileArtifact.digest as Digest,
      runtimeDigest,
      mode: execution.execution.mode,
      createdAt: execution.createdAt,
      parentArtifactIds: parents,
    });
    if (
      execution.tenantId !== lease.tenantId ||
      execution.operationId !== lease.operationId ||
      execution.operationStepId !== lease.id ||
      hex(execution.stepInputDigest) !== lease.inputSha256 ||
      artifact.tenantId !== lease.tenantId ||
      artifact.digest !== payloadDigest ||
      artifact.byteLength !== bytes.byteLength ||
      artifact.createdAt !== execution.createdAt ||
      artifact.transformationSignature !== signature ||
      canonicalizeJson(artifact.parentArtifactIds) !== canonicalizeJson(parents)
    )
      throw new Error("STRUCTURED_EXTRACTION_EXECUTION_ARTIFACT_BINDING_INVALID");
    const expected = {
      tenantId: execution.tenantId,
      operationId: execution.operationId,
      operationStepId: execution.operationStepId,
      producerAttemptId: execution.producerAttemptId,
      requestDigest: execution.requestDigest,
      stepInputDigest: execution.stepInputDigest,
      profileArtifactId: execution.profileArtifact.artifactId,
      profileDigest: execution.profileArtifact.digest,
      executionArtifactId: artifact.artifactId,
      executionDigest: artifact.digest,
      runtimeDigest,
      mode: execution.execution.mode,
      dirtyArtifactId: dirty?.artifactId ?? null,
      dirtyDigest: dirty?.digest ?? null,
      createdAt: execution.createdAt,
    };
    return this.database.transaction(lease.tenantId, async (client) => {
      const operation = await live(client, lease);
      if (
        operation.attempt_id !== execution.producerAttemptId ||
        operation.request_sha256 !== hex(execution.requestDigest)
      )
        throw new Error("STRUCTURED_EXTRACTION_EXECUTION_OPERATION_BINDING_INVALID");
      const prior = (
        await client.query<Row>(
          "select * from orchestration.verification_structured_extraction_execution where tenant_id=$1 and operation_id=$2 for update",
          [lease.tenantId, lease.operationId],
        )
      ).rows[0];
      if (prior) {
        const bound = snapshot(prior),
          { boundAt: _time, ...identity } = bound;
        if (canonicalizeJson(identity) !== canonicalizeJson(expected))
          throw new Error("STRUCTURED_EXTRACTION_EXECUTION_BINDING_DRIFT");
        return bound;
      }
      const row = (
        await client.query<Row>(
          `insert into orchestration.verification_structured_extraction_execution(tenant_id,operation_id,operation_step_id,producer_attempt_id,request_sha256,step_input_sha256,profile_artifact_id,profile_sha256,execution_artifact_id,execution_sha256,runtime_sha256,execution_mode,dirty_artifact_id,dirty_sha256,execution_created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
          [
            execution.tenantId,
            execution.operationId,
            execution.operationStepId,
            execution.producerAttemptId,
            hex(execution.requestDigest),
            hex(execution.stepInputDigest),
            execution.profileArtifact.artifactId,
            hex(execution.profileArtifact.digest),
            artifact.artifactId,
            hex(artifact.digest),
            hex(runtimeDigest),
            execution.execution.mode,
            dirty?.artifactId ?? null,
            dirty ? hex(dirty.digest) : null,
            execution.createdAt,
          ],
        )
      ).rows[0];
      if (!row) throw new Error("STRUCTURED_EXTRACTION_EXECUTION_BINDING_LOST");
      return snapshot(row);
    });
  }
  /** Metadata only; publication freshly hydrates the execution artifact through the authorized resolver. */
  async readForRecovery(input: {
    readonly lease: LeasedStep;
  }): Promise<StructuredExtractionExecutionBinding | undefined> {
    const lease = leaseSnapshot(input.lease);
    return this.database.transaction(lease.tenantId, async (client) => {
      const operation = await live(client, lease);
      const row = (
        await client.query<Row>(
          "select * from orchestration.verification_structured_extraction_execution where tenant_id=$1 and operation_id=$2",
          [lease.tenantId, lease.operationId],
        )
      ).rows[0];
      if (!row) return undefined;
      const result = snapshot(row);
      if (
        result.operationStepId !== lease.id ||
        result.producerAttemptId !== operation.attempt_id ||
        hex(result.requestDigest) !== operation.request_sha256 ||
        hex(result.stepInputDigest) !== lease.inputSha256
      )
        throw new Error("STRUCTURED_EXTRACTION_EXECUTION_BINDING_DRIFT");
      return result;
    });
  }
}
