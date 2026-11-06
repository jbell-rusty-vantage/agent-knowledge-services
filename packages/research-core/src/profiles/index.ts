import type { Ref } from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { EDUCATION_PROFILE, EDUCATION_RUBRIC_VERSION, EducationQualifiersSchema } from "./education.js";
import { ENGINEERING_PROFILE, ENGINEERING_RUBRIC_VERSION, EngineeringQualifiersSchema } from "./engineering.js";
import { SCIENTIFIC_PROFILE, SCIENTIFIC_RUBRIC_VERSION, ScientificQualifiersSchema } from "./scientific.js";

export * from "./base.js";
export * from "./education.js";
export * from "./engineering.js";
export * from "./scientific.js";

/** `AssertionVersion.qualifiers`: strict, discriminated by profile. An unknown profile fails to parse. */
export const QualifiersSchema = z.discriminatedUnion("profile", [
  EngineeringQualifiersSchema,
  ScientificQualifiersSchema,
  EducationQualifiersSchema,
]);
export type Qualifiers = z.infer<typeof QualifiersSchema>;
export type QualifierProfileId = Qualifiers["profile"];

type ProfileEntry = { readonly profile: QualifierProfileId; readonly domain: string; readonly rubricVersion: string };

export const QUALIFIER_PROFILES: readonly ProfileEntry[] = [
  { profile: ENGINEERING_PROFILE, domain: "engineering", rubricVersion: ENGINEERING_RUBRIC_VERSION },
  { profile: SCIENTIFIC_PROFILE, domain: "scientific", rubricVersion: SCIENTIFIC_RUBRIC_VERSION },
  { profile: EDUCATION_PROFILE, domain: "education", rubricVersion: EDUCATION_RUBRIC_VERSION },
];

export type ProfileResolution =
  | { readonly ok: true; readonly profile: QualifierProfileId; readonly domain: string }
  | { readonly ok: false; readonly code: "SCHEMA_UNSUPPORTED" | "PROFILE_MISMATCH"; readonly reason: string };

/** Resolve the qualifier profile a pinned rubric requires, by the rubric record's schema version. Unknown refuses. */
export function profileFor(rubric: Ref<"rubric">): ProfileResolution {
  const entry = QUALIFIER_PROFILES.find((candidate) => candidate.rubricVersion === rubric.version);
  if (entry === undefined) {
    return { ok: false, code: "SCHEMA_UNSUPPORTED", reason: `no qualifier profile for rubric ${rubric.version}` };
  }
  return { ok: true, profile: entry.profile, domain: entry.domain };
}

export type QualifierCheck =
  | { readonly ok: true; readonly qualifiers: Qualifiers }
  | { readonly ok: false; readonly code: "SCHEMA_UNSUPPORTED" | "PROFILE_MISMATCH"; readonly reason: string };

/** Parse qualifiers against the profile the rubric requires; a different or unknown profile refuses. */
export function qualifiersFor(rubric: Ref<"rubric">, qualifiers: unknown): QualifierCheck {
  const resolution = profileFor(rubric);
  if (!resolution.ok) return resolution;
  const parsed = QualifiersSchema.safeParse(qualifiers);
  if (!parsed.success) {
    return { ok: false, code: "SCHEMA_UNSUPPORTED", reason: parsed.error.issues[0]?.message ?? "invalid qualifiers" };
  }
  if (parsed.data.profile !== resolution.profile) {
    return {
      ok: false,
      code: "PROFILE_MISMATCH",
      reason: `rubric requires ${resolution.profile}, qualifiers use ${parsed.data.profile}`,
    };
  }
  return { ok: true, qualifiers: parsed.data };
}
