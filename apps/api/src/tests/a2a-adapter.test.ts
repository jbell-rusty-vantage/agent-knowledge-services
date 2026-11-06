import { describe, expect, it } from "vitest";
import { A2ATaskSchema } from "@aiengineer/knowledge-contracts";
import { CallbackReplayGuard, KnowledgeIntegrationService, verifyCallback } from "@aiengineer/knowledge-application";
import { A2AKnowledgeAdapter, operationInputForA2ATask } from "../a2a-adapter.js";

const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
const secret = "callback-signing-secret-is-at-least-32-bytes";
const context = {
  tenantId: id(1),
  operationId: id(2),
  attemptId: id(3),
  workItemId: id(4),
  missionId: id(5),
  correlationId: "mission-correlation",
  causationId: "parent-eve-operation",
  actor: {
    kind: "service" as const,
    id: id(6),
    serviceIdentity: "mission_control_client" as const,
  },
  capabilityVersion: "a2a/1",
  idempotencyKey: "a2a-task-0001",
  reason: "prepare evidence",
  contractVersion: "v1" as const,
  externalExecution: {
    runtime: "eve" as const,
    runId: "nested-run",
    rootRunId: "root-run",
    sessionId: "session",
    turnId: "turn",
    toolCallId: "tool-call",
  },
};
const task = {
  taskId: id(7),
  kind: "retrieval" as const,
  contractVersion: "v1" as const,
  context,
  purpose: "retrieve exact evidence",
  capabilityVersions: { retrieval: "v1" },
  expectedOutputContract: "evidence-packet.v1",
  inputArtifactIds: [],
  operationInput: {
    plan: {
      policyVersion: id(8),
      query: "retrieve exact evidence",
      intents: ["knowledge_evidence"],
      subqueries: [{ id: "exact-evidence", text: "retrieve exact evidence", coverageRole: "required" }],
      spaces: ["engineering_claims"],
      anchors: { entities: [], concepts: [], useCases: [] },
      hardFilters: [],
      softBoosts: [],
      temporalScope: {},
      candidateK: 10,
      finalK: 5,
      graph: { maxDepth: 0, allowedEdges: [] },
      abstention: { minimumCoverage: 0.5 },
    },
  },
  callback: {
    url: "https://callback.example/a2a",
    authenticationReference: "secret://callback-auth",
    signingKeyReference: "secret://callback-signing",
  },
};

describe("A2A adapter", () => {
  it("requires real object input and reserves the callback binding field", () => {
    const parsed = A2ATaskSchema.parse(task);
    expect(() => operationInputForA2ATask({ ...parsed, operationInput: null })).toThrow(
      "A2A_OPERATION_INPUT_OBJECT_REQUIRED",
    );
    expect(() => operationInputForA2ATask({ ...parsed, operationInput: { a2a: {} } })).toThrow(
      "A2A_OPERATION_INPUT_RESERVED_FIELD",
    );
  });

  it("preserves nested Mission Control and Eve correlation in canonical admission", async () => {
    const service = new KnowledgeIntegrationService();
    const status = await new A2AKnowledgeAdapter(service, "https://knowledge.example").dispatch(task);
    expect(status.operationId).toBe(context.operationId);
    expect(service.get(status.operationId)?.context).toMatchObject({
      workItemId: context.workItemId,
      missionId: context.missionId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      externalExecution: context.externalExecution,
    });
    expect(service.input(status.operationId)).toMatchObject({
      plan: task.operationInput.plan,
      a2a: {
        taskId: task.taskId,
        callback: task.callback,
      },
    });
  });

  it("signs tenant-bound callbacks and rejects replay, tamper, stale, and future input", () => {
    const adapter = new A2AKnowledgeAdapter(new KnowledgeIntegrationService(), "https://knowledge.example");
    const callback = adapter.callback(task, { outcome: "succeeded" }, secret, "2026-09-03T12:00:00Z");
    const clock = { now: () => new Date("2026-09-03T12:01:00Z") };
    const guard = new CallbackReplayGuard();
    expect(callback).toMatchObject({
      tenantId: context.tenantId,
      correlationId: context.correlationId,
      causationId: context.causationId,
    });
    expect(verifyCallback(callback, secret, guard, clock)).toBe(true);
    expect(verifyCallback(callback, secret, guard, clock)).toBe(false);
    expect(
      verifyCallback({ ...callback, payload: { outcome: "failed" } }, secret, new CallbackReplayGuard(), clock),
    ).toBe(false);
    expect(verifyCallback({ ...callback, tenantId: id(99) }, secret, new CallbackReplayGuard(), clock)).toBe(false);
    expect(
      verifyCallback(callback, secret, new CallbackReplayGuard(), {
        now: () => new Date("2026-09-03T12:10:00Z"),
      }),
    ).toBe(false);
    expect(
      verifyCallback({ ...callback, occurredAt: "2026-09-03T12:02:00Z" }, secret, new CallbackReplayGuard(), clock),
    ).toBe(false);
  });
});
