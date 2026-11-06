import {
  VerificationArtifactHandleSchema,
  VerificationBenchmarkOperationResultSchema,
  VerificationBenchmarkPublicationManifestSchema,
  type VerificationArtifactHandle,
  type VerificationBenchmarkPublicationManifest,
} from "@aiengineer/knowledge-contracts";
import { createHash } from "node:crypto";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import { verifyVerificationBenchmarkPublication } from "@aiengineer/knowledge-verification";
import type { AuditBundleSignatureVerifier } from "@aiengineer/knowledge-verification";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
import type { PostgresVerificationRepository } from "./verification.js";

const uuid = (value: string, field: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error(`VERIFICATION_BENCHMARK_READ_INVALID_${field}`);
  return value;
};
const digest = (value: string, field: string) => {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`VERIFICATION_BENCHMARK_READ_INVALID_${field}`);
  return value;
};
const hex = (value: string, field: string) => digest(value, field).slice(7);
const equalHandle = (left: VerificationArtifactHandle, right: VerificationArtifactHandle) =>
  digestCanonicalJson(left) === digestCanonicalJson(right);

export interface VerifiedBenchmarkPublicationReadSnapshot {
  readonly publicationArtifact: VerificationArtifactHandle;
  readonly manifest: VerificationBenchmarkPublicationManifest;
  readonly signatureStatus: "verified";
}

type Binding = {
  readonly run_id: string;
  readonly operation_id: string;
  readonly dataset_artifact_id: string;
  readonly dataset_sha256: string;
  readonly experiment_artifact_id: string;
  readonly experiment_sha256: string;
  readonly runner_version: string;
  readonly network_policy: string;
  readonly random_seed: number;
  readonly repetitions: number;
  readonly checkpoint_plan: unknown;
  readonly checkpoint_plan_sha256: string;
  readonly run_manifest_artifact_id: string;
  readonly run_manifest_sha256: string;
  readonly operation_attempt_id: string;
  readonly mission_id: string | null;
  readonly work_item_id: string | null;
};
type Mapping = {
  readonly benchmark_arm_id: string;
  readonly experiment_arm_id: string;
  readonly eval_run_id: string;
  readonly publication_manifest_artifact_id: string;
  readonly publication_manifest_sha256: string;
  readonly configuration_artifact_id: string;
  readonly configuration_sha256: string;
  readonly policy_artifact_id: string;
  readonly policy_sha256: string;
  readonly target_code_ref: string;
  readonly terminal_status: string;
  readonly eval_status: string;
  readonly eval_attempt_id: string | null;
  readonly eval_times_exact: boolean;
  readonly benchmark_lifecycle_ms_exact: boolean;
  readonly eval_dataset_id: string;
  readonly eval_dataset_version_id: string;
  readonly eval_experiment_arm_id: string;
  readonly eval_run_manifest_artifact_id: string;
  readonly eval_policy_artifact_id: string;
  readonly arm_experiment_id: string;
  readonly arm_is_control: boolean;
  readonly arm_configuration_artifact_id: string;
  readonly arm_configuration_sha256: string;
  readonly eval_context_exact: boolean;
  readonly dataset_version_number: number;
  readonly dataset_version_manifest_artifact_id: string;
  readonly dataset_version_manifest_sha256: string;
  readonly dataset_version_contract_version: string;
  readonly dataset_version_case_count: number;
  readonly experiment_dataset_version_id: string;
  readonly dataset_version_dataset_id: string;
  readonly dataset_version_label_provenance: string;
};
type Receipt = {
  readonly receipt_kind: string;
  readonly outcome: string;
  readonly body: unknown;
  readonly step_id: string;
  readonly step_status: string;
  readonly step_key: string;
};

/**
 * Tenant-scoped repository read.  It exposes no row/body data: an absent,
 * cancelled, or merely sealed-but-uncompleted operation is deliberately hidden.
 */
export class PostgresVerificationBenchmarkReadRepository {
  constructor(
    private readonly database: PostgresCanonicalRepository,
    private readonly verification: PostgresVerificationRepository,
    private readonly options: { readonly verifier: AuditBundleSignatureVerifier },
  ) {}

  async loadVerifiedBenchmarkPublication(
    tenantValue: string,
    runValue: string,
  ): Promise<VerifiedBenchmarkPublicationReadSnapshot> {
    const tenantId = uuid(tenantValue, "TENANT"),
      runId = uuid(runValue, "RUN");
    const binding = await this.#binding(tenantId, runId);
    const receipts = await this.#receipts(tenantId, binding.operation_id);
    // A sealed row is not publicly readable merely because its operation later
    // reached succeeded: first require the terminal step receipt before touching
    // any retained artifact bytes.
    if (receipts.length === 0) throw new Error("VERIFICATION_BENCHMARK_READ_RECEIPT_BINDING");
    const publication = await this.#publicationArtifact(tenantId, runId);
    const resolver = this.verification.createTrustedArtifactResolver();
    await resolver.authorizeArtifact({ tenantId, artifactId: publication.artifactId, purpose: "verification_replay" });
    const hydrated = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId: publication.artifactId });
    const publicationArtifact = VerificationArtifactHandleSchema.parse(hydrated.registration);
    if (
      publicationArtifact.tenantId !== tenantId ||
      publicationArtifact.artifactId !== publication.artifactId ||
      publicationArtifact.digest !== `sha256:${publication.sha256}` ||
      hydrated.bytes.byteLength !== publicationArtifact.byteLength ||
      `sha256:${createHash("sha256").update(hydrated.bytes).digest("hex")}` !== publicationArtifact.digest
    )
      throw new Error("VERIFICATION_BENCHMARK_READ_ARTIFACT_BINDING");
    let verified: Awaited<ReturnType<typeof verifyVerificationBenchmarkPublication>>;
    try {
      verified = await verifyVerificationBenchmarkPublication(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(hydrated.bytes)),
        { verifier: this.options.verifier, requireSignature: true },
      );
    } catch {
      throw new Error("VERIFICATION_BENCHMARK_READ_PUBLICATION_INVALID");
    }
    if (verified.signatureStatus !== "verified") throw new Error("VERIFICATION_BENCHMARK_READ_SIGNATURE_REQUIRED");
    const manifest = VerificationBenchmarkPublicationManifestSchema.parse(verified.manifest);
    this.#manifestBinding(manifest, binding, publicationArtifact);
    const mappings = await this.#mappings(tenantId, runId, manifest);
    this.#mappingsBinding(manifest, binding, publicationArtifact, mappings);
    this.#receiptBinding(manifest, publicationArtifact, receipts);
    return Object.freeze({ publicationArtifact, manifest, signatureStatus: "verified" as const });
  }

  async #binding(tenantId: string, runId: string): Promise<Binding> {
    return this.database.transaction(tenantId, async (client) => {
      const row = (
        await client.query<Binding>(
          `select benchmark.id run_id,benchmark.operation_id,benchmark.dataset_artifact_id,benchmark.dataset_sha256,
        benchmark.experiment_artifact_id,benchmark.experiment_sha256,benchmark.runner_version,benchmark.network_policy,benchmark.random_seed,
        benchmark.repetitions,benchmark.checkpoint_plan,benchmark.checkpoint_plan_sha256,benchmark.run_manifest_artifact_id,
        benchmark.run_manifest_sha256,operation.attempt_id operation_attempt_id,operation.mission_id,operation.work_item_id
        from evaluation.verification_benchmark_run benchmark join knowledge_service.operation operation
          on operation.tenant_id=benchmark.tenant_id and operation.id=benchmark.operation_id
        where benchmark.tenant_id=$1 and benchmark.id=$2 and benchmark.status='sealed'
          and operation.status='succeeded' and operation.operation_kind='verification_benchmark'`,
          [tenantId, runId],
        )
      ).rows[0];
      if (!row || !row.run_manifest_artifact_id || !row.run_manifest_sha256 || !row.operation_attempt_id)
        throw new Error("VERIFICATION_BENCHMARK_RUN_NOT_FOUND");
      return row;
    });
  }

  async #mappings(
    tenantId: string,
    runId: string,
    manifest: VerificationBenchmarkPublicationManifest,
  ): Promise<readonly Mapping[]> {
    return this.database.transaction(tenantId, async (client) => {
      const result = await client.query<Mapping>(
        `select publication.benchmark_arm_id,publication.experiment_arm_id,publication.eval_run_id,
        publication.publication_manifest_artifact_id,publication.publication_manifest_sha256,publication.configuration_artifact_id,
        publication.configuration_sha256,publication.policy_artifact_id,publication.policy_sha256,publication.target_code_ref,
        publication.terminal_status,evaluation.status eval_status,evaluation.attempt_id eval_attempt_id,
        (evaluation.started_at=benchmark.started_at and evaluation.ended_at=benchmark.completed_at and evaluation.executed_at=benchmark.completed_at) eval_times_exact,
        (to_char(benchmark.started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=$3 and to_char(benchmark.completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=$4) benchmark_lifecycle_ms_exact,
        evaluation.dataset_id eval_dataset_id,evaluation.dataset_version_id eval_dataset_version_id,evaluation.experiment_arm_id eval_experiment_arm_id,
        evaluation.run_manifest_artifact_id eval_run_manifest_artifact_id,evaluation.policy_artifact_id eval_policy_artifact_id,
        arm.experiment_id arm_experiment_id,arm.is_control arm_is_control,arm.configuration_artifact_id arm_configuration_artifact_id,
        arm.configuration_sha256 arm_configuration_sha256,
        version.version dataset_version_number,version.manifest_artifact_id dataset_version_manifest_artifact_id,version.manifest_sha256 dataset_version_manifest_sha256,
        version.contract_version dataset_version_contract_version,version.case_count dataset_version_case_count,experiment.dataset_version_id experiment_dataset_version_id,
        version.dataset_id dataset_version_dataset_id,version.label_provenance dataset_version_label_provenance,
        (evaluation.mission_id is not distinct from operation.mission_id and evaluation.work_item_id is not distinct from operation.work_item_id) eval_context_exact
        from evaluation.verification_benchmark_arm_publication publication join evaluation.eval_run evaluation
          on evaluation.tenant_id=publication.tenant_id and evaluation.id=publication.eval_run_id
        join evaluation.experiment_arm arm on arm.tenant_id=evaluation.tenant_id and arm.id=evaluation.experiment_arm_id
        join evaluation.experiment experiment on experiment.tenant_id=arm.tenant_id and experiment.id=arm.experiment_id
        join evaluation.eval_dataset_version version on version.tenant_id=experiment.tenant_id and version.id=experiment.dataset_version_id
        join evaluation.verification_benchmark_run benchmark on benchmark.tenant_id=publication.tenant_id and benchmark.id=publication.benchmark_run_id
        join knowledge_service.operation operation on operation.tenant_id=benchmark.tenant_id and operation.id=benchmark.operation_id
        where publication.tenant_id=$1 and publication.benchmark_run_id=$2
        order by publication.benchmark_arm_id`,
        [tenantId, runId, manifest.startedAt, manifest.completedAt],
      );
      return result.rows;
    });
  }

  async #publicationArtifact(tenantId: string, runId: string): Promise<{ artifactId: string; sha256: string }> {
    return this.database.transaction(tenantId, async (client) => {
      const rows = (
        await client.query<{ publication_manifest_artifact_id: string; publication_manifest_sha256: string }>(
          "select distinct publication_manifest_artifact_id,publication_manifest_sha256 from evaluation.verification_benchmark_arm_publication where tenant_id=$1 and benchmark_run_id=$2",
          [tenantId, runId],
        )
      ).rows;
      if (rows.length !== 1 || !rows[0]) throw new Error("VERIFICATION_BENCHMARK_READ_PUBLICATION_MAPPING");
      return { artifactId: rows[0].publication_manifest_artifact_id, sha256: rows[0].publication_manifest_sha256 };
    });
  }

  async #receipts(tenantId: string, operationId: string): Promise<readonly Receipt[]> {
    return this.database.transaction(tenantId, async (client) => {
      const result = await client.query<Receipt>(
        `select receipt.receipt_kind,receipt.outcome,receipt.body,receipt.step_id,step.status step_status,step.step_key
      from knowledge_service.receipt receipt join knowledge_service.operation_step step
       on step.tenant_id=receipt.tenant_id and step.id=receipt.step_id and step.operation_id=receipt.operation_id
      where receipt.tenant_id=$1 and receipt.operation_id=$2 and receipt.receipt_kind='replay_recorded_and_register.succeeded'
       and receipt.outcome='succeeded' and step.status='succeeded' and step.step_key='replay_recorded_and_register'`,
        [tenantId, operationId],
      );
      return result.rows;
    });
  }

  #manifestBinding(
    manifest: VerificationBenchmarkPublicationManifest,
    binding: Binding,
    publicationArtifact: VerificationArtifactHandle,
  ): void {
    if (
      manifest.tenantId !== publicationArtifact.tenantId ||
      manifest.runId !== binding.run_id ||
      manifest.operationId !== binding.operation_id ||
      manifest.dataset.artifact.artifactId !== binding.dataset_artifact_id ||
      hex(manifest.dataset.artifact.digest, "DATASET") !== binding.dataset_sha256 ||
      manifest.experiment.artifact.artifactId !== binding.experiment_artifact_id ||
      hex(manifest.experiment.artifact.digest, "EXPERIMENT") !== binding.experiment_sha256 ||
      manifest.experiment.runnerVersion !== binding.runner_version ||
      binding.network_policy !== "offline" ||
      manifest.execution.mode !== "offline_recorded" ||
      manifest.experiment.randomSeed !== binding.random_seed ||
      manifest.experiment.repetitions !== binding.repetitions ||
      manifest.checkpointPlanDigest !== `sha256:${binding.checkpoint_plan_sha256}` ||
      manifest.runtime.attemptId !== binding.operation_attempt_id ||
      manifest.runnerPayload.artifactId !== binding.run_manifest_artifact_id ||
      hex(manifest.runnerPayload.digest, "RUNNER_MANIFEST") !== binding.run_manifest_sha256 ||
      !manifest.seal.signature ||
      publicationArtifact.tenantId !== manifest.tenantId ||
      digestCanonicalJson(binding.checkpoint_plan) !== `sha256:${binding.checkpoint_plan_sha256}`
    )
      throw new Error("VERIFICATION_BENCHMARK_READ_MANIFEST_BINDING");
  }

  #mappingsBinding(
    manifest: VerificationBenchmarkPublicationManifest,
    binding: Binding,
    publicationArtifact: VerificationArtifactHandle,
    rows: readonly Mapping[],
  ): void {
    const planArmIds = Array.isArray(binding.checkpoint_plan)
      ? new Set(
          binding.checkpoint_plan.map((item) =>
            item && typeof item === "object" ? (item as Record<string, unknown>).armId : undefined,
          ),
        )
      : undefined;
    if (
      !planArmIds ||
      planArmIds.size !== manifest.arms.length ||
      [...planArmIds].some((id) => typeof id !== "string") ||
      rows.length !== manifest.arms.length
    )
      throw new Error("VERIFICATION_BENCHMARK_READ_ARM_PLAN_BINDING");
    const byArm = new Map(rows.map((row) => [row.benchmark_arm_id, row]));
    if (byArm.size !== rows.length) throw new Error("VERIFICATION_BENCHMARK_READ_DUPLICATE_ARM");
    for (const arm of manifest.arms) {
      const row = byArm.get(arm.armId);
      if (
        !row ||
        !planArmIds.has(arm.armId) ||
        row.experiment_arm_id !== arm.experimentArmId ||
        row.eval_run_id !== arm.evalRunId ||
        row.publication_manifest_artifact_id !== publicationArtifact.artifactId ||
        row.publication_manifest_sha256 !== hex(publicationArtifact.digest, "PUBLICATION") ||
        row.configuration_artifact_id !== arm.configurationArtifact.artifactId ||
        row.configuration_sha256 !== hex(arm.configurationArtifact.digest, "CONFIGURATION") ||
        row.policy_artifact_id !== arm.policyArtifact.artifactId ||
        row.policy_sha256 !== hex(arm.policyArtifact.digest, "POLICY") ||
        row.target_code_ref !== manifest.runtime.targetCodeRef ||
        row.terminal_status !== arm.terminalStatus ||
        row.eval_status !== arm.terminalStatus ||
        row.eval_attempt_id !== manifest.runtime.attemptId ||
        row.eval_times_exact !== true ||
        row.benchmark_lifecycle_ms_exact !== true ||
        row.eval_dataset_id !== manifest.dataset.datasetId ||
        row.eval_dataset_version_id !== manifest.dataset.datasetVersionId ||
        row.eval_experiment_arm_id !== arm.experimentArmId ||
        row.eval_run_manifest_artifact_id !== publicationArtifact.artifactId ||
        row.eval_policy_artifact_id !== arm.policyArtifact.artifactId ||
        row.arm_experiment_id !== manifest.experiment.experimentId ||
        row.arm_is_control !== arm.isControl ||
        row.arm_configuration_artifact_id !== arm.configurationArtifact.artifactId ||
        row.arm_configuration_sha256 !== hex(arm.configurationArtifact.digest, "CONFIGURATION") ||
        row.eval_context_exact !== true ||
        row.dataset_version_number !== manifest.dataset.version ||
        row.dataset_version_manifest_artifact_id !== manifest.dataset.artifact.artifactId ||
        row.dataset_version_manifest_sha256 !== hex(manifest.dataset.artifact.digest, "DATASET") ||
        row.dataset_version_contract_version !== "verification.v1" ||
        row.dataset_version_case_count !== manifest.dataset.caseCount ||
        row.experiment_dataset_version_id !== manifest.dataset.datasetVersionId ||
        row.dataset_version_dataset_id !== manifest.dataset.datasetId ||
        row.dataset_version_label_provenance !== "agent_generated"
      )
        throw new Error("VERIFICATION_BENCHMARK_READ_ARM_BINDING");
    }
  }

  #receiptBinding(
    manifest: VerificationBenchmarkPublicationManifest,
    publicationArtifact: VerificationArtifactHandle,
    rows: readonly Receipt[],
  ): void {
    const expectedEvalIds = new Set(manifest.arms.map((arm) => arm.evalRunId));
    const matches = rows.filter((row) => {
      try {
        const body = row.body as Record<string, unknown>;
        const output = VerificationBenchmarkOperationResultSchema.parse(body.output);
        const resultArtifact = VerificationArtifactHandleSchema.parse(body.resultArtifact);
        return (
          row.receipt_kind === "replay_recorded_and_register.succeeded" &&
          row.outcome === "succeeded" &&
          row.step_status === "succeeded" &&
          row.step_key === "replay_recorded_and_register" &&
          typeof row.step_id === "string" &&
          body.schemaVersion === "verification-operation-result.v1" &&
          body.operationId === manifest.operationId &&
          body.useCase === "runBenchmark" &&
          output.benchmarkRunId === manifest.runId &&
          output.manifestDigest === manifest.seal.payloadDigest &&
          output.evalRunIds.length === expectedEvalIds.size &&
          output.evalRunIds.every((id) => expectedEvalIds.has(id)) &&
          equalHandle(resultArtifact, publicationArtifact)
        );
      } catch {
        return false;
      }
    });
    if (rows.length !== 1 || matches.length !== 1) throw new Error("VERIFICATION_BENCHMARK_READ_RECEIPT_BINDING");
  }
}
