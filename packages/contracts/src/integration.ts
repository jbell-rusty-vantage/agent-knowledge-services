import { z } from "zod";
import { OperationContextSchema } from "./identity.js";
import {
  ContractVersionSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  UuidSchema,
} from "./primitives.js";
import { VerificationFailureCategorySchema } from "./verification/primitives.js";

export const OperationKindSchema = z.enum([
  "source_discovery",
  "source_resolution",
  "capture",
  "capture_inspection",
  "capture_comparison",
  "source_vetting",
  "vector_store_create",
  "vector_store_documents",
  "vector_store_ingestion",
  "vector_store_search",
  "vector_store_evaluation",
  "document",
  "document_version",
  "representation",
  "transformation",
  "representation_inspection",
  "representation_comparison",
  "representation_decision",
  "chunk_preview",
  "chunk_comparison",
  "chunk_set",
  "chunk_set_inspection",
  "promotion_proposal",
  "promotion_decision",
  "embedding_run",
  "space_publication",
  "publication_verification",
  "publication_rollback",
  "retrieval_run",
  "evidence_packet",
  "evaluation_dataset",
  "experiment",
  "evaluation_run",
  "review",
  "review_decision",
  "verification_capture",
  "verification_extraction",
  "verification_replay",
  "verification_parse_artifact",
  "verification_benchmark",
  "verification_benchmark_compare",
  "verification_structured_extraction",
]);
export type OperationKind = z.infer<typeof OperationKindSchema>;

export const MutationEnvelopeSchema = z.strictObject({
  context: OperationContextSchema,
  input: JsonValueSchema,
  expectedVersions: z
    .record(z.string(), NonEmptyStringSchema)
    .refine((versions) => Object.keys(versions).length > 0, "at least one expected contract version is required"),
});
export type MutationEnvelope = z.infer<typeof MutationEnvelopeSchema>;

/** Compact, receipt-derived public summary. The raw receipt body and message stay private. */
export const OperationFailureClassSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/u);
export const OperationFailureSummarySchema = z.strictObject({
  receiptId: UuidSchema,
  category: VerificationFailureCategorySchema,
  errorClass: OperationFailureClassSchema,
  retryable: z.boolean(),
  qualityFailure: z.boolean(),
});
export type OperationFailureSummary = z.infer<typeof OperationFailureSummarySchema>;

export const OperationStatusSchema = z.strictObject({
  operationId: UuidSchema,
  kind: OperationKindSchema,
  state: z.enum(["queued", "running", "needs_review", "quarantined", "succeeded", "failed", "cancelled"]),
  context: OperationContextSchema,
  inputDigest: Sha256DigestSchema,
  rowVersion: z.int().positive(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  receiptIds: z.array(UuidSchema),
  failure: OperationFailureSummarySchema.optional(),
});
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export const AcceptedOperationSchema = z.strictObject({
  operationId: UuidSchema,
  state: z.literal("queued"),
  contractVersion: ContractVersionSchema,
  statusUrl: z.string().url(),
  eventStreamUrl: z.string().url(),
  cancellationUrl: z.string().url(),
  retryUrl: z.string().url(),
  reconcileUrl: z.string().url(),
});
export type AcceptedOperation = z.infer<typeof AcceptedOperationSchema>;
export const VerificationProfileCaptureAcceptedSchema = z.strictObject({
  tenantId: UuidSchema,
  operation: AcceptedOperationSchema,
});
export type VerificationProfileCaptureAccepted = z.infer<typeof VerificationProfileCaptureAcceptedSchema>;

export const CallbackEnvelopeSchema = z.strictObject({
  callbackId: UuidSchema,
  tenantId: UuidSchema,
  taskId: UuidSchema,
  operationId: UuidSchema,
  correlationId: NonEmptyStringSchema,
  causationId: NonEmptyStringSchema.optional(),
  occurredAt: IsoDateTimeSchema,
  payload: JsonValueSchema,
  payloadDigest: Sha256DigestSchema,
  signature: NonEmptyStringSchema,
  signatureVersion: z.literal("hmac-sha256-v1"),
});
export type CallbackEnvelope = z.infer<typeof CallbackEnvelopeSchema>;

export const CallbackAcknowledgementSchema = z.strictObject({
  callbackId: UuidSchema,
  operationId: UuidSchema,
  state: z.literal("accepted"),
  receivedAt: IsoDateTimeSchema,
});
export type CallbackAcknowledgement = z.infer<typeof CallbackAcknowledgementSchema>;

export const ExploratoryBundleDescriptorSchema = z.strictObject({
  schema_version: z.literal("ai-engineer-embedding-bundle/0.1.0"),
  store_class: z.literal("internal_exploratory"),
  video_id: z.enum(["kTnfJszFxCg", "bk0TmxoZlUY", "rmvDxxNubIg"]),
  evaluation_scope: NonEmptyStringSchema.max(128),
});
export type ExploratoryBundleDescriptor = z.infer<typeof ExploratoryBundleDescriptorSchema>;

export const ExploratoryEvaluationInputSchema = z
  .strictObject({
    mode: z.literal("three_bundle_internal_exploratory"),
    bundles: z.array(ExploratoryBundleDescriptorSchema).length(3),
  })
  .superRefine((input, context) => {
    const expected = new Set(ExploratoryBundleDescriptorSchema.shape.video_id.options);
    const actual = new Set(input.bundles.map((bundle) => bundle.video_id));
    if (actual.size !== expected.size || [...expected].some((id) => !actual.has(id)))
      context.addIssue({
        code: "custom",
        path: ["bundles"],
        message: "bundles must contain each allow-listed exploratory video exactly once",
      });
  });
export type ExploratoryEvaluationInput = z.infer<typeof ExploratoryEvaluationInputSchema>;
