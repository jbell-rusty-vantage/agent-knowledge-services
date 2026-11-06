import { z } from "zod";
import { NonEmptyStringSchema, Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationContractVersionSchema, VerificationIdSchema } from "./primitives.js";
import { ExternalExecutionContextSchema } from "../identity.js";
import { ParseArtifactRequestSchema } from "./parse.js";

/** Header-carried routing hints. The API must authenticate their ownership before creating OperationContext. */
export const VerificationOperationContextHintsSchema = z.strictObject({
  attemptId: UuidSchema.optional(),
  workItemId: UuidSchema.optional(),
  missionId: UuidSchema.optional(),
  causationId: NonEmptyStringSchema.optional(),
  externalExecution: ExternalExecutionContextSchema.optional(),
});
export type VerificationOperationContextHints = z.infer<typeof VerificationOperationContextHintsSchema>;

/**
 * Public route payloads. Authentication, operation context, artifact tenancy,
 * and trusted runtime/reviewer identity are outer application concerns.
 */
const RequestVersionSchema = z.strictObject({ verificationContractVersion: VerificationContractVersionSchema });
const ArtifactInputSchema = z.strictObject({ artifactId: UuidSchema, digest: Sha256DigestSchema });
const CaptureIdsSchema = z
  .array(VerificationIdSchema)
  .min(1)
  .max(100)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "capture IDs must be unique" });
  });
const SourceUriSchema = z
  .string()
  .max(2_048)
  .superRefine((value, context) => {
    try {
      const url = new URL(value);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "")
        context.addIssue({ code: "custom", message: "source URI must be credential-free HTTP(S)" });
    } catch {
      context.addIssue({ code: "custom", message: "source URI must be a valid absolute URL" });
    }
  });
const SourceKindSchema = z.enum([
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
const CaptureSourceInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("acquire"), sourceKind: SourceKindSchema, sourceUri: SourceUriSchema }),
  z.strictObject({
    mode: z.literal("register"),
    sourceKind: SourceKindSchema,
    sourceId: VerificationIdSchema,
    contentArtifact: ArtifactInputSchema,
  }),
]);

export const CaptureSourceRequestSchema = RequestVersionSchema.extend({
  source: CaptureSourceInputSchema,
  requestedProjectionKinds: z
    .array(
      z.enum([
        "native_text",
        "canonical_json",
        "html_dom",
        "pdf_text",
        "geometry",
        "ocr_geometry",
        "table_grid",
        "transcript",
      ]),
    )
    .min(1)
    .max(4),
}).superRefine((value, context) => {
  if (new Set(value.requestedProjectionKinds).size !== value.requestedProjectionKinds.length)
    context.addIssue({
      code: "custom",
      path: ["requestedProjectionKinds"],
      message: "projection kinds must be unique",
    });
});

export const ExtractStructuredDataRequestSchema = RequestVersionSchema.extend({
  captureId: VerificationIdSchema,
  representation: ArtifactInputSchema,
  extractionSchema: ArtifactInputSchema,
  extractionProfile: z.literal("registered_default"),
});

export const VerifyExtractionRequestSchema = RequestVersionSchema.extend({
  captureIds: CaptureIdsSchema,
  extractionSchema: ArtifactInputSchema,
  extractionOutput: ArtifactInputSchema,
});

export const RunBenchmarkRequestSchema = RequestVersionSchema.extend({
  dataset: ArtifactInputSchema,
  experimentDefinition: ArtifactInputSchema,
  executionMode: z.literal("offline_recorded"),
});

export const CompareBenchmarkRunsRequestSchema = RequestVersionSchema.extend({
  baselineRunId: VerificationIdSchema,
  candidateRunId: VerificationIdSchema,
  comparisonProfile: z.enum(["paired_default", "regression_gate"]),
}).refine((value) => value.baselineRunId !== value.candidateRunId, {
  path: ["candidateRunId"],
  message: "candidate run must differ from baseline",
});

export const ReplayRunRequestSchema = RequestVersionSchema.extend({
  runId: VerificationIdSchema,
  replayMode: z.enum(["deterministic_only", "recorded_provider_outputs"]),
});

export const GetVerificationOperationRequestSchema = RequestVersionSchema.extend({ operationId: UuidSchema });
export const VerificationMutationRequestSchema = z.discriminatedUnion("useCase", [
  z.strictObject({ useCase: z.literal("captureSource"), request: CaptureSourceRequestSchema }),
  z.strictObject({ useCase: z.literal("parseArtifact"), request: ParseArtifactRequestSchema }),
  z.strictObject({ useCase: z.literal("extractStructuredData"), request: ExtractStructuredDataRequestSchema }),
  z.strictObject({ useCase: z.literal("verifyExtraction"), request: VerifyExtractionRequestSchema }),
  z.strictObject({ useCase: z.literal("runBenchmark"), request: RunBenchmarkRequestSchema }),
  z.strictObject({ useCase: z.literal("compareBenchmarkRuns"), request: CompareBenchmarkRunsRequestSchema }),
  z.strictObject({ useCase: z.literal("replayRun"), request: ReplayRunRequestSchema }),
]);

export type CaptureSourceRequest = z.infer<typeof CaptureSourceRequestSchema>;
export type ExtractStructuredDataRequest = z.infer<typeof ExtractStructuredDataRequestSchema>;
export type VerifyExtractionRequest = z.infer<typeof VerifyExtractionRequestSchema>;
export type RunBenchmarkRequest = z.infer<typeof RunBenchmarkRequestSchema>;
export type CompareBenchmarkRunsRequest = z.infer<typeof CompareBenchmarkRunsRequestSchema>;
export type ReplayRunRequest = z.infer<typeof ReplayRunRequestSchema>;
export type GetVerificationOperationRequest = z.infer<typeof GetVerificationOperationRequestSchema>;
export type VerificationMutationRequest = z.infer<typeof VerificationMutationRequestSchema>;
