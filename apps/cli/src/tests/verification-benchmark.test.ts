import { describe, expect, it, vi } from "vitest";
import type { OperationContext } from "@aiengineer/knowledge-contracts";
import { dispatchCliCommand, resolveCommand, type CliKnowledgeClient } from "../commands.js";
import { waitForVerification } from "../verification-completion.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context: OperationContext = {
  tenantId: id(1),
  operationId: id(2),
  attemptId: id(3),
  correlationId: id(4),
  actor: { kind: "human", id: id(5) },
  capabilityVersion: "verification.v1",
  idempotencyKey: "benchmark-cli",
  reason: "test",
  contractVersion: "v1",
};
const request = {
  verificationContractVersion: "verification.v1",
  dataset: { artifactId: id(6), digest: `sha256:${"1".repeat(64)}` },
  experimentDefinition: {
    artifactId: id(7),
    digest: `sha256:${"2".repeat(64)}`,
  },
  executionMode: "offline_recorded",
};

describe("benchmark CLI", () => {
  it("submits comparison references and reports an engineering gate failure without fabricating quality", async () => {
    const compareBenchmarkRuns = vi.fn(),
      request = {
        verificationContractVersion: "verification.v1",
        baselineRunId: id(20),
        candidateRunId: id(21),
        comparisonProfile: "regression_gate",
      };
    await dispatchCliCommand(
      { compareBenchmarkRuns } as unknown as CliKnowledgeClient,
      resolveCommand("benchmark", "compare")!,
      request,
      context,
    );
    expect(compareBenchmarkRuns).toHaveBeenCalledWith(request, context);
    const output = {
      comparisonId: id(22),
      baselineRunId: id(20),
      candidateRunId: id(21),
      manifestDigest: `sha256:${"a".repeat(64)}`,
      resultDigest: `sha256:${"b".repeat(64)}`,
      engineeringGateOutcome: "fail",
      qualityClaims: {
        humanGoldValidated: false,
        sourceAuthorityAssessed: false,
        calibrated: false,
      },
    };
    const client = {
      getVerificationOperation: vi.fn(async () => ({
        kind: "verification_benchmark_compare",
        state: "succeeded",
        receiptIds: [id(23)],
      })),
      getReceipt: vi.fn(async () => ({
        operationId: context.operationId,
        receiptKind: "compare_registered_and_publish.succeeded",
        outcome: "succeeded",
        body: { output },
      })),
    };
    const completed = await waitForVerification(client as never, context.operationId, context, 1000);
    expect(completed).toMatchObject({ exitCode: 1, comparison: output });
    expect(completed).not.toHaveProperty("qualityPassed");
  });
  it("uses the dedicated typed method and rejects caller results", async () => {
    const runBenchmark = vi.fn(),
      client = { runBenchmark } as unknown as CliKnowledgeClient;
    await dispatchCliCommand(client, resolveCommand("benchmark", "run")!, request, context);
    expect(runBenchmark).toHaveBeenCalledWith(request, context);
    await expect(
      dispatchCliCommand(client, resolveCommand("benchmark", "run")!, { ...request, results: [] }, context),
    ).rejects.toThrow();
    expect(runBenchmark).toHaveBeenCalledTimes(1);
  });
  it("reports completed execution without inventing a quality pass", async () => {
    const output = {
      benchmarkRunId: id(8),
      evalRunIds: [id(9), id(10)],
      manifestDigest: `sha256:${"3".repeat(64)}`,
      qualityClaims: {
        humanGoldValidated: false,
        sourceAuthorityAssessed: false,
        calibrated: false,
      },
    };
    const client = {
      getVerificationOperation: vi.fn(async () => ({
        kind: "verification_benchmark",
        state: "succeeded",
        receiptIds: [id(11)],
      })),
      getReceipt: vi.fn(async () => ({
        operationId: context.operationId,
        receiptKind: "replay_recorded_and_register.succeeded",
        outcome: "succeeded",
        body: { output },
      })),
    };
    const result = await waitForVerification(client as never, context.operationId, context, 1000);
    expect(result).toMatchObject({ exitCode: 0, benchmark: output });
    expect(result).not.toHaveProperty("qualityPassed");
    output.qualityClaims.humanGoldValidated = true;
    await expect(waitForVerification(client as never, context.operationId, context, 1000)).rejects.toThrow();
  });
});

describe("--wait completion", () => {
  it("refuses to interpret kinds it cannot grade and names the fallback", async () => {
    const client = {
      getVerificationOperation: vi.fn(async () => ({
        kind: "verification_parse_artifact",
        state: "succeeded",
        receiptIds: [id(33)],
      })),
      getReceipt: vi.fn(),
    };
    await expect(waitForVerification(client as never, context.operationId, context, 1000)).rejects.toThrow(
      /^VERIFICATION_WAIT_UNSUPPORTED_KIND:verification_parse_artifact/,
    );
    expect(client.getReceipt).not.toHaveBeenCalled();
  });
  it("refuses the retired claims/report kinds (SV-17)", async () => {
    const client = {
      getVerificationOperation: vi.fn(async () => ({
        kind: "verification_claims",
        state: "succeeded",
        receiptIds: [id(34)],
      })),
      getReceipt: vi.fn(),
    };
    await expect(waitForVerification(client as never, context.operationId, context, 1000)).rejects.toThrow(
      /^VERIFICATION_WAIT_UNSUPPORTED_KIND:verification_claims/,
    );
  });
});
