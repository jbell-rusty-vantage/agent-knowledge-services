import { UuidSchema } from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { verificationBenchmarkDigest, type VerificationBenchmarkExecutor } from "@aiengineer/knowledge-evaluation";
import type { RegisteredBenchmarkInputAdmission } from "./verification-benchmark-inputs.js";
import type { RegisteredBenchmarkProfileAdmission } from "./verification-benchmark-registered-profile.js";
import type {
  RegisteredBenchmarkReplayAdmission,
  RegisteredBenchmarkReplayOutcome,
} from "./verification-benchmark-registered-replay.js";
import type { RegisteredBenchmarkSourceImportAdmission } from "./verification-benchmark-source-import.js";
import { composeDiagnosticsRecordedArm, diagnosticsBenchmarkArms } from "./verification-benchmark.js";

const preparations = new WeakMap<object, { readonly tenantId: string; readonly runId: string }>();
export type RegisteredOfflineBenchmarkPreparation = Awaited<
  ReturnType<RegisteredDiagnosticsOfflineBenchmark["prepare"]>
>;
export function assertRegisteredOfflineBenchmarkPreparation(
  value: RegisteredOfflineBenchmarkPreparation,
  context: { tenantId: string; runId: string },
): void {
  const binding = preparations.get(value);
  if (!binding || binding.tenantId !== context.tenantId || binding.runId !== context.runId)
    throw new Error("BENCHMARK_REGISTERED_PREPARATION_REQUIRED");
}

/** Runtime composition for the sealed diagnostics profile. No provider dispatch port. */
export class RegisteredDiagnosticsOfflineBenchmark {
  constructor(
    private readonly ports: {
      readonly inputs: Pick<RegisteredBenchmarkInputAdmission, "load">;
      readonly profiles: Pick<RegisteredBenchmarkProfileAdmission, "load">;
      readonly replays: Pick<RegisteredBenchmarkReplayAdmission, "load"> &
        Partial<Pick<RegisteredBenchmarkReplayAdmission, "loadWithFailures">>;
      readonly sources: Pick<RegisteredBenchmarkSourceImportAdmission, "prepare">;
    },
  ) {}

  async prepare(
    request: unknown,
    context: { readonly tenantId: unknown; readonly runId: unknown; readonly signal?: AbortSignal },
  ) {
    const tenantId = UuidSchema.parse(context.tenantId),
      runId = UuidSchema.parse(context.runId);
    const assertActive = () => {
      if (context.signal?.aborted) throw new Error("BENCHMARK_CANCELLED");
    };
    assertActive();
    const admitted = await this.ports.inputs.load(request, { tenantId });
    assertActive();
    if (
      admitted.request.executionMode !== "offline_recorded" ||
      admitted.experiment.networkPolicy !== "offline" ||
      verificationBenchmarkDigest(admitted.experiment.arms) !== verificationBenchmarkDigest(diagnosticsBenchmarkArms())
    ) {
      throw new Error("BENCHMARK_OFFLINE_EXECUTOR_PROFILE_MISMATCH");
    }
    const profile = await this.ports.profiles.load(admitted, tenantId, context.signal);
    assertActive();
    const sources = await this.ports.sources.prepare(admitted, tenantId, context.signal);
    assertActive();
    const replayOutcomes: readonly RegisteredBenchmarkReplayOutcome[] = this.ports.replays.loadWithFailures
      ? (await this.ports.replays.loadWithFailures(admitted, profile, tenantId, context.signal)).outcomes
      : (await this.ports.replays.load(admitted, profile, tenantId, context.signal)).map((observation) => ({
          outcome: "observed" as const,
          observation,
        }));
    assertActive();
    const replays = replayOutcomes.flatMap((item) => (item.outcome === "observed" ? [item.observation] : []));
    const failures = replayOutcomes.flatMap((item) => (item.outcome === "failed" ? [item.failure] : []));
    const cases = new Map(admitted.dataset.cases.map((testCase) => [testCase.caseId, testCase]));
    const arms = new Map(admitted.experiment.arms.map((arm) => [arm.armId, arm]));
    if (Object.keys(sources.prepared.byCaseId).length !== cases.size)
      throw new Error("BENCHMARK_OFFLINE_PROJECTION_MATRIX_INVALID");
    for (const testCase of cases.values()) {
      const prepared = sources.prepared.byCaseId[testCase.caseId];
      if (
        !prepared ||
        prepared.caseId !== testCase.caseId ||
        Object.keys(prepared.byFragmentId).length !== testCase.evidence.length ||
        testCase.evidence.some((edge) => {
          const resolved = prepared.byFragmentId[edge.fragmentId];
          return (
            !resolved ||
            resolved.fragmentId !== edge.fragmentId ||
            resolved.captureId !== edge.captureId ||
            resolved.projectionArtifactId !== edge.projectionArtifactId ||
            resolved.projectionDigest !== edge.projectionDigest
          );
        })
      )
        throw new Error("BENCHMARK_OFFLINE_PROJECTION_MATRIX_INVALID");
    }
    const execute: VerificationBenchmarkExecutor = async (execution) => {
      assertActive();
      const testCase = cases.get(execution.testCase.caseId),
        arm = arms.get(execution.arm.armId);
      if (
        execution.runId !== runId ||
        execution.datasetManifestDigest !== admitted.dataset.manifestDigest ||
        execution.networkPolicy !== "offline" ||
        !testCase ||
        !arm ||
        verificationBenchmarkDigest(execution.testCase) !== verificationBenchmarkDigest(testCase) ||
        verificationBenchmarkDigest(execution.arm) !== verificationBenchmarkDigest(arm) ||
        !Number.isInteger(execution.repetition) ||
        execution.repetition < 0 ||
        execution.repetition >= admitted.experiment.repetitions
      ) {
        throw new Error("BENCHMARK_OFFLINE_EXECUTION_BINDING_INVALID");
      }
      const observations = replays.filter((item) => item.caseId === testCase.caseId);
      const resolutions = Object.values(sources.prepared.byCaseId[testCase.caseId]!.byFragmentId);
      const fieldMechanicsByRole = Object.fromEntries(
        observations
          .filter((item) => item.role !== "haiku_judge")
          .map((item) => [item.role, item.fieldMechanics?.schemaValid === true && item.fieldMechanics.fieldMechanics]),
      );
      return composeDiagnosticsRecordedArm({
        arm,
        testCase,
        executionMode: "offline_replay",
        observations: observations.map((item) => item.observation),
        mechanics: {
          locatorValid: resolutions.length > 0 && resolutions.every((item) => item.locatorValid),
          fieldMechanics: false,
          fieldMechanicsByRole,
        },
      }).execution;
    };
    const provenance = deepFreeze({
      dataset: admitted.request.dataset,
      experiment: admitted.request.experimentDefinition,
      sourceImport: sources.importManifest,
      sourceMappings: sources.mappings,
      profileFiles: profile.profileFiles,
      checkpoints: replayOutcomes.map((item) =>
        item.outcome === "observed" ? item.observation.checkpoint : item.failure.checkpoint,
      ),
      replayedObservationCount: replays.length,
      ...(failures.length === 0 ? {} : { replayedFailureCount: failures.length, failedCheckpoints: failures }),
      externalProviderRequests: 0 as const,
      scope: "offline_mechanical_replay; source authority unassessed; no human-gold claim" as const,
    });
    const prepared = Object.freeze({ admitted, execute, provenance });
    preparations.set(prepared, { tenantId, runId });
    return prepared;
  }
}
