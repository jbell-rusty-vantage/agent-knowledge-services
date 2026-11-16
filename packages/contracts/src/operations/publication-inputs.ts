import { z } from "zod";
import {
  SelectedCandidateEvaluationInputSchema,
  SelectedCandidateIndexInputSchema,
  VectorStoreIngestionInputSchema,
} from "../vector-store.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Input of the `embedding_run` operation: embed approved projections into one vector-space version. */
export const EmbeddingRunInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.embedding-run/v1"),
  vectorSpaceVersionId: z.uuid(),
  promotionDecisionId: z.uuid(),
  projectionIds: z.array(z.uuid()).min(1),
  providerRoute: z.array(z.string().trim().min(1)).min(1),
  expectedDimensions: z.literal(1536),
  modelSlug: z.string().trim().min(1),
});

const BaselineQuerySchema = z.strictObject({
  queryId: z.string().trim().min(1).max(256),
  embedding: z.array(z.number().finite()).length(1_536),
});

/** Input of the `space_publication` operation: make one evaluated vector-space version the active one. */
export const SpacePublicationInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.space-publication/v1"),
  vectorStoreSpaceId: z.uuid(),
  vectorSpaceVersionId: z.uuid(),
  promotionDecisionId: z.uuid(),
  evaluationResultId: z.uuid(),
  expectedOwnerIdentity: z.string().trim().min(1),
  guardedDigest: digestSchema,
  reason: z.string().trim().min(1),
  /** Present whenever the space publishes an evaluated selected candidate rather than the legacy counted chain. */
  candidate: SelectedCandidateIndexInputSchema.optional(),
  candidateEvidenceDigest: digestSchema.optional(),
  evaluationDigest: digestSchema.optional(),
});

/** Input of the `publication_rollback` operation: switch the active pointer back to an earlier publication. */
export const PublicationRollbackInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.publication-rollback/v1"),
  currentPublicationId: z.uuid(),
  targetPublicationId: z.uuid(),
  guardedDigest: digestSchema,
  reason: z.string().trim().min(1),
  vectorStoreSpaceId: z.uuid().optional(),
  baselineQueries: z.array(BaselineQuerySchema).min(1).max(16).optional(),
});

/**
 * Input of the `publication_verification` operation and the plain form of `vector_store_evaluation`:
 * one query vector whose approximate and exact nearest neighbours are compared.
 */
export const VectorVerificationInputSchema = z.strictObject({
  vectorSpaceVersionId: z.uuid(),
  queryEmbedding: z.array(z.number().finite()).length(1_536),
  resultLimit: z.int().positive().max(100).default(20),
  minimumRecallAtK: z.number().min(0).max(1).default(0.95),
});

/**
 * Input of the `vector_store_evaluation` operation. The worker evaluates a selected candidate when the input is
 * one, and otherwise runs the plain nearest-neighbour check.
 */
export const VectorStoreEvaluationInputSchema = z.union([
  SelectedCandidateEvaluationInputSchema,
  VectorVerificationInputSchema,
]);

/**
 * Input of the `vector_store_ingestion` operation. The worker reconciles a selected candidate when
 * `schemaVersion` names one, and otherwise verifies the listed preparation-to-publication chains.
 */
export const VectorStoreIngestionJobInputSchema = z.union([
  SelectedCandidateIndexInputSchema,
  VectorStoreIngestionInputSchema,
]);
