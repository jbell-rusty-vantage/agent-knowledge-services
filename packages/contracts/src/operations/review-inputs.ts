import { z } from "zod";
import { JsonValueSchema } from "../primitives.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Input of the `promotion_decision` operation: a reviewer's decision on one promotion proposal. */
export const PromotionDecisionInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.promotion-decision/v1"),
  proposalId: z.uuid(),
  reviewSubjectId: z.uuid(),
  guardedDigest: digestSchema,
  decision: z.enum(["accept", "reject", "defer", "request_changes"]),
  gates: JsonValueSchema,
  policyVersion: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  expiresAt: z.iso.datetime().optional(),
});

/** Input of the `review_decision` operation: a reviewer's decision on any existing review subject. */
export const ReviewDecisionInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.review-decision/v1"),
  reviewSubjectId: z.uuid(),
  guardedDigest: digestSchema,
  decision: z.enum(["approve", "reject", "defer", "request_changes"]),
  rationale: z.string().trim().min(1).max(8_000),
});
