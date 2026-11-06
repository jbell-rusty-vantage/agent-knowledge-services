import {
  CompareBenchmarkRunsRequestSchema,
  VerificationBenchmarkComparisonOperationResultSchema,
  VerificationBenchmarkComparisonPublicationSchema,
  type JsonValue,
  type OperationContext,
  type VerificationBenchmarkComparisonPublication,
} from "@aiengineer/knowledge-contracts";
import {
  type PreparedVerificationBenchmarkComparison,
  type RegisteredBenchmarkComparisonPublicationBuilder,
  type VerificationBenchmarkComparisonApplicationService,
} from "@aiengineer/knowledge-application";
import {
  type DurableVerificationBenchmarkComparison,
  type OperationsRepository,
  type PostgresVerificationBenchmarkComparisonStore,
  type VerificationBenchmarkComparisonIdentity,
} from "@aiengineer/knowledge-persistence";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import { z } from "zod";
import { CanonicalActivityError, type CanonicalActivityHandler } from "./activity-registry.js";

const inputSchema = z.strictObject({
  schemaVersion: z.literal("verification-service-request.v1"),
  useCase: z.literal("compareBenchmarkRuns"),
  request: CompareBenchmarkRunsRequestSchema,
});

export interface VerificationBenchmarkComparisonRuntimeIdentity {
  resolve(context: OperationContext): VerificationBenchmarkComparisonPublication["runtime"];
}

/** Executes a registered comparison profile over two already sealed benchmark runs. */
export function verificationBenchmarkComparisonActivityHandler(dependencies: {
  readonly application: Pick<VerificationBenchmarkComparisonApplicationService, "prepare">;
  readonly store: Pick<PostgresVerificationBenchmarkComparisonStore, "initialize" | "complete" | "seal">;
  readonly publicationBuilder: Pick<RegisteredBenchmarkComparisonPublicationBuilder, "retainResult" | "publish">;
  readonly operations: Pick<OperationsRepository, "getOperationRecord">;
  readonly runtime: VerificationBenchmarkComparisonRuntimeIdentity;
  /** Bounds cancellation observation while registered artifacts are being hydrated. */
  readonly cancellationPollIntervalMs?: number;
}): CanonicalActivityHandler {
  return {
    operationKind: "verification_benchmark_compare",
    stepName: "compare_registered_and_publish",
    async execute({ activity, claim, operation }): Promise<JsonValue> {
      const { context } = activity;
      const controller = new AbortController();
      let activeCheck: Promise<void> | undefined;
      let pollFailure: unknown;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const checkActive = async (): Promise<void> => {
        if (pollFailure) throw pollFailure;
        const current = await dependencies.operations.getOperationRecord(context.tenantId, context.operationId);
        if (!current || current.status !== "running") {
          const failure = new CanonicalActivityError(
            "VERIFICATION_OPERATION_NOT_ACTIVE",
            "VERIFICATION_OPERATION_NOT_ACTIVE",
            false,
          );
          pollFailure ??= failure;
          controller.abort();
          throw failure;
        }
        if (
          current.id !== context.operationId ||
          current.tenantId !== context.tenantId ||
          current.operationKind !== "verification_benchmark_compare"
        ) {
          const failure = new CanonicalActivityError(
            "BENCHMARK_COMPARISON_OPERATION_IDENTITY_MISMATCH",
            "BENCHMARK_COMPARISON_OPERATION_IDENTITY_MISMATCH",
            false,
          );
          pollFailure ??= failure;
          controller.abort();
          throw failure;
        }
        if (controller.signal.aborted) {
          throw new CanonicalActivityError("BENCHMARK_COMPARISON_CANCELLED", "BENCHMARK_COMPARISON_CANCELLED", false);
        }
      };
      const active = (): Promise<void> => {
        activeCheck ??= checkActive().finally(() => {
          activeCheck = undefined;
        });
        return activeCheck;
      };
      const schedulePoll = (interval: number): void => {
        if (stopped || controller.signal.aborted) return;
        timer = setTimeout(() => {
          void active()
            .catch((error: unknown) => {
              pollFailure ??= error;
              controller.abort();
            })
            .finally(() => schedulePoll(interval));
        }, interval);
      };
      const stopPolling = (): void => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };

      try {
        const input = inputSchema.parse(activity.operationInput);
        if (
          claim.tenantId !== context.tenantId ||
          claim.operationId !== context.operationId ||
          operation.tenantId !== context.tenantId ||
          operation.id !== context.operationId ||
          operation.operationKind !== "verification_benchmark_compare"
        ) {
          throw new Error("BENCHMARK_COMPARISON_OPERATION_IDENTITY_MISMATCH");
        }
        await active();
        const runtime = VerificationBenchmarkComparisonPublicationSchema.shape.runtime.parse(
          dependencies.runtime.resolve(context),
        );
        if (runtime.attemptId !== context.attemptId) throw new Error("BENCHMARK_COMPARISON_RUNTIME_ATTEMPT_MISMATCH");
        const comparisonId = deterministicUuid(
          "verification-benchmark-comparison",
          `${context.tenantId}:${context.operationId}`,
        );
        schedulePoll(boundedPollInterval(dependencies.cancellationPollIntervalMs));

        const prepared = await dependencies.application.prepare({
          tenantId: context.tenantId,
          request: input.request,
          signal: controller.signal,
        });
        await active();
        if (
          prepared.input.tenantId !== context.tenantId ||
          digestCanonicalJson(prepared.input.request) !== digestCanonicalJson(input.request)
        ) {
          throw new Error("BENCHMARK_COMPARISON_PREPARATION_IDENTITY_MISMATCH");
        }

        const identity: VerificationBenchmarkComparisonIdentity = {
          tenantId: context.tenantId,
          operationId: context.operationId,
          comparisonId,
          baseline: side(prepared.input.baseline),
          candidate: side(prepared.input.candidate),
          profileId: prepared.input.profile.profileId,
          profileArtifact: prepared.input.profileArtifact,
          runtime,
        };
        let durable = await dependencies.store.initialize(identity, claim);
        await active();
        assertDurableIdentity(durable, identity);

        const retained = await dependencies.publicationBuilder.retainResult({
          tenantId: context.tenantId,
          request: input.request,
          prepared,
          attemptId: context.attemptId,
          createdAt: durable.startedAt,
          signal: controller.signal,
        });
        await active();
        durable = await dependencies.store.complete({
          comparison: durable,
          lease: claim,
          resultArtifact: retained.resultArtifact,
          resultDigest: retained.resultDigest,
          engineeringGateOutcome: retained.engineeringGateOutcome,
        });
        await active();
        assertCompleted(durable, identity, retained);

        const publication = await dependencies.publicationBuilder.publish({
          tenantId: context.tenantId,
          operationId: context.operationId,
          comparisonId,
          request: input.request,
          prepared,
          runtime,
          startedAt: durable.startedAt,
          completedAt: durable.completedAt,
          resultArtifact: retained.resultArtifact,
          resultDigest: retained.resultDigest,
          engineeringGateOutcome: retained.engineeringGateOutcome,
          signal: controller.signal,
        });
        await active();
        const qualityClaims = publication.manifest.qualityClaims;
        if (
          qualityClaims.humanGoldValidated !== false ||
          qualityClaims.sourceAuthorityAssessed !== false ||
          qualityClaims.calibrated !== false
        ) {
          throw new Error("BENCHMARK_COMPARISON_PUBLICATION_QUALITY_CLAIMS_INVALID");
        }
        durable = await dependencies.store.seal({
          comparison: durable,
          lease: claim,
          publicationArtifact: publication.publicationArtifact,
          publicationPayloadDigest: publication.publicationPayloadDigest,
        });
        stopPolling();
        await active();
        assertSealed(durable, identity, retained, publication);

        const output = VerificationBenchmarkComparisonOperationResultSchema.parse({
          comparisonId,
          baselineRunId: publication.manifest.baseline.runId,
          candidateRunId: publication.manifest.candidate.runId,
          manifestDigest: publication.manifest.seal.payloadDigest,
          resultDigest: retained.resultDigest,
          engineeringGateOutcome: retained.engineeringGateOutcome,
          qualityClaims,
        });
        return {
          schemaVersion: "verification-operation-result.v1",
          operationId: context.operationId,
          useCase: "compareBenchmarkRuns",
          resultArtifact: publication.publicationArtifact,
          output,
        } as unknown as JsonValue;
      } catch (error) {
        const source = pollFailure ?? error;
        if (source instanceof CanonicalActivityError) throw source;
        if (source instanceof z.ZodError) {
          throw new CanonicalActivityError(
            "INVALID_VERIFICATION_BENCHMARK_COMPARISON_INPUT",
            "INVALID_VERIFICATION_BENCHMARK_COMPARISON_INPUT",
            false,
          );
        }
        const message = source instanceof Error ? source.message : "";
        const code = /^[A-Z][A-Z0-9_]{2,127}$/u.test(message)
          ? message
          : "VERIFICATION_BENCHMARK_COMPARISON_INFRASTRUCTURE_FAILURE";
        const retryable =
          code === "VERIFICATION_BENCHMARK_COMPARISON_INFRASTRUCTURE_FAILURE" ||
          code.startsWith("OBJECT_STORE_") ||
          code === "REGISTERED_ARTIFACT_BYTES_UNAVAILABLE";
        throw new CanonicalActivityError(code, code, retryable, { cause: source });
      } finally {
        stopPolling();
      }
    },
  };
}

function side(value: PreparedVerificationBenchmarkComparison["input"]["baseline"]) {
  return {
    runId: value.run.runId,
    publicationArtifact: value.publication.publicationArtifact,
    payloadDigest: value.publication.manifest.seal.payloadDigest,
  };
}

function assertDurableIdentity(
  durable: DurableVerificationBenchmarkComparison,
  identity: VerificationBenchmarkComparisonIdentity,
): void {
  if (digestCanonicalJson(durable.identity) !== digestCanonicalJson(identity))
    throw new Error("BENCHMARK_COMPARISON_DURABLE_IDENTITY_MISMATCH");
  if (!Number.isFinite(Date.parse(durable.startedAt))) throw new Error("BENCHMARK_COMPARISON_DURABLE_TIMING_INVALID");
}

function assertCompleted(
  durable: DurableVerificationBenchmarkComparison,
  identity: VerificationBenchmarkComparisonIdentity,
  retained: Awaited<ReturnType<RegisteredBenchmarkComparisonPublicationBuilder["retainResult"]>>,
): asserts durable is DurableVerificationBenchmarkComparison & { readonly completedAt: string } {
  assertDurableIdentity(durable, identity);
  if (
    durable.status === "running" ||
    durable.completedAt === null ||
    !Number.isFinite(Date.parse(durable.completedAt)) ||
    Date.parse(durable.completedAt) < Date.parse(durable.startedAt) ||
    durable.resultArtifact?.artifactId !== retained.resultArtifact.artifactId ||
    durable.resultArtifact.digest !== retained.resultArtifact.digest ||
    durable.resultDigest !== retained.resultDigest ||
    durable.engineeringGateOutcome !== retained.engineeringGateOutcome
  ) {
    throw new Error("BENCHMARK_COMPARISON_DURABLE_RESULT_MISMATCH");
  }
}

function assertSealed(
  durable: DurableVerificationBenchmarkComparison,
  identity: VerificationBenchmarkComparisonIdentity,
  retained: Awaited<ReturnType<RegisteredBenchmarkComparisonPublicationBuilder["retainResult"]>>,
  publication: Awaited<ReturnType<RegisteredBenchmarkComparisonPublicationBuilder["publish"]>>,
): void {
  assertCompleted(durable, identity, retained);
  if (
    durable.status !== "sealed" ||
    durable.publicationArtifact?.artifactId !== publication.publicationArtifact.artifactId ||
    durable.publicationArtifact.digest !== publication.publicationArtifact.digest ||
    durable.publicationPayloadDigest !== publication.publicationPayloadDigest
  ) {
    throw new Error("BENCHMARK_COMPARISON_DURABLE_PUBLICATION_MISMATCH");
  }
}

function boundedPollInterval(value: number | undefined): number {
  if (value === undefined) return 250;
  if (!Number.isInteger(value) || value < 25 || value > 60_000)
    throw new Error("BENCHMARK_COMPARISON_CANCELLATION_POLL_INTERVAL_INVALID");
  return value;
}
