import { z } from "zod";
import { NullableTextSchema, baseQualifierShape } from "./base.js";

/** Engineering / AI Engineer research rubric qualifiers (VERIFICATION.md §4 domain rubric table). */
export const ENGINEERING_PROFILE = "engineering.v2" as const;
export const ENGINEERING_RUBRIC_VERSION = "research-rubric.engineering.v2" as const;

export const EngineeringQualifiersSchema = z.strictObject({
  profile: z.literal(ENGINEERING_PROFILE),
  ...baseQualifierShape,
  runtime: NullableTextSchema,
  softwareVersion: NullableTextSchema,
  configuration: NullableTextSchema,
  benchmarkEnvironment: NullableTextSchema,
  denominator: NullableTextSchema,
  /** Repository selectors bind a full commit. */
  repositoryCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
});
export type EngineeringQualifiers = z.infer<typeof EngineeringQualifiersSchema>;
