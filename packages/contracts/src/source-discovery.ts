import { z } from "zod";
import {
  IsoDateTimeSchema,
  JsonValueSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  UuidSchema,
} from "./primitives.js";
import { VerificationArtifactHandleSchema } from "./verification/primitives.js";
const ProviderCodeSchema = NonEmptyStringSchema.max(128);
const UrlSchema = z.string().url().max(8192);
const IdempotencyKeySchema = NonEmptyStringSchema.max(256);
const ResultDispositionSchema = z.enum(["selected", "omitted", "duplicate", "unreviewed"]);
const FailureCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/u);
export const SourceDiscoveryResultSchema = z.strictObject({
  providerResultId: NonEmptyStringSchema.max(256).optional(),
  rank: z.int().positive().max(10000),
  requestedUrl: UrlSchema,
  finalUrl: UrlSchema,
  redirectUrls: z.array(UrlSchema).max(32),
  disposition: ResultDispositionSchema,
  sourceClass: z.enum(["web_page", "api", "repository", "pdf", "transcript", "dataset", "registry", "other"]),
  captureId: UuidSchema.optional(),
  title: NonEmptyStringSchema.max(2000).optional(),
  snippet: NonEmptyStringSchema.max(16000).optional(),
  payloadDigest: Sha256DigestSchema,
});
export type SourceDiscoveryResult = z.infer<typeof SourceDiscoveryResultSchema>;
const requestCore = z.strictObject({
  providerCode: ProviderCodeSchema,
  providerVersion: NonEmptyStringSchema.max(128).default("unspecified"),
  queryText: NonEmptyStringSchema.max(8000),
  purpose: NonEmptyStringSchema.max(2000),
  parameters: JsonValueSchema,
  requestedUrls: z.array(UrlSchema).max(256),
});
/** The service, not a caller, assigns managed origin after it dispatches through a host provider port. */
export const ManagedSourceDiscoveryRequestSchema = requestCore.extend({
  schemaVersion: z.literal("source-discovery-managed-request.v1"),
  idempotencyKey: IdempotencyKeySchema,
  retryOfAttemptId: UuidSchema.optional(),
});
export type ManagedSourceDiscoveryRequest = z.infer<typeof ManagedSourceDiscoveryRequestSchema>;
export const ImportedSourceDiscoveryReceiptSchema = requestCore
  .extend({
    schemaVersion: z.literal("source-discovery-import-receipt.v1"),
    idempotencyKey: IdempotencyKeySchema,
    retryOfAttemptId: UuidSchema.optional(),
    externalAttemptId: NonEmptyStringSchema.max(256).optional(),
    occurredAt: IsoDateTimeSchema,
    selfReported: z.literal(true),
    externalReceiptArtifact: VerificationArtifactHandleSchema,
    rawOutputArtifact: VerificationArtifactHandleSchema.optional(),
    state: z.enum(["succeeded", "failed", "uncertain", "cancelled"]),
    failureCode: FailureCodeSchema.optional(),
    results: z.array(SourceDiscoveryResultSchema).max(10000),
  })
  .superRefine((value, context) => {
    if (value.state === "succeeded" && value.failureCode !== undefined)
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "successful import cannot carry a failure code",
      });
    if (value.state !== "succeeded" && value.failureCode === undefined)
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "non-success import requires a failure code",
      });
    if (value.state !== "succeeded" && value.results.length !== 0)
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "failed imports cannot expose result leads",
      });
  });
export type ImportedSourceDiscoveryReceipt = z.infer<typeof ImportedSourceDiscoveryReceiptSchema>;
export const SourceDiscoveryAttemptStateSchema = z.enum(["started", "succeeded", "failed", "uncertain", "cancelled"]);
export const SourceDiscoveryAttemptSchema = z.strictObject({
  attemptId: UuidSchema,
  origin: z.enum(["managed", "imported"]),
  providerCode: ProviderCodeSchema,
  providerVersion: NonEmptyStringSchema.max(128),
  rootAttemptId: UuidSchema,
  retryOfAttemptId: UuidSchema.optional(),
  attemptOrdinal: z.int().nonnegative(),
  accountingCompleteness: z.enum(["complete", "partial"]),
  trust: z.enum(["managed_host", "self_reported"]),
  state: SourceDiscoveryAttemptStateSchema,
  requestArtifact: VerificationArtifactHandleSchema,
  rawOutputArtifact: VerificationArtifactHandleSchema.optional(),
  completionArtifact: VerificationArtifactHandleSchema.optional(),
  externalReceiptArtifact: VerificationArtifactHandleSchema.optional(),
  resultCount: z.int().nonnegative(),
  failureCode: FailureCodeSchema.optional(),
  completedAt: IsoDateTimeSchema.optional(),
});
export type SourceDiscoveryAttempt = z.infer<typeof SourceDiscoveryAttemptSchema>;
export const SourceDiscoveryLeadReadSchema = z.strictObject({
  rank: z.int().positive(),
  requestedUrl: UrlSchema,
  finalUrl: UrlSchema,
  redirectUrls: z.array(UrlSchema),
  disposition: ResultDispositionSchema,
  captureId: UuidSchema.optional(),
});
export const SourceDiscoveryAttemptReadSchema = z.strictObject({
  selectionArtifacts: z.array(VerificationArtifactHandleSchema).max(200).default([]),
  attempt: SourceDiscoveryAttemptSchema,
  /** Started attempts remain visible for reconciliation, but never contain leads. */
  results: z.array(SourceDiscoveryLeadReadSchema).max(200),
  page: z.strictObject({
    offset: z.int().nonnegative(),
    limit: z.int().min(1).max(200),
    total: z.int().nonnegative(),
    hasMore: z.boolean(),
  }),
});
export type SourceDiscoveryAttemptRead = z.infer<typeof SourceDiscoveryAttemptReadSchema>;
export const SourceDiscoveryReadOptionsSchema = z.strictObject({
  offset: z.int().nonnegative().default(0),
  limit: z.int().min(1).max(200).default(100),
});
export type SourceDiscoveryReadOptions = z.input<typeof SourceDiscoveryReadOptionsSchema>;
export const SourceDiscoveryCompletionEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal("source-discovery-completion.v1"),
    tenantId: UuidSchema,
    attemptId: UuidSchema,
    requestArtifact: VerificationArtifactHandleSchema,
    originalDispatchToken: UuidSchema,
    originalFencingToken: z.int().positive(),
    state: z.enum(["succeeded", "failed", "uncertain", "cancelled"]),
    failureCode: FailureCodeSchema.optional(),
    results: z.array(SourceDiscoveryResultSchema).max(10000),
    rawOutput: z.strictObject({
      encoding: z.literal("base64"),
      base64: z.string().max(16000000),
      digest: Sha256DigestSchema,
      byteLength: z.int().min(0).max(12000000),
    }),
    observedAt: IsoDateTimeSchema,
  })
  .superRefine((value, context) => {
    if ((value.state === "succeeded") !== (value.failureCode === undefined))
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "completion failure/state mismatch",
      });
    if (value.state !== "succeeded" && value.results.length)
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "non-success cannot expose leads",
      });
    if (value.tenantId !== value.requestArtifact.tenantId)
      context.addIssue({
        code: "custom",
        path: ["requestArtifact"],
        message: "completion tenant mismatch",
      });
    if (new Set(value.results.map((result) => result.rank)).size !== value.results.length)
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "completion ranks must be unique",
      });
  });
export type SourceDiscoveryCompletionEnvelope = z.infer<typeof SourceDiscoveryCompletionEnvelopeSchema>;
export const SourceDiscoverySelectionRequestSchema = z
  .strictObject({
    schemaVersion: z.literal("source-discovery-selection.v1"),
    attemptId: UuidSchema,
    idempotencyKey: IdempotencyKeySchema,
    decisions: z
      .array(
        z.strictObject({
          rank: z.int().positive().max(10000),
          disposition: z.enum(["selected", "omitted", "duplicate"]),
          reason: NonEmptyStringSchema.max(2000),
        }),
      )
      .min(1)
      .max(10000),
  })
  .superRefine((value, context) => {
    if (new Set(value.decisions.map((decision) => decision.rank)).size !== value.decisions.length)
      context.addIssue({
        code: "custom",
        path: ["decisions"],
        message: "decision ranks must be unique",
      });
  });
export type SourceDiscoverySelectionRequest = z.infer<typeof SourceDiscoverySelectionRequestSchema>;
export const SourceDiscoverySelectionReceiptSchema = z.strictObject({
  attemptId: UuidSchema,
  selectionArtifact: VerificationArtifactHandleSchema,
  decisionCount: z.int().nonnegative(),
  revision: z.int().positive(),
});
export type SourceDiscoverySelectionReceipt = z.infer<typeof SourceDiscoverySelectionReceiptSchema>;
