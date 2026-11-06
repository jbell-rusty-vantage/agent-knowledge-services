import { z } from "zod";
import { IsoDateTimeSchema, NonEmptyStringSchema, Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import {
  VerificationArtifactHandleSchema,
  VerificationContractVersionSchema,
  VerificationIdSchema,
  VerificationOperationContextSchema,
} from "./primitives.js";
import { VerificationSelectorSchema } from "./selectors.js";
import { SemanticJudgeOutputSchema } from "./semantic-policy.js";

export const VerificationBenchmarkSchemaVersionSchema = z.literal("verification-benchmark.v1");
export const VerificationBenchmarkPartitionSchema = z.enum([
  "development",
  "calibration",
  "locked_test",
  "distribution_shift",
]);
export const VerificationBenchmarkStageSchema = z.enum(["pilot", "benchmark_v1", "mature"]);
export const VerificationBenchmarkLabelSchema = z.enum([
  "supported_by_source",
  "independently_corroborated",
  "partially_supported",
  "contradicted",
  "unsupported",
  "outdated",
  "promotional_only",
  "not_verifiable_from_public_sources",
  "not_applicable",
  "locator_error",
  "abstain",
]);
export const VerificationBenchmarkLabelStatusSchema = z.enum([
  "engineering_expectation",
  "annotation_pending",
  "independent_annotations_complete",
  "expert_adjudicated",
]);

export const VerificationBenchmarkV1CandidateSchema = z.strictObject({
  candidateId: VerificationIdSchema,
  fragmentId: VerificationIdSchema,
  sourceKey: VerificationIdSchema,
  sourceClass: NonEmptyStringSchema,
  captureId: UuidSchema,
  projectionArtifactId: UuidSchema,
  projectionDigest: Sha256DigestSchema,
  selector: VerificationSelectorSchema,
  selectedContentDigest: Sha256DigestSchema,
  labelStatus: z.literal("annotation_pending"),
  independentObservation: z.literal(false),
});

export const VerificationBenchmarkV1CandidatePoolSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-benchmark-v1-candidate-pool.v1"),
    status: z.literal("unlabeled_unfrozen_candidates"),
    sourcePreparationDigest: Sha256DigestSchema,
    count: z.int().min(150).max(300),
    independentObservationCount: z.literal(0),
    limitation: NonEmptyStringSchema,
    candidates: z.array(VerificationBenchmarkV1CandidateSchema).min(150).max(300),
  })
  .superRefine((value, context) => {
    if (value.count !== value.candidates.length)
      context.addIssue({ code: "custom", path: ["count"], message: "candidate count must match the candidate array" });
    for (const [path, values] of [
      ["candidateId", value.candidates.map((item) => item.candidateId)],
      ["fragmentId", value.candidates.map((item) => item.fragmentId)],
    ] as const)
      if (new Set(values).size !== values.length)
        context.addIssue({ code: "custom", path: ["candidates"], message: `${path} values must be unique` });
    if (
      new Set(value.candidates.map((item) => item.sourceKey)).size < 4 ||
      new Set(value.candidates.map((item) => item.sourceClass)).size < 2
    )
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Benchmark v1 candidates require multiple source keys and source classes",
      });
  });

export type VerificationBenchmarkV1Candidate = z.infer<typeof VerificationBenchmarkV1CandidateSchema>;
export type VerificationBenchmarkV1CandidatePool = z.infer<typeof VerificationBenchmarkV1CandidatePoolSchema>;

export const VerificationBenchmarkEvidenceSchema = z.strictObject({
  fragmentId: VerificationIdSchema,
  captureId: UuidSchema,
  sourceKey: VerificationIdSchema,
  sourceClass: NonEmptyStringSchema,
  projectionArtifactId: UuidSchema,
  projectionDigest: Sha256DigestSchema,
  transformationArtifactId: UuidSchema,
  selector: VerificationSelectorSchema,
  selectedContentDigest: Sha256DigestSchema,
  excerpt: z.string().min(1).max(2_000),
  rights: NonEmptyStringSchema,
  providerUploadAuthorized: z.boolean(),
});

export const VerificationBenchmarkExpectationSchema = z.strictObject({
  label: VerificationBenchmarkLabelSchema,
  labelStatus: VerificationBenchmarkLabelStatusSchema,
  expectedPolicy: z.enum(["pass", "pass_with_warnings", "review", "fail", "abstain"]),
  expectedLocatorValid: z.boolean(),
  support: z.enum(["full", "partial", "none", "contradicted", "not_applicable"]),
  authority: z.enum(["sufficient", "interested_party_only", "insufficient", "not_applicable"]),
  worldCorrectness: z.enum(["established", "not_established", "contradicted", "unknown", "not_applicable"]),
  rationale: NonEmptyStringSchema,
});

export const VerificationBenchmarkCaseSchema = z
  .strictObject({
    schemaVersion: VerificationBenchmarkSchemaVersionSchema,
    caseId: VerificationIdSchema,
    caseDigest: Sha256DigestSchema,
    partition: VerificationBenchmarkPartitionSchema,
    inputManifestArtifactId: UuidSchema,
    goldArtifactId: UuidSchema.nullable(),
    modality: z.enum([
      "text",
      "html",
      "json",
      "pdf",
      "image",
      "table",
      "repository",
      "transcript",
      "audio",
      "video",
      "dataset",
      "api",
    ]),
    sourceFamily: NonEmptyStringSchema,
    entityFamily: NonEmptyStringSchema,
    reportCluster: NonEmptyStringSchema,
    pairCluster: NonEmptyStringSchema,
    tags: z.array(NonEmptyStringSchema),
    adversarialTransforms: z.array(NonEmptyStringSchema),
    assertion: z.string().min(1).max(8_000),
    evidence: z.array(VerificationBenchmarkEvidenceSchema).max(8),
    expectation: VerificationBenchmarkExpectationSchema,
    independentObservation: z.boolean(),
    humanGoldScoringEligible: z.boolean(),
    humanGoldDimensions: z
      .array(z.enum(["label", "locator", "field_mechanics", "support", "authority", "world_correctness", "policy"]))
      .min(1)
      .optional(),
    adjudicationId: UuidSchema.nullable().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.humanGoldScoringEligible &&
      (value.expectation.labelStatus !== "expert_adjudicated" ||
        value.adjudicationId == null ||
        !value.humanGoldDimensions?.includes("label"))
    )
      context.addIssue({
        code: "custom",
        path: ["humanGoldScoringEligible"],
        message: "human gold scoring requires bound expert adjudication and an explicit reviewed-dimension scope",
      });
    if (value.expectation.expectedLocatorValid && value.evidence.length === 0)
      context.addIssue({ code: "custom", path: ["evidence"], message: "locator-valid cases require evidence" });
  });

export const VerificationBenchmarkAnnotationSchema = z.strictObject({
  schemaVersion: VerificationBenchmarkSchemaVersionSchema,
  annotationId: UuidSchema,
  datasetManifestDigest: Sha256DigestSchema,
  caseId: VerificationIdSchema,
  annotatorIdentity: NonEmptyStringSchema,
  annotatorRole: z.enum(["human_annotator", "expert_adjudicator"]),
  blindedToOtherAnnotations: z.boolean(),
  label: VerificationBenchmarkLabelSchema,
  rationale: NonEmptyStringSchema,
  evidenceFragmentIds: z.array(VerificationIdSchema),
  createdAt: IsoDateTimeSchema,
});

export const VerificationBenchmarkAdjudicationSchema = z.strictObject({
  schemaVersion: VerificationBenchmarkSchemaVersionSchema,
  adjudicationId: UuidSchema,
  datasetManifestDigest: Sha256DigestSchema,
  caseId: VerificationIdSchema,
  expertIdentity: NonEmptyStringSchema,
  annotationIds: z.array(UuidSchema).min(2),
  finalLabel: VerificationBenchmarkLabelSchema,
  rationale: NonEmptyStringSchema,
  createdAt: IsoDateTimeSchema,
});

export const VerificationBenchmarkDatasetSchema = z
  .strictObject({
    schemaVersion: VerificationBenchmarkSchemaVersionSchema,
    verificationContractVersion: VerificationContractVersionSchema,
    datasetId: VerificationIdSchema,
    version: z.int().positive(),
    stage: VerificationBenchmarkStageSchema,
    manifestDigest: Sha256DigestSchema,
    frozen: z.literal(true),
    supersedesManifestDigest: Sha256DigestSchema.nullable(),
    sourcePreparationDigest: Sha256DigestSchema,
    labelProvenance: z.enum(["expert_adjudicated", "human_reviewed", "engineering_expectations", "mixed_pending"]),
    annotationGuidelinesDigest: Sha256DigestSchema,
    adjudicationArtifactDigest: Sha256DigestSchema.nullable().optional(),
    cases: z.array(VerificationBenchmarkCaseSchema).min(1).max(1_000),
    createdAt: IsoDateTimeSchema,
    sealedAt: IsoDateTimeSchema,
  })
  .superRefine((value, context) => {
    const ids = value.cases.map((item) => item.caseId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", path: ["cases"], message: "case ids must be unique" });
    if (value.stage === "pilot" && (value.cases.length < 30 || value.cases.length > 50))
      context.addIssue({ code: "custom", path: ["cases"], message: "Pilot requires 30-50 cases" });
    if (value.stage === "benchmark_v1" && (value.cases.length < 150 || value.cases.length > 300))
      context.addIssue({ code: "custom", path: ["cases"], message: "Benchmark v1 requires 150-300 cases" });
    if (value.cases.some((item) => item.humanGoldScoringEligible) && value.adjudicationArtifactDigest == null)
      context.addIssue({
        code: "custom",
        path: ["adjudicationArtifactDigest"],
        message: "human gold requires an adjudication artifact",
      });
    const splitByGroup = new Map<string, string>();
    for (const item of value.cases)
      for (const group of [item.sourceFamily, item.entityFamily, item.reportCluster, item.pairCluster]) {
        const previous = splitByGroup.get(group);
        if (previous && previous !== item.partition)
          context.addIssue({ code: "custom", path: ["cases"], message: `split leakage for group ${group}` });
        else splitByGroup.set(group, item.partition);
      }
  });

export const VerificationBenchmarkArmSchema = z.strictObject({
  armId: VerificationIdSchema,
  name: NonEmptyStringSchema,
  control: z.boolean(),
  strategy: z.enum(["baseline", "interfaze", "cascade", "consensus_abstention"]),
  extractorProfile: NonEmptyStringSchema,
  parserProfile: NonEmptyStringSchema,
  retrieverProfile: NonEmptyStringSchema,
  judgeProfile: NonEmptyStringSchema,
  policyVersion: NonEmptyStringSchema,
  configurationDigest: Sha256DigestSchema,
  cachePolicy: z.enum(["disabled", "exact_request_only"]),
  replicas: z.int().min(1).max(10),
});

export const VerificationBenchmarkCallAttributionSchema = z.strictObject({
  callId: VerificationIdSchema,
  armId: VerificationIdSchema,
  caseId: VerificationIdSchema,
  provider: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  requestDigest: Sha256DigestSchema,
  responseDigest: Sha256DigestSchema.nullable(),
  cacheDisposition: z.enum(["fresh", "exact_cache_shared", "not_dispatched"]),
  sharedWithArmIds: z.array(VerificationIdSchema),
  costState: z.enum(["actual", "estimated_not_billed", "unknown_dispatched", "not_dispatched"]),
  actualCostMicros: z.int().nonnegative().nullable(),
  reservationCostMicros: z.int().nonnegative(),
  latencyMs: z.int().nonnegative().nullable(),
  failureClass: z.enum(["none", "provider", "network", "timeout", "schema", "policy", "local"]),
});

export const DiagnosticsBenchmarkSupportOutputSchema = z.strictObject({
  support: z.enum(["full", "partial", "none", "contradicted"]),
  qualifiers_preserved: z.boolean(),
  unsupported_facets: z.array(NonEmptyStringSchema.max(160)).max(12),
  public_rationale: NonEmptyStringSchema.max(600),
});

export const DiagnosticsBenchmarkExtractedFieldSchema = z
  .strictObject({
    fieldKey: VerificationIdSchema,
    status: z.enum(["extracted", "missing", "ambiguous"]),
    value: z.string().max(300),
    evidenceQuote: z.string().max(600),
    publicRationale: z.string().min(1).max(300),
  })
  .superRefine((value, context) => {
    if (value.status === "extracted" && (!value.value.length || !value.evidenceQuote.length))
      context.addIssue({ code: "custom", message: "extracted fields require a value and exact evidence quote" });
    if (value.status !== "extracted" && (value.value.length || value.evidenceQuote.length))
      context.addIssue({
        code: "custom",
        message: "missing or ambiguous fields must not invent a value or evidence quote",
      });
  });

export const DiagnosticsBenchmarkExtractionOutputSchema = z.strictObject({
  support: z.enum(["full", "partial", "none", "contradicted"]),
  qualifiers_preserved: z.boolean(),
  fields: z.array(DiagnosticsBenchmarkExtractedFieldSchema).min(1).max(4),
  unsupported_facets: z.array(z.string().max(160)).max(12),
  public_rationale: z.string().min(1).max(600),
});

/** A schema-validated provider observation that can be replayed without network access. */
export const DiagnosticsBenchmarkProviderObservationSchema = z.strictObject({
  schemaVersion: z.literal("verification-benchmark-provider-observation.v1"),
  observationDigest: Sha256DigestSchema,
  caseId: VerificationIdSchema,
  caseDigest: Sha256DigestSchema,
  role: z.enum(["luna_extractor", "interfaze_extractor", "haiku_judge"]),
  provider: z.enum(["gateway", "interfaze"]),
  model: z.enum(["openai/gpt-5.6-luna", "anthropic/claude-haiku-4.5", "interfaze-beta"]),
  requestDigest: Sha256DigestSchema,
  rawResponseDigest: Sha256DigestSchema,
  envelopeDigest: Sha256DigestSchema,
  output: z.union([
    DiagnosticsBenchmarkSupportOutputSchema,
    DiagnosticsBenchmarkExtractionOutputSchema,
    SemanticJudgeOutputSchema,
  ]),
  promptTokens: z.int().nonnegative().nullable(),
  completionTokens: z.int().nonnegative().nullable(),
  actualCostMicros: z.int().nonnegative().nullable(),
  reservationCostMicros: z.int().nonnegative(),
  latencyMs: z.int().nonnegative().nullable(),
  costState: z.enum(["actual", "unknown_dispatched"]),
  runDisposition: z.enum(["fresh_in_run", "recorded_exact_reuse"]),
  capturedAt: IsoDateTimeSchema,
  custody: z.strictObject({
    state: z.enum(["registered", "recovered_bytes_original_registration_lost"]),
    sourceReceiptDigest: Sha256DigestSchema,
    recoveryInventoryDigest: Sha256DigestSchema.nullable(),
    recoveryWrapperArtifactId: UuidSchema.nullable(),
  }),
});

export const DiagnosticsBenchmarkLiveArtifactBytesSchema = z.strictObject({
  role: z.enum([
    "transmission_manifest",
    "provider_input",
    "granted_fragment",
    "request",
    "raw_response",
    "response_envelope",
    "provider_precontext",
    "precontext_envelope",
    "observation",
    "field_ledger",
  ]),
  handle: VerificationArtifactHandleSchema,
  bytesBase64: z
    .string()
    .max(300_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
});

export const DiagnosticsBenchmarkLiveSourceBindingSchema = z.strictObject({
  datasetVersionId: UuidSchema,
  evalCaseId: UuidSchema,
  inputManifestArtifact: VerificationArtifactHandleSchema,
  locatorValid: z.boolean(),
  selectorResolutionDigest: Sha256DigestSchema,
});
export const DiagnosticsBenchmarkLiveAccountingSchema = z.strictObject({
  budgetId: UuidSchema,
  budgetKey: NonEmptyStringSchema,
  ceilingCostMicros: z.int().positive(),
  reservedCostMicros: z.int().nonnegative(),
  settledCostMicros: z.int().nonnegative(),
  attemptState: z.enum(["settled", "uncertain"]),
  reservationCostMicros: z.int().positive(),
  estimatedCostMicros: z.int().nonnegative().nullable(),
  actualCostMicros: z.int().nonnegative().nullable(),
  requestArtifactId: UuidSchema,
  responseArtifactId: UuidSchema,
  runAttemptCount: z.int().positive(),
  runReservedCostMicros: z.int().nonnegative(),
  runSettledCostMicros: z.int().nonnegative(),
});

/** Complete append-only offline checkpoint for one successful paid provider call. */
export const DiagnosticsBenchmarkLiveCallCheckpointSchema = z
  .strictObject({
    schemaVersion: z.literal("diagnostics-benchmark-live-call-checkpoint.v1"),
    checkpointDigest: Sha256DigestSchema,
    runIdentityDigest: Sha256DigestSchema,
    experimentManifestDigest: Sha256DigestSchema,
    datasetManifestDigest: Sha256DigestSchema,
    caseId: VerificationIdSchema,
    caseDigest: Sha256DigestSchema,
    role: z.enum(["luna_extractor", "interfaze_extractor", "haiku_judge"]),
    provider: z.enum(["gateway", "interfaze"]),
    model: z.enum(["openai/gpt-5.6-luna", "anthropic/claude-haiku-4.5", "interfaze-beta"]),
    attemptId: UuidSchema,
    providerHttpStatus: z.int().min(200).max(299),
    sourceBinding: DiagnosticsBenchmarkLiveSourceBindingSchema,
    observation: DiagnosticsBenchmarkProviderObservationSchema,
    fieldLedger: z.unknown().nullable(),
    artifacts: z.array(DiagnosticsBenchmarkLiveArtifactBytesSchema).min(7).max(10),
    accounting: DiagnosticsBenchmarkLiveAccountingSchema,
    completedAt: IsoDateTimeSchema,
  })
  .superRefine((value, context) => {
    if (
      value.observation.caseId !== value.caseId ||
      value.observation.caseDigest !== value.caseDigest ||
      value.observation.role !== value.role ||
      value.observation.provider !== value.provider ||
      value.observation.model !== value.model ||
      value.observation.actualCostMicros !== value.accounting.actualCostMicros
    )
      context.addIssue({ code: "custom", message: "observation and accounting must bind to the call identity" });
    const roles = value.artifacts.map((item) => item.role);
    const required = [
      "transmission_manifest",
      "provider_input",
      "granted_fragment",
      "request",
      "raw_response",
      "response_envelope",
      "observation",
    ];
    if (
      new Set(roles).size !== roles.length ||
      required.some((role) => !roles.includes(role as never)) ||
      (value.role === "haiku_judge") !== (value.fieldLedger === null) ||
      (value.role === "haiku_judge") === roles.includes("field_ledger")
    )
      context.addIssue({
        code: "custom",
        message: "checkpoint artifact roles and field ledger do not match provider role",
      });
    if (roles.includes("provider_precontext") !== roles.includes("precontext_envelope"))
      context.addIssue({ code: "custom", message: "provider precontext and its envelope must be retained together" });
  });

/** Captured provider/schema failure with complete bytes and accounting; never retried. */
export const DiagnosticsBenchmarkLiveFailedCallCheckpointSchema = z
  .strictObject({
    schemaVersion: z.literal("diagnostics-benchmark-live-failed-call-checkpoint.v1"),
    checkpointDigest: Sha256DigestSchema,
    runIdentityDigest: Sha256DigestSchema,
    experimentManifestDigest: Sha256DigestSchema,
    datasetManifestDigest: Sha256DigestSchema,
    caseId: VerificationIdSchema,
    caseDigest: Sha256DigestSchema,
    role: z.enum(["luna_extractor", "interfaze_extractor", "haiku_judge"]),
    provider: z.enum(["gateway", "interfaze"]),
    model: z.enum(["openai/gpt-5.6-luna", "anthropic/claude-haiku-4.5", "interfaze-beta"]),
    attemptId: UuidSchema,
    providerHttpStatus: z.int().min(100).max(599),
    sourceBinding: DiagnosticsBenchmarkLiveSourceBindingSchema,
    failureClass: z.enum(["provider", "schema"]),
    failureCode: z.enum([
      "PROVIDER_HTTP_FAILURE_CAPTURED",
      "PROVIDER_OUTPUT_SCHEMA_INVALID_CAPTURED",
      "EXTRACTION_FIELD_MATRIX_INVALID_CAPTURED",
    ]),
    adapterFailureCode: z
      .string()
      .min(1)
      .max(80)
      .regex(/^PROVIDER_[A-Z_]+$/u)
      .nullable(),
    artifacts: z.array(DiagnosticsBenchmarkLiveArtifactBytesSchema).min(6).max(8),
    accounting: DiagnosticsBenchmarkLiveAccountingSchema,
    latencyMs: z.int().nonnegative(),
    completedAt: IsoDateTimeSchema,
    automaticRetry: z.literal(false),
  })
  .superRefine((value, context) => {
    const roles = value.artifacts.map((item) => item.role),
      required = [
        "transmission_manifest",
        "provider_input",
        "granted_fragment",
        "request",
        "raw_response",
        "response_envelope",
      ];
    if (new Set(roles).size !== roles.length || required.some((role) => !roles.includes(role as never)))
      context.addIssue({ code: "custom", message: "failed checkpoint lacks the complete captured provider chain" });
    if (roles.includes("provider_precontext") !== roles.includes("precontext_envelope"))
      context.addIssue({
        code: "custom",
        message: "failed checkpoint precontext and its envelope must be retained together",
      });
    if (value.failureCode === "PROVIDER_HTTP_FAILURE_CAPTURED" && value.adapterFailureCode !== "PROVIDER_HTTP_FAILURE")
      context.addIssue({ code: "custom", message: "HTTP failure must preserve its adapter failure code" });
    if (value.failureCode === "EXTRACTION_FIELD_MATRIX_INVALID_CAPTURED" && value.adapterFailureCode !== null)
      context.addIssue({ code: "custom", message: "field matrix failure occurs after adapter acceptance" });
    if (
      value.failureCode === "PROVIDER_OUTPUT_SCHEMA_INVALID_CAPTURED" &&
      (value.adapterFailureCode === null || value.adapterFailureCode === "PROVIDER_HTTP_FAILURE")
    )
      context.addIssue({ code: "custom", message: "schema failure must preserve its non-HTTP adapter failure code" });
  });

export const DiagnosticsBenchmarkProviderCallPlanSchema = z.strictObject({
  role: z.enum(["luna_extractor", "interfaze_extractor", "haiku_judge"]),
  provider: z.enum(["gateway", "interfaze"]),
  model: z.enum(["openai/gpt-5.6-luna", "anthropic/claude-haiku-4.5", "interfaze-beta"]),
  reservationCostMicros: z.int().nonnegative(),
  maximumOutputTokens: z.literal(900),
  maximumRequestUtf8Bytes: z.literal(10_000),
  outputSchemaDigest: Sha256DigestSchema,
  ownerArmId: VerificationIdSchema,
  sharedWithArmIds: z.array(VerificationIdSchema).min(1),
});

export const DiagnosticsBenchmarkExperimentManifestSchema = z.strictObject({
  schemaVersion: z.literal("verification-benchmark-experiment-manifest.v1"),
  manifestDigest: Sha256DigestSchema,
  datasetManifestDigest: Sha256DigestSchema,
  grantDigest: Sha256DigestSchema,
  runnerVersion: NonEmptyStringSchema,
  arms: z.array(VerificationBenchmarkArmSchema).length(4),
  providerCallPlan: z.array(DiagnosticsBenchmarkProviderCallPlanSchema).length(3),
  casePlan: z
    .array(
      z.strictObject({
        caseId: VerificationIdSchema,
        caseDigest: Sha256DigestSchema,
        execution: z.enum(["recorded_exact_reuse", "fresh_dispatch", "local_only"]),
        providerRoles: z.array(z.enum(["luna_extractor", "interfaze_extractor", "haiku_judge"])).max(3),
      }),
    )
    .min(30)
    .max(50),
  repetitions: z.literal(1),
  randomSeed: z.int(),
  networkPolicy: z.literal("allow_listed_providers"),
  concurrency: z.literal(1),
  automaticQualityRetries: z.literal(0),
  maximumFreshProviderCalls: z.int().nonnegative(),
  maximumFreshReservationMicros: z.int().nonnegative(),
  budget: z
    .strictObject({
      originalCeilingMicros: z.int().positive().max(20_000_000),
      preResetSettledAndHeldLiabilityMicros: z.int().nonnegative().max(20_000_000),
      maximumRecoveryBudgetCeilingMicros: z.int().positive().max(20_000_000),
      budgetKey: NonEmptyStringSchema,
      carryForwardProvenanceDigest: Sha256DigestSchema.nullable(),
    })
    .superRefine((value, context) => {
      if (
        value.originalCeilingMicros - value.preResetSettledAndHeldLiabilityMicros !==
        value.maximumRecoveryBudgetCeilingMicros
      )
        context.addIssue({
          code: "custom",
          message: "recovery ceiling must equal original ceiling less retained liabilities",
        });
    }),
  hypothesisFamily: z.array(NonEmptyStringSchema).min(1),
  metricDimensions: z
    .array(
      z.enum([
        "schema",
        "locator",
        "field_mechanics",
        "support",
        "authority",
        "world_correctness",
        "policy",
        "calibration",
        "cost",
        "latency",
        "failure",
      ]),
    )
    .min(1),
  limitations: z.array(NonEmptyStringSchema).min(1),
  createdAt: IsoDateTimeSchema,
});

export const DiagnosticsBenchmarkExtractionExperimentManifestSchema = z
  .strictObject({
    schemaVersion: z.literal("diagnostics-benchmark-extraction-experiment.v1"),
    manifestDigest: Sha256DigestSchema,
    datasetManifestDigest: Sha256DigestSchema,
    grantDigest: Sha256DigestSchema,
    outputSchemaDigest: Sha256DigestSchema,
    runnerVersion: NonEmptyStringSchema,
    arms: z.array(VerificationBenchmarkArmSchema).length(4),
    providerCallPlan: z.array(DiagnosticsBenchmarkProviderCallPlanSchema).length(3),
    casePlan: z
      .array(
        z.strictObject({
          caseId: VerificationIdSchema,
          caseDigest: Sha256DigestSchema,
          execution: z.enum(["fresh_dispatch", "excluded_prior_protocol_smoke", "local_only"]),
          providerRoles: z.array(z.enum(["luna_extractor", "interfaze_extractor", "haiku_judge"])).max(3),
          fields: z
            .array(
              z.strictObject({
                fieldKey: VerificationIdSchema,
                description: z.string().min(1).max(240),
                comparison: z.enum(["exact", "normalized_text"]),
                required: z.boolean(),
              }),
            )
            .max(4),
        }),
      )
      .min(30)
      .max(50),
    repetitions: z.literal(1),
    randomSeed: z.int(),
    networkPolicy: z.literal("allow_listed_providers"),
    concurrency: z.literal(1),
    automaticQualityRetries: z.literal(0),
    maximumFreshProviderCalls: z.int().nonnegative(),
    maximumFreshReservationMicros: z.int().nonnegative(),
    budget: z.strictObject({
      budgetId: UuidSchema,
      budgetKey: NonEmptyStringSchema,
      ceilingMicros: z.int().positive(),
      carriedLiabilityMicros: z.int().nonnegative(),
      carryForwardReceiptDigest: Sha256DigestSchema,
    }),
    hypothesisFamily: z.array(NonEmptyStringSchema).min(1),
    metricDimensions: z
      .array(
        z.enum([
          "schema",
          "locator",
          "field_mechanics",
          "support",
          "authority",
          "world_correctness",
          "policy",
          "calibration",
          "cost",
          "latency",
          "failure",
        ]),
      )
      .min(1),
    limitations: z.array(NonEmptyStringSchema).min(1),
    createdAt: IsoDateTimeSchema,
  })
  .superRefine((value, context) => {
    const fresh = value.casePlan.filter((item) => item.execution === "fresh_dispatch");
    if (fresh.some((item) => item.providerRoles.length !== 3 || item.fields.length < 1))
      context.addIssue({
        code: "custom",
        path: ["casePlan"],
        message: "fresh cases require all three provider roles and at least one extracted field",
      });
    if (value.maximumFreshProviderCalls !== fresh.length * 3)
      context.addIssue({
        code: "custom",
        path: ["maximumFreshProviderCalls"],
        message: "fresh call bound must equal the sealed case-role matrix",
      });
    if (value.maximumFreshReservationMicros > value.budget.ceilingMicros)
      context.addIssue({
        code: "custom",
        path: ["maximumFreshReservationMicros"],
        message: "reservation bound exceeds successor budget",
      });
  });

export const VerificationBenchmarkCaseResultSchema = z.strictObject({
  schemaVersion: VerificationBenchmarkSchemaVersionSchema,
  runId: UuidSchema,
  armId: VerificationIdSchema,
  caseId: VerificationIdSchema,
  repetition: z.int().nonnegative(),
  checkpointContextDigest: Sha256DigestSchema,
  checkpointDigest: Sha256DigestSchema,
  completedAt: IsoDateTimeSchema,
  schemaValid: z.boolean(),
  locatorValid: z.boolean(),
  fieldMechanics: z.boolean(),
  support: z.enum(["full", "partial", "none", "contradicted", "not_applicable"]),
  authority: z.enum(["sufficient", "interested_party_only", "insufficient", "not_applicable"]),
  worldCorrectness: z.enum(["established", "not_established", "contradicted", "unknown", "not_applicable"]),
  policy: z.enum(["pass", "pass_with_warnings", "review", "fail", "abstain"]),
  confidence: z.number().min(0).max(1).nullable(),
  confidenceCalibrated: z.boolean(),
  failureClass: z.enum(["none", "provider", "network", "timeout", "schema", "policy", "local"]),
  callAttributions: z.array(VerificationBenchmarkCallAttributionSchema),
});

/** Immutable offline experiment artifact, separate from runtime operation context. */
export const VerificationBenchmarkExperimentDefinitionSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-benchmark-experiment.v1"),
    verificationContractVersion: VerificationContractVersionSchema,
    experimentId: VerificationIdSchema,
    datasetManifestDigest: Sha256DigestSchema,
    runnerVersion: z.literal("verification-benchmark-runner.v1"),
    randomSeed: z.int(),
    repetitions: z.int().min(1).max(10),
    arms: z.array(VerificationBenchmarkArmSchema).min(2).max(16),
    networkPolicy: z.literal("offline"),
    recordedObservationArtifacts: z
      .array(z.strictObject({ artifactId: UuidSchema, digest: Sha256DigestSchema }))
      .max(512),
  })
  .superRefine((input, context) => {
    if (
      input.arms.filter((arm) => arm.control).length !== 1 ||
      new Set(input.arms.map((arm) => arm.armId)).size !== input.arms.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["arms"],
        message: "Experiment arms must be unique with exactly one control",
      });
    }
    if (
      new Set(input.recordedObservationArtifacts.map((artifact) => artifact.artifactId)).size !==
      input.recordedObservationArtifacts.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["recordedObservationArtifacts"],
        message: "Recorded observation artifact IDs must be unique",
      });
    }
  });
export type VerificationBenchmarkExperimentDefinition = z.infer<typeof VerificationBenchmarkExperimentDefinitionSchema>;

export const RunVerificationBenchmarkInputSchema = z
  .strictObject({
    verificationContractVersion: VerificationContractVersionSchema,
    context: VerificationOperationContextSchema,
    dataset: VerificationBenchmarkDatasetSchema,
    experimentId: VerificationIdSchema,
    experimentDefinitionDigest: Sha256DigestSchema,
    randomSeed: z.int(),
    repetitions: z.int().positive().max(10),
    arms: z.array(VerificationBenchmarkArmSchema).min(2).max(16),
    networkPolicy: z.enum(["offline", "allow_listed_providers"]),
  })
  .superRefine((input, context) => {
    if (input.arms.filter((arm) => arm.control).length !== 1)
      context.addIssue({ code: "custom", path: ["arms"], message: "exactly one benchmark arm must be the control" });
    if (new Set(input.arms.map((arm) => arm.armId)).size !== input.arms.length)
      context.addIssue({ code: "custom", path: ["arms"], message: "benchmark arm ids must be unique" });
  });
export type RunVerificationBenchmarkInput = z.infer<typeof RunVerificationBenchmarkInputSchema>;

export const CompareVerificationBenchmarkRunsInputSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  context: VerificationOperationContextSchema,
  baselineRunManifestDigest: Sha256DigestSchema,
  candidateRunManifestDigest: Sha256DigestSchema,
  paired: z.literal(true),
  clusterUnit: z.enum(["source_family", "report_cluster"]),
  confidenceLevel: z.literal(0.95),
  bootstrapReplicates: z.int().min(100).max(10_000),
  correction: z.enum(["none", "holm"]),
});

export type VerificationBenchmarkDataset = z.infer<typeof VerificationBenchmarkDatasetSchema>;
export type VerificationBenchmarkCase = z.infer<typeof VerificationBenchmarkCaseSchema>;
export type VerificationBenchmarkArm = z.infer<typeof VerificationBenchmarkArmSchema>;
export type VerificationBenchmarkCaseResult = z.infer<typeof VerificationBenchmarkCaseResultSchema>;
export type DiagnosticsBenchmarkSupportOutput = z.infer<typeof DiagnosticsBenchmarkSupportOutputSchema>;
export type DiagnosticsBenchmarkExtractionOutput = z.infer<typeof DiagnosticsBenchmarkExtractionOutputSchema>;
export type DiagnosticsBenchmarkProviderObservation = z.infer<typeof DiagnosticsBenchmarkProviderObservationSchema>;
export type DiagnosticsBenchmarkLiveCallCheckpoint = z.infer<typeof DiagnosticsBenchmarkLiveCallCheckpointSchema>;
export type DiagnosticsBenchmarkLiveFailedCallCheckpoint = z.infer<
  typeof DiagnosticsBenchmarkLiveFailedCallCheckpointSchema
>;
export type DiagnosticsBenchmarkExperimentManifest = z.infer<typeof DiagnosticsBenchmarkExperimentManifestSchema>;
export type DiagnosticsBenchmarkExtractionExperimentManifest = z.infer<
  typeof DiagnosticsBenchmarkExtractionExperimentManifestSchema
>;
export type VerificationBenchmarkAnnotation = z.infer<typeof VerificationBenchmarkAnnotationSchema>;
export type VerificationBenchmarkAdjudication = z.infer<typeof VerificationBenchmarkAdjudicationSchema>;
