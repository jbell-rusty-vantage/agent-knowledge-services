import { describe, expect, it, vi } from "vitest";
import type { OperationContext } from "@aiengineer/knowledge-contracts";
import { dispatchCliCommand, resolveCommand, type CliKnowledgeClient } from "../commands.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context: OperationContext = {
  tenantId: id(1),
  operationId: id(2),
  attemptId: id(3),
  correlationId: id(4),
  actor: { kind: "human", id: id(5) },
  capabilityVersion: "v1",
  idempotencyKey: "key",
  reason: "test",
  contractVersion: "v1",
};
const client = () =>
  ({
    submitOperation: vi.fn(),
    createRetrievalRun: vi.fn(),
    validateRetrievalPlan: vi.fn(),
    createVectorStore: vi.fn(),
    attachVectorStoreDocuments: vi.fn(),
    getVectorStore: vi.fn(),
    getVectorStoreOperation: vi.fn(),
    getOperation: vi.fn(),
    getVerificationOperation: vi.fn(),
    getOperationEvents: vi.fn(),
    retryOperation: vi.fn(),
    reconcileOperation: vi.fn(),
    getRetrievalExplanation: vi.fn(),
    getEvaluationFailures: vi.fn(),
    captureVerificationSource: vi.fn(),
    parseArtifact: vi.fn(),
    verifyExtraction: vi.fn(),
    replayVerificationRun: vi.fn(),
  }) as unknown as CliKnowledgeClient;
describe("CLI semantic dispatcher", () => {
  it("routes store reads using real ids", async () => {
    const c = client();
    await dispatchCliCommand(c, resolveCommand("store", "show")!, { vectorStoreId: id(6) }, context);
    await dispatchCliCommand(
      c,
      resolveCommand("store", "status")!,
      { vectorStoreId: id(6), operationId: id(7) },
      context,
    );
    expect(c.getVectorStore).toHaveBeenCalledWith(id(6), context);
    expect(c.getVectorStoreOperation).toHaveBeenCalledWith(id(6), id(7), context);
    expect(c.submitOperation).not.toHaveBeenCalled();
  });
  it.each([
    ["promotion", "status", "getOperation", "operationId"],
    ["embed", "status", "getOperation", "operationId"],
    ["retrieve", "explain", "getRetrievalExplanation", "runId"],
    ["eval", "failures", "getEvaluationFailures", "runId"],
  ])("routes %s %s as a read", async (group, action, method, key) => {
    const c = client();
    await dispatchCliCommand(c, resolveCommand(group, action)!, { [key]: id(8) }, context);
    expect(c[method as keyof CliKnowledgeClient]).toHaveBeenCalled();
    expect(c.submitOperation).not.toHaveBeenCalled();
  });
  it("routes verify status through the verification-aware operation read", async () => {
    const c = client();
    await dispatchCliCommand(c, resolveCommand("verify", "status")!, { operationId: id(16) }, context);
    expect(c.getVerificationOperation).toHaveBeenCalledWith(id(16), context);
    expect(c.getOperation).not.toHaveBeenCalled();
    await expect(
      dispatchCliCommand(c, resolveCommand("verify", "status")!, { operationId: "latest" }, context),
    ).rejects.toThrow();
    await expect(
      dispatchCliCommand(c, resolveCommand("verify", "status")!, { operationId: id(16), state: "succeeded" }, context),
    ).rejects.toThrow("CLI_OPERATION_READ_UNKNOWN_FIELD");
    expect(c.getVerificationOperation).toHaveBeenCalledTimes(1);
  });
  it("rejects deferred commands before admission", async () => {
    const c = client();
    await expect(dispatchCliCommand(c, resolveCommand("space", "rebuild")!, {}, context)).rejects.toThrow(
      "CAPABILITY_NOT_ADMITTED",
    );
    expect(c.submitOperation).not.toHaveBeenCalled();
  });
  it("rejects fabricated ids", async () => {
    const c = client();
    await expect(
      dispatchCliCommand(c, resolveCommand("store", "show")!, { vectorStoreId: "latest" }, context),
    ).rejects.toThrow();
    expect(c.getVectorStore).not.toHaveBeenCalled();
  });
  it("routes admitted mutations", async () => {
    const c = client();
    await dispatchCliCommand(c, resolveCommand("embed", "run")!, { model: "x" }, context);
    expect(c.submitOperation).toHaveBeenCalledWith("embedding_run", { model: "x" }, context);
  });
  it("uses the typed vector-store documents endpoint", async () => {
    const c = client(),
      input = {
        schemaVersion: "knowledge.vector-store-documents/v1",
        vectorStoreId: id(6),
        documents: [
          {
            documentId: id(7),
            documentVersionId: id(8),
            representationId: id(9),
            requestedProfile: { profile: "canonical" },
          },
        ],
      };
    await dispatchCliCommand(c, resolveCommand("store", "add-documents")!, input, context);
    expect(c.attachVectorStoreDocuments).toHaveBeenCalledWith(id(6), input, context);
    expect(c.submitOperation).not.toHaveBeenCalled();
  });
  it("routes extraction verification through the strict verification client method", async () => {
    const c = client(),
      input = {
        verificationContractVersion: "verification.v1",
        captureIds: ["capture-1"],
        extractionSchema: {
          artifactId: id(10),
          digest: `sha256:${"1".repeat(64)}`,
        },
        extractionOutput: {
          artifactId: id(11),
          digest: `sha256:${"2".repeat(64)}`,
        },
      };
    await dispatchCliCommand(c, resolveCommand("verify", "extract")!, input, context);
    expect(c.verifyExtraction).toHaveBeenCalledWith(input, context);
    expect(c.submitOperation).not.toHaveBeenCalled();
  });
  it("routes parseArtifact through the strict client method", async () => {
    const c = client(),
      input = {
        verificationContractVersion: "verification.v1",
        captureId: id(10),
        sourceArtifact: {
          artifactId: id(11),
          tenantId: id(1),
          digest: `sha256:${"1".repeat(64)}`,
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
    await dispatchCliCommand(c, resolveCommand("artifact", "parse")!, input, context);
    expect(c.parseArtifact).toHaveBeenCalledWith(input, context);
  });
  it("does not route the retired claims, report, metric, audit or adjudication commands (SV-17)", () => {
    for (const [group, action] of [
      ["verify", "citations"],
      ["verify", "report"],
      ["verify", "metric"],
      ["verify", "claims-result"],
      ["verify", "run"],
      ["bundle", "inspect"],
      ["bundle", "show"],
      ["adjudication", "request"],
    ] as const)
      expect(resolveCommand(group, action), `${group} ${action}`).toBeUndefined();
    expect(resolveCommand("bundle", "replay")).toBeDefined();
  });
});
