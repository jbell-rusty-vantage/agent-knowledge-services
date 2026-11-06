import { z } from "zod";
import { ProtocolErrorSchema } from "./errors.js";
import {
  DigestSchema,
  IdSchema,
  InstantSchema,
  NameSchema,
  ProtocolVersionSchema,
  RefSchema,
  SafeIntSchema,
  ScopeIdSchema,
  refOf,
} from "./primitives.js";

/** `OperationHandle` binds tenant, application, binding, operation id and protocol version (design §4). */
export const OperationHandleSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  tenant: ScopeIdSchema,
  application: NameSchema,
  binding: NameSchema,
  operationId: IdSchema,
});
export type OperationHandle = z.infer<typeof OperationHandleSchema>;

export const OPERATION_STATES = [
  "queued",
  "running",
  "waiting_review",
  "cancelling",
  "succeeded",
  "partial",
  "held",
  "rejected",
  "failed",
  "cancelled",
] as const;
export const OperationStateSchema = z.enum(OPERATION_STATES);
export type OperationState = z.infer<typeof OperationStateSchema>;

export const TERMINAL_STATES: ReadonlySet<OperationState> = new Set([
  "succeeded",
  "partial",
  "held",
  "rejected",
  "failed",
  "cancelled",
]);

/** Domain held/rejected are not infrastructure failures; `failed` is. */
export const DOMAIN_TERMINAL_STATES: ReadonlySet<OperationState> = new Set([
  "succeeded",
  "partial",
  "held",
  "rejected",
]);

const TRANSITIONS: Record<OperationState, readonly OperationState[]> = {
  queued: ["running", "cancelling", "cancelled", "failed", "rejected"],
  running: ["waiting_review", "cancelling", "succeeded", "partial", "held", "rejected", "failed"],
  waiting_review: ["running", "cancelling", "held", "rejected", "succeeded", "partial", "failed"],
  cancelling: ["cancelled", "succeeded", "partial", "held", "rejected", "failed"],
  succeeded: [],
  partial: [],
  held: [],
  rejected: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: OperationState, to: OperationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: OperationState): boolean {
  return TERMINAL_STATES.has(state);
}

/** An effect whose outcome is not yet known; blocks mission settlement until reconciled (design §4). */
export const UnresolvedEffectSchema = z.strictObject({
  effectKey: IdSchema,
  boundEffectDigest: DigestSchema,
  dispatchId: IdSchema,
  reconciliation: z.enum(["pending", "lookup_negative", "lookup_failed", "resolved"]),
  lastCheckedAt: InstantSchema.nullable(),
});
export type UnresolvedEffect = z.infer<typeof UnresolvedEffectSchema>;

/**
 * `OperationStatus`: monotonic revision, timestamps, progress/review/result/error references and unresolved effects.
 * A cancelled computation may still have unresolved effects; they keep separate reconciliation status.
 */
export const OperationStatusSchema = z
  .strictObject({
    handle: OperationHandleSchema,
    state: OperationStateSchema,
    revision: SafeIntSchema.min(1),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    progressRef: refOf("artifact").nullable(),
    pendingReviewRef: refOf("adjudication").nullable(),
    resultRef: RefSchema.nullable(),
    error: ProtocolErrorSchema.nullable(),
    unresolvedEffects: z.array(UnresolvedEffectSchema),
    /** Bounded polling hint; absent for terminal states. */
    retryAfterMs: z.int().min(100).max(300000).nullable(),
    /** Idempotent cancellation: the request id that first asked, if any. */
    cancelRequestId: IdSchema.nullable(),
  })
  .superRefine((status, context) => {
    const terminal = isTerminal(status.state);
    if (terminal && status.retryAfterMs !== null) {
      context.addIssue({ code: "custom", path: ["retryAfterMs"], message: "terminal status carries no retry hint" });
    }
    if (!terminal && status.retryAfterMs === null) {
      context.addIssue({ code: "custom", path: ["retryAfterMs"], message: "non-terminal status needs a retry hint" });
    }
    if (status.state === "failed" && status.error === null) {
      context.addIssue({ code: "custom", path: ["error"], message: "failed requires a typed error" });
    }
    if (status.state === "waiting_review" && status.pendingReviewRef === null) {
      context.addIssue({ code: "custom", path: ["pendingReviewRef"], message: "waiting_review names its review" });
    }
    if ((status.state === "cancelling" || status.state === "cancelled") && status.cancelRequestId === null) {
      context.addIssue({ code: "custom", path: ["cancelRequestId"], message: "cancellation names its request id" });
    }
  });
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

/** Apply a transition, bumping the revision; refuses illegal edges so a stale writer cannot regress a status. */
export function transitionStatus(
  status: OperationStatus,
  next: Pick<OperationStatus, "state" | "updatedAt"> & Partial<OperationStatus>,
): OperationStatus {
  if (!canTransition(status.state, next.state)) {
    throw new Error(`ILLEGAL_TRANSITION: ${status.state} -> ${next.state}`);
  }
  const terminal = isTerminal(next.state);
  return OperationStatusSchema.parse({
    ...status,
    ...next,
    handle: status.handle,
    revision: status.revision + 1,
    createdAt: status.createdAt,
    retryAfterMs: terminal ? null : (next.retryAfterMs ?? status.retryAfterMs ?? 1000),
  });
}
