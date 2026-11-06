import { describe, expect, it, vi } from "vitest";
import { operationFailureSummary, PostgresKnowledgeOperationService } from "./operation-service.js";
import type { PostgresCanonicalRepository } from "./postgres.js";
import type { CreateCanonicalOperation } from "./types.js";
import { sha256Digest } from "@aiengineer/knowledge-core";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const envelope = {
  context: {
    tenantId: id(1),
    operationId: id(2),
    attemptId: id(3),
    correlationId: "capability-admission-test",
    actor: { kind: "service" as const, id: id(4), serviceIdentity: "knowledge_worker" as const },
    capabilityVersion: "knowledge-operation/v1",
    idempotencyKey: "capability-admission-test-001",
    reason: "prove unsupported work is rejected before persistence",
    contractVersion: "v1" as const,
  },
  input: { schemaVersion: "test/v1" },
  expectedVersions: { api: "v1" },
};

describe("PostgresKnowledgeOperationService capability admission", () => {
  it("projects only canonical failure receipts through exact category classification", () => {
    const receipt = (idValue: number, errorClass: string, retryable = false) => ({
      id: id(idValue),
      receiptKind: "failure",
      outcome: "failed",
      body: { errorClass, retryable, attemptsExhausted: !retryable, fencingToken: 1 },
    });
    expect(operationFailureSummary([receipt(40, "PROVIDER_HTTP_FAILURE")], "failed")).toMatchObject({
      receiptId: id(40),
      category: "provider_upstream_failure",
      errorClass: "PROVIDER_HTTP_FAILURE",
      retryable: false,
      qualityFailure: false,
    });
    expect(operationFailureSummary([receipt(42, "POLICY_OVERRIDE_FAIL_CLOSED")], "failed")).toMatchObject({
      category: "policy_rejection",
      qualityFailure: false,
    });
    expect(operationFailureSummary([receipt(43, "ACTIVITY_REGISTRY_REQUIRED")], "failed")).toMatchObject({
      category: "harness_failure",
      qualityFailure: false,
    });
    expect(operationFailureSummary([receipt(43, "PROVIDER_DEADLINE_EXCEEDED")], "failed")).toMatchObject({
      category: "provider_timeout",
    });
    expect(operationFailureSummary([receipt(43, "PROVIDER_ARTIFACT_PERSISTENCE_FAILURE")], "failed")).toMatchObject({
      category: "artifact_registration_failure",
    });
    expect(operationFailureSummary([receipt(43, "PROVIDER_HTTP_FAILURE")], "succeeded")).toBeUndefined();
    expect(
      operationFailureSummary([{ ...receipt(44, "PROVIDER_HTTP_FAILURE"), receiptKind: "not-a-failure" }], "failed"),
    ).toBeUndefined();
    expect(
      operationFailureSummary([{ ...receipt(45, "PROVIDER_HTTP_FAILURE"), body: { retryable: false } }], "failed"),
    ).toBeUndefined();
    expect(operationFailureSummary([receipt(46, "private error message")], "failed")).toBeUndefined();
  });
  it("binds verification ownership to both the operation columns and idempotency digest", async () => {
    const createOperation = vi.fn(async (input: CreateCanonicalOperation) => ({ id: input.id }));
    const service = new PostgresKnowledgeOperationService(
      { createOperation } as unknown as PostgresCanonicalRepository,
      { admittedOperationKinds: ["verification_extraction"] },
    );
    const context = {
      ...envelope.context,
      missionId: id(30),
      workItemId: id(31),
      externalExecution: { runtime: "mission_control" as const, runId: "mission-run-001" },
    };
    await service.submit("verification_extraction", { ...envelope, context }, "https://knowledge.example");
    const first = createOperation.mock.calls[0]![0];
    expect(first).toMatchObject({
      attemptId: context.attemptId,
      missionId: context.missionId,
      workItemId: context.workItemId,
      ownershipMode: "mission_control",
      externalRunId: "mission-run-001",
      request: { authenticatedContext: context },
    });
    for (const changed of [
      { ...context, attemptId: id(32) },
      { ...context, actor: { ...context.actor, id: id(33) } },
      { ...context, missionId: id(34) },
      { ...context, capabilityVersion: "other-deployment/v1" },
    ]) {
      await service.submit("verification_extraction", { ...envelope, context: changed }, "https://knowledge.example");
      const latest = createOperation.mock.calls.at(-1)![0];
      expect(sha256Digest(latest.request as never)).not.toBe(sha256Digest(first.request as never));
    }
  });
  it("rejects an unsupported contract kind before any database write", async () => {
    const createOperation = vi.fn();
    const service = new PostgresKnowledgeOperationService({
      createOperation,
    } as unknown as PostgresCanonicalRepository);
    await expect(service.submit("capture_comparison", envelope, "https://knowledge.example")).rejects.toMatchObject({
      code: "CAPABILITY_NOT_ADMITTED",
      operationKind: "capture_comparison",
    });
    expect(createOperation).not.toHaveBeenCalled();
  });

  it("requires explicit endpoint ownership before admitting canonical retrieval", async () => {
    const createOperation = vi.fn(async (input: { id: string }) => ({ id: input.id }));
    const defaultService = new PostgresKnowledgeOperationService({
      createOperation,
    } as unknown as PostgresCanonicalRepository);
    await expect(defaultService.submit("retrieval_run", envelope, "https://knowledge.example")).rejects.toMatchObject({
      code: "CAPABILITY_NOT_ADMITTED",
    });

    const retrievalService = new PostgresKnowledgeOperationService(
      { createOperation } as unknown as PostgresCanonicalRepository,
      { admittedOperationKinds: ["retrieval_run"] },
    );
    await expect(
      retrievalService.submit("retrieval_run", envelope, "https://knowledge.example"),
    ).resolves.toMatchObject({ operationId: envelope.context.operationId, state: "queued" });
    expect(createOperation).toHaveBeenCalledOnce();
    expect(createOperation.mock.calls[0]?.[0]).toMatchObject({
      operationKind: "retrieval_run",
      steps: [{ key: "retrieve" }, { key: "packet" }],
    });
  });

  it("persists bounded verification work only through an explicitly admitted service", async () => {
    const createOperation = vi.fn(async (input: { id: string }) => ({ id: input.id })),
      service = new PostgresKnowledgeOperationService({ createOperation } as unknown as PostgresCanonicalRepository, {
        admittedOperationKinds: ["verification_capture", "verification_extraction", "verification_replay"],
      });
    const input = {
      ...envelope,
      context: {
        ...envelope.context,
        operationId: id(20),
        attemptId: id(21),
        idempotencyKey: "verification-durable-001",
      },
      input: {
        schemaVersion: "verification-service-request.v1",
        useCase: "verifyExtraction",
        request: {
          verificationContractVersion: "verification.v1",
          captureIds: ["capture-1"],
          extractionSchema: { artifactId: id(22), digest: `sha256:${"1".repeat(64)}` },
          extractionOutput: { artifactId: id(23), digest: `sha256:${"2".repeat(64)}` },
        },
      },
      expectedVersions: { verification: "verification.v1", service: "verification-service-request.v1" },
    };
    await expect(service.submit("verification_extraction", input, "https://knowledge.example")).resolves.toMatchObject({
      operationId: id(20),
    });
    expect(createOperation.mock.calls[0]?.[0]).toMatchObject({
      operationKind: "verification_extraction",
      steps: [{ key: "verify_and_register", kind: "verify_and_register" }],
    });
    const defaultService = new PostgresKnowledgeOperationService({
      createOperation: vi.fn(),
    } as unknown as PostgresCanonicalRepository);
    await expect(
      defaultService.submit("verification_extraction", input, "https://knowledge.example"),
    ).rejects.toMatchObject({ code: "CAPABILITY_NOT_ADMITTED" });
  });
});
