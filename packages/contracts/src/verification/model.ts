import { z } from "zod";
import {
  IsoDateTimeSchema,
  JsonValueSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  UuidSchema,
} from "./index-primitives.js";
import {
  VerificationActorDeploymentSchema,
  VerificationArtifactHandleSchema,
  VerificationCheckSchema,
  VerificationContractVersionSchema,
  VerificationIdSchema,
} from "./primitives.js";
import { ResolvedSelectorSchema, VerificationSelectorSchema } from "./selectors.js";

export const SourceKindSchema = z.enum([
  "web_page",
  "api",
  "repository",
  "pdf",
  "image",
  "table",
  "transcript",
  "audio",
  "video",
  "dataset",
  "registry",
  "upload",
  "other",
]);

export const VerificationSourceSchema = z.strictObject({
  sourceId: VerificationIdSchema,
  kind: SourceKindSchema,
  canonicalUri: NonEmptyStringSchema,
  logicalIdentity: NonEmptyStringSchema,
});
export type VerificationSource = z.infer<typeof VerificationSourceSchema>;

export const VerificationSourceCaptureSchema = z.strictObject({
  captureId: VerificationIdSchema,
  sourceId: VerificationIdSchema,
  capturedAt: IsoDateTimeSchema,
  effectiveAt: IsoDateTimeSchema.optional(),
  captureMethod: NonEmptyStringSchema,
  captureMethodVersion: NonEmptyStringSchema,
  contentArtifact: VerificationArtifactHandleSchema,
  canonicalProjectionArtifact: VerificationArtifactHandleSchema.optional(),
});
export type VerificationSourceCapture = z.infer<typeof VerificationSourceCaptureSchema>;

export const LineageRelationSchema = z.enum([
  "derived_from",
  "used",
  "generated",
  "quoted_from",
  "revision_of",
  "primary_source_for",
]);
export const LineageEdgeSchema = z.strictObject({
  edgeId: VerificationIdSchema,
  fromArtifactId: UuidSchema,
  toArtifactId: UuidSchema,
  relation: LineageRelationSchema,
  activityId: VerificationIdSchema,
  activityVersion: NonEmptyStringSchema,
});
export type LineageEdge = z.infer<typeof LineageEdgeSchema>;

export const SourceAuthorityVectorSchema = z.strictObject({
  authority: z.enum(["primary", "authoritative_aggregator", "independent", "secondary", "promotional", "unknown"]),
  independence: z.enum(["independent", "same_organization", "self_reported", "interested_party", "unknown"]),
  directness: z.enum(["direct", "derived", "commentary", "unknown"]),
  freshness: z.enum(["current", "historical", "stale", "unknown"]),
  applicability: z.enum(["direct", "partial", "indirect", "unknown"]),
});
export type SourceAuthorityVector = z.infer<typeof SourceAuthorityVectorSchema>;

export const SourceFragmentSchema = z.strictObject({
  fragmentId: VerificationIdSchema,
  captureId: VerificationIdSchema,
  representationArtifactId: UuidSchema,
  selector: VerificationSelectorSchema,
  displayExcerpt: z.string().optional(),
});
export type SourceFragment = z.infer<typeof SourceFragmentSchema>;

export const EvidenceRoleSchema = z.enum(["supports", "contradicts", "qualifies", "context"]);
export const EvidenceEdgeSchema = z.strictObject({
  evidenceId: VerificationIdSchema,
  fragment: SourceFragmentSchema,
  role: EvidenceRoleSchema,
  origin: z.enum(["declared", "verifier_found"]),
  expectedSelectedContentDigest: Sha256DigestSchema.optional(),
  authority: SourceAuthorityVectorSchema,
  parserLineageArtifactIds: z.array(UuidSchema),
});
export type EvidenceEdge = z.infer<typeof EvidenceEdgeSchema>;

export const VerificationIntentSchema = z.strictObject({
  intentId: VerificationIdSchema,
  operation: z.enum([
    "verify_claim_support",
    "verify_extraction",
    "verify_metric",
    "verify_identity",
    "verify_report_coverage",
  ]),
  subject: NonEmptyStringSchema,
  expectedResult: NonEmptyStringSchema,
  method: NonEmptyStringSchema,
  acceptanceCriteria: z.array(NonEmptyStringSchema).min(1),
  abstainWhen: z.array(NonEmptyStringSchema),
});

export const AssertionKindSchema = z.enum([
  "field",
  "claim",
  "metric",
  "relationship",
  "computation",
  "report_assertion",
]);
export const ClaimTypeSchema = z.enum([
  "attribute",
  "relationship",
  "measurement",
  "capability",
  "compatibility",
  "temporal",
  "causal",
  "comparative",
  "methodological",
  "definition",
  "event",
  "provenance",
  "recommendation",
  "other",
]);
export const DerivationTypeSchema = z.enum(["direct", "normalized", "computed", "inferred"]);

export const AssertionSchema = z
  .strictObject({
    assertionId: VerificationIdSchema,
    kind: AssertionKindSchema,
    claimType: ClaimTypeSchema.optional(),
    value: JsonValueSchema.optional(),
    proposition: NonEmptyStringSchema.optional(),
    producer: VerificationActorDeploymentSchema,
    outputArtifactId: UuidSchema.optional(),
    outputRange: z.strictObject({ start: z.int().nonnegative(), end: z.int().positive() }).optional(),
    qualifiers: z.array(NonEmptyStringSchema),
    entityBindings: z.array(z.strictObject({ role: NonEmptyStringSchema, canonicalId: NonEmptyStringSchema })),
    derivation: DerivationTypeSchema,
    evidence: z.array(EvidenceEdgeSchema),
    intent: VerificationIntentSchema,
    riskClass: z.enum(["low", "medium", "high", "critical"]),
    downstreamUse: z.array(NonEmptyStringSchema).min(1),
    atomic: z.boolean(),
  })
  .superRefine((assertion, context) => {
    if (assertion.value === undefined && assertion.proposition === undefined)
      context.addIssue({ code: "custom", message: "an assertion requires a value or proposition" });
    if (assertion.outputRange && assertion.outputRange.end <= assertion.outputRange.start)
      context.addIssue({
        code: "custom",
        path: ["outputRange", "end"],
        message: "output range end must be greater than start",
      });
    if ((assertion.kind === "claim" || assertion.kind === "report_assertion") && assertion.claimType === undefined)
      context.addIssue({ code: "custom", path: ["claimType"], message: "claim assertions require a claim type" });
  });
export type Assertion = z.infer<typeof AssertionSchema>;

export const EntityIdentitySchema = z.strictObject({
  kind: z.enum([
    "library",
    "repository",
    "package",
    "paper",
    "person",
    "organization",
    "product",
    "model",
    "video",
    "dataset",
    "other",
  ]),
  canonicalId: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  parentCanonicalId: NonEmptyStringSchema.optional(),
  aliases: z.array(NonEmptyStringSchema),
});

export const DecimalStringSchema = z
  .string()
  .max(128)
  .regex(/^-?(?:0|[1-9]\d{0,63})(?:\.\d{1,63})?$/);
export const UnitDescriptorSchema = z.strictObject({
  symbol: NonEmptyStringSchema,
  dimension: NonEmptyStringSchema,
  scaleToCanonical: DecimalStringSchema,
});
const PointObservationPeriodSchema = z.strictObject({
  start: IsoDateTimeSchema.optional(),
  end: IsoDateTimeSchema.optional(),
  timezone: NonEmptyStringSchema,
  semantics: z.literal("point"),
});
const IntervalObservationPeriodSchema = z.strictObject({
  start: IsoDateTimeSchema,
  end: IsoDateTimeSchema,
  timezone: NonEmptyStringSchema,
  semantics: z.literal("interval"),
});
const CumulativeObservationPeriodSchema = z.strictObject({
  start: IsoDateTimeSchema.optional(),
  end: IsoDateTimeSchema,
  timezone: NonEmptyStringSchema,
  semantics: z.literal("cumulative"),
});
export const ObservationPeriodSchema = z.discriminatedUnion("semantics", [
  PointObservationPeriodSchema,
  IntervalObservationPeriodSchema,
  CumulativeObservationPeriodSchema,
]);

export const CalculationProofSchema = z.strictObject({
  operation: z.enum(["identity", "sum", "difference", "product", "ratio", "percent_change"]),
  operands: z
    .array(z.strictObject({ observationId: VerificationIdSchema, value: DecimalStringSchema }))
    .min(1)
    .max(100),
  expectedResult: DecimalStringSchema,
  rounding: z.strictObject({
    mode: z.enum(["none", "half_even", "half_up", "down"]),
    decimalPlaces: z.int().nonnegative().max(18),
  }),
  tolerance: DecimalStringSchema,
  operationVersion: NonEmptyStringSchema,
});

export const MetricEvidenceBindingSchema = z.strictObject({
  evidenceId: VerificationIdSchema,
  facet: z.enum(["value", "unit", "identity", "period_start", "period_end"]),
  expectedLiteral: NonEmptyStringSchema,
  comparison: z.enum(["decimal", "exact_text", "iso_datetime"]),
});

export const VerificationMetricObservationSchema = z
  .strictObject({
    observationId: VerificationIdSchema,
    entity: EntityIdentitySchema,
    artifactLevel: NonEmptyStringSchema,
    provider: NonEmptyStringSchema,
    providerNativeField: NonEmptyStringSchema,
    metricDefinition: NonEmptyStringSchema,
    metricDefinitionVersion: NonEmptyStringSchema,
    rawValue: JsonValueSchema,
    canonicalValue: DecimalStringSchema,
    unit: UnitDescriptorSchema,
    period: ObservationPeriodSchema,
    numerator: DecimalStringSchema.optional(),
    denominator: DecimalStringSchema.optional(),
    population: NonEmptyStringSchema.optional(),
    aggregation: NonEmptyStringSchema,
    deduplication: NonEmptyStringSchema,
    caveats: z.array(NonEmptyStringSchema),
    observedAt: IsoDateTimeSchema,
    effectiveAt: IsoDateTimeSchema.optional(),
    comparabilityGroup: NonEmptyStringSchema,
    evidence: z.array(EvidenceEdgeSchema).min(1),
    evidenceBindings: z.array(MetricEvidenceBindingSchema).min(3),
    calculation: CalculationProofSchema.optional(),
  })
  .superRefine((observation, context) => {
    const facets = new Set(observation.evidenceBindings.map((binding) => binding.facet));
    for (const facet of ["value", "unit", "identity"] as const)
      if (!facets.has(facet))
        context.addIssue({
          code: "custom",
          path: ["evidenceBindings"],
          message: `metric requires a ${facet} evidence binding`,
        });
    if (observation.period.start !== undefined && !facets.has("period_start"))
      context.addIssue({
        code: "custom",
        path: ["evidenceBindings"],
        message: "metric period start requires an evidence binding",
      });
    if (observation.period.end !== undefined && !facets.has("period_end"))
      context.addIssue({
        code: "custom",
        path: ["evidenceBindings"],
        message: "metric period end requires an evidence binding",
      });
    const evidenceIds = observation.evidence.map((edge) => edge.evidenceId);
    for (const binding of observation.evidenceBindings)
      if (!evidenceIds.includes(binding.evidenceId))
        context.addIssue({
          code: "custom",
          path: ["evidenceBindings"],
          message: `binding references unknown evidence ${binding.evidenceId}`,
        });
  });
export type VerificationMetricObservation = z.infer<typeof VerificationMetricObservationSchema>;

export const SemanticVerdictSchema = z.enum([
  "pending_semantic_review",
  "directly_supported",
  "supported_with_qualification",
  "partially_supported",
  "context_only",
  "contradicted",
  "mixed_or_conflicting",
  "not_supported",
  "insufficient_evidence",
  "unverifiable",
  "source_unavailable",
  "locator_error",
  "parser_error",
  "derived_verified",
  "derived_failed",
]);
export type SemanticVerdict = z.infer<typeof SemanticVerdictSchema>;
export const PolicyOutcomeSchema = z.enum(["pass", "pass_with_warnings", "review", "fail", "abstain"]);

const PropertyObservationSchema = z.strictObject({
  status: z.enum(["satisfied", "not_satisfied", "unknown", "not_assessed"]),
  rationale: NonEmptyStringSchema,
});
export const OrthogonalJudgmentSchema = z.strictObject({
  evidenceSupport: PropertyObservationSchema,
  worldCorrectness: PropertyObservationSchema,
  attributionFaithfulness: PropertyObservationSchema,
  sourceAuthority: PropertyObservationSchema,
  provenanceIntegrity: PropertyObservationSchema,
});

export const JudgmentSchema = z.strictObject({
  judgmentId: VerificationIdSchema,
  assertionId: VerificationIdSchema,
  evidenceId: VerificationIdSchema.optional(),
  judgeKind: z.enum(["deterministic", "nli", "llm", "human", "policy", "statistical"]),
  graderVersion: NonEmptyStringSchema,
  promptDigest: Sha256DigestSchema.optional(),
  outputSchemaDigest: Sha256DigestSchema,
  blindedInputArtifactDigest: Sha256DigestSchema,
  verdict: SemanticVerdictSchema,
  properties: OrthogonalJudgmentSchema,
  supportingFragmentIds: z.array(VerificationIdSchema),
  contradictingFragmentIds: z.array(VerificationIdSchema),
  unsupportedFacets: z.array(NonEmptyStringSchema),
  calibratedProbability: z.number().min(0).max(1).optional(),
  publicRationale: NonEmptyStringSchema,
  latencyMs: z.int().nonnegative(),
  tokenUsage: z.int().nonnegative().optional(),
  costMicros: z.int().nonnegative().optional(),
  retries: z.int().nonnegative(),
  providerResponseId: NonEmptyStringSchema.optional(),
  failureCategory: NonEmptyStringSchema.optional(),
  observedAt: IsoDateTimeSchema,
});
export type Judgment = z.infer<typeof JudgmentSchema>;

export const EvidenceMechanicalResultSchema = z.strictObject({
  evidenceId: VerificationIdSchema,
  status: z.enum(["passed", "failed", "review_required"]),
  resolution: ResolvedSelectorSchema,
  checks: z.array(VerificationCheckSchema),
});
export type EvidenceMechanicalResult = z.infer<typeof EvidenceMechanicalResultSchema>;

export const AssertionMechanicalResultSchema = z.strictObject({
  assertionId: VerificationIdSchema,
  status: z.enum(["passed", "failed", "review_required"]),
  semanticEligibility: z.boolean(),
  verdict: SemanticVerdictSchema,
  evidence: z.array(EvidenceMechanicalResultSchema),
  checks: z.array(VerificationCheckSchema),
});

export const MetricMechanicalResultSchema = z.strictObject({
  observationId: VerificationIdSchema,
  status: z.enum(["passed", "failed", "review_required"]),
  semanticEligibility: z.boolean(),
  checks: z.array(VerificationCheckSchema),
  replayedValue: DecimalStringSchema.optional(),
});
export type MetricMechanicalResult = z.infer<typeof MetricMechanicalResultSchema>;

export const DeterministicVerificationResultSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  status: z.enum(["passed", "failed", "review_required"]),
  semanticEligibility: z.boolean(),
  deploymentSeparation: z.strictObject({
    status: z.enum(["established", "not_established"]),
    basis: z.literal("runtime_principal_binding"),
    producerDeploymentId: VerificationIdSchema,
    verifierDeploymentId: VerificationIdSchema,
  }),
  captureChecks: z.array(VerificationCheckSchema),
  assertions: z.array(AssertionMechanicalResultSchema),
  metrics: z.array(MetricMechanicalResultSchema),
  summary: z.strictObject({
    capturesTotal: z.int().nonnegative(),
    capturesPassed: z.int().nonnegative(),
    assertionsTotal: z.int().nonnegative(),
    assertionsPassed: z.int().nonnegative(),
    metricsTotal: z.int().nonnegative(),
    metricsPassed: z.int().nonnegative(),
    failedCheckCodes: z.array(NonEmptyStringSchema),
    reviewReasons: z.array(NonEmptyStringSchema),
  }),
});
export type DeterministicVerificationResult = z.infer<typeof DeterministicVerificationResultSchema>;

const VerificationBundleBaseSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  bundleId: VerificationIdSchema,
  policyVersion: NonEmptyStringSchema,
  producer: VerificationActorDeploymentSchema,
  verifier: VerificationActorDeploymentSchema,
  sources: z.array(VerificationSourceSchema),
  captures: z.array(VerificationSourceCaptureSchema).min(1),
  lineage: z.array(LineageEdgeSchema),
});
export const VerificationBundleSchema = z.union([
  VerificationBundleBaseSchema.extend({
    assertions: z.array(AssertionSchema).min(1),
    metricObservations: z.array(VerificationMetricObservationSchema),
  }),
  VerificationBundleBaseSchema.extend({
    assertions: z.array(AssertionSchema),
    metricObservations: z.array(VerificationMetricObservationSchema).min(1),
  }),
]);
export type VerificationBundle = z.infer<typeof VerificationBundleSchema>;
