import { describe, expect, it, vi } from "vitest";
import { verificationBenchmarkActivityHandler } from "./verification-benchmark-activity.js";

const uuid = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  operationId: "00000000-0000-4000-8000-000000000002",
  attemptId: "00000000-0000-4000-8000-000000000003",
  datasetId: "00000000-0000-4000-8000-000000000004",
  experimentId: "00000000-0000-4000-8000-000000000005",
  artifactId: "00000000-0000-4000-8000-000000000006",
  publicationId: "00000000-0000-4000-8000-000000000007",
};
const digest = `sha256:${"a".repeat(64)}`;
const now = "2026-09-06T12:00:00.000Z";

function invocation() {
  return {
    claim: {
      id: "step",
      tenantId: uuid.tenantId,
      operationId: uuid.operationId,
      stepKey: "replay",
      stepKind: "replay_recorded_and_register",
      inputSha256: "a".repeat(64),
      status: "running",
      attemptCount: 1,
      maxAttempts: 3,
      rowVersion: 1,
      holderIdentity: "worker",
      leaseToken: "lease",
      fencingToken: 1,
      expiresAt: "2026-09-06T12:01:00.000Z",
    },
    activity: {
      context: { tenantId: uuid.tenantId, operationId: uuid.operationId, attemptId: uuid.attemptId },
      operationInput: {
        schemaVersion: "verification-service-request.v1",
        useCase: "runBenchmark",
        request: {
          verificationContractVersion: "verification.v1",
          dataset: { artifactId: uuid.datasetId, digest },
          experimentDefinition: { artifactId: uuid.experimentId, digest },
          executionMode: "offline_recorded",
        },
      },
    },
  };
}

function runtime() {
  return {
    deploymentId: "benchmark-worker",
    attemptId: uuid.attemptId,
    capabilityVersion: "verification-service.v1",
    targetCodeRef: "uncommitted",
    gitSha: "uncommitted",
    dirty: true,
  };
}

function prepared() {
  const dataset = {
    datasetId: "dataset",
    version: 1,
    sealedAt: now,
    manifestDigest: digest,
    labelProvenance: "engineering_expectations",
    cases: [{ caseId: "case", caseDigest: digest }],
  };
  const arms = [
    { armId: "control", name: "Control", control: true, policyVersion: "v1" },
    { armId: "candidate", name: "Candidate", control: false, policyVersion: "v1" },
  ];
  return {
    admitted: {
      dataset,
      datasetArtifact: {
        artifactId: uuid.datasetId,
        tenantId: uuid.tenantId,
        digest,
        byteLength: 1,
        mediaType: "application/json",
        parentArtifactIds: [],
        transformationSignature: digest,
      },
      experimentArtifact: {
        artifactId: uuid.experimentId,
        tenantId: uuid.tenantId,
        digest,
        byteLength: 1,
        mediaType: "application/json",
        parentArtifactIds: [],
        transformationSignature: digest,
      },
      experiment: { runnerVersion: "verification-benchmark-runner.v1", repetitions: 1, randomSeed: 7, arms },
    },
    execute: vi.fn(),
  };
}

function publication() {
  const artifact = {
    artifactId: uuid.publicationId,
    tenantId: uuid.tenantId,
    digest,
    byteLength: 1,
    mediaType: "application/json",
    parentArtifactIds: [],
    transformationSignature: digest,
  };
  return {
    manifest: {
      seal: { payloadDigest: digest },
      qualityClaims: { humanGoldValidated: false, sourceAuthorityAssessed: false, calibrated: false },
    },
    input: { publicationManifest: artifact },
  };
}

function durable() {
  return { run: {}, checkpoints: {}, lifecycle: { startedAt: now, complete: vi.fn(async () => now) } };
}

function completedRun(runId: string) {
  return { runId, startedAt: now, completedAt: now, manifestDigest: digest, results: [], arms: [] };
}

describe("verification benchmark activity (unit-only)", () => {
  it("orchestrates trusted offline preparation, durable checkpoints, publication and a compact engineering-only receipt", async () => {
    const events: string[] = [];
    const prepare = vi.fn(async () => {
      events.push("prepare");
      return prepared();
    });
    const initialize = vi.fn(async () => {
      events.push("initialize");
      return durable();
    });
    const runBenchmark = vi.fn(async (input: { runId: string }) => {
      events.push("run");
      return completedRun(input.runId);
    });
    const build = vi.fn(async () => {
      events.push("build");
      return publication();
    });
    const publishCompleted = vi.fn(async () => {
      events.push("publish");
      return { benchmarkRunId: uuid.operationId, evalRunIds: [uuid.experimentId, uuid.publicationId] };
    });
    const handler = verificationBenchmarkActivityHandler({
      benchmark: { prepare } as never,
      runStore: { initialize } as never,
      publicationBuilder: { prepare: build } as never,
      publisher: { publishCompleted } as never,
      operations: { getOperationRecord: async () => ({ status: "running" }) } as never,
      runtime: { resolve: runtime },
      now: () => now,
      runBenchmark: runBenchmark as never,
      createCheckpointPlan: vi.fn(() => ({
        entries: [{ checkpointContextDigest: digest, caseId: "case", armId: "control", repetition: 0 }],
        planDigest: digest,
      })) as never,
    });

    const result = (await handler.execute(invocation() as never)) as any;
    expect(events).toEqual(["prepare", "initialize", "run", "build", "publish"]);
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: uuid.tenantId, operationId: uuid.operationId, startedAt: now }),
    );
    expect(publishCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ lease: expect.objectContaining({ id: "step", fencingToken: 1 }) }),
    );
    expect(result.resultArtifact).toEqual(publication().input.publicationManifest);
    expect(result.output).toEqual({
      benchmarkRunId: uuid.operationId,
      evalRunIds: [uuid.experimentId, uuid.publicationId],
      manifestDigest: digest,
      qualityClaims: { humanGoldValidated: false, sourceAuthorityAssessed: false, calibrated: false },
    });
    expect(result.output).not.toHaveProperty("valid");
  });

  it("polls cancellation into the abort signal and never publishes retained work after cancellation", async () => {
    const prepare = vi.fn(async (_request: unknown, options: { signal: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("BENCHMARK_CANCELLED")), { once: true }),
      );
      return prepared();
    });
    const initialize = vi.fn();
    const build = vi.fn();
    const publishCompleted = vi.fn();
    let checks = 0;
    const handler = verificationBenchmarkActivityHandler({
      benchmark: { prepare } as never,
      runStore: { initialize } as never,
      publicationBuilder: { prepare: build } as never,
      publisher: { publishCompleted } as never,
      operations: { getOperationRecord: async () => ({ status: ++checks === 1 ? "running" : "cancelled" }) } as never,
      runtime: { resolve: runtime },
      now: () => now,
      runBenchmark: vi.fn() as never,
      cancellationPollIntervalMs: 25,
    });

    await expect(handler.execute(invocation() as never)).rejects.toMatchObject({
      code: "VERIFICATION_OPERATION_NOT_ACTIVE",
      retryable: false,
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(publishCompleted).not.toHaveBeenCalled();
  });

  it("does not publish an incomplete or failed durable benchmark", async () => {
    const prepare = vi.fn(async () => prepared());
    const initialize = vi.fn(async () => durable());
    const build = vi.fn();
    const publishCompleted = vi.fn();
    const handler = verificationBenchmarkActivityHandler({
      benchmark: { prepare } as never,
      runStore: { initialize } as never,
      publicationBuilder: { prepare: build } as never,
      publisher: { publishCompleted } as never,
      operations: { getOperationRecord: async () => ({ status: "running" }) } as never,
      runtime: { resolve: runtime },
      now: () => now,
      runBenchmark: vi.fn(async () => {
        throw new Error("BENCHMARK_DURABLE_CHECKPOINT_PLAN_INCOMPLETE");
      }) as never,
      createCheckpointPlan: vi.fn(() => ({
        entries: [{ checkpointContextDigest: digest, caseId: "case", armId: "control", repetition: 0 }],
        planDigest: digest,
      })) as never,
    });

    await expect(handler.execute(invocation() as never)).rejects.toMatchObject({
      code: "BENCHMARK_DURABLE_CHECKPOINT_PLAN_INCOMPLETE",
      retryable: false,
    });
    expect(build).not.toHaveBeenCalled();
    expect(publishCompleted).not.toHaveBeenCalled();
  });

  it("preserves a transient polling failure as retryable instead of relabeling it as cancellation", async () => {
    const prepare = vi.fn(async (_request: unknown, options: { signal: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("BENCHMARK_CANCELLED")), { once: true }),
      );
      return prepared();
    });
    const publishCompleted = vi.fn();
    let checks = 0;
    const handler = verificationBenchmarkActivityHandler({
      benchmark: { prepare } as never,
      runStore: {} as never,
      publicationBuilder: {} as never,
      publisher: { publishCompleted } as never,
      operations: {
        getOperationRecord: async () => {
          if (++checks === 1) return { status: "running" };
          throw new Error("temporary database failure");
        },
      } as never,
      runtime: { resolve: runtime },
      now: () => now,
      cancellationPollIntervalMs: 25,
    });
    await expect(handler.execute(invocation() as never)).rejects.toMatchObject({
      code: "VERIFICATION_BENCHMARK_INFRASTRUCTURE_FAILURE",
      retryable: true,
    });
    expect(publishCompleted).not.toHaveBeenCalled();
  });

  it("does not disclose unsupported quality claims or publish them", async () => {
    const build = vi.fn(async () => ({
      ...publication(),
      manifest: {
        ...publication().manifest,
        qualityClaims: { humanGoldValidated: true, sourceAuthorityAssessed: false, calibrated: false },
      },
    }));
    const publishCompleted = vi.fn();
    const handler = verificationBenchmarkActivityHandler({
      benchmark: { prepare: async () => prepared() } as never,
      runStore: { initialize: async () => durable() } as never,
      publicationBuilder: { prepare: build } as never,
      publisher: { publishCompleted } as never,
      operations: { getOperationRecord: async () => ({ status: "running" }) } as never,
      runtime: { resolve: runtime },
      now: () => now,
      runBenchmark: vi.fn(async (input: { runId: string }) => completedRun(input.runId)) as never,
      createCheckpointPlan: vi.fn(() => ({
        entries: [{ checkpointContextDigest: digest, caseId: "case", armId: "control", repetition: 0 }],
        planDigest: digest,
      })) as never,
    });
    await expect(handler.execute(invocation() as never)).rejects.toMatchObject({
      code: "BENCHMARK_PUBLICATION_QUALITY_CLAIMS_INVALID",
      retryable: false,
    });
    expect(publishCompleted).not.toHaveBeenCalled();
  });
  it("rejects a runtime identity that is not bound to the canonical attempt", async () => {
    const prepare = vi.fn();
    const handler = verificationBenchmarkActivityHandler({
      benchmark: { prepare } as never,
      runStore: {} as never,
      publicationBuilder: {} as never,
      publisher: {} as never,
      operations: { getOperationRecord: async () => ({ status: "running" }) } as never,
      runtime: { resolve: () => ({ ...runtime(), attemptId: "00000000-0000-4000-8000-000000000099" }) },
      now: () => now,
    });
    await expect(handler.execute(invocation() as never)).rejects.toMatchObject({
      code: "BENCHMARK_RUNTIME_ATTEMPT_MISMATCH",
      retryable: false,
    });
    expect(prepare).not.toHaveBeenCalled();
  });
});
