import { z } from "zod";
import {
  DeterministicVerificationResultSchema,
  PolicyOutcomeSchema,
  SemanticVerdictSchema,
  SourceAuthorityVectorSchema,
} from "./model.js";
import { IsoDateTimeSchema, NonEmptyStringSchema, Sha256DigestSchema } from "./index-primitives.js";
import { VerificationIdSchema } from "./primitives.js";

export const SemanticSupportStatusSchema = z.enum(["satisfied", "not_satisfied", "unknown", "not_assessed"]);

export const SemanticJudgeOutputSchema = z.strictObject({
  schemaVersion: z.literal("verification-semantic-judge.v1"),
  assertionId: VerificationIdSchema,
  verdict: z.enum([
    "directly_supported",
    "supported_with_qualification",
    "partially_supported",
    "context_only",
    "contradicted",
    "not_supported",
    "insufficient_evidence",
  ]),
  nliLabel: z.enum(["entailed", "neutral", "contradicted"]),
  supportingFragmentIds: z.array(VerificationIdSchema).max(16),
  contradictingFragmentIds: z.array(VerificationIdSchema).max(16),
  unsupportedFacets: z.array(NonEmptyStringSchema.max(160)).max(32),
  qualifiersPreserved: z.boolean(),
  publicRationale: NonEmptyStringSchema.max(800),
  rawProviderConfidence: z.number().min(0).max(1).optional(),
});
export type SemanticJudgeOutput = z.infer<typeof SemanticJudgeOutputSchema>;

export const SemanticJudgeIdentitySchema = z.strictObject({
  deploymentId: VerificationIdSchema,
  provider: NonEmptyStringSchema.max(120),
  family: NonEmptyStringSchema.max(120),
  model: NonEmptyStringSchema.max(160),
  capability: z.enum(["trained_nli", "llm_evidence_rubric"]),
  graderVersion: NonEmptyStringSchema.max(120),
  promptDigest: Sha256DigestSchema,
  outputSchemaDigest: Sha256DigestSchema,
  configurationDigest: Sha256DigestSchema,
});
export type SemanticJudgeIdentity = z.infer<typeof SemanticJudgeIdentitySchema>;

export const SemanticAssessmentRecordSchema = z
  .strictObject({
    assertionId: VerificationIdSchema,
    assertionValueDigest: Sha256DigestSchema.optional(),
    verdict: SemanticVerdictSchema,
    disposition: z.enum(["admit", "review", "abstain", "fail"]),
    evidenceSupport: SemanticSupportStatusSchema,
    worldCorrectness: SemanticSupportStatusSchema,
    attributionFaithfulness: SemanticSupportStatusSchema,
    sourceAuthority: SemanticSupportStatusSchema,
    provenanceIntegrity: SemanticSupportStatusSchema,
    judgeIdentities: z.array(SemanticJudgeIdentitySchema).max(3),
    supportingFragmentIds: z.array(VerificationIdSchema).max(16),
    contradictingFragmentIds: z.array(VerificationIdSchema).max(16),
    unsupportedFacets: z.array(NonEmptyStringSchema.max(160)).max(32),
    reasonCodes: z.array(NonEmptyStringSchema.max(120)).max(32),
    crossFamilySecondJudge: z.boolean(),
    rawProviderConfidences: z
      .array(
        z.strictObject({
          deploymentId: VerificationIdSchema,
          value: z.number().min(0).max(1),
        }),
      )
      .max(3),
  })
  .superRefine((value, context) => {
    const families = new Set(value.judgeIdentities.map((item) => item.family));
    const deployments = new Set(value.judgeIdentities.map((item) => item.deploymentId));
    const established = families.size >= 2 && deployments.size >= 2;
    if (value.crossFamilySecondJudge !== established)
      context.addIssue({
        code: "custom",
        path: ["crossFamilySecondJudge"],
        message: "cross-family status must be derived from distinct recorded judge families and deployments",
      });
    const confidenceDeployments = new Set(value.judgeIdentities.map((item) => item.deploymentId));
    if (value.rawProviderConfidences.some((item) => !confidenceDeployments.has(item.deploymentId)))
      context.addIssue({
        code: "custom",
        path: ["rawProviderConfidences"],
        message: "raw confidence requires a recorded judge deployment",
      });
  });
export type SemanticAssessmentRecord = z.infer<typeof SemanticAssessmentRecordSchema>;

export const VerificationSourceAssessmentSchema = z.strictObject({
  assessmentId: VerificationIdSchema,
  assertionId: VerificationIdSchema,
  fragmentId: VerificationIdSchema,
  sourceFamilyId: VerificationIdSchema,
  sourceOrganizationId: VerificationIdSchema,
  vector: SourceAuthorityVectorSchema,
  claimScope: z.enum([
    "source_summary",
    "descriptive_fact",
    "population_accuracy",
    "clinical_utility",
    "comparative_superiority",
    "causal",
    "product_validation",
    "method_validation",
  ]),
  evidenceScope: z.enum([
    "single_sample_technical",
    "population",
    "antecedent_method",
    "commercial_product",
    "company_statement",
    "unknown",
  ]),
  publicationRelation: z.enum([
    "validates_product",
    "validates_antecedent_method",
    "general_concept",
    "not_publication",
    "unknown",
  ]),
  jurisdictionKnown: z.boolean(),
  licenseKnown: z.boolean(),
  freshnessKnown: z.boolean(),
  conflictSetId: VerificationIdSchema.optional(),
});
export type VerificationSourceAssessment = z.infer<typeof VerificationSourceAssessmentSchema>;

export const LiteralExtractionPolicySchema = z.strictObject({
  assertionIds: z.array(VerificationIdSchema).min(1).max(256),
  downstreamUses: z.array(z.literal("knowledge_ingestion:claim.materialize")).min(1).max(1),
});

export const VerificationPolicyDefinitionSchema = z.strictObject({
  schemaVersion: z.literal("verification-policy.v1"),
  policyVersion: NonEmptyStringSchema.max(160),
  definitionId: VerificationIdSchema,
  literalExtraction: LiteralExtractionPolicySchema.optional(),
  criticalDownstreamUses: z.array(NonEmptyStringSchema.max(120)).max(32),
  requireCrossFamilyForRisk: z.array(z.enum(["low", "medium", "high", "critical"])).max(4),
  requireIndependentAuthorityForScopes: z
    .array(
      z.enum([
        "source_summary",
        "descriptive_fact",
        "population_accuracy",
        "clinical_utility",
        "comparative_superiority",
        "causal",
        "product_validation",
        "method_validation",
      ]),
    )
    .max(8),
  mixedEvidenceOutcome: z.enum(["review", "abstain", "fail"]),
  unknownCriticalOutcome: z.enum(["review", "abstain", "fail"]),
  authorityWithheldOutcome: z.enum(["review", "abstain", "fail"]),
  reviewAvailable: z.boolean(),
});
export type VerificationPolicyDefinition = z.infer<typeof VerificationPolicyDefinitionSchema>;

export const VerificationRecordedPolicyInputsSchema = z.strictObject({
  schemaVersion: z.literal("verification-policy-inputs.v1"),
  policyVersion: NonEmptyStringSchema.max(160),
  runId: VerificationIdSchema,
  recordedAt: IsoDateTimeSchema,
  deterministicResult: DeterministicVerificationResultSchema,
  assertions: z
    .array(
      z.strictObject({
        assertionId: VerificationIdSchema,
        riskClass: z.enum(["low", "medium", "high", "critical"]),
        downstreamUse: z.array(NonEmptyStringSchema.max(120)).min(1).max(32),
        claimScope: z.enum([
          "source_summary",
          "descriptive_fact",
          "population_accuracy",
          "clinical_utility",
          "comparative_superiority",
          "causal",
          "product_validation",
          "method_validation",
        ]),
        literalExtraction: z.literal(true).optional(),
        semantic: SemanticAssessmentRecordSchema,
        authorityStatus: z.enum(["sufficient", "withheld", "unknown"]),
        independentCorroboration: z.boolean(),
        conflictPresent: z.boolean(),
        criticalFactsKnown: z.boolean(),
      }),
    )
    .max(512),
  metrics: z
    .array(
      z.strictObject({
        observationId: VerificationIdSchema,
        riskClass: z.enum(["low", "medium", "high", "critical"]),
        downstreamUse: z.array(NonEmptyStringSchema.max(120)).min(1).max(32),
        criticalFactsKnown: z.boolean(),
        conflictPresent: z.boolean(),
      }),
    )
    .max(512),
  sourceAssessments: z.array(VerificationSourceAssessmentSchema).max(2048),
});
export type VerificationRecordedPolicyInputs = z.infer<typeof VerificationRecordedPolicyInputsSchema>;

export const VerificationPolicyDecisionSchema = z.strictObject({
  schemaVersion: z.literal("verification-policy-decision.v1"),
  policyVersion: NonEmptyStringSchema.max(160),
  runId: VerificationIdSchema,
  outcome: PolicyOutcomeSchema,
  assertionOutcomes: z
    .array(
      z.strictObject({
        assertionId: VerificationIdSchema,
        outcome: PolicyOutcomeSchema,
        reasonCodes: z.array(NonEmptyStringSchema.max(120)).max(32),
      }),
    )
    .max(512),
  reasonCodes: z.array(NonEmptyStringSchema.max(120)).max(64),
  overrideApplied: z.boolean(),
});
export type VerificationPolicyDecision = z.infer<typeof VerificationPolicyDecisionSchema>;

export const VerificationPolicyOverrideRecordSchema = z.strictObject({
  schemaVersion: z.literal("verification-policy-override.v1"),
  overrideId: VerificationIdSchema,
  policyVersion: NonEmptyStringSchema.max(160),
  runId: VerificationIdSchema,
  decisionDigest: Sha256DigestSchema,
  before: PolicyOutcomeSchema,
  after: PolicyOutcomeSchema,
  reason: NonEmptyStringSchema.max(1000),
  actorPrincipalId: VerificationIdSchema,
  actorAuthority: z.literal("verification_policy_override"),
  recordedAt: IsoDateTimeSchema,
  previousOverrideDigest: Sha256DigestSchema.optional(),
});
export type VerificationPolicyOverrideRecord = z.infer<typeof VerificationPolicyOverrideRecordSchema>;
