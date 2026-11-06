import { describe, expect, it, vi } from "vitest";
import type { VerificationContextResolutionInput } from "@aiengineer/knowledge-application";
import { createVerificationMcpToolExecutor } from "../index.js";

// Submissions run in process: trusted ownership resolves the context, the shared
// admission gates admit the request, and the application service enqueues it.
const admitAll = {
  isParseArtifactRequestAdmitted: () => true,
  isStructuredExtractionRequestAdmitted: () => true,
  isBenchmarkRequestAdmitted: () => true,
  isBenchmarkComparisonRequestAdmitted: () => true,
};
function inProcess(submissions: Record<string, ReturnType<typeof vi.fn>>, grantTenant = tenant) {
  const resolveVerificationContext = vi.fn((input: VerificationContextResolutionInput) => ({
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    operationId: id(90),
    attemptId: input.hints.attemptId ?? id(91),
    ...(input.hints.missionId ? { missionId: input.hints.missionId } : {}),
    ...(input.hints.workItemId ? { workItemId: input.hints.workItemId } : {}),
    actor,
    capabilityVersion: "verification-service.v1",
    reason: "mcp verification test",
    contractVersion: "v1" as const,
  }));
  const execute = createVerificationMcpToolExecutor({
    operationService: {} as never,
    apiOrigin: "https://knowledge.example",
    identity: {
      actor,
      grants: [{ tenantId: grantTenant, roles: ["knowledge_operator"], scopes: [] }],
    },
    verificationOperations: submissions as never,
    resolveVerificationContext,
    verificationAdmission: admitAll,
  });
  return { execute, resolveVerificationContext };
}
const queued = (operationId: string) => vi.fn(async () => ({ operationId, state: "queued" }));
const bound = (value: Record<string, unknown> = context) =>
  expect.objectContaining({ ...value, actor, operationId: id(90) });

describe("benchmark and extraction MCP adapter", () => {
  it("submits comparison references in process and rejects caller inference", async () => {
    const submitCompareBenchmarkRuns = queued(id(80)),
      { execute } = inProcess({ submitCompareBenchmarkRuns });
    const request = {
      verificationContractVersion: "verification.v1",
      baselineRunId: id(81),
      candidateRunId: id(82),
      comparisonProfile: "paired_default",
    };
    await expect(execute("verify_benchmark_compare", { context, request })).resolves.toMatchObject({
      structuredContent: { operationId: id(80) },
    });
    expect(submitCompareBenchmarkRuns).toHaveBeenCalledWith(request, bound());
    await expect(
      execute("verify_benchmark_compare", {
        context,
        request: { ...request, statistics: {} },
      }),
    ).rejects.toThrow();
    expect(submitCompareBenchmarkRuns).toHaveBeenCalledTimes(1);
  });
  it("routes offline benchmarks and rejects caller checkpoint plans", async () => {
    const submitRunBenchmark = queued(id(8)),
      { execute } = inProcess({ submitRunBenchmark });
    const request = {
      verificationContractVersion: "verification.v1",
      dataset: { artifactId: id(12), digest: `sha256:${"3".repeat(64)}` },
      experimentDefinition: {
        artifactId: id(13),
        digest: `sha256:${"4".repeat(64)}`,
      },
      executionMode: "offline_recorded",
    };
    await expect(execute("verify_benchmark_run", { context, request })).resolves.toMatchObject({
      structuredContent: { operationId: id(8) },
    });
    expect(submitRunBenchmark).toHaveBeenCalledWith(request, bound());
    await expect(
      execute("verify_benchmark_run", {
        context,
        request: { ...request, checkpointPlan: [] },
      }),
    ).rejects.toThrow();
    expect(submitRunBenchmark).toHaveBeenCalledTimes(1);
  });
  it("forwards extraction routing hints to trusted ownership and rejects caller findings", async () => {
    const submitVerifyExtraction = queued(id(8)),
      { execute, resolveVerificationContext } = inProcess({
        submitVerifyExtraction,
      });
    const hints = { missionId: id(9), workItemId: id(10), attemptId: id(11) };
    const routedContext = { ...context, ...hints };
    const extractionRequest = {
      verificationContractVersion: "verification.v1",
      captureIds: ["capture-1"],
      extractionSchema: { artifactId: id(12), digest: `sha256:${"3".repeat(64)}` },
      extractionOutput: { artifactId: id(13), digest: `sha256:${"4".repeat(64)}` },
    };
    await expect(
      execute("verify_extract", {
        context: routedContext,
        request: extractionRequest,
      }),
    ).resolves.toMatchObject({ structuredContent: { operationId: id(8) } });
    expect(resolveVerificationContext).toHaveBeenCalledWith(
      expect.objectContaining({
        useCase: "verifyExtraction",
        hints: expect.objectContaining(hints),
      }),
    );
    expect(submitVerifyExtraction).toHaveBeenCalledWith(extractionRequest, bound(routedContext));
    await expect(
      execute("verify_extract", {
        context: routedContext,
        request: { ...extractionRequest, findings: [] },
      }),
    ).rejects.toThrow();
  });
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  tenant = id(1),
  actor = {
    kind: "service" as const,
    id: id(2),
    serviceIdentity: "mission_control_client" as const,
  };
const context = {
    tenantId: tenant,
    correlationId: "mcp-verification",
    idempotencyKey: "mcp-verification-001",
  },
  request = {
    verificationContractVersion: "verification.v1" as const,
    captureIds: ["capture-1"],
    extractionSchema: {
      artifactId: id(3),
      digest: `sha256:${"1".repeat(64)}` as const,
    },
    extractionOutput: {
      artifactId: id(4),
      digest: `sha256:${"2".repeat(64)}` as const,
    },
  };
describe("verification MCP adapter", () => {
  it("uses bearer-bound identity and strict in-process admission without accepting actor context", async () => {
    const submitVerifyExtraction = queued(id(5)),
      { execute, resolveVerificationContext } = inProcess({
        submitVerifyExtraction,
      });
    await expect(execute("verify_extract", { context, request })).resolves.toMatchObject({
      structuredContent: { operationId: id(5) },
    });
    expect(resolveVerificationContext).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ actor }) }),
    );
    expect(submitVerifyExtraction).toHaveBeenCalledWith(request, bound());
    await expect(
      execute("verify_extract", {
        context: { ...context, actor },
        request,
      }),
    ).rejects.toThrow();
  });
  it("denies a tenant outside the authenticated grant before submission", async () => {
    const submitVerifyExtraction = vi.fn(),
      { execute, resolveVerificationContext } = inProcess({ submitVerifyExtraction }, id(99));
    await expect(execute("verify_extract", { context, request })).resolves.toMatchObject({
      isError: true,
    });
    expect(resolveVerificationContext).not.toHaveBeenCalled();
    expect(submitVerifyExtraction).not.toHaveBeenCalled();
  });
});

describe("parse MCP adapter", () => {
  it("forwards only a strict artifact handle to in-process submission", async () => {
    const submitParseArtifact = queued(id(70)),
      { execute } = inProcess({ submitParseArtifact }),
      parse = {
        verificationContractVersion: "verification.v1",
        captureId: id(71),
        sourceArtifact: {
          artifactId: id(72),
          tenantId: tenant,
          digest: `sha256:${"7".repeat(64)}`,
          mediaType: "text/html",
          byteLength: 4,
          objectKey: "tenant/object",
          createdAt: "2026-09-07T00:00:00.000Z",
          producerActivityId: "capture",
          producerVersion: "v1",
          encryptionClass: "managed",
          retentionClass: "audit",
          dataClassification: "restricted",
          parentArtifactIds: [],
        },
      };
    await execute("verify_artifact_parse", { context, request: parse });
    expect(submitParseArtifact).toHaveBeenCalledWith(parse, bound());
    await expect(
      execute("verify_artifact_parse", {
        context,
        request: { ...parse, parserKind: "html" },
      }),
    ).rejects.toThrow();
  });
});
