import { describe, expect, it } from "vitest";
import { protocolError } from "./errors.js";
import { OPERATION_STATES, OperationStatusSchema, canTransition, isTerminal, transitionStatus } from "./handle.js";
import type { OperationStatus } from "./handle.js";

const queued: OperationStatus = {
  handle: {
    protocolVersion: "ks.knowledge_operation.v2",
    tenant: "t",
    application: "ai-engineer",
    binding: "aiengineer-postgres",
    operationId: "op-1",
  },
  state: "queued",
  revision: 1,
  createdAt: "2026-10-24T20:00:00Z",
  updatedAt: "2026-10-24T20:00:00Z",
  progressRef: null,
  pendingReviewRef: null,
  resultRef: null,
  error: null,
  unresolvedEffects: [],
  retryAfterMs: 1000,
  cancelRequestId: null,
};

describe("operation status (design §4)", () => {
  it("terminal states are closed; non-terminal states carry a retry hint", () => {
    for (const state of OPERATION_STATES) {
      for (const next of OPERATION_STATES) {
        if (isTerminal(state)) expect(canTransition(state, next)).toBe(false);
      }
    }
    expect(OperationStatusSchema.safeParse({ ...queued, state: "succeeded" }).success).toBe(false);
    expect(OperationStatusSchema.safeParse({ ...queued, retryAfterMs: null }).success).toBe(false);
  });

  it("transitions bump the revision and keep the handle; illegal edges throw", () => {
    const running = transitionStatus(queued, { state: "running", updatedAt: "2026-10-24T20:00:01Z" });
    expect(running.revision).toBe(2);
    expect(running.handle).toEqual(queued.handle);
    const held = transitionStatus(running, { state: "held", updatedAt: "2026-10-24T20:00:02Z" });
    expect(held.retryAfterMs).toBeNull();
    expect(() => transitionStatus(held, { state: "running", updatedAt: "2026-10-24T20:00:03Z" })).toThrow(
      /ILLEGAL_TRANSITION/,
    );
    expect(() => transitionStatus(queued, { state: "succeeded", updatedAt: "x" })).toThrow(/ILLEGAL_TRANSITION/);
  });

  it("failed needs a typed error; cancellation names its request; a cancelled run may keep unresolved effects", () => {
    const running = transitionStatus(queued, { state: "running", updatedAt: "2026-10-24T20:00:01Z" });
    expect(() => transitionStatus(running, { state: "failed", updatedAt: "2026-10-24T20:00:02Z" })).toThrow();
    const failed = transitionStatus(running, {
      state: "failed",
      updatedAt: "2026-10-24T20:00:02Z",
      error: protocolError({ code: "INTERNAL", message: "boom", occurredAt: "2026-10-24T20:00:02Z" }),
    });
    expect(failed.error?.retryable).toBe(true);
    expect(() => transitionStatus(running, { state: "cancelling", updatedAt: "2026-10-24T20:00:02Z" })).toThrow();
    const cancelling = transitionStatus(running, {
      state: "cancelling",
      updatedAt: "2026-10-24T20:00:02Z",
      cancelRequestId: "cancel-1",
    });
    const cancelled = transitionStatus(cancelling, {
      state: "cancelled",
      updatedAt: "2026-10-24T20:00:03Z",
      unresolvedEffects: [
        {
          effectKey: "effect-1",
          boundEffectDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000002",
          dispatchId: "dispatch-1",
          reconciliation: "pending",
          lastCheckedAt: null,
        },
      ],
    });
    expect(cancelled.unresolvedEffects).toHaveLength(1);
  });

  it("protocol errors carry their fixed classification", () => {
    const held = protocolError({
      code: "REVIEW_REQUIRED",
      message: "reviewer sign-off",
      occurredAt: "2026-10-24T20:00:02Z",
    });
    expect(held).toMatchObject({ retryable: false, domainOutcome: true });
    expect(() =>
      transitionStatus(queued, {
        state: "failed",
        updatedAt: "2026-10-24T20:00:02Z",
        error: { ...held, retryable: true },
      }),
    ).toThrow();
  });
});
