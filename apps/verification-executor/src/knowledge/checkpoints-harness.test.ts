import { describe, expect, it } from "vitest";
import { KnowledgeCheckpointHarnessRequestSchema } from "./checkpoints-harness.js";

const digest = `sha256:${"a".repeat(64)}`;
const base = {
  action: "observe" as const,
  session: { sessionId: "session", sandboxId: "sandbox" },
  scopeContext: {
    tenantId: "11111111-1111-4111-8111-111111111111",
    runId: "run",
    producerAttemptId: "attempt",
    namespace: "notes",
  },
  profilePins: {
    storageProfileVersion: "storage",
    storageProfileDigest: digest,
    retentionPolicyVersion: "retention",
    retentionPolicyDigest: digest,
    capabilityProfileVersion: "capability",
    capabilityProfileDigest: digest,
  },
};

describe("checkpoint harness request boundary", () => {
  it("defaults initial restore files and accepts Eve's batched requested-action event", () => {
    expect(KnowledgeCheckpointHarnessRequestSchema.parse({ ...base, action: "restore" }).files).toEqual([]);
    expect(
      KnowledgeCheckpointHarnessRequestSchema.safeParse({
        ...base,
        event: {
          eventId: "event",
          eventType: "actions.requested",
          data: { actions: [{ callId: "call", toolName: "source_discover", input: {} }] },
        },
      }).success,
    ).toBe(true);
  });

  it("keeps file payload validation separate from event normalization", () => {
    expect(KnowledgeCheckpointHarnessRequestSchema.safeParse({ ...base, files: [] }).success).toBe(true);
  });

  it("accepts Eve partial and nested final action envelopes", () => {
    expect(
      KnowledgeCheckpointHarnessRequestSchema.safeParse({
        ...base,
        event: { eventId: "partial", eventType: "action.partial", data: { result: { callId: "one" } } },
      }).success,
    ).toBe(true);
    expect(
      KnowledgeCheckpointHarnessRequestSchema.safeParse({
        ...base,
        event: { eventId: "final", eventType: "action.result", data: { result: { callId: "one" } } },
      }).success,
    ).toBe(true);
  });
});
