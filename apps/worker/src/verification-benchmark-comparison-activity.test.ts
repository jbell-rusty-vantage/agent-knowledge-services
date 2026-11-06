import { describe, expect, it, vi } from "vitest";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import { CanonicalActivityError } from "./activity-registry.js";
import { verificationBenchmarkComparisonActivityHandler } from "./verification-benchmark-comparison-activity.js";

const ids = Array.from({ length: 16 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const [
  tenantId,
  operationId,
  attemptId,
  baselineRunId,
  candidateRunId,
  baselinePublicationId,
  candidatePublicationId,
  profileArtifactId,
  resultArtifactId,
  publicationArtifactId,
  stepId,
  leaseToken,
] = ids as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  ...string[],
];
const digest = (value: string) => digestCanonicalJson(value);
const startedAt = "2026-09-06T12:00:00.000Z";
const completedAt = "2026-09-06T12:01:00.000Z";

const request = {
  verificationContractVersion: "verification.v1",
  baselineRunId,
  candidateRunId,
  comparisonProfile: "regression_gate",
} as const;

function artifact(artifactId: string, value: string) {
  return {
    artifactId,
    tenantId,
    digest: digest(value),
    byteLength: 1,
    mediaType: "application/json",
    parentArtifactIds: [],
    transformationSignature: digest(`signature:${value}`),
  };
}

const baselinePublication = artifact(baselinePublicationId, "baseline-publication");
const candidatePublication = artifact(candidatePublicationId, "candidate-publication");
const profileArtifact = artifact(profileArtifactId, "comparison-profile");
const resultArtifact = artifact(resultArtifactId, "comparison-result");
const publicationArtifact = artifact(publicationArtifactId, "comparison-publication");
const resultDigest = digest("result-semantic");
const publicationPayloadDigest = digest("publication-payload");

function runtime(attempt = attemptId) {
  return {
    deploymentId: "comparison-worker",
    attemptId: attempt,
    capabilityVersion: "verification-service.v1",
    targetCodeRef: "commit",
    gitSha: "a".repeat(40),
    dirty: false,
  };
}

function prepared() {
  return {
    input: {
      tenantId,
      request,
      profileArtifact,
      profile: { profileId: "regression_gate", version: 3 },
      baseline: {
        run: { runId: baselineRunId },
        publication: {
          publicationArtifact: baselinePublication,
          manifest: { seal: { payloadDigest: digest("baseline-payload") } },
        },
      },
      candidate: {
        run: { runId: candidateRunId },
        publication: {
          publicationArtifact: candidatePublication,
          manifest: { seal: { payloadDigest: digest("candidate-payload") } },
        },
      },
    },
    result: {
      resultDigest,
      engineeringRegressionGate: { outcome: "pass" },
    },
  };
}

function operation(status = "running") {
  return {
    id: operationId,
    tenantId,
    operationKind: "verification_benchmark_compare",
    status,
  };
}

function invocation() {
  return {
    operation: operation(),
    claim: {
      id: stepId,
      tenantId,
      operationId,
      stepKey: "compare_registered_and_publish",
      stepKind: "compare_registered_and_publish",
      inputSha256: "a".repeat(64),
      status: "running",
      attemptCount: 1,
      maxAttempts: 3,
      rowVersion: 1,
      holderIdentity: "comparison-worker",
      leaseToken,
      fencingToken: 1,
      expiresAt: "2026-09-06T12:10:00.000Z",
    },
    activity: {
      context: { tenantId, operationId, attemptId },
      operationInput: { schemaVersion: "verification-service-request.v1", useCase: "compareBenchmarkRuns", request },
    },
  };
}

function durable(identity: unknown, status: "running" | "completed" | "sealed" = "running") {
  return {
    identity,
    identityDigest: digestCanonicalJson(identity),
    status,
    startedAt,
    completedAt: status === "running" ? null : completedAt,
    resultArtifact:
      status === "running" ? null : { artifactId: resultArtifact.artifactId, digest: resultArtifact.digest },
    resultDigest: status === "running" ? null : resultDigest,
    engineeringGateOutcome: status === "running" ? null : "pass",
    publicationArtifact:
      status === "sealed" ? { artifactId: publicationArtifact.artifactId, digest: publicationArtifact.digest } : null,
    publicationPayloadDigest: status === "sealed" ? publicationPayloadDigest : null,
  };
}

function builtPublication() {
  return {
    manifest: {
      baseline: { runId: baselineRunId },
      candidate: { runId: candidateRunId },
      seal: { payloadDigest: publicationPayloadDigest },
      qualityClaims: { humanGoldValidated: false, sourceAuthorityAssessed: false, calibrated: false },
    },
    publicationArtifact,
    publicationPayloadDigest,
  };
}

function fixture(options: { initialStatus?: "running" | "completed" | "sealed" } = {}) {
  const events: string[] = [];
  const prepare = vi.fn(async () => {
    events.push("prepare");
    return prepared();
  });
  const initialize = vi.fn(async (identity: unknown) => {
    events.push("initialize");
    return durable(identity, options.initialStatus);
  });
  const retainResult = vi.fn(async () => {
    events.push("retain");
    return { resultArtifact, resultDigest, engineeringGateOutcome: "pass" };
  });
  const complete = vi.fn(async ({ comparison }: { comparison: ReturnType<typeof durable> }) => {
    events.push("complete");
    return comparison.status === "sealed" ? comparison : durable(comparison.identity, "completed");
  });
  const publish = vi.fn(async () => {
    events.push("publish");
    return builtPublication();
  });
  const seal = vi.fn(async ({ comparison }: { comparison: ReturnType<typeof durable> }) => {
    events.push("seal");
    return durable(comparison.identity, "sealed");
  });
  const getOperationRecord = vi.fn(async () => operation());
  const handler = verificationBenchmarkComparisonActivityHandler({
    application: { prepare } as never,
    store: { initialize, complete, seal } as never,
    publicationBuilder: { retainResult, publish } as never,
    operations: { getOperationRecord } as never,
    runtime: { resolve: () => runtime() },
  });
  return { handler, events, prepare, initialize, retainResult, complete, publish, seal, getOperationRecord };
}

describe("verification benchmark comparison activity (unit-only)", () => {
  it("orchestrates branded preparation, fenced durable transitions and a compact engineering-only receipt", async () => {
    const test = fixture();
    const body = (await test.handler.execute(invocation() as never)) as any;
    const comparisonId = deterministicUuid("verification-benchmark-comparison", `${tenantId}:${operationId}`);

    expect(test.events).toEqual(["prepare", "initialize", "retain", "complete", "publish", "seal"]);
    expect(test.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, operationId, comparisonId, runtime: runtime() }),
      expect.objectContaining({ id: stepId, leaseToken, fencingToken: 1 }),
    );
    expect(test.retainResult).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId, attemptId, createdAt: startedAt, request, prepared: prepared() }),
    );
    expect(test.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        operationId,
        comparisonId,
        startedAt,
        completedAt,
        resultArtifact,
        resultDigest,
        engineeringGateOutcome: "pass",
      }),
    );
    expect(body).toEqual({
      schemaVersion: "verification-operation-result.v1",
      operationId,
      useCase: "compareBenchmarkRuns",
      resultArtifact: publicationArtifact,
      output: {
        comparisonId,
        baselineRunId,
        candidateRunId,
        manifestDigest: publicationPayloadDigest,
        resultDigest,
        engineeringGateOutcome: "pass",
        qualityClaims: { humanGoldValidated: false, sourceAuthorityAssessed: false, calibrated: false },
      },
    });
  });

  it("re-prepares and regenerates exact artifacts while reusing sealed retry timing and custody", async () => {
    const test = fixture({ initialStatus: "sealed" });
    await test.handler.execute(invocation() as never);

    expect(test.events).toEqual(["prepare", "initialize", "retain", "complete", "publish", "seal"]);
    expect(test.retainResult).toHaveBeenCalledWith(expect.objectContaining({ createdAt: startedAt }));
    expect(test.complete.mock.calls[0]?.[0].comparison).toMatchObject({ status: "sealed", startedAt, completedAt });
    expect(test.publish).toHaveBeenCalledWith(expect.objectContaining({ startedAt, completedAt }));
    expect(test.seal.mock.calls[0]?.[0].comparison).toMatchObject({ status: "sealed", startedAt, completedAt });
  });

  it("rejects durable result drift before signing or sealing a publication", async () => {
    const test = fixture();
    test.complete.mockImplementationOnce(async ({ comparison }) => ({
      ...durable(comparison.identity, "completed"),
      resultDigest: digest("different-result"),
    }));

    await expect(test.handler.execute(invocation() as never)).rejects.toMatchObject({
      code: "BENCHMARK_COMPARISON_DURABLE_RESULT_MISMATCH",
      retryable: false,
    });
    expect(test.publish).not.toHaveBeenCalled();
    expect(test.seal).not.toHaveBeenCalled();
  });

  it("rejects canonical tenant identity and runtime attempt mismatches before preparation", async () => {
    const wrongTenant = ids[15]!;
    const identityTest = fixture();
    identityTest.getOperationRecord.mockResolvedValueOnce({ ...operation(), tenantId: wrongTenant } as never);
    await expect(identityTest.handler.execute(invocation() as never)).rejects.toMatchObject({
      code: "BENCHMARK_COMPARISON_OPERATION_IDENTITY_MISMATCH",
      retryable: false,
    });
    expect(identityTest.prepare).not.toHaveBeenCalled();

    const runtimeTest = fixture();
    const handler = verificationBenchmarkComparisonActivityHandler({
      application: { prepare: runtimeTest.prepare } as never,
      store: {} as never,
      publicationBuilder: {} as never,
      operations: { getOperationRecord: runtimeTest.getOperationRecord } as never,
      runtime: { resolve: () => runtime(ids[14]!) },
    });
    await expect(handler.execute(invocation() as never)).rejects.toMatchObject({
      code: "BENCHMARK_COMPARISON_RUNTIME_ATTEMPT_MISMATCH",
      retryable: false,
    });
    expect(runtimeTest.prepare).not.toHaveBeenCalled();
  });

  it("serializes cancellation polls and does not retain work after the operation is cancelled", async () => {
    let calls = 0;
    let concurrent = 0;
    let maximumConcurrent = 0;
    const getOperationRecord = vi.fn(async () => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result = operation(++calls === 1 ? "running" : "cancelled");
      concurrent -= 1;
      return result;
    });
    const prepare = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("BENCHMARK_CANCELLED")), { once: true }),
      );
      return prepared();
    });
    const retainResult = vi.fn();
    const handler = verificationBenchmarkComparisonActivityHandler({
      application: { prepare } as never,
      store: {} as never,
      publicationBuilder: { retainResult } as never,
      operations: { getOperationRecord } as never,
      runtime: { resolve: () => runtime() },
      cancellationPollIntervalMs: 25,
    });

    await expect(handler.execute(invocation() as never)).rejects.toMatchObject({
      code: "VERIFICATION_OPERATION_NOT_ACTIVE",
      retryable: false,
    });
    expect(maximumConcurrent).toBe(1);
    expect(retainResult).not.toHaveBeenCalled();
  });

  it("preserves explicit retryable errors and scrubs unknown infrastructure messages", async () => {
    const retryable = fixture();
    retryable.retainResult.mockRejectedValueOnce(
      new CanonicalActivityError("COMPARISON_STORAGE_BUSY", "COMPARISON_STORAGE_BUSY", true),
    );
    await expect(retryable.handler.execute(invocation() as never)).rejects.toMatchObject({
      code: "COMPARISON_STORAGE_BUSY",
      retryable: true,
    });

    const unknown = fixture();
    unknown.retainResult.mockRejectedValueOnce(new Error("password=secret host=db.example"));
    const failure = (await Promise.resolve(unknown.handler.execute(invocation() as never)).catch(
      (error: unknown) => error,
    )) as CanonicalActivityError;
    expect(failure).toMatchObject({
      code: "VERIFICATION_BENCHMARK_COMPARISON_INFRASTRUCTURE_FAILURE",
      retryable: true,
    });
    expect(String(failure)).not.toContain("secret");
  });

  it("maps a malformed public comparison request to the exact nonretryable input failure", async () => {
    const test = fixture();
    const malformed = invocation();
    malformed.activity.operationInput = {
      ...malformed.activity.operationInput,
      request: { ...request, candidateRunId: baselineRunId },
    } as never;
    await expect(test.handler.execute(malformed as never)).rejects.toMatchObject({
      code: "INVALID_VERIFICATION_BENCHMARK_COMPARISON_INPUT",
      retryable: false,
    });
    expect(test.getOperationRecord).not.toHaveBeenCalled();
    expect(test.prepare).not.toHaveBeenCalled();
  });
});
