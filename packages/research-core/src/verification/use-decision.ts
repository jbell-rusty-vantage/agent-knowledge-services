import type { Digest } from "@aiengineer/knowledge-operation-protocol";
import { compareInstants } from "../records/common.js";
import type { UseDecision } from "../records/decision.js";
import { normalizedValuesDigest } from "../ports/oracle.js";

/** The only decision condition a qualified reviewer can satisfy; approval never waives mechanics (design §9). */
export const REVIEW_CONDITION = "review_required" as const;

export type AdmissionHoldReason =
  | "decision_held"
  | "authority_unavailable"
  | "stale_epoch"
  | "decision_epoch_ahead_of_authority"
  | "invalidation_closure_incomplete"
  | "review_required"
  | "expired";

export type AdmissionRejectReason =
  | "decision_rejected"
  | "scope_mismatch"
  | "use_mismatch"
  | "audience_mismatch"
  | "effect_digest_mismatch"
  | "normalized_values_mismatch"
  /** Checkpoint A decision: an invalidated decision is rejected; re-admission needs a successor decision. */
  | "invalidated";

export type Admissibility =
  | { readonly status: "admitted" }
  | { readonly status: "held"; readonly reason: AdmissionHoldReason }
  | { readonly status: "rejected"; readonly reason: AdmissionRejectReason };

/** The adjudication a decision with `review_required` names, as the authority reads it at admission time. */
export interface ReviewBinding {
  readonly adjudicationId: string;
  readonly outcome: "approve" | "hold" | "reject";
  readonly boundEffectDigest: string | null;
  readonly qualifiersDigest: string | null;
  /** The reviewer's grant is still live (not revoked, in scope) at admission time. */
  readonly grantLive: boolean;
}

export interface AdmissionContext {
  readonly tenant: string;
  readonly use: string;
  readonly audience: string;
  /** Authoritative per-scope revocation high-water mark; `null` when the authority cannot be reached. */
  readonly authoritativeEpoch: number | null;
  /** Invalidation epoch this reader has fully processed. */
  readonly processedEpoch: number;
  /** Whether the affected invalidation closure up to `processedEpoch` has been rechecked. */
  readonly closureComplete: boolean;
  /** Decision ids named by processed invalidation closures (see `invalidate`). */
  readonly invalidated: ReadonlySet<string>;
  readonly now: string;
  /** The exact bound effect digest about to be applied. */
  readonly boundEffectDigest: Digest;
  /** Digest of the normalized domain values about to be written (`normalizedValuesDigest`). */
  readonly normalizedValuesDigest: Digest;
  /** The adjudication the decision names, when it names one. */
  readonly review?: ReviewBinding | null;
}

/**
 * Exact-use admission check (design §7). Order matters: exact-binding failures reject; anything that might change once
 * authority, invalidation or review catches up holds. Admission requires `processedEpoch >= authoritativeEpoch` and a
 * completed affected closure; authority unavailable holds. Effect and normalized-value digests must match exactly.
 * The component's `admit_exact_use` applies the same rules under its epoch lock; this is the pure statement of them.
 */
export function admissible(decision: UseDecision, context: AdmissionContext): Admissibility {
  if (decision.disposition === "rejected") return { status: "rejected", reason: "decision_rejected" };
  if (decision.tenant !== context.tenant) return { status: "rejected", reason: "scope_mismatch" };
  if (decision.use !== context.use) return { status: "rejected", reason: "use_mismatch" };
  if (decision.audience !== context.audience) return { status: "rejected", reason: "audience_mismatch" };
  if (decision.boundEffectDigest !== context.boundEffectDigest) {
    return { status: "rejected", reason: "effect_digest_mismatch" };
  }
  if (normalizedValuesDigest(decision.normalizedValues) !== context.normalizedValuesDigest) {
    return { status: "rejected", reason: "normalized_values_mismatch" };
  }
  if (decision.disposition === "held") return { status: "held", reason: "decision_held" };
  if (context.authoritativeEpoch === null) return { status: "held", reason: "authority_unavailable" };
  if (context.processedEpoch < context.authoritativeEpoch) return { status: "held", reason: "stale_epoch" };
  if (decision.revocationEpoch > context.authoritativeEpoch) {
    return { status: "held", reason: "decision_epoch_ahead_of_authority" };
  }
  if (!context.closureComplete) return { status: "held", reason: "invalidation_closure_incomplete" };
  if (context.invalidated.has(decision.id)) return { status: "rejected", reason: "invalidated" };
  if (decision.expiresAt !== null && compareInstants(context.now, decision.expiresAt) >= 0) {
    return { status: "held", reason: "expired" };
  }
  if (decision.conditions.includes(REVIEW_CONDITION)) {
    const review = context.review ?? null;
    if (
      decision.reviewer === null ||
      review === null ||
      review.adjudicationId !== decision.reviewer.id ||
      review.outcome !== "approve" ||
      review.boundEffectDigest !== decision.boundEffectDigest ||
      review.qualifiersDigest !== decision.qualifiersDigest ||
      !review.grantLive
    ) {
      return { status: "held", reason: "review_required" };
    }
  }
  return { status: "admitted" };
}
