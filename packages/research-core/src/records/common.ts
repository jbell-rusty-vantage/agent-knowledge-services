import {
  IdSchema,
  InstantSchema,
  NameSchema,
  type Ref,
  SafeIntSchema,
  ScopeIdSchema,
  UsdSchema,
  refOf,
} from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";

/** Offsets count UTF-16 code units (JavaScript string indices), compatible with the existing report contract. */
export const SPAN_BASIS = "utf16-code-units-v1" as const;

export const SpanSchema = z
  .strictObject({ basis: z.literal(SPAN_BASIS), start: SafeIntSchema, end: SafeIntSchema })
  .refine((value) => value.start < value.end, { path: ["end"], message: "a span is non-empty: start < end" });
export type Span = z.infer<typeof SpanSchema>;

export function span(start: number, end: number): Span {
  return SpanSchema.parse({ basis: SPAN_BASIS, start, end });
}

/**
 * Every record carries its own identity instead of a `ref` field: a record cannot contain the digest of its own bytes.
 * `recordRef(kind, record)` derives the K01 `Ref` from these fields plus the digest of the whole record.
 */
export function identityShape<V extends string>(schemaVersion: V) {
  return {
    schemaVersion: z.literal(schemaVersion),
    id: IdSchema,
    tenant: ScopeIdSchema,
    binding: NameSchema,
  };
}

export type RecordIdentity = {
  readonly schemaVersion: string;
  readonly id: string;
  readonly tenant: string;
  readonly binding: string;
};

/** Ids local to one structured body (section, block, citation label): no path separators. */
export const LocalIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const ShortTextSchema = z.string().min(1).max(500);
export const LongTextSchema = z.string().min(1).max(4000);
/** Decimal number as a string; the protocol carries no floats. */
export const DecimalSchema = z.string().regex(/^-?(0|[1-9]\d*)(\.\d*[1-9])?$/);

/**
 * Impact classes copied from `packages/contracts/src/verification/model.ts` (`riskClass`). They are not the
 * verification levels L0..L3 (VERIFICATION.md §4).
 */
export const RISK_CLASSES = ["low", "medium", "high", "critical"] as const;
export const RiskClassSchema = z.enum(RISK_CLASSES);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const UsageSchema = z.strictObject({ providerCalls: SafeIntSchema, tokens: SafeIntSchema, costUsd: UsdSchema });
export type Usage = z.infer<typeof UsageSchema>;

export const IntervalSchema = z.strictObject({ from: InstantSchema.nullable(), to: InstantSchema.nullable() });
export type Interval = z.infer<typeof IntervalSchema>;

/** `Recorded<T>`: an assessed value always names the observations behind it; otherwise the reason it was not assessed. */
export type Recorded<T> =
  | { readonly state: "assessed"; readonly value: T; readonly observations: readonly Ref<"observation">[] }
  | { readonly state: "not_assessed"; readonly reason: string };

export function recordedSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("assessed"), value, observations: z.array(refOf("observation")).min(1) }),
    z.strictObject({ state: z.literal("not_assessed"), reason: ShortTextSchema }),
  ]);
}

/** Values that occur more than once, in first-seen order. */
export function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

/** Compare two RFC 3339 instants by time, not by string order (fractions sort wrongly as strings). */
export function compareInstants(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}
