import {
  VerificationArtifactHandleSchema,
  VerificationBenchmarkCaseResultSchema,
  type VerificationArtifactHandle,
  type VerificationBenchmarkCaseResult,
} from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import type { LeasedStep } from "./types.js";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";

type Digest = `sha256:${string}`;
/** Structural compatibility with the evaluation runner; persistence does not import the runner package. */
export interface VerificationBenchmarkCheckpointStore {
  load(key: string): Promise<VerificationBenchmarkCaseResult | undefined>;
  save(key: string, result: VerificationBenchmarkCaseResult): Promise<void>;
}
export interface VerificationBenchmarkRunLifecycle {
  readonly startedAt: string;
  complete(): Promise<string>;
}
export interface VerificationBenchmarkCheckpointPlanEntry {
  readonly checkpointContextDigest: Digest;
  readonly caseId: string;
  readonly armId: string;
  readonly repetition: number;
}
export interface VerificationBenchmarkCheckpointPlan {
  readonly entries: readonly VerificationBenchmarkCheckpointPlanEntry[];
  readonly planDigest: Digest;
}
export interface DurableVerificationBenchmarkRunInput {
  readonly tenantId: string;
  readonly operationId: string;
  readonly lease: LeasedStep;
  readonly runId: string;
  readonly datasetArtifact: VerificationArtifactHandle;
  readonly experimentArtifact: VerificationArtifactHandle;
  readonly runnerVersion: string;
  readonly networkPolicy: "offline";
  readonly randomSeed: number;
  readonly repetitions: number;
  readonly checkpointPlan: VerificationBenchmarkCheckpointPlan;
  readonly startedAt: string;
}
export interface DurableVerificationBenchmarkRun {
  readonly tenantId: string;
  readonly operationId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly checkpointPlan: VerificationBenchmarkCheckpointPlan;
}
export interface DurableVerificationBenchmarkExecution {
  readonly run: DurableVerificationBenchmarkRun;
  readonly checkpoints: VerificationBenchmarkCheckpointStore;
  readonly lifecycle: VerificationBenchmarkRunLifecycle;
}

type StoredRun = {
  id: string;
  tenant_id: string;
  operation_id: string;
  dataset_artifact_id: string;
  dataset_sha256: string;
  experiment_artifact_id: string;
  experiment_sha256: string;
  runner_version: string;
  network_policy: string;
  random_seed: number;
  repetitions: number;
  checkpoint_plan: unknown;
  checkpoint_plan_sha256: string;
  expected_checkpoint_count: number;
  started_at: Date | string;
  completed_at: Date | string | null;
  status: string;
};
type StoredCheckpoint = {
  checkpoint_context_sha256: string;
  checkpoint_sha256: string;
  result_sha256: string;
  result: unknown;
  completed_at: Date | string;
};

/**
 * Fenced durable state for the offline runner. State mutation locks the
 * canonical operation first, then uses the same non-inverting live lease
 * predicate as verification-run sealing, so cancellation is linearized first.
 */
export class PostgresVerificationBenchmarkRunStore {
  constructor(private readonly database: Pick<PostgresCanonicalRepository, "transaction">) {}

  async initialize(input: DurableVerificationBenchmarkRunInput): Promise<DurableVerificationBenchmarkExecution> {
    const values = parseInput(input);
    const run = await this.database.transaction(values.tenantId, async (client) => {
      await assertLiveOperationLease(client, values.tenantId, values.operationId, values.lease);
      const existing = (
        await client.query<StoredRun>(
          "select * from evaluation.verification_benchmark_run where tenant_id=$1 and id=$2 for update",
          [values.tenantId, values.runId],
        )
      ).rows[0];
      if (existing) return assertExactRun(existing, values);
      await client.query(
        `insert into evaluation.verification_benchmark_run
        (id,tenant_id,operation_id,dataset_artifact_id,dataset_sha256,experiment_artifact_id,experiment_sha256,runner_version,network_policy,random_seed,repetitions,checkpoint_plan,checkpoint_plan_sha256,expected_checkpoint_count,started_at,status)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,'running')`,
        [
          values.runId,
          values.tenantId,
          values.operationId,
          values.datasetArtifact.artifactId,
          hex(values.datasetArtifact.digest),
          values.experimentArtifact.artifactId,
          hex(values.experimentArtifact.digest),
          values.runnerVersion,
          values.networkPolicy,
          values.randomSeed,
          values.repetitions,
          JSON.stringify(values.checkpointPlan.entries),
          hex(values.checkpointPlan.planDigest),
          values.checkpointPlan.entries.length,
          values.startedAt,
        ],
      );
      const stored = (
        await client.query<StoredRun>(
          "select * from evaluation.verification_benchmark_run where tenant_id=$1 and id=$2 for update",
          [values.tenantId, values.runId],
        )
      ).rows[0];
      if (!stored) throw new Error("BENCHMARK_DURABLE_RUN_INSERT_LOST");
      return assertExactRun(stored, values);
    });
    const durable = freezeRun(run);
    return {
      run: durable,
      checkpoints: {
        load: async (key) => this.load(durable, key),
        save: async (key, result) => this.save(durable, values.lease, key, result),
      },
      lifecycle: { startedAt: durable.startedAt, complete: async () => this.complete(durable, values.lease) },
    };
  }

  async load(run: DurableVerificationBenchmarkRun, key: string): Promise<VerificationBenchmarkCaseResult | undefined> {
    requireDigest(key, "checkpoint key");
    return this.database.transaction(run.tenantId, async (client) => {
      const row = (
        await client.query<StoredCheckpoint>(
          `select checkpoint_context_sha256,checkpoint_sha256,result_sha256,result,completed_at
        from evaluation.verification_benchmark_checkpoint where tenant_id=$1 and benchmark_run_id=$2 and checkpoint_context_sha256=$3`,
          [run.tenantId, run.runId, hex(key)],
        )
      ).rows[0];
      return row ? parseStoredCheckpoint(row, run, key) : undefined;
    });
  }

  async save(
    run: DurableVerificationBenchmarkRun,
    lease: LeasedStep,
    key: string,
    value: VerificationBenchmarkCaseResult,
  ): Promise<void> {
    const result = parseCheckpoint(run, key, value);
    await this.database.transaction(run.tenantId, async (client) => {
      await assertLiveOperationLease(client, run.tenantId, run.operationId, lease);
      const storedRun = (
        await client.query<StoredRun>(
          "select * from evaluation.verification_benchmark_run where tenant_id=$1 and id=$2 for update",
          [run.tenantId, run.runId],
        )
      ).rows[0];
      if (!storedRun || storedRun.status !== "running") throw new Error("BENCHMARK_DURABLE_RUN_NOT_WRITABLE");
      assertStoredRunBinding(storedRun, run);
      const current = (await client.query<{ now: Date | string }>("select clock_timestamp() now")).rows[0];
      if (
        !current ||
        new Date(result.completedAt).valueOf() < new Date(run.startedAt).valueOf() ||
        new Date(result.completedAt).valueOf() > new Date(iso(current.now)).valueOf()
      )
        throw new Error("BENCHMARK_DURABLE_CHECKPOINT_TIMESTAMP_INVALID");
      await client.query(
        `insert into evaluation.verification_benchmark_checkpoint
       (tenant_id,benchmark_run_id,checkpoint_context_sha256,checkpoint_sha256,result_sha256,result,completed_at)
       values($1,$2,$3,$4,$5,$6::jsonb,$7) on conflict(tenant_id,benchmark_run_id,checkpoint_context_sha256) do nothing`,
        [
          run.tenantId,
          run.runId,
          hex(key),
          hex(result.checkpointDigest),
          hex(sha256Digest(result)),
          JSON.stringify(result),
          result.completedAt,
        ],
      );
      const stored = (
        await client.query<StoredCheckpoint>(
          `select checkpoint_context_sha256,checkpoint_sha256,result_sha256,result,completed_at
       from evaluation.verification_benchmark_checkpoint where tenant_id=$1 and benchmark_run_id=$2 and checkpoint_context_sha256=$3`,
          [run.tenantId, run.runId, hex(key)],
        )
      ).rows[0];
      if (!stored) throw new Error("BENCHMARK_DURABLE_CHECKPOINT_INSERT_LOST");
      parseStoredCheckpoint(stored, run, key, result);
    });
  }

  async complete(run: DurableVerificationBenchmarkRun, lease: LeasedStep): Promise<string> {
    return this.database.transaction(run.tenantId, async (client) => {
      await assertLiveOperationLease(client, run.tenantId, run.operationId, lease);
      const stored = (
        await client.query<StoredRun>(
          "select * from evaluation.verification_benchmark_run where tenant_id=$1 and id=$2 for update",
          [run.tenantId, run.runId],
        )
      ).rows[0];
      if (!stored) throw new Error("BENCHMARK_DURABLE_RUN_NOT_FOUND");
      assertStoredRunBinding(stored, run);
      if (stored.status === "completed" || stored.status === "sealed") return iso(stored.completed_at);
      if (stored.status !== "running") throw new Error("BENCHMARK_DURABLE_RUN_NOT_WRITABLE");
      const count = (
        await client.query<{ count: string }>(
          "select count(*)::text count from evaluation.verification_benchmark_checkpoint where tenant_id=$1 and benchmark_run_id=$2",
          [run.tenantId, run.runId],
        )
      ).rows[0];
      if (!count || Number(count.count) !== run.checkpointPlan.entries.length)
        throw new Error("BENCHMARK_DURABLE_CHECKPOINT_PLAN_INCOMPLETE");
      const updated = (
        await client.query<{ completed_at: Date | string }>(
          `update evaluation.verification_benchmark_run set status='completed',completed_at=clock_timestamp()
       where tenant_id=$1 and id=$2 and status='running' and clock_timestamp()>=started_at and clock_timestamp()>=coalesce((select max(completed_at) from evaluation.verification_benchmark_checkpoint where tenant_id=$1 and benchmark_run_id=$2),started_at) returning completed_at`,
          [run.tenantId, run.runId],
        )
      ).rows[0];
      if (!updated) throw new Error("BENCHMARK_DURABLE_RUN_COMPLETION_RACE");
      return iso(updated.completed_at);
    });
  }
}

function parseInput(input: DurableVerificationBenchmarkRunInput): DurableVerificationBenchmarkRunInput {
  requireUuid(input.tenantId, "tenantId");
  requireUuid(input.operationId, "operationId");
  requireUuid(input.runId, "runId");
  assertLease(input.lease, input.operationId);
  canonicalIso(input.startedAt, "startedAt");
  const datasetArtifact = VerificationArtifactHandleSchema.parse(input.datasetArtifact),
    experimentArtifact = VerificationArtifactHandleSchema.parse(input.experimentArtifact);
  if (
    datasetArtifact.tenantId !== input.tenantId ||
    experimentArtifact.tenantId !== input.tenantId ||
    !input.runnerVersion.trim() ||
    input.runnerVersion.length > 255 ||
    !Number.isInteger(input.randomSeed) ||
    !Number.isInteger(input.repetitions) ||
    input.repetitions < 1 ||
    input.repetitions > 10
  )
    throw new Error("BENCHMARK_DURABLE_RUN_INPUT_INVALID");
  const entries = input.checkpointPlan?.entries;
  if (
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > 160000 ||
    digestCanonicalJson(entries) !== input.checkpointPlan.planDigest
  )
    throw new Error("BENCHMARK_DURABLE_PLAN_INVALID");
  const keys = new Set<string>();
  for (const entry of entries) {
    requireDigest(entry.checkpointContextDigest, "plan key");
    if (
      !entry.caseId ||
      !entry.armId ||
      !Number.isInteger(entry.repetition) ||
      entry.repetition < 0 ||
      keys.has(entry.checkpointContextDigest)
    )
      throw new Error("BENCHMARK_DURABLE_PLAN_INVALID");
    keys.add(entry.checkpointContextDigest);
  }
  return {
    ...input,
    datasetArtifact,
    experimentArtifact,
    startedAt: canonicalIso(input.startedAt, "startedAt"),
    checkpointPlan: { entries: entries.map((entry) => ({ ...entry })), planDigest: input.checkpointPlan.planDigest },
  };
}
function assertExactRun(
  stored: StoredRun,
  input: DurableVerificationBenchmarkRunInput,
): DurableVerificationBenchmarkRun {
  const exact =
    stored.tenant_id === input.tenantId &&
    stored.operation_id === input.operationId &&
    stored.dataset_artifact_id === input.datasetArtifact.artifactId &&
    stored.dataset_sha256 === hex(input.datasetArtifact.digest) &&
    stored.experiment_artifact_id === input.experimentArtifact.artifactId &&
    stored.experiment_sha256 === hex(input.experimentArtifact.digest) &&
    stored.runner_version === input.runnerVersion &&
    stored.network_policy === input.networkPolicy &&
    Number(stored.random_seed) === input.randomSeed &&
    Number(stored.repetitions) === input.repetitions &&
    stored.checkpoint_plan_sha256 === hex(input.checkpointPlan.planDigest) &&
    Number(stored.expected_checkpoint_count) === input.checkpointPlan.entries.length &&
    digestCanonicalJson(stored.checkpoint_plan) === input.checkpointPlan.planDigest;
  if (!exact) throw new Error("BENCHMARK_DURABLE_RUN_IDENTITY_DRIFT");
  return freezeRun({
    tenantId: input.tenantId,
    operationId: input.operationId,
    runId: input.runId,
    startedAt: iso(stored.started_at),
    checkpointPlan: input.checkpointPlan,
  });
}
function assertStoredRunBinding(stored: StoredRun, run: DurableVerificationBenchmarkRun): void {
  if (
    stored.id !== run.runId ||
    stored.tenant_id !== run.tenantId ||
    stored.operation_id !== run.operationId ||
    iso(stored.started_at) !== run.startedAt ||
    digestCanonicalJson(run.checkpointPlan.entries) !== run.checkpointPlan.planDigest ||
    stored.checkpoint_plan_sha256 !== hex(run.checkpointPlan.planDigest) ||
    digestCanonicalJson(stored.checkpoint_plan) !== run.checkpointPlan.planDigest ||
    Number(stored.expected_checkpoint_count) !== run.checkpointPlan.entries.length
  )
    throw new Error("BENCHMARK_DURABLE_RUN_BINDING_INVALID");
}
function parseCheckpoint(
  run: DurableVerificationBenchmarkRun,
  key: string,
  value: VerificationBenchmarkCaseResult,
): VerificationBenchmarkCaseResult {
  requireDigest(key, "checkpoint key");
  const result = VerificationBenchmarkCaseResultSchema.parse(value);
  const plan = run.checkpointPlan.entries.find((entry) => entry.checkpointContextDigest === key);
  const { checkpointDigest, ...material } = result;
  if (
    !plan ||
    result.runId !== run.runId ||
    result.checkpointContextDigest !== key ||
    result.caseId !== plan.caseId ||
    result.armId !== plan.armId ||
    result.repetition !== plan.repetition ||
    digestCanonicalJson(material) !== checkpointDigest
  )
    throw new Error("BENCHMARK_DURABLE_CHECKPOINT_BINDING_INVALID");
  canonicalIso(result.completedAt, "checkpoint.completedAt");
  return result;
}
function parseStoredCheckpoint(
  stored: StoredCheckpoint,
  run: DurableVerificationBenchmarkRun,
  key: string,
  expected?: VerificationBenchmarkCaseResult,
): VerificationBenchmarkCaseResult {
  if (stored.checkpoint_context_sha256 !== hex(key)) throw new Error("BENCHMARK_DURABLE_CHECKPOINT_BINDING_INVALID");
  const result = parseCheckpoint(run, key, VerificationBenchmarkCaseResultSchema.parse(stored.result));
  if (
    stored.checkpoint_sha256 !== hex(result.checkpointDigest) ||
    stored.result_sha256 !== hex(sha256Digest(result)) ||
    iso(stored.completed_at) !== canonicalIso(result.completedAt, "checkpoint.completedAt") ||
    (expected !== undefined && digestCanonicalJson(expected) !== digestCanonicalJson(result))
  )
    throw new Error("BENCHMARK_DURABLE_CHECKPOINT_DRIFT");
  return result;
}
async function assertLiveOperationLease(
  client: TenantSqlClient,
  tenantId: string,
  operationId: string,
  lease: LeasedStep,
): Promise<void> {
  const operation = (
    await client.query<{ status: string }>(
      "select status from knowledge_service.operation where tenant_id=$1 and id=$2 for update",
      [tenantId, operationId],
    )
  ).rows[0];
  if (!operation || operation.status !== "running") throw new Error("BENCHMARK_DURABLE_OPERATION_NOT_ACTIVE");
  const row = (
    await client.query<{ id: string }>(
      `select step.id from knowledge_service.operation_step step join knowledge_service.lease lease on lease.tenant_id=step.tenant_id and lease.operation_step_id=step.id where step.tenant_id=$1 and step.id=$2 and step.operation_id=$3 and lease.lease_token=$4 and lease.fencing_token=$5 and lease.holder_identity=$6 and lease.released_at is null and lease.expires_at>clock_timestamp() and step.status='running'`,
      [tenantId, lease.id, operationId, lease.leaseToken, lease.fencingToken, lease.holderIdentity],
    )
  ).rows[0];
  if (!row) throw new Error("BENCHMARK_DURABLE_STALE_LEASE");
}
function freezeRun(value: DurableVerificationBenchmarkRun): DurableVerificationBenchmarkRun {
  return Object.freeze({
    ...value,
    checkpointPlan: Object.freeze({
      entries: Object.freeze(value.checkpointPlan.entries.map((entry) => Object.freeze({ ...entry }))),
      planDigest: value.checkpointPlan.planDigest,
    }),
  });
}
function hex(value: string): string {
  requireDigest(value, "digest");
  return value.slice(7);
}
function requireDigest(value: string, field: string): asserts value is Digest {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`BENCHMARK_DURABLE_${field.toUpperCase()}_INVALID`);
}
function requireUuid(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  )
    throw new Error(`BENCHMARK_DURABLE_${field.toUpperCase()}_INVALID`);
}
function canonicalIso(value: string, field: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== value)
    throw new Error(`BENCHMARK_DURABLE_${field.toUpperCase()}_INVALID`);
  return value;
}
function iso(value: Date | string | null): string {
  if (!value) throw new Error("BENCHMARK_DURABLE_COMPLETION_MISSING");
  return value instanceof Date ? value.toISOString() : canonicalIso(value, "timestamp");
}
function assertLease(lease: LeasedStep, operationId: string): void {
  requireUuid(lease.id, "lease.stepId");
  if (
    lease.operationId !== operationId ||
    !lease.leaseToken.trim() ||
    !lease.holderIdentity.trim() ||
    !Number.isSafeInteger(lease.fencingToken) ||
    lease.fencingToken < 1
  )
    throw new Error("BENCHMARK_DURABLE_LEASE_INVALID");
}
