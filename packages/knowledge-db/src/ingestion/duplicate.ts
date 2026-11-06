import { domainError } from "../schema-workspace/index.js";

/**
 * Parallel submissions of the same intent bytes race on the unique
 * `orchestration.operation_intent.idempotency_key`. The first transaction wins; every loser
 * sees SQLSTATE 23505 and must return the winner's receipt as `duplicateOf` (spec §6.3).
 */
const UNIQUE_VIOLATION = "23505";
const IDEMPOTENCY_KEY_CONSTRAINT = "operation_intent_idempotency_key_key";

export interface DuplicateWaitPolicy {
  readonly timeoutMs: number;
  readonly backoffMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export const DEFAULT_DUPLICATE_WAIT: DuplicateWaitPolicy = {
  timeoutMs: 30_000,
  backoffMs: 250,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

export interface DuplicateIdentity {
  readonly intentId: string;
  readonly idempotencyKey: string;
}

export function isIdempotencyKeyCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === IDEMPOTENCY_KEY_CONSTRAINT;
}

/** Polls `lookup` until the winner's receipt appears; `DUPLICATE_PENDING` once the policy's timeout elapses. */
export async function awaitWinnerReceipt<TReceipt>(
  lookup: () => Promise<TReceipt | undefined>,
  identity: DuplicateIdentity,
  policy: DuplicateWaitPolicy = DEFAULT_DUPLICATE_WAIT,
): Promise<TReceipt> {
  const deadline = policy.now() + policy.timeoutMs;
  for (let attempts = 1; ; attempts += 1) {
    const receipt = await lookup();
    if (receipt !== undefined) return receipt;
    const remainingMs = deadline - policy.now();
    if (remainingMs <= 0) {
      throw domainError(
        "DUPLICATE_PENDING",
        `intent ${identity.intentId} was submitted concurrently and the winning submission has no receipt after ${policy.timeoutMs} ms`,
        { ...identity, attempts },
      );
    }
    await policy.sleep(Math.min(policy.backoffMs, remainingMs));
  }
}
