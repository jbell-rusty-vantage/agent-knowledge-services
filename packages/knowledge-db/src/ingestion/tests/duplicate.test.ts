import { describe, expect, it } from "vitest";
import { awaitWinnerReceipt, isIdempotencyKeyCollision, type DuplicateWaitPolicy } from "../duplicate.js";

/** A policy whose clock advances only when the poller sleeps, so tests never wait. */
function fakeClockPolicy(timeoutMs: number, backoffMs: number): DuplicateWaitPolicy & { readonly sleeps: number[] } {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    timeoutMs,
    backoffMs,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    sleeps,
  };
}

const identity = { intentId: "openai-products-2026-09-11", idempotencyKey: "sha256:abc" };

describe("isIdempotencyKeyCollision", () => {
  it("recognises 23505 on operation_intent.idempotency_key", () => {
    expect(isIdempotencyKeyCollision({ code: "23505", constraint: "operation_intent_idempotency_key_key" })).toBe(true);
  });

  it("ignores other unique violations, other SQLSTATEs, and non-object errors", () => {
    expect(
      isIdempotencyKeyCollision({ code: "23505", constraint: "knowledge_batch_tenant_id_idempotency_key_key" }),
    ).toBe(false);
    expect(isIdempotencyKeyCollision({ code: "23503", constraint: "operation_intent_idempotency_key_key" })).toBe(
      false,
    );
    expect(isIdempotencyKeyCollision("23505")).toBe(false);
    expect(isIdempotencyKeyCollision(null)).toBe(false);
  });
});

describe("awaitWinnerReceipt", () => {
  it("returns the winner's receipt as soon as the lookup yields it", async () => {
    const policy = fakeClockPolicy(30_000, 250);
    const answers: (string | undefined)[] = [undefined, undefined, "receipt-1"];
    const receipt = await awaitWinnerReceipt(async () => answers.shift(), identity, policy);
    expect(receipt).toBe("receipt-1");
    expect(policy.sleeps).toEqual([250, 250]);
  });

  it("fails DUPLICATE_PENDING naming the intent once the timeout elapses without a receipt", async () => {
    const policy = fakeClockPolicy(1_000, 400);
    let lookups = 0;
    const pending = awaitWinnerReceipt(
      async () => {
        lookups += 1;
        return undefined;
      },
      identity,
      policy,
    );
    await expect(pending).rejects.toMatchObject({
      code: "DUPLICATE_PENDING",
      exit: 1,
      message: expect.stringContaining(identity.intentId),
      details: { ...identity, attempts: 4 },
    });
    expect(policy.sleeps).toEqual([400, 400, 200]);
    expect(lookups).toBe(4);
  });
});
