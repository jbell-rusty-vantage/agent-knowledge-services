import { describe, expect, it, vi } from "vitest";
import { A2ACallbackHttpSender } from "../index.js";

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
  it("sends an authenticated result only to its admitted exact callback target", async () => {
    const result = {
      taskId: task.taskId,
      operationId: task.context.operationId,
      outcome: "succeeded" as const,
      artifacts: [],
      evidencePacketIds: [],
      receiptIds: [],
      warnings: [],
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toBe(task.callback.url);
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer callback-bearer");
      expect(headers.get("x-tenant-id")).toBe(task.context.tenantId);
      const envelope = JSON.parse(String(init?.body));
      expect(envelope).toMatchObject({
        tenantId: task.context.tenantId,
        taskId: task.taskId,
        correlationId: task.context.correlationId,
        causationId: task.context.causationId,
        payload: result,
      });
      return new Response(
        JSON.stringify({
          callbackId: envelope.callbackId,
          operationId: task.context.operationId,
          state: "accepted",
          receivedAt: "2026-09-03T12:00:00Z",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    });
    const sender = new A2ACallbackHttpSender(
      () => ({
        ...task.callback,
        bearerToken: "callback-bearer",
        signingSecret: secret,
      }),
      fetch,
    );
    await expect(sender.sendResult(task, result)).resolves.toMatchObject({
      operationId: task.context.operationId,
      state: "accepted",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects target substitution and result correlation mismatch before network I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = {
      taskId: task.taskId,
      operationId: task.context.operationId,
      outcome: "failed" as const,
      artifacts: [],
      evidencePacketIds: [],
      receiptIds: [],
      warnings: ["failed"],
    };
    const sender = new A2ACallbackHttpSender(
      () => ({
        ...task.callback,
        url: "https://attacker.example/callback",
        bearerToken: "callback-bearer",
        signingSecret: secret,
      }),
      fetch,
    );
    await expect(sender.sendResult(task, result)).rejects.toThrow("CALLBACK_TARGET_CONTRACT_MISMATCH");
    await expect(sender.sendResult(task, { ...result, operationId: id(99) })).rejects.toThrow(
      "CALLBACK_RESULT_CONTEXT_MISMATCH",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
