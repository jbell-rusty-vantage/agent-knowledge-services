import { type Digest, IdSchema, OriginSchema, digestCanonical, refOf } from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { type Qualifiers, QualifiersSchema } from "../profiles/index.js";
import { DecimalSchema, IntervalSchema, LongTextSchema, ShortTextSchema, identityShape } from "./common.js";

export const ASSERTION_SCHEMA_VERSION = "research-core.assertion.v2" as const;

export const ASSERTION_KINDS = ["source_report", "world_fact", "derivation", "recommendation", "forecast"] as const;
export const AssertionKindSchema = z.enum(ASSERTION_KINDS);
export type AssertionKind = z.infer<typeof AssertionKindSchema>;

/** Recommendations and forecasts expose premises; neither receives an ordinary fact-entailed verdict. */
export const NON_ENTAILED_KINDS: ReadonlySet<AssertionKind> = new Set(["recommendation", "forecast"]);

export const AssertionValueSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("quantity"), amount: DecimalSchema, unit: ShortTextSchema }),
  z.strictObject({ type: z.literal("categorical"), value: ShortTextSchema }),
  z.strictObject({ type: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({ type: z.literal("text"), value: LongTextSchema }),
]);
export type AssertionValue = z.infer<typeof AssertionValueSchema>;

/**
 * The typed basis of a recommendation or forecast (Sprint OC WI-03, OC-D112): its rationale, explicit assumptions,
 * stated uncertainty and (for a forecast) the time horizon it speaks about. The premises are the assertion's own
 * `premises`. A judgment basis makes the assertion eligible for a use-specific judgment policy with independent
 * assessment and required review; it never makes the assertion fact-entailed.
 */
export const JudgmentBasisSchema = z.strictObject({
  rationale: LongTextSchema,
  assumptions: z.array(ShortTextSchema).min(1).max(32),
  uncertainty: z.strictObject({
    level: z.enum(["low", "medium", "high", "unknown"]),
    statement: ShortTextSchema,
  }),
  horizon: IntervalSchema.nullable(),
});
export type JudgmentBasis = z.infer<typeof JudgmentBasisSchema>;

/** `AssertionVersion` (design §3). `qualifiers` is the strict profile union, never an open record. */
export const AssertionVersionSchema = z
  .strictObject({
    ...identityShape(ASSERTION_SCHEMA_VERSION),
    logicalId: IdSchema,
    proposition: LongTextSchema,
    kind: AssertionKindSchema,
    value: AssertionValueSchema,
    subject: ShortTextSchema.nullable(),
    object: ShortTextSchema.nullable(),
    qualifiers: QualifiersSchema,
    riskReasons: z.array(ShortTextSchema),
    producer: OriginSchema,
    premises: z.array(refOf("assertion")),
    /** Recommendations and forecasts only: the typed judgment basis (absent = no judgment policy can admit it). */
    judgment: JudgmentBasisSchema.optional(),
  })
  .superRefine((assertion, context) => {
    if (assertion.kind === "derivation" && assertion.premises.length === 0) {
      context.addIssue({ code: "custom", path: ["premises"], message: "a derivation names its premises" });
    }
    if (assertion.judgment !== undefined) {
      if (!NON_ENTAILED_KINDS.has(assertion.kind)) {
        context.addIssue({
          code: "custom",
          path: ["judgment"],
          message: "only a recommendation or forecast has a judgment basis",
        });
      } else if (assertion.premises.length === 0) {
        context.addIssue({ code: "custom", path: ["premises"], message: "a judgment names its typed premises" });
      }
      if (assertion.kind === "forecast" && assertion.judgment.horizon === null) {
        context.addIssue({
          code: "custom",
          path: ["judgment", "horizon"],
          message: "a forecast states its time horizon",
        });
      }
    }
    if (assertion.premises.some((premise) => premise.id === assertion.id)) {
      context.addIssue({ code: "custom", path: ["premises"], message: "an assertion cannot be its own premise" });
    }
  });
export type AssertionVersion = z.infer<typeof AssertionVersionSchema>;

/** The digest a support set or observation binds; any qualifier change produces a different claim. */
export function qualifiersDigest(qualifiers: Qualifiers): Digest {
  return digestCanonical(qualifiers);
}
