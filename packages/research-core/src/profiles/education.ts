import { z } from "zod";
import { ShortTextSchema } from "../records/common.js";
import { NullableTextSchema, baseQualifierShape } from "./base.js";

/** Educational / AI Engineer learning rubric qualifiers (VERIFICATION.md §4). Pedagogy is not evidence truth. */
export const EDUCATION_PROFILE = "education.v2" as const;
export const EDUCATION_RUBRIC_VERSION = "research-rubric.education.v2" as const;

export const EducationQualifiersSchema = z.strictObject({
  profile: z.literal(EDUCATION_PROFILE),
  ...baseQualifierShape,
  learningObjective: NullableTextSchema,
  prerequisites: z.array(ShortTextSchema),
  simplificationDeclared: z.boolean(),
  exampleStatus: z.enum(["reproducible", "illustrative", "none"]),
  citedScopeVersion: NullableTextSchema,
});
export type EducationQualifiers = z.infer<typeof EducationQualifiersSchema>;
