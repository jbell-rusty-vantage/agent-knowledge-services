import {
  type Digest,
  DigestSchema,
  EvaluatorIdentitySchema,
  IdSchema,
  SafeIntSchema,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import { z } from "zod";
import { LongTextSchema, ShortTextSchema, identityShape, recordedSchema } from "../records/common.js";
import { NullableTextSchema, baseQualifierShape } from "./base.js";

/** Scientific / Biotech rubric qualifiers (VERIFICATION.md §4). Fields are required by claim class, never invented. */
export const SCIENTIFIC_PROFILE = "scientific.v2" as const;
export const SCIENTIFIC_RUBRIC_VERSION = "research-rubric.scientific.v2" as const;

export const STUDY_DESIGNS = [
  "randomized_controlled_trial",
  "cohort",
  "case_control",
  "cross_sectional",
  "case_report",
  "in_vitro",
  "animal",
  "analytical_validation",
  "systematic_review",
  "modeling",
  "other",
] as const;

/** Risk-of-bias appraisal domains of ONE study (K08 `study_appraisal` `domains` table). */
export const APPRAISAL_DOMAINS = ["selection", "performance", "detection", "attrition", "reporting"] as const;
export const APPRAISAL_JUDGMENTS = ["low", "some_concerns", "high", "not_reported"] as const;

export const ScientificQualifiersSchema = z
  .strictObject({
    profile: z.literal(SCIENTIFIC_PROFILE),
    ...baseQualifierShape,
    /** A source report ("study X reported Y") is a different claim from the generalized proposition. */
    claimClass: z.enum(["source_report", "generalized"]),
    studyDesign: z.enum(STUDY_DESIGNS).nullable(),
    species: NullableTextSchema,
    intervention: NullableTextSchema,
    comparator: NullableTextSchema,
    endpoint: NullableTextSchema,
    sampleSize: SafeIntSchema.nullable(),
    effectMeasure: NullableTextSchema,
    followUp: NullableTextSchema,
    causalClaim: z.enum(["association", "causal", "none", "unknown"]),
    /**
     * Study appraisal (SV-07): the appraisal domain this source-report assertion is about and the appraiser's judgment
     * for it. Both null outside a study appraisal. A domain judgment is about one study (`entity`, `studyDesign`).
     */
    appraisalDomain: z.enum(APPRAISAL_DOMAINS).nullable(),
    appraisalJudgment: z.enum(APPRAISAL_JUDGMENTS).nullable(),
  })
  .superRefine((qualifiers, context) => {
    if (qualifiers.appraisalJudgment !== null && qualifiers.appraisalDomain === null) {
      context.addIssue({
        code: "custom",
        path: ["appraisalJudgment"],
        message: "a judgment names its appraisal domain",
      });
    }
    if (
      qualifiers.appraisalDomain !== null &&
      (qualifiers.claimClass !== "source_report" || qualifiers.studyDesign === null || qualifiers.entity === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["appraisalDomain"],
        message: "an appraisal domain qualifies a source report about one named study with a known design",
      });
    }
  });
export type ScientificQualifiers = z.infer<typeof ScientificQualifiersSchema>;

/**
 * `EvidenceSynthesisAssessment` (design §3.1): a body-of-evidence judgment keyed by outcome/comparison/population and an
 * included-study set digest. Each certainty domain is recorded separately; neither source support nor study type
 * supplies a rating automatically, so an overall rating other than `not_assessed` needs a reviewer.
 */
export const EVIDENCE_SYNTHESIS_SCHEMA_VERSION = "research-core.evidence_synthesis.v2" as const;
const CertaintyJudgmentSchema = z.strictObject({
  judgment: z.enum(["no_concern", "serious", "very_serious", "unclear"]),
  reasons: z.array(ShortTextSchema).min(1),
});
export const EvidenceSynthesisAssessmentSchema = z
  .strictObject({
    ...identityShape(EVIDENCE_SYNTHESIS_SCHEMA_VERSION),
    outcome: ShortTextSchema,
    comparison: ShortTextSchema,
    population: ShortTextSchema,
    includedStudySetDigest: DigestSchema,
    domains: z.strictObject({
      riskOfBias: recordedSchema(CertaintyJudgmentSchema),
      inconsistency: recordedSchema(CertaintyJudgmentSchema),
      indirectness: recordedSchema(CertaintyJudgmentSchema),
      imprecision: recordedSchema(CertaintyJudgmentSchema),
      publicationBias: recordedSchema(CertaintyJudgmentSchema),
    }),
    overall: z.enum(["high", "moderate", "low", "very_low", "not_assessed"]),
    rationale: LongTextSchema,
    reviewer: EvaluatorIdentitySchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.overall !== "not_assessed" && value.reviewer === null) {
      context.addIssue({
        code: "custom",
        path: ["reviewer"],
        message: "an overall certainty rating names its reviewer",
      });
    }
    // Never auto-derived (design §3.1): a model or the support algebra cannot supply the body-of-evidence rating, and
    // a rating rests on every certainty domain having been assessed.
    if (value.overall !== "not_assessed" && value.reviewer !== null && value.reviewer.role !== "human_reviewer") {
      context.addIssue({ code: "custom", path: ["reviewer"], message: "an overall rating is a human reviewer's" });
    }
    if (value.overall !== "not_assessed" && Object.values(value.domains).some((d) => d.state !== "assessed")) {
      context.addIssue({ code: "custom", path: ["domains"], message: "an overall rating assesses every domain" });
    }
  });
export type EvidenceSynthesisAssessment = z.infer<typeof EvidenceSynthesisAssessmentSchema>;

/**
 * The included-study set digest an EvidenceSynthesisAssessment is keyed by. Reports are grouped by their VERIFIED
 * origin family (three reports of one study are one study); a report with an unknown family is its own entry, never
 * merged by guess. Order-independent. The synthesis itself is never derived from support verdicts or study types.
 */
export const IncludedStudySchema = z.strictObject({ report: IdSchema, originFamily: IdSchema.nullable() });
export function includedStudySetDigest(reports: readonly z.infer<typeof IncludedStudySchema>[]): {
  digest: Digest;
  studies: number;
} {
  const studies = new Map<string, string[]>();
  for (const entry of reports.map((item) => IncludedStudySchema.parse(item))) {
    const key = entry.originFamily === null ? `unknown:${entry.report}` : `family:${entry.originFamily}`;
    studies.set(key, [...(studies.get(key) ?? []), entry.report]);
  }
  const canonical = [...studies.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([study, members]) => ({ study, reports: [...new Set(members)].sort() }));
  return { digest: digestCanonical(canonical), studies: canonical.length };
}
