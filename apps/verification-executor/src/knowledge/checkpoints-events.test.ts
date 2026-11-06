import { describe, expect, it } from "vitest";
import { checkpointRequestedOperations, checkpointTerminalOutcome } from "./checkpoints-events.js";

describe("native action lifecycle checkpoint mapping", () => {
  it("admits tool, child and remote calls without treating skill loading as external work", () => {
    expect(
      checkpointRequestedOperations({
        actions: [
          { kind: "tool-call", callId: "tool", toolName: "search", input: {} },
          {
            kind: "subagent-call",
            callId: "child",
            subagentName: "research-worker",
            nodeId: "node",
            name: "research",
            description: "Research",
            input: {},
          },
          {
            kind: "remote-agent-call",
            callId: "remote",
            remoteAgentName: "remote-worker",
            nodeId: "remote-node",
            input: {},
          },
          { kind: "load-skill", callId: "skill", input: { name: "research" } },
        ],
      }).map((operation) => operation.operationId),
    ).toEqual(["tool", "child", "remote"]);
  });
  it("preserves background child work but settles a finished turn of a parked reusable child", () => {
    const result = {
      kind: "subagent-result",
      origin: "child",
      callId: "child",
      subagentName: "research-worker",
      output: "partial work",
      outcome: { kind: "parked", result: { kind: "succeeded" } },
    };
    expect(
      checkpointTerminalOutcome({
        status: "completed",
        result: { ...result, backgroundTask: { status: "working", taskId: "task" } },
      }),
    ).toBeUndefined();
    expect(checkpointTerminalOutcome({ status: "completed", result })).toBe("succeeded");
    expect(
      checkpointTerminalOutcome({
        status: "completed",
        result: { ...result, outcome: { kind: "terminal", result: { kind: "cancelled" } } },
      }),
    ).toBe("cancelled");
  });
  it("does not mistake completed transport delivery for successful tool or child execution", () => {
    expect(
      checkpointTerminalOutcome({
        status: "completed",
        result: { kind: "tool-result", callId: "tool", output: { isError: true } },
      }),
    ).toBe("failed");
    expect(
      checkpointTerminalOutcome({
        status: "completed",
        result: { kind: "subagent-result", origin: "dispatch", callId: "child", isError: true },
      }),
    ).toBe("failed");
    expect(
      checkpointTerminalOutcome({ status: "completed", result: { kind: "unknown", callId: "unknown" } }),
    ).toBeUndefined();
  });
});
