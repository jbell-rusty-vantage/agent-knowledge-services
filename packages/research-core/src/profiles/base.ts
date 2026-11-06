import { InstantSchema } from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { ShortTextSchema } from "../records/common.js";

/** Unreported qualifiers stay `null` (unknown); a profile never invents a value (VERIFICATION.md §4). */
export const NullableTextSchema = ShortTextSchema.nullable();

export const TimeQualifierSchema = z
  .strictObject({ from: InstantSchema.nullable(), to: InstantSchema.nullable(), asOf: InstantSchema.nullable() })
  .nullable();
export type TimeQualifier = z.infer<typeof TimeQualifierSchema>;

export const MODALITIES = [
  "asserted",
  "possible",
  "probable",
  "hypothetical",
  "recommended",
  "forecast",
  "interrogative",
] as const;
export const ModalitySchema = z.enum(MODALITIES);

export const ComparisonSchema = z
  .strictObject({
    comparator: ShortTextSchema,
    relation: z.enum(["greater", "less", "equal", "not_different", "different", "unknown"]),
  })
  .nullable();

/** Qualifiers every profile shares (VERIFICATION.md §3 `AssertionVersion`). Losing one creates a new claim. */
export const baseQualifierShape = {
  entity: NullableTextSchema,
  population: NullableTextSchema,
  time: TimeQualifierSchema,
  unit: NullableTextSchema,
  jurisdiction: NullableTextSchema,
  baseline: NullableTextSchema,
  negation: z.boolean(),
  modality: ModalitySchema,
  comparison: ComparisonSchema,
};
