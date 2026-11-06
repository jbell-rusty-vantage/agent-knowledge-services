import { z } from "zod";
import {
  IsoDateTimeSchema,
  JsonValueSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  UuidSchema,
} from "./index-primitives.js";
import {
  CanonicalizationDescriptorSchema,
  VerificationContractVersionSchema,
  VerificationErrorSchema,
  VerificationIdSchema,
  VerificationOperationContextSchema,
} from "./primitives.js";
import {
  AssertionSchema,
  DeterministicVerificationResultSchema,
  JudgmentSchema,
  LineageEdgeSchema,
  VerificationMetricObservationSchema,
  PolicyOutcomeSchema,
  VerificationBundleSchema,
} from "./model.js";
import { VerificationArtifactHandleSchema } from "./primitives.js";

export const VerificationUseCaseSchema = z.enum([
  "captureSource",
  "parseArtifact",
  "extractStructuredData",
  "verifyExtraction",
  "runBenchmark",
  "compareBenchmarkRuns",
  "replayRun",
]);

export const VerificationCommandSchema = z.strictObject({
  context: VerificationOperationContextSchema,
  useCase: VerificationUseCaseSchema,
  inputManifestArtifactId: UuidSchema,
  inputManifestDigest: Sha256DigestSchema,
  parameters: z.record(z.string(), JsonValueSchema),
});
export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;

export const VerifyBundleInputSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  context: VerificationOperationContextSchema,
  bundle: VerificationBundleSchema,
});
export type VerifyBundleInput = z.infer<typeof VerifyBundleInputSchema>;

export const VerifyExtractionInputSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  context: VerificationOperationContextSchema,
  captureIds: z.array(VerificationIdSchema).min(1),
  assertions: z.array(AssertionSchema).min(1),
  extractionSchemaArtifactId: UuidSchema,
  extractionOutputArtifactId: UuidSchema,
});

export const VerifyClaimsInputSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  context: VerificationOperationContextSchema,
  captureIds: z.array(VerificationIdSchema).min(1),
  assertions: z.array(AssertionSchema).min(1),
});

export const VerifyMetricObservationInputSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  context: VerificationOperationContextSchema,
  captureIds: z.array(VerificationIdSchema).min(1),
  observations: z.array(VerificationMetricObservationSchema).min(1),
});

export const VerificationOperationReceiptSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  operationId: UuidSchema,
  receiptId: UuidSchema,
  state: z.enum(["accepted", "running", "succeeded", "failed", "cancelled"]),
  inputManifestDigest: Sha256DigestSchema,
  outputManifestDigest: Sha256DigestSchema.optional(),
  resultArtifactIds: z.array(UuidSchema),
  error: VerificationErrorSchema.optional(),
  updatedAt: IsoDateTimeSchema,
});

export const VerificationEventSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  eventId: UuidSchema,
  operationId: UuidSchema,
  sequence: z.int().nonnegative(),
  eventType: z.enum([
    "accepted",
    "stage_started",
    "stage_completed",
    "checkpointed",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  stage: NonEmptyStringSchema,
  payloadArtifactId: UuidSchema.optional(),
  payloadDigest: Sha256DigestSchema.optional(),
  occurredAt: IsoDateTimeSchema,
});

export const VerificationRunManifestSchema = z
  .strictObject({
    verificationContractVersion: VerificationContractVersionSchema,
    manifestId: VerificationIdSchema,
    runId: VerificationIdSchema,
    datasetId: VerificationIdSchema.optional(),
    datasetVersionDigest: Sha256DigestSchema.optional(),
    experimentDefinitionDigest: Sha256DigestSchema.optional(),
    variantId: VerificationIdSchema.optional(),
    versions: z.strictObject({
      policy: NonEmptyStringSchema,
      schema: NonEmptyStringSchema,
      grader: NonEmptyStringSchema.optional(),
      parser: NonEmptyStringSchema.optional(),
      normalizer: NonEmptyStringSchema,
      extractor: NonEmptyStringSchema.optional(),
      prompt: Sha256DigestSchema.optional(),
    }),
    code: z.strictObject({
      gitSha: NonEmptyStringSchema,
      dirty: z.boolean(),
      dirtyStateArtifactId: UuidSchema.optional(),
    }),
    runtime: z.strictObject({
      container: NonEmptyStringSchema.optional(),
      platform: NonEmptyStringSchema,
      deploymentId: VerificationIdSchema,
    }),
    provider: z
      .strictObject({
        endpointIdentity: NonEmptyStringSchema,
        model: NonEmptyStringSchema,
        nativeConfiguration: z.record(z.string(), JsonValueSchema),
        pricingSnapshotArtifactId: UuidSchema,
      })
      .optional(),
    inputArtifacts: z.array(VerificationArtifactHandleSchema),
    outputArtifacts: z.array(VerificationArtifactHandleSchema),
    stages: z.array(
      z.strictObject({
        name: NonEmptyStringSchema,
        status: z.enum(["succeeded", "failed", "skipped"]),
        startedAt: IsoDateTimeSchema,
        endedAt: IsoDateTimeSchema,
      }),
    ),
    calls: z.array(
      z
        .strictObject({
          providerResponseId: NonEmptyStringSchema.optional(),
          requestDigest: Sha256DigestSchema,
          responseArtifactId: UuidSchema.optional(),
          retries: z.int().nonnegative(),
          /** Reservation is always known before dispatch; it is not a billed-cost claim. */
          reservationCostMicros: z.int().positive(),
          costState: z.enum(["reserved", "estimated", "actual", "unknown_dispatched"]),
          estimatedCostMicros: z.int().nonnegative().optional(),
          actualCostMicros: z.int().nonnegative().optional(),
        })
        .superRefine((call, context) => {
          if (call.costState === "actual" && call.actualCostMicros === undefined)
            context.addIssue({
              code: "custom",
              path: ["actualCostMicros"],
              message: "actual cost requires an observed provider amount",
            });
          if (call.costState === "estimated" && call.estimatedCostMicros === undefined)
            context.addIssue({
              code: "custom",
              path: ["estimatedCostMicros"],
              message: "estimated cost requires a pricing-derived amount",
            });
          if (
            call.costState === "unknown_dispatched" &&
            (call.actualCostMicros !== undefined || call.estimatedCostMicros !== undefined)
          )
            context.addIssue({
              code: "custom",
              path: ["costState"],
              message: "unknown dispatched calls cannot represent unknown cost as zero or an ungrounded estimate",
            });
          if (call.actualCostMicros !== undefined && call.actualCostMicros > call.reservationCostMicros)
            context.addIssue({
              code: "custom",
              path: ["actualCostMicros"],
              message: "actual cost may not exceed the conservative reservation",
            });
          if (call.estimatedCostMicros !== undefined && call.estimatedCostMicros > call.reservationCostMicros)
            context.addIssue({
              code: "custom",
              path: ["estimatedCostMicros"],
              message: "estimate may not exceed the conservative reservation",
            });
        }),
    ),
    randomSeed: z.int().optional(),
    toolPolicy: z.array(NonEmptyStringSchema),
    networkPolicy: z.enum(["disabled", "allowlisted", "unrestricted"]),
    deterministicResult: DeterministicVerificationResultSchema,
    judgments: z.array(JudgmentSchema),
    policyOutcome: PolicyOutcomeSchema,
    resultDigest: Sha256DigestSchema,
    gateDigest: Sha256DigestSchema.optional(),
    lineage: z.array(LineageEdgeSchema),
    replayOfRunId: VerificationIdSchema.optional(),
    canonicalization: CanonicalizationDescriptorSchema,
    signatureArtifactId: UuidSchema.optional(),
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema,
  })
  .superRefine((manifest, context) => {
    if (Date.parse(manifest.completedAt) < Date.parse(manifest.startedAt))
      context.addIssue({ code: "custom", path: ["completedAt"], message: "completedAt must not precede startedAt" });
  });
export type VerificationRunManifest = z.infer<typeof VerificationRunManifestSchema>;

export const VerificationResultEnvelopeSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  operationId: UuidSchema,
  receipt: VerificationOperationReceiptSchema,
  manifest: VerificationRunManifestSchema,
});
