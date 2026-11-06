import {
  UuidSchema,
  VerificationArtifactHandleSchema,
  VerificationBenchmarkPublicationManifestSchema,
  type VerificationArtifactHandle,
  type VerificationBenchmarkPublicationManifest,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  createVerificationBenchmarkCheckpointPlan,
  summarizeVerificationBenchmark,
  verificationBenchmarkDigest,
  type VerificationBenchmarkRun,
} from "@aiengineer/knowledge-evaluation";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import {
  canonicalizeJson,
  digestCanonicalJson,
  sealVerificationBenchmarkPublication,
  sha256Digest,
  type AuditBundleSigner,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import {
  assertRegisteredOfflineBenchmarkPreparation,
  type RegisteredOfflineBenchmarkPreparation,
} from "./verification-benchmark-offline-executor.js";
import type { VerificationSealPolicyCatalog } from "../admission/verification-seal-policy.js";

export interface BenchmarkPublicationArtifactPort {
  register(input: {
    readonly tenantId: string;
    readonly producerAttemptId: string;
    readonly artifactType: string;
    readonly bytes: Uint8Array;
    readonly createdAt: string;
    readonly parentArtifactIds: readonly string[];
    readonly transformationSignature: `sha256:${string}`;
  }): Promise<VerificationArtifactHandle>;
}

/** Constructs immutable publication artifacts; the caller performs the fenced DB publication. */
export class RegisteredBenchmarkPublicationBuilder {
  constructor(
    private readonly ports: {
      readonly artifacts: BenchmarkPublicationArtifactPort;
      readonly policies: VerificationSealPolicyCatalog;
      readonly resolver: TrustedArtifactResolver;
      readonly signer?: AuditBundleSigner;
    },
  ) {}

  async prepare(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly prepared: RegisteredOfflineBenchmarkPreparation;
    readonly run: VerificationBenchmarkRun;
    readonly runtime: VerificationBenchmarkPublicationManifest["runtime"];
    readonly signal?: AbortSignal;
  }) {
    const tenantId = UuidSchema.parse(input.tenantId),
      operationId = UuidSchema.parse(input.operationId);
    assertRegisteredOfflineBenchmarkPreparation(input.prepared, { tenantId, runId: input.run.runId });
    const { admitted, provenance } = deepFreeze(
      structuredClone({ admitted: input.prepared.admitted, provenance: input.prepared.provenance }),
    );
    const run = deepFreeze(structuredClone(input.run)),
      runtime = deepFreeze(VerificationBenchmarkPublicationManifestSchema.shape.runtime.parse(input.runtime));
    VerificationBenchmarkPublicationManifestSchema.shape.startedAt.parse(run.startedAt);
    VerificationBenchmarkPublicationManifestSchema.shape.completedAt.parse(run.completedAt);
    if (
      Date.parse(run.completedAt) < Date.parse(run.startedAt) ||
      run.results.some(
        (result) =>
          Date.parse(result.completedAt) < Date.parse(run.startedAt) ||
          Date.parse(result.completedAt) > Date.parse(run.completedAt),
      )
    )
      throw new Error("BENCHMARK_PUBLICATION_TIMING_INVALID");
    if (runtime.dirtyStateArtifact && runtime.dirtyStateArtifact.tenantId !== tenantId)
      throw new Error("BENCHMARK_PUBLICATION_RUNTIME_TENANT_MISMATCH");
    const assertActive = () => {
      if (input.signal?.aborted) throw new Error("BENCHMARK_CANCELLED");
    };
    assertActive();
    const summaries = summarizeVerificationBenchmark(admitted.dataset, run);
    if (
      run.experimentDefinitionDigest !== admitted.experimentArtifact.digest ||
      run.networkPolicy !== "offline" ||
      run.randomSeed !== admitted.experiment.randomSeed ||
      verificationBenchmarkDigest(run.arms) !== verificationBenchmarkDigest(admitted.experiment.arms) ||
      run.results.length !==
        admitted.dataset.cases.length * admitted.experiment.arms.length * admitted.experiment.repetitions ||
      !["engineering_expectations", "mixed_pending"].includes(admitted.dataset.labelProvenance) ||
      summaries.some((summary) => summary.qualityClaimEligible || summary.humanGoldDenominator !== 0) ||
      provenance.externalProviderRequests !== 0 ||
      provenance.dataset.artifactId !== admitted.datasetArtifact.artifactId ||
      provenance.dataset.digest !== admitted.datasetArtifact.digest ||
      provenance.experiment.artifactId !== admitted.experimentArtifact.artifactId ||
      provenance.experiment.digest !== admitted.experimentArtifact.digest
    )
      throw new Error("BENCHMARK_PUBLICATION_INPUT_BINDING_INVALID");
    if (
      run.results.some((result) =>
        result.callAttributions.some(
          (call) =>
            call.cacheDisposition === "fresh" ||
            call.reservationCostMicros !== 0 ||
            (call.actualCostMicros !== null && call.actualCostMicros !== 0) ||
            call.latencyMs !== null,
        ),
      )
    )
      throw new Error("BENCHMARK_PUBLICATION_OFFLINE_ACCOUNTING_INVALID");
    const plan = createVerificationBenchmarkCheckpointPlan({
      ...run,
      dataset: admitted.dataset,
      repetitions: admitted.experiment.repetitions,
    });
    const id = (kind: string, value: unknown) =>
      deterministicUuid(`verification-benchmark-publication:${kind}`, canonicalizeJson({ tenantId, value }));
    const datasetId = id("dataset", admitted.dataset.datasetId),
      datasetVersionId = id("dataset-version", admitted.request.dataset),
      experimentId = id("experiment", admitted.request.experimentDefinition);
    const policies = new Map<string, Awaited<ReturnType<VerificationSealPolicyCatalog["resolve"]>>>();
    for (const arm of admitted.experiment.arms) {
      if (!policies.has(arm.policyVersion)) {
        const policy = await this.ports.policies.resolve(
          { tenantId, policyVersion: arm.policyVersion },
          this.ports.resolver,
        );
        assertActive();
        policies.set(arm.policyVersion, policy);
      }
    }
    const retain = async (artifactType: string, value: unknown, parents: readonly string[]) => {
      assertActive();
      const bytes = new TextEncoder().encode(canonicalizeJson(value)),
        parentArtifactIds = [...new Set(parents)];
      const transformationSignature = digestCanonicalJson({
        kind: "verification-benchmark-publication-artifact.v1",
        artifactType,
        digest: sha256Digest(bytes),
        parentArtifactIds,
      });
      const handle = VerificationArtifactHandleSchema.parse(
        await this.ports.artifacts.register({
          tenantId,
          producerAttemptId: runtime.attemptId,
          artifactType,
          bytes,
          createdAt: run.completedAt,
          parentArtifactIds,
          transformationSignature,
        }),
      );
      assertActive();
      if (
        handle.tenantId !== tenantId ||
        handle.digest !== sha256Digest(bytes) ||
        handle.byteLength !== bytes.byteLength ||
        canonicalizeJson(handle.parentArtifactIds) !== canonicalizeJson(parentArtifactIds) ||
        handle.transformationSignature !== transformationSignature
      )
        throw new Error("BENCHMARK_PUBLICATION_REGISTERED_ARTIFACT_MISMATCH");
      return handle;
    };
    const provenanceArtifact = await retain(
      "verification_benchmark_provenance",
      {
        schemaVersion: "verification-benchmark-publication-provenance.v1",
        operationId,
        runId: run.runId,
        runnerManifestDigest: run.manifestDigest,
        provenance,
      },
      [
        admitted.datasetArtifact.artifactId,
        admitted.experimentArtifact.artifactId,
        provenance.sourceImport.artifactId,
        ...provenance.sourceMappings.map((item) => item.artifactId),
        ...provenance.profileFiles.map((item) => item.artifactId),
        ...provenance.checkpoints.map((item) => item.artifactId),
      ],
    );
    const runnerPayload = await retain("verification_benchmark_run_manifest", run, [
      admitted.datasetArtifact.artifactId,
      admitted.experimentArtifact.artifactId,
      provenanceArtifact.artifactId,
    ]);
    const summaryArtifact = await retain(
      "verification_benchmark_summary",
      {
        schemaVersion: "verification-benchmark-publication-summary.v1",
        runId: run.runId,
        runnerManifestDigest: run.manifestDigest,
        datasetManifestDigest: admitted.dataset.manifestDigest,
        metrics: summaries,
      },
      [runnerPayload.artifactId, admitted.datasetArtifact.artifactId],
    );
    const arms = [];
    for (const arm of admitted.experiment.arms) {
      const configurationArtifact = await retain(
        "evaluation_arm_manifest",
        {
          schemaVersion: "verification-benchmark-arm-configuration.v1",
          experimentDefinition: admitted.request.experimentDefinition,
          arm,
        },
        [admitted.experimentArtifact.artifactId],
      );
      const policy = policies.get(arm.policyVersion)!;
      const terminalStatus =
        policy.definition.authorityWithheldOutcome === "fail"
          ? ("failed" as const)
          : policy.definition.authorityWithheldOutcome === "abstain" || !policy.definition.reviewAvailable
            ? ("abstained" as const)
            : ("review" as const);
      arms.push({
        benchmarkArmId: arm.armId,
        experimentArmId: id("arm", { experimentId, armId: arm.armId }),
        evalRunId: id("eval-run", { runId: run.runId, armId: arm.armId }),
        name: arm.name,
        isControl: arm.control,
        configuration: arm,
        configurationArtifact,
        policyArtifact: policy.artifact,
        targetCodeRef: runtime.targetCodeRef,
        terminalStatus,
      });
    }
    const manifest = await sealVerificationBenchmarkPublication(
      {
        schemaVersion: "verification-benchmark-publication.v1",
        verificationContractVersion: "verification.v1",
        tenantId,
        runId: run.runId,
        operationId,
        dataset: {
          artifact: admitted.datasetArtifact,
          datasetId,
          datasetVersionId,
          version: admitted.dataset.version,
          caseCount: admitted.dataset.cases.length,
          manifestDigest: admitted.dataset.manifestDigest,
          labelProvenance: admitted.dataset.labelProvenance as "engineering_expectations" | "mixed_pending",
        },
        experiment: {
          artifact: admitted.experimentArtifact,
          experimentId,
          runnerVersion: admitted.experiment.runnerVersion,
          randomSeed: run.randomSeed,
          repetitions: admitted.experiment.repetitions,
        },
        runnerPayload,
        runnerManifestDigest: run.manifestDigest,
        checkpointPlanDigest: plan.planDigest,
        summaryArtifact,
        provenanceArtifact,
        arms: arms.map((arm) => ({
          armId: arm.benchmarkArmId,
          experimentArmId: arm.experimentArmId,
          evalRunId: arm.evalRunId,
          configurationArtifact: arm.configurationArtifact,
          policyArtifact: arm.policyArtifact,
          isControl: arm.isControl,
          terminalStatus: arm.terminalStatus,
          dispositionBasis: "source_authority_unassessed" as const,
          summaryDigest: verificationBenchmarkDigest(
            summaries.find((summary) => summary.armId === arm.benchmarkArmId)!,
          ),
        })),
        runtime,
        execution: { mode: "offline_recorded", externalProviderRequests: 0 },
        qualityClaims: { humanGoldValidated: false, sourceAuthorityAssessed: false, calibrated: false },
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      },
      this.ports.signer,
    );
    assertActive();
    const publicationManifest = await retain("verification_run_manifest", manifest, [
      admitted.datasetArtifact.artifactId,
      admitted.experimentArtifact.artifactId,
      runnerPayload.artifactId,
      summaryArtifact.artifactId,
      provenanceArtifact.artifactId,
      ...arms.flatMap((arm) => [arm.configurationArtifact.artifactId, arm.policyArtifact.artifactId]),
      ...(runtime.dirtyStateArtifact ? [runtime.dirtyStateArtifact.artifactId] : []),
    ]);
    return deepFreeze({
      manifest,
      summaries,
      input: {
        tenantId,
        operationId,
        benchmarkRunId: run.runId,
        runnerPayloadManifest: runnerPayload,
        publicationManifest,
        dataset: {
          id: datasetId,
          slug: `verification-benchmark-${datasetId}`,
          purpose: "Frozen verification benchmark evaluation",
          version: {
            id: datasetVersionId,
            number: admitted.dataset.version,
            manifest: admitted.dataset,
            manifestArtifact: admitted.datasetArtifact,
            frozenAt: admitted.dataset.sealedAt,
            caseCount: admitted.dataset.cases.length,
            labelProvenance: "agent_generated" as const,
          },
        },
        experiment: {
          id: experimentId,
          name: admitted.experiment.experimentId,
          hypothesis: "Compare frozen verification variants using retained observations.",
          artifact: admitted.experimentArtifact,
        },
        arms,
      },
    });
  }
}
