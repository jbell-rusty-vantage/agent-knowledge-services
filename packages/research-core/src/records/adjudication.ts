import {
  DigestSchema,
  IdSchema,
  InstantSchema,
  NameSchema,
  refOf,
  refOfAny,
} from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { LongTextSchema, identityShape } from "./common.js";

export const ADJUDICATION_SCHEMA_VERSION = "research-core.adjudication.v1" as const;

/** "*" is an explicit wildcard; an empty list qualifies for nothing (design §7 "qualified reviewer grants"). */
export const ReviewerScopeSchema = z.strictObject({
  uses: z.array(z.union([NameSchema, z.literal("*")])),
  audiences: z.array(z.union([NameSchema, z.literal("*")])),
  reportKinds: z.array(z.union([z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), z.literal("*")])),
});
export type ReviewerScope = z.infer<typeof ReviewerScopeSchema>;

export function scopeCovers(
  scope: ReviewerScope,
  input: { use: string; audience: string; reportKind: string },
): boolean {
  const has = (values: readonly string[], value: string) => values.includes("*") || values.includes(value);
  return has(scope.uses, input.use) && has(scope.audiences, input.audience) && has(scope.reportKinds, input.reportKind);
}

/**
 * A qualified human reviewer's decision over exact bindings (design §7): the use decision reviewed, its subject, the
 * exact bound effect digest and qualifiers digest. Approval satisfies only the `review_required` condition; it never
 * waives mechanics (design §9). Append-only; a later adjudication supersedes by reference.
 */
export const AdjudicationSchema = z.strictObject({
  ...identityShape(ADJUDICATION_SCHEMA_VERSION),
  decision: refOf("use_decision"),
  subject: refOfAny(["assertion", "report"]),
  boundEffectDigest: DigestSchema,
  qualifiersDigest: DigestSchema.nullable(),
  reviewerId: IdSchema,
  outcome: z.enum(["approve", "hold", "reject"]),
  rationale: LongTextSchema,
  decidedAt: InstantSchema,
});
export type Adjudication = z.infer<typeof AdjudicationSchema>;
