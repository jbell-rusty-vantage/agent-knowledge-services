import {
  RunBenchmarkRequestSchema,
  VerificationBenchmarkOperationResultSchema,
  VerificationBenchmarkPublicationManifestSchema,
  type JsonValue,
  type OperationContext,
  type VerificationBenchmarkPublicationManifest,
} from "@aiengineer/knowledge-contracts";
import {
  RegisteredBenchmarkPublicationBuilder,
  RegisteredDiagnosticsOfflineBenchmark,
} from "@aiengineer/knowledge-application";
import {
  createVerificationBenchmarkCheckpointPlan,
  runVerificationBenchmark,
  type VerificationBenchmarkRun,
} from "@aiengineer/knowledge-evaluation";
import {
  PostgresVerificationBenchmarkPublisher,
  PostgresVerificationBenchmarkRunStore,
  type OperationsRepository,
} from "@aiengineer/knowledge-persistence";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import { z } from "zod";
import { CanonicalActivityError, type CanonicalActivityHandler } from "./activity-registry.js";

const inputSchema = z.strictObject({
  schemaVersion: z.literal("verification-service-request.v1"),
  useCase: z.literal("runBenchmark"),
  request: RunBenchmarkRequestSchema,
});

export interface VerificationBenchmarkRuntimeIdentity {
  resolve(context: OperationContext): VerificationBenchmarkPublicationManifest["runtime"];
}

/**
 * Executes only the registered, offline benchmark profile. It does not expose a
 * provider or public-read capability; publication is the final fenced write.
 */
export function verificationBenchmarkActivityHandler(dependencies: {
  readonly benchmark: Pick<RegisteredDiagnosticsOfflineBenchmark, "prepare">;
  readonly runStore: Pick<PostgresVerificationBenchmarkRunStore, "initialize">;
  readonly publicationBuilder: Pick<RegisteredBenchmarkPublicationBuilder, "prepare">;
  readonly publisher: Pick<PostgresVerificationBenchmarkPublisher, "publishCompleted">;
  readonly operations: Pick<OperationsRepository, "getOperationRecord">;
  readonly runtime: VerificationBenchmarkRuntimeIdentity;
  readonly now: () => string;
  /** Test seam. Production defaults to the evaluation package's durable runner. */
  readonly runBenchmark?: typeof runVerificationBenchmark;
  /** Test seam. Production derives the exact plan with the evaluation helper. */
  readonly createCheckpointPlan?: typeof createVerificationBenchmarkCheckpointPlan;
  /** Bounds cancellation observation while retained artifacts are being hydrated. */
  readonly cancellationPollIntervalMs?: number;
}): CanonicalActivityHandler {
  return {
    operationKind: "verification_benchmark",
    stepName: "replay_recorded_and_register",
    async execute({ activity, claim }): Promise<JsonValue> {
      const { context } = activity;
      const controller = new AbortController();
      let pollFailure: unknown;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const active = async () => {
        if (pollFailure) throw pollFailure;
        const operation = await dependencies.operations.getOperationRecord(context.tenantId, context.operationId);
        if (!operation || operation.status !== "running") {
          controller.abort();
          throw new CanonicalActivityError(
            "VERIFICATION_OPERATION_NOT_ACTIVE",
            "VERIFICATION_OPERATION_NOT_ACTIVE",
            false,
          );
        }
        if (controller.signal.aborted) {
          throw new CanonicalActivityError("BENCHMARK_CANCELLED", "BENCHMARK_CANCELLED", false);
        }
      };
      const schedulePoll = (interval: number) => {
        if (stopped || controller.signal.aborted) return;
        timer = setTimeout(() => {
          void (async () => {
            try {
              await active();
            } catch (error) {
              pollFailure ??= error;
              controller.abort();
            } finally {
              schedulePoll(interval);
            }
          })();
        }, interval);
      };
      try {
        const input = inputSchema.parse(activity.operationInput);
        await active();
        const runtime = VerificationBenchmarkPublicationManifestSchema.shape.runtime.parse(
          dependencies.runtime.resolve(context),
        );
        if (runtime.attemptId !== context.attemptId) throw new Error("BENCHMARK_RUNTIME_ATTEMPT_MISMATCH");
        const runId = deterministicUuid("verification-benchmark-run", `${context.tenantId}:${context.operationId}`);
        schedulePoll(boundedPollInterval(dependencies.cancellationPollIntervalMs));

        const prepared = await dependencies.benchmark.prepare(input.request, {
          tenantId: context.tenantId,
          runId,
          signal: controller.signal,
        });
        await active();
        const checkpointPlan = (dependencies.createCheckpointPlan ?? createVerificationBenchmarkCheckpointPlan)({
          runId,
          dataset: prepared.admitted.dataset,
          experimentDefinitionDigest: prepared.admitted.experimentArtifact.digest as `sha256:${string}`,
          arms: prepared.admitted.experiment.arms,
          repetitions: prepared.admitted.experiment.repetitions,
          randomSeed: prepared.admitted.experiment.randomSeed,
          networkPolicy: "offline",
        });
        const durable = await dependencies.runStore.initialize({
          tenantId: context.tenantId,
          operationId: context.operationId,
          lease: claim,
          runId,
          datasetArtifact: prepared.admitted.datasetArtifact,
          experimentArtifact: prepared.admitted.experimentArtifact,
          runnerVersion: prepared.admitted.experiment.runnerVersion,
          networkPolicy: "offline",
          randomSeed: prepared.admitted.experiment.randomSeed,
          repetitions: prepared.admitted.experiment.repetitions,
          checkpointPlan,
          startedAt: dependencies.now(),
        });
        await active();
        const run = await (dependencies.runBenchmark ?? runVerificationBenchmark)({
          runId,
          dataset: prepared.admitted.dataset,
          experimentDefinitionDigest: prepared.admitted.experimentArtifact.digest as `sha256:${string}`,
          arms: prepared.admitted.experiment.arms,
          repetitions: prepared.admitted.experiment.repetitions,
          randomSeed: prepared.admitted.experiment.randomSeed,
          networkPolicy: "offline",
          checkpoints: durable.checkpoints,
          lifecycle: durable.lifecycle,
          execute: prepared.execute,
          now: dependencies.now,
          signal: controller.signal,
        });
        await active();
        const publication = await dependencies.publicationBuilder.prepare({
          tenantId: context.tenantId,
          operationId: context.operationId,
          prepared,
          run: run as VerificationBenchmarkRun,
          runtime,
          signal: controller.signal,
        });
        await active();
        const qualityClaims = publication.manifest.qualityClaims;
        if (
          qualityClaims.humanGoldValidated !== false ||
          qualityClaims.sourceAuthorityAssessed !== false ||
          qualityClaims.calibrated !== false
        ) {
          throw new Error("BENCHMARK_PUBLICATION_QUALITY_CLAIMS_INVALID");
        }
        const completed = await dependencies.publisher.publishCompleted({ ...publication.input, lease: claim });
        await active();
        const output = VerificationBenchmarkOperationResultSchema.parse({
          benchmarkRunId: completed.benchmarkRunId,
          evalRunIds: completed.evalRunIds,
          manifestDigest: publication.manifest.seal.payloadDigest,
          qualityClaims,
        });
        return {
          schemaVersion: "verification-operation-result.v1",
          operationId: context.operationId,
          useCase: "runBenchmark",
          resultArtifact: publication.input.publicationManifest,
          output,
        } as unknown as JsonValue;
      } catch (error) {
        const source = pollFailure ?? error;
        if (source instanceof CanonicalActivityError) throw source;
        if (source instanceof z.ZodError) {
          throw new CanonicalActivityError(
            "INVALID_VERIFICATION_BENCHMARK_INPUT",
            "INVALID_VERIFICATION_BENCHMARK_INPUT",
            false,
          );
        }
        const message = source instanceof Error ? source.message : "";
        const code = /^[A-Z][A-Z0-9_]{2,127}$/u.test(message)
          ? message
          : "VERIFICATION_BENCHMARK_INFRASTRUCTURE_FAILURE";
        const retryable =
          code === "VERIFICATION_BENCHMARK_INFRASTRUCTURE_FAILURE" ||
          code.startsWith("OBJECT_STORE_") ||
          code === "REGISTERED_ARTIFACT_BYTES_UNAVAILABLE";
        throw new CanonicalActivityError(code, code, retryable, { cause: source });
      } finally {
        stopped = true;
        if (timer) clearTimeout(timer);
      }
    },
  };
}

function boundedPollInterval(value: number | undefined): number {
  if (value === undefined) return 250;
  if (!Number.isInteger(value) || value < 25 || value > 60_000)
    throw new Error("BENCHMARK_CANCELLATION_POLL_INTERVAL_INVALID");
  return value;
}
