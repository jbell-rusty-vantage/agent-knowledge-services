import {
  VerificationArtifactHandleSchema,
  VerificationBenchmarkDatasetSchema,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import type { LeasedStep } from "./types.js";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";

type TerminalStatus = "succeeded" | "failed" | "review" | "abstained";
type Handle = VerificationArtifactHandle;
export interface BenchmarkPublicationDatasetDefinition {
  readonly id: string;
  readonly slug: string;
  readonly purpose: string;
  readonly version: {
    readonly id: string;
    readonly number: number;
    readonly manifest: unknown;
    readonly manifestArtifact: Handle;
    readonly frozenAt: string;
    readonly caseCount: number;
    readonly labelProvenance: "agent_generated";
  };
}
export interface BenchmarkPublicationArmDefinition {
  readonly benchmarkArmId: string;
  readonly experimentArmId: string;
  readonly evalRunId: string;
  readonly name: string;
  readonly isControl: boolean;
  readonly configuration: unknown;
  readonly configurationArtifact: Handle;
  readonly policyArtifact: Handle;
  readonly targetCodeRef: string;
  readonly terminalStatus: TerminalStatus;
}
export interface CompletedBenchmarkPublicationInput {
  readonly tenantId: string;
  readonly operationId: string;
  readonly lease: LeasedStep;
  readonly benchmarkRunId: string;
  readonly runnerPayloadManifest: Handle;
  readonly publicationManifest: Handle;
  readonly dataset: BenchmarkPublicationDatasetDefinition;
  readonly experiment: {
    readonly id: string;
    readonly name: string;
    readonly hypothesis: string;
    readonly artifact: Handle;
  };
  readonly arms: readonly BenchmarkPublicationArmDefinition[];
}
export interface CompletedBenchmarkPublication {
  readonly benchmarkRunId: string;
  readonly evalRunIds: readonly string[];
}

/** Atomically freezes a completed runner payload and one factual evaluation run per configured arm. */
export class PostgresVerificationBenchmarkPublisher {
  constructor(private readonly database: Pick<PostgresCanonicalRepository, "transaction">) {}
  async publishCompleted(input: CompletedBenchmarkPublicationInput): Promise<CompletedBenchmarkPublication> {
    const v = parse(input);
    return this.database.transaction(v.tenantId, async (client) => {
      const operation = await live(client, v.tenantId, v.operationId, v.lease);
      const run = (
        await client.query<Run>(
          "select * from evaluation.verification_benchmark_run where tenant_id=$1 and id=$2 for update",
          [v.tenantId, v.benchmarkRunId],
        )
      ).rows[0];
      if (
        !run ||
        run.operation_id !== v.operationId ||
        !(["completed", "sealed"] as const).includes(run.status as "completed" | "sealed") ||
        !same(run.dataset_artifact_id, v.dataset.version.manifestArtifact.artifactId) ||
        !same(run.dataset_sha256, hex(v.dataset.version.manifestArtifact.digest))
      )
        throw new Error("BENCHMARK_PUBLICATION_RUN_BINDING_INVALID");
      if (
        run.status === "sealed" &&
        (run.run_manifest_artifact_id !== v.runnerPayloadManifest.artifactId ||
          run.run_manifest_sha256 !== hex(v.runnerPayloadManifest.digest))
      )
        throw new Error("BENCHMARK_PUBLICATION_IDENTITY_DRIFT");
      if (!same(run.experiment_artifact_id, v.experimentArtifactId) || !same(run.experiment_sha256, v.experimentDigest))
        throw new Error("BENCHMARK_PUBLICATION_EXPERIMENT_BINDING_INVALID");
      assertPlanArms(run.checkpoint_plan, v.arms);
      await catalog(client, v, operation, run);
      for (const arm of v.arms) await armRun(client, v, operation, run, arm);
      await client.query(
        "update evaluation.verification_benchmark_run set status='sealed',run_manifest_artifact_id=$3,run_manifest_sha256=$4 where tenant_id=$1 and id=$2 and status='completed'",
        [v.tenantId, v.benchmarkRunId, v.runnerPayloadManifest.artifactId, hex(v.runnerPayloadManifest.digest)],
      );
      for (const arm of v.arms) await mapping(client, v, arm);
      return Object.freeze({
        benchmarkRunId: v.benchmarkRunId,
        evalRunIds: Object.freeze(v.arms.map((a) => a.evalRunId)),
      });
    });
  }
}
type Parsed = CompletedBenchmarkPublicationInput & {
  readonly experimentArtifactId: string;
  readonly experimentDigest: string;
};
type Run = {
  operation_id: string;
  status: string;
  dataset_artifact_id: string;
  dataset_sha256: string;
  experiment_artifact_id: string;
  experiment_sha256: string;
  run_manifest_artifact_id: string | null;
  run_manifest_sha256: string | null;
  checkpoint_plan: unknown;
  started_at: string | Date;
  completed_at: string | Date | null;
};
type Op = { mission_id: string | null; work_item_id: string | null; attempt_id: string | null };
function parse(input: CompletedBenchmarkPublicationInput): Parsed {
  const i = deepFreeze(structuredClone(input)) as CompletedBenchmarkPublicationInput;
  uuid(i.tenantId);
  uuid(i.operationId);
  uuid(i.benchmarkRunId);
  if (
    i.lease.operationId !== i.operationId ||
    !i.lease.leaseToken.trim() ||
    !i.lease.holderIdentity.trim() ||
    !Number.isSafeInteger(i.lease.fencingToken) ||
    i.lease.fencingToken < 1
  )
    throw new Error("BENCHMARK_PUBLICATION_LEASE_INVALID");
  const dataset = VerificationBenchmarkDatasetSchema.parse(i.dataset.version.manifest);
  const handle = (x: Handle) => {
    const h = VerificationArtifactHandleSchema.parse(x);
    if (h.tenantId !== i.tenantId) throw new Error("BENCHMARK_PUBLICATION_ARTIFACT_TENANT_MISMATCH");
    return h;
  };
  const manifest = handle(i.dataset.version.manifestArtifact),
    runner = handle(i.runnerPayloadManifest),
    pub = handle(i.publicationManifest);
  uuid(i.dataset.id);
  uuid(i.dataset.version.id);
  uuid(i.experiment.id);
  const material = { ...dataset } as Record<string, unknown>;
  delete material.manifestDigest;
  if (
    !i.dataset.slug.trim() ||
    !i.dataset.purpose.trim() ||
    i.dataset.version.labelProvenance !== "agent_generated" ||
    !["engineering_expectations", "mixed_pending"].includes(dataset.labelProvenance) ||
    digestCanonicalJson(material) !== dataset.manifestDigest ||
    dataset.version !== i.dataset.version.number ||
    dataset.cases.length !== i.dataset.version.caseCount ||
    dataset.sealedAt !== i.dataset.version.frozenAt
  )
    throw new Error("BENCHMARK_PUBLICATION_DATASET_DEFINITION_INVALID");
  const arms = i.arms.map((a) => ({
    ...a,
    configurationArtifact: handle(a.configurationArtifact),
    policyArtifact: handle(a.policyArtifact),
  }));
  if (
    !arms.length ||
    new Set(arms.map((a) => a.benchmarkArmId)).size !== arms.length ||
    new Set(arms.map((a) => a.evalRunId)).size !== arms.length ||
    new Set(arms.map((a) => a.experimentArmId)).size !== arms.length ||
    arms.filter((a) => a.isControl).length !== 1
  )
    throw new Error("BENCHMARK_PUBLICATION_ARM_SET_INVALID");
  for (const a of arms) {
    uuid(a.experimentArmId);
    uuid(a.evalRunId);
    if (
      a.benchmarkArmId.length > 255 ||
      a.name.length > 4096 ||
      a.targetCodeRef.length > 4096 ||
      !a.benchmarkArmId.trim() ||
      !a.name.trim() ||
      !a.targetCodeRef.trim() ||
      !["succeeded", "failed", "review", "abstained"].includes(a.terminalStatus) ||
      !record(a.configuration) ||
      record(a.configuration).armId !== a.benchmarkArmId
    )
      throw new Error("BENCHMARK_PUBLICATION_ARM_INVALID");
  }
  const experimentArtifact = i.experiment.artifact;
  if (!experimentArtifact) throw new Error("BENCHMARK_PUBLICATION_EXPERIMENT_ARTIFACT_REQUIRED");
  const exp = handle(experimentArtifact);
  return {
    ...i,
    dataset: { ...i.dataset, version: { ...i.dataset.version, manifestArtifact: manifest } },
    runnerPayloadManifest: runner,
    publicationManifest: pub,
    experiment: { ...i.experiment, artifact: exp },
    arms,
    experimentArtifactId: exp.artifactId,
    experimentDigest: hex(exp.digest),
  };
}
async function live(c: TenantSqlClient, t: string, o: string, l: LeasedStep): Promise<Op> {
  const op = (
    await c.query<Op & { status: string }>(
      "select mission_id,work_item_id,attempt_id,status from knowledge_service.operation where tenant_id=$1 and id=$2 for update",
      [t, o],
    )
  ).rows[0];
  if (!op || op.status !== "running") throw new Error("BENCHMARK_PUBLICATION_OPERATION_NOT_ACTIVE");
  const lease = (
    await c.query<{ id: string }>(
      "select step.id from knowledge_service.operation_step step join knowledge_service.lease lease on lease.tenant_id=step.tenant_id and lease.operation_step_id=step.id where step.tenant_id=$1 and step.id=$2 and step.operation_id=$3 and lease.lease_token=$4 and lease.fencing_token=$5 and lease.holder_identity=$6 and lease.released_at is null and lease.expires_at>clock_timestamp() and step.status='running'",
      [t, l.id, o, l.leaseToken, l.fencingToken, l.holderIdentity],
    )
  ).rows[0];
  if (!lease) throw new Error("BENCHMARK_PUBLICATION_STALE_LEASE");
  if (!op.attempt_id) throw new Error("BENCHMARK_PUBLICATION_ATTEMPT_REQUIRED");
  return op;
}
async function catalog(c: TenantSqlClient, v: Parsed, _op: Op, _run: Run) {
  const d = v.dataset;
  await c.query(
    "insert into evaluation.eval_dataset(id,tenant_id,slug,purpose) values($1,$2,$3,$4) on conflict do nothing",
    [d.id, v.tenantId, d.slug, d.purpose],
  );
  const row = (
    await c.query<{ slug: string; purpose: string }>(
      "select slug,purpose from evaluation.eval_dataset where tenant_id=$1 and id=$2 for update",
      [v.tenantId, d.id],
    )
  ).rows[0];
  if (!row || row.slug !== d.slug || row.purpose !== d.purpose) throw new Error("BENCHMARK_PUBLICATION_DATASET_DRIFT");
  await c.query(
    "insert into evaluation.eval_dataset_version(id,tenant_id,dataset_id,version,manifest_sha256,manifest,contract_version,manifest_artifact_id,frozen_at,label_provenance,case_count) values($1,$2,$3,$4,$5,$6::jsonb,'verification.v1',$7,$8,'agent_generated',$9) on conflict do nothing",
    [
      d.version.id,
      v.tenantId,
      d.id,
      d.version.number,
      hex(d.version.manifestArtifact.digest),
      JSON.stringify(d.version.manifest),
      d.version.manifestArtifact.artifactId,
      d.version.frozenAt,
      d.version.caseCount,
    ],
  );
  const ver = (
    await c.query<{
      dataset_id: string;
      version: number;
      contract_version: string;
      manifest_sha256: string;
      manifest: unknown;
      manifest_artifact_id: string;
      frozen_at: Date | string;
      label_provenance: string;
      case_count: number;
    }>("select * from evaluation.eval_dataset_version where tenant_id=$1 and id=$2 for update", [
      v.tenantId,
      d.version.id,
    ])
  ).rows[0];
  if (
    !ver ||
    Number(ver.version) !== d.version.number ||
    ver.contract_version !== "verification.v1" ||
    ver.dataset_id !== d.id ||
    ver.manifest_sha256 !== hex(d.version.manifestArtifact.digest) ||
    ver.manifest_artifact_id !== d.version.manifestArtifact.artifactId ||
    digestCanonicalJson(ver.manifest) !== digestCanonicalJson(d.version.manifest) ||
    iso(ver.frozen_at) !== d.version.frozenAt ||
    ver.label_provenance !== "agent_generated" ||
    Number(ver.case_count) !== d.version.caseCount
  )
    throw new Error("BENCHMARK_PUBLICATION_DATASET_VERSION_DRIFT");
  await c.query(
    "insert into evaluation.experiment(id,tenant_id,name,hypothesis,dataset_version_id) values($1,$2,$3,$4,$5) on conflict do nothing",
    [v.experiment.id, v.tenantId, v.experiment.name, v.experiment.hypothesis, d.version.id],
  );
  const ex = (
    await c.query<{ name: string; hypothesis: string; dataset_version_id: string }>(
      "select * from evaluation.experiment where tenant_id=$1 and id=$2 for update",
      [v.tenantId, v.experiment.id],
    )
  ).rows[0];
  if (
    !ex ||
    ex.name !== v.experiment.name ||
    ex.hypothesis !== v.experiment.hypothesis ||
    ex.dataset_version_id !== d.version.id
  )
    throw new Error("BENCHMARK_PUBLICATION_EXPERIMENT_DRIFT");
}
async function armRun(c: TenantSqlClient, v: Parsed, op: Op, _run: Run, a: BenchmarkPublicationArmDefinition) {
  await c.query(
    "insert into evaluation.experiment_arm(id,tenant_id,experiment_id,name,configuration,is_control,verification_contract_version,configuration_artifact_id,configuration_sha256) values($1,$2,$3,$4,$5::jsonb,$6,'verification.v1',$7,$8) on conflict do nothing",
    [
      a.experimentArmId,
      v.tenantId,
      v.experiment.id,
      a.name,
      JSON.stringify(a.configuration),
      a.isControl,
      a.configurationArtifact.artifactId,
      hex(a.configurationArtifact.digest),
    ],
  );
  const ar = (
    await c.query<{
      experiment_id: string;
      name: string;
      configuration: unknown;
      is_control: boolean;
      verification_contract_version: string;
      configuration_artifact_id: string;
      configuration_sha256: string;
    }>("select * from evaluation.experiment_arm where tenant_id=$1 and id=$2 for update", [
      v.tenantId,
      a.experimentArmId,
    ])
  ).rows[0];
  if (
    !ar ||
    ar.experiment_id !== v.experiment.id ||
    ar.name !== a.name ||
    digestCanonicalJson(ar.configuration) !== digestCanonicalJson(a.configuration) ||
    Boolean(ar.is_control) !== a.isControl ||
    ar.verification_contract_version !== "verification.v1" ||
    ar.configuration_artifact_id !== a.configurationArtifact.artifactId ||
    ar.configuration_sha256 !== hex(a.configurationArtifact.digest)
  )
    throw new Error("BENCHMARK_PUBLICATION_ARM_DRIFT");
  await c.query(
    "insert into evaluation.eval_run(id,tenant_id,dataset_id,target_code_ref,config,executed_at,verification_contract_version,dataset_version_id,experiment_arm_id,mission_id,work_item_id,attempt_id,run_manifest_artifact_id,policy_artifact_id,status,started_at,ended_at) select $1,$2,$3,$4,$5::jsonb,benchmark.completed_at,'verification.v1',$6,$7,$8,$9,$10,$11,$12,$13,benchmark.started_at,benchmark.completed_at from evaluation.verification_benchmark_run benchmark where benchmark.tenant_id=$2 and benchmark.id=$14 on conflict do nothing",
    [
      a.evalRunId,
      v.tenantId,
      v.dataset.id,
      a.targetCodeRef,
      JSON.stringify({ benchmarkRunId: v.benchmarkRunId, benchmarkArmId: a.benchmarkArmId }),
      v.dataset.version.id,
      a.experimentArmId,
      op.mission_id,
      op.work_item_id,
      op.attempt_id,
      v.publicationManifest.artifactId,
      a.policyArtifact.artifactId,
      a.terminalStatus,
      v.benchmarkRunId,
    ],
  );
  const er = (
    await c.query<{
      tenant_id: string;
      dataset_id: string;
      target_code_ref: string;
      config: unknown;
      executed_at: Date | string;
      verification_contract_version: string;
      dataset_version_id: string;
      experiment_arm_id: string;
      mission_id: string | null;
      work_item_id: string | null;
      attempt_id: string | null;
      run_manifest_artifact_id: string;
      policy_artifact_id: string;
      status: string;
      started_at: Date | string;
      ended_at: Date | string;
      benchmark_times_exact: boolean;
    }>(
      "select r.*, r.started_at=b.started_at and r.ended_at=b.completed_at and r.executed_at=b.completed_at as benchmark_times_exact from evaluation.eval_run r join evaluation.verification_benchmark_run b on b.tenant_id=r.tenant_id where r.tenant_id=$1 and r.id=$2 and b.id=$3 for update",
      [v.tenantId, a.evalRunId, v.benchmarkRunId],
    )
  ).rows[0];
  if (
    !er ||
    er.tenant_id !== v.tenantId ||
    er.dataset_id !== v.dataset.id ||
    er.target_code_ref !== a.targetCodeRef ||
    digestCanonicalJson(er.config) !==
      digestCanonicalJson({ benchmarkRunId: v.benchmarkRunId, benchmarkArmId: a.benchmarkArmId }) ||
    er.verification_contract_version !== "verification.v1" ||
    er.dataset_version_id !== v.dataset.version.id ||
    er.experiment_arm_id !== a.experimentArmId ||
    er.mission_id !== op.mission_id ||
    er.work_item_id !== op.work_item_id ||
    er.attempt_id !== op.attempt_id ||
    er.run_manifest_artifact_id !== v.publicationManifest.artifactId ||
    er.policy_artifact_id !== a.policyArtifact.artifactId ||
    er.status !== a.terminalStatus ||
    er.benchmark_times_exact !== true
  )
    throw new Error("BENCHMARK_PUBLICATION_EVAL_RUN_DRIFT");
}
async function mapping(c: TenantSqlClient, v: Parsed, a: BenchmarkPublicationArmDefinition) {
  await c.query(
    "insert into evaluation.verification_benchmark_arm_publication(tenant_id,benchmark_run_id,operation_id,benchmark_arm_id,experiment_arm_id,eval_run_id,publication_manifest_artifact_id,publication_manifest_sha256,configuration_artifact_id,configuration_sha256,policy_artifact_id,policy_sha256,target_code_ref,terminal_status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict do nothing",
    [
      v.tenantId,
      v.benchmarkRunId,
      v.operationId,
      a.benchmarkArmId,
      a.experimentArmId,
      a.evalRunId,
      v.publicationManifest.artifactId,
      hex(v.publicationManifest.digest),
      a.configurationArtifact.artifactId,
      hex(a.configurationArtifact.digest),
      a.policyArtifact.artifactId,
      hex(a.policyArtifact.digest),
      a.targetCodeRef,
      a.terminalStatus,
    ],
  );
  const p = (
    await c.query<{
      operation_id: string;
      experiment_arm_id: string;
      eval_run_id: string;
      publication_manifest_artifact_id: string;
      publication_manifest_sha256: string;
      configuration_artifact_id: string;
      configuration_sha256: string;
      policy_artifact_id: string;
      policy_sha256: string;
      target_code_ref: string;
      terminal_status: string;
    }>(
      "select * from evaluation.verification_benchmark_arm_publication where tenant_id=$1 and benchmark_run_id=$2 and benchmark_arm_id=$3 for update",
      [v.tenantId, v.benchmarkRunId, a.benchmarkArmId],
    )
  ).rows[0];
  if (
    !p ||
    p.operation_id !== v.operationId ||
    p.experiment_arm_id !== a.experimentArmId ||
    p.eval_run_id !== a.evalRunId ||
    p.publication_manifest_artifact_id !== v.publicationManifest.artifactId ||
    p.publication_manifest_sha256 !== hex(v.publicationManifest.digest) ||
    p.configuration_artifact_id !== a.configurationArtifact.artifactId ||
    p.configuration_sha256 !== hex(a.configurationArtifact.digest) ||
    p.policy_artifact_id !== a.policyArtifact.artifactId ||
    p.policy_sha256 !== hex(a.policyArtifact.digest) ||
    p.target_code_ref !== a.targetCodeRef ||
    p.terminal_status !== a.terminalStatus
  )
    throw new Error("BENCHMARK_PUBLICATION_IDENTITY_DRIFT");
}
function record(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("BENCHMARK_PUBLICATION_INPUT_INVALID");
  return x as Record<string, unknown>;
}
function uuid(x: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x))
    throw new Error("BENCHMARK_PUBLICATION_UUID_INVALID");
}
function hex(x: string) {
  return x.slice(7);
}
function same(a: string, b: string) {
  return a === b;
}
function iso(x: Date | string) {
  return x instanceof Date ? x.toISOString() : new Date(x).toISOString();
}
function assertPlanArms(plan: unknown, arms: readonly BenchmarkPublicationArmDefinition[]) {
  if (!Array.isArray(plan)) throw new Error("BENCHMARK_PUBLICATION_PLAN_INVALID");
  const expected = new Set(plan.map((item) => record(item).armId).filter((id): id is string => typeof id === "string"));
  const actual = new Set(arms.map((a) => a.benchmarkArmId));
  if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id)))
    throw new Error("BENCHMARK_PUBLICATION_ARM_PLAN_MISMATCH");
}
