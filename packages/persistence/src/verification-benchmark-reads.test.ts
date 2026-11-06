import { generateKeyPairSync } from "node:crypto";
import { TextEncoder } from "node:util";
import { describe, expect, it } from "vitest";
import type {
  VerificationArtifactHandle,
  VerificationBenchmarkPublicationManifest,
} from "@aiengineer/knowledge-contracts";
import {
  createEd25519Signer,
  createEd25519Verifier,
  digestCanonicalJson,
  sealVerificationBenchmarkPublication,
} from "@aiengineer/knowledge-verification";
import { sha256Digest } from "@aiengineer/knowledge-verification";
import { PostgresVerificationBenchmarkReadRepository } from "./verification-benchmark-reads.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1),
  runId = id(2),
  operationId = id(3),
  attemptId = id(4),
  createdAt = "2026-09-05T00:00:00.000Z",
  digest = (n: string) => `sha256:${n.repeat(64)}` as `sha256:${string}`;
const handle = (n: number, d = digest(`${n % 10}`)): VerificationArtifactHandle => ({
  artifactId: id(n),
  tenantId,
  digest: d,
  mediaType: "application/json",
  byteLength: 42,
  objectKey: `private/${id(n)}`,
  createdAt,
  producerActivityId: "fixture",
  producerVersion: "1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
});
async function fixture() {
  const pair = generateKeyPairSync("ed25519"),
    signer = createEd25519Signer(pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), "key"),
    verifier = createEd25519Verifier({ key: pair.publicKey.export({ format: "pem", type: "spki" }).toString() }),
    runnerPayload = handle(15),
    checkpointPlan = [{ armId: "control" }, { armId: "candidate" }];
  const manifest = await sealVerificationBenchmarkPublication(
      {
        schemaVersion: "verification-benchmark-publication.v1",
        verificationContractVersion: "verification.v1",
        tenantId,
        runId,
        operationId,
        dataset: {
          artifact: handle(10),
          datasetId: id(11),
          datasetVersionId: id(12),
          version: 1,
          caseCount: 2,
          manifestDigest: digest("a"),
          labelProvenance: "engineering_expectations",
        },
        experiment: {
          artifact: handle(13),
          experimentId: id(14),
          runnerVersion: "verification-benchmark-runner.v1",
          randomSeed: 7,
          repetitions: 1,
        },
        runnerPayload,
        runnerManifestDigest: digest("b"),
        checkpointPlanDigest: digestCanonicalJson(checkpointPlan),
        summaryArtifact: handle(16),
        provenanceArtifact: handle(17),
        arms: [
          {
            armId: "control",
            experimentArmId: id(18),
            evalRunId: id(19),
            configurationArtifact: handle(20),
            policyArtifact: handle(21),
            isControl: true,
            terminalStatus: "review",
            dispositionBasis: "source_authority_unassessed",
            summaryDigest: digest("d"),
          },
          {
            armId: "candidate",
            experimentArmId: id(22),
            evalRunId: id(23),
            configurationArtifact: handle(24),
            policyArtifact: handle(25),
            isControl: false,
            terminalStatus: "review",
            dispositionBasis: "source_authority_unassessed",
            summaryDigest: digest("e"),
          },
        ],
        runtime: {
          deploymentId: "fixture",
          attemptId,
          capabilityVersion: "verification-service.v1",
          targetCodeRef: "uncommitted:fixture",
          gitSha: "uncommitted",
          dirty: true,
        },
        execution: { mode: "offline_recorded", externalProviderRequests: 0 },
        qualityClaims: { humanGoldValidated: false, sourceAuthorityAssessed: false, calibrated: false },
        startedAt: createdAt,
        completedAt: createdAt,
      },
      signer,
    ),
    bytes = new TextEncoder().encode(JSON.stringify(manifest)),
    publicationArtifact = { ...handle(30, sha256Digest(bytes)), byteLength: bytes.byteLength };
  return { manifest, publicationArtifact, runnerPayload, verifier, bytes, checkpointPlan };
}
function subject(
  input: Awaited<ReturnType<typeof fixture>>,
  options: {
    receipt?: unknown;
    mapping?: Partial<Record<string, unknown>>;
    binding?: Partial<Record<string, unknown>>;
    bytes?: Uint8Array;
    registration?: VerificationArtifactHandle;
    verifier?: Awaited<ReturnType<typeof fixture>>["verifier"];
  } = {},
) {
  const rows = (sql: string) => {
    if (sql.includes("from evaluation.verification_benchmark_run benchmark join"))
      return [
        {
          run_id: runId,
          operation_id: operationId,
          dataset_artifact_id: id(10),
          dataset_sha256: digest("0").slice(7),
          experiment_artifact_id: id(13),
          experiment_sha256: digest("3").slice(7),
          runner_version: "verification-benchmark-runner.v1",
          network_policy: "offline",
          random_seed: 7,
          repetitions: 1,
          checkpoint_plan: input.checkpointPlan,
          checkpoint_plan_sha256: input.manifest.checkpointPlanDigest.slice(7),
          run_manifest_artifact_id: id(15),
          run_manifest_sha256: digest("5").slice(7),
          operation_attempt_id: attemptId,
          mission_id: id(40),
          work_item_id: id(41),
          ...options.binding,
        },
      ];
    if (sql.includes("select distinct publication_manifest"))
      return [
        {
          publication_manifest_artifact_id: id(30),
          publication_manifest_sha256: input.publicationArtifact.digest.slice(7),
        },
      ];
    if (sql.includes("from evaluation.verification_benchmark_arm_publication publication"))
      return input.manifest.arms.map((arm) => ({
        benchmark_arm_id: arm.armId,
        experiment_arm_id: arm.experimentArmId,
        eval_run_id: arm.evalRunId,
        publication_manifest_artifact_id: id(30),
        publication_manifest_sha256: input.publicationArtifact.digest.slice(7),
        configuration_artifact_id: arm.configurationArtifact.artifactId,
        configuration_sha256: arm.configurationArtifact.digest.slice(7),
        policy_artifact_id: arm.policyArtifact.artifactId,
        policy_sha256: arm.policyArtifact.digest.slice(7),
        target_code_ref: "uncommitted:fixture",
        terminal_status: arm.terminalStatus,
        eval_status: arm.terminalStatus,
        eval_attempt_id: attemptId,
        eval_times_exact: true,
        benchmark_lifecycle_ms_exact: true,
        eval_dataset_id: id(11),
        eval_dataset_version_id: id(12),
        eval_experiment_arm_id: arm.experimentArmId,
        eval_run_manifest_artifact_id: id(30),
        eval_policy_artifact_id: arm.policyArtifact.artifactId,
        arm_experiment_id: id(14),
        arm_is_control: arm.isControl,
        arm_configuration_artifact_id: arm.configurationArtifact.artifactId,
        arm_configuration_sha256: arm.configurationArtifact.digest.slice(7),
        eval_context_exact: true,
        dataset_version_number: 1,
        dataset_version_manifest_artifact_id: id(10),
        dataset_version_manifest_sha256: digest("0").slice(7),
        dataset_version_contract_version: "verification.v1",
        dataset_version_case_count: 2,
        experiment_dataset_version_id: id(12),
        dataset_version_dataset_id: id(11),
        dataset_version_label_provenance: "agent_generated",
        ...options.mapping,
      }));
    if (sql.includes("from knowledge_service.receipt"))
      return [
        {
          receipt_kind: "replay_recorded_and_register.succeeded",
          outcome: "succeeded",
          step_id: id(42),
          step_status: "succeeded",
          step_key: "replay_recorded_and_register",
          body: options.receipt ?? {
            schemaVersion: "verification-operation-result.v1",
            operationId,
            useCase: "runBenchmark",
            output: {
              benchmarkRunId: runId,
              evalRunIds: input.manifest.arms.map((arm) => arm.evalRunId),
              manifestDigest: input.manifest.seal.payloadDigest,
              qualityClaims: input.manifest.qualityClaims,
            },
            resultArtifact: input.publicationArtifact,
          },
        },
      ];
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  };
  const database = {
    transaction: async (_tenant: string, work: any) =>
      work({ query: async (sql: string) => ({ rows: rows(sql), rowCount: 1 }) }),
  };
  const verification = {
    createTrustedArtifactResolver: () => {
      let authorized = false;
      return {
        authorizeArtifact: async (input: { artifactId: string }) => {
          expect(input.artifactId).toBe(id(30));
          authorized = true;
        },
        hydrateRegisteredArtifact: async () => {
          if (!authorized) throw new Error("NO_TICKET");
          return {
            registration: options.registration ?? input.publicationArtifact,
            bytes: options.bytes ?? input.bytes,
          };
        },
      };
    },
  };
  return new PostgresVerificationBenchmarkReadRepository(database as never, verification as never, {
    verifier: options.verifier ?? input.verifier,
  });
}

describe("postgres benchmark publication reads (unit-only)", () => {
  it("checks actual retained bytes independently of signed content and tenant registration", async () => {
    const value = await fixture(),
      bytes = Uint8Array.from(value.bytes);
    bytes[10] = bytes[10]! ^ 1;
    await expect(subject(value, { bytes }).loadVerifiedBenchmarkPublication(tenantId, runId)).rejects.toThrow(
      "VERIFICATION_BENCHMARK_READ_ARTIFACT_BINDING",
    );
    await expect(
      subject(value, {
        registration: { ...value.publicationArtifact, tenantId: id(99) },
      }).loadVerifiedBenchmarkPublication(tenantId, runId),
    ).rejects.toThrow("VERIFICATION_BENCHMARK_READ_ARTIFACT_BINDING");
    await expect(
      subject(value, { verifier: (await fixture()).verifier }).loadVerifiedBenchmarkPublication(tenantId, runId),
    ).rejects.toThrow("VERIFICATION_BENCHMARK_READ_PUBLICATION_INVALID");
  });
  it("does not reinterpret agent-generated engineering labels as human gold", async () => {
    const value = await fixture();
    await expect(
      subject(value, { mapping: { dataset_version_label_provenance: "human_gold" } }).loadVerifiedBenchmarkPublication(
        tenantId,
        runId,
      ),
    ).rejects.toThrow("VERIFICATION_BENCHMARK_READ_ARM_BINDING");
    await expect(
      subject(value, { mapping: { dataset_version_dataset_id: id(99) } }).loadVerifiedBenchmarkPublication(
        tenantId,
        runId,
      ),
    ).rejects.toThrow("VERIFICATION_BENCHMARK_READ_ARM_BINDING");
  });
  it("requires the exact succeeded receipt, mapped arms, canonical timing, and signed publication", async () => {
    const value = await fixture(),
      read = subject(value),
      loaded = await read.loadVerifiedBenchmarkPublication(tenantId, runId);
    expect(loaded).toMatchObject({ signatureStatus: "verified", manifest: { runId, operationId } });
  });
  it("attributes receipt, arm, and manifest drift as integrity failures rather than absence", async () => {
    const value = await fixture();
    await expect(
      subject(value, {
        receipt: {
          schemaVersion: "verification-operation-result.v1",
          operationId,
          useCase: "runBenchmark",
          output: {
            benchmarkRunId: runId,
            evalRunIds: [],
            manifestDigest: value.manifest.seal.payloadDigest,
            qualityClaims: value.manifest.qualityClaims,
          },
          resultArtifact: value.publicationArtifact,
        },
      }).loadVerifiedBenchmarkPublication(tenantId, runId),
    ).rejects.toThrow("VERIFICATION_BENCHMARK_READ_RECEIPT_BINDING");
    await expect(
      subject(value, { mapping: { eval_times_exact: false } }).loadVerifiedBenchmarkPublication(tenantId, runId),
    ).rejects.toThrow("VERIFICATION_BENCHMARK_READ_ARM_BINDING");
    await expect(
      subject(value, { binding: { operation_attempt_id: id(99) } }).loadVerifiedBenchmarkPublication(tenantId, runId),
    ).rejects.toThrow("VERIFICATION_BENCHMARK_READ_MANIFEST_BINDING");
  });
  it("validates request UUIDs before opening a tenant transaction", async () => {
    const value = await fixture();
    await expect(subject(value).loadVerifiedBenchmarkPublication("not-a-uuid", runId)).rejects.toThrow(
      "INVALID_TENANT",
    );
  });
});
