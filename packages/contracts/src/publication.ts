import { z } from "zod";
import { ImmutableResourceSchema, NonEmptyStringSchema, Sha256DigestSchema, UuidSchema } from "./primitives.js";
import { VectorSpaceSchema } from "./spaces.js";

export const SearchProjectionSchema = ImmutableResourceSchema.extend({
  targetKind: NonEmptyStringSchema,
  targetSchemaVersion: NonEmptyStringSchema,
  targetRecordId: UuidSchema,
  space: VectorSpaceSchema,
  procedureVersionId: UuidSchema,
  text: NonEmptyStringSchema,
  textDigest: Sha256DigestSchema,
  supportSetDigest: Sha256DigestSchema,
  state: z.enum(["candidate", "validated", "approved", "published", "rejected", "superseded", "withdrawn"]),
});
export type SearchProjection = z.infer<typeof SearchProjectionSchema>;

export const EmbeddingItemSchema = ImmutableResourceSchema.extend({
  embeddingRunId: UuidSchema,
  searchProjectionId: UuidSchema,
  inputDigest: Sha256DigestSchema,
  outputDigest: Sha256DigestSchema,
  dimensions: z.int().positive(),
  cacheIdentity: NonEmptyStringSchema.optional(),
  state: z.enum(["pending", "embedded", "verified", "failed"]),
  providerItemId: NonEmptyStringSchema.optional(),
});
export const EmbeddingRunSchema = ImmutableResourceSchema.extend({
  vectorSpaceVersionId: UuidSchema,
  adapterVersion: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  providerRoute: NonEmptyStringSchema,
  orderedManifestDigest: Sha256DigestSchema,
  operationId: UuidSchema,
  attemptId: UuidSchema,
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  inputCount: z.int().nonnegative(),
  outputCount: z.int().nonnegative(),
  usageTokens: z.int().nonnegative(),
  costMicros: z.int().nonnegative(),
  receiptId: UuidSchema.optional(),
});
export type EmbeddingRun = z.infer<typeof EmbeddingRunSchema>;

export const VectorPublicationSchema = ImmutableResourceSchema.extend({
  vectorStoreId: UuidSchema,
  space: VectorSpaceSchema,
  vectorSpaceVersionId: UuidSchema,
  sourceManifestDigest: Sha256DigestSchema,
  representationManifestDigest: Sha256DigestSchema,
  chunkSetManifestDigest: Sha256DigestSchema,
  projectionManifestDigest: Sha256DigestSchema,
  embeddingManifestDigest: Sha256DigestSchema,
  indexManifestDigest: Sha256DigestSchema,
  retrievalPolicyVersionId: UuidSchema,
  evaluationGateResultId: UuidSchema,
  promotionDecisionId: UuidSchema,
  state: z.enum(["draft", "evaluated", "approved", "publishing", "published", "superseded", "withdrawn"]),
  predecessorId: UuidSchema.optional(),
  publishedItemCount: z.int().nonnegative(),
  dimensions: z.int().positive(),
  receiptId: UuidSchema.optional(),
});
export type VectorPublication = z.infer<typeof VectorPublicationSchema>;
