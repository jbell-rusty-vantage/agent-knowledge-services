import { z } from "zod";
import { A2AOperationBindingSchema } from "./a2a.js";
import { JsonValueSchema, UuidSchema } from "./primitives.js";
import { PromotionSelectionSchema } from "./promotion-selection.js";

export const VectorStoreCreateInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.vector-store/v1"),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(255),
  purpose: z.string().trim().min(1).max(2_000),
  storeClass: z.enum(["official_canonical", "internal_exploratory", "user_managed"]),
  visibility: z.enum(["private", "tenant", "public"]),
  quotaProfile: z.strictObject({
    maximumDocuments: z.int().positive().max(10_000_000),
    maximumBytes: z.int().positive().max(Number.MAX_SAFE_INTEGER),
    maximumSpaces: z.int().positive().max(100),
  }),
  retentionPolicy: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("indefinite") }),
    z.strictObject({ mode: z.literal("duration"), days: z.int().positive().max(36_500) }),
  ]),
  deletionPolicy: z.strictObject({
    mode: z.enum(["tombstone_only", "review_required"]),
    minimumRetentionDays: z.int().nonnegative().max(36_500),
  }),
  supersedesId: UuidSchema.optional(),
});
export type VectorStoreCreateInput = z.infer<typeof VectorStoreCreateInputSchema>;

export const VectorStoreDocumentsInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.vector-store-documents/v1"),
  vectorStoreId: UuidSchema,
  documents: z
    .array(
      z.strictObject({
        documentId: UuidSchema,
        documentVersionId: UuidSchema,
        representationId: UuidSchema,
        requestedProfile: JsonValueSchema,
      }),
    )
    .min(1)
    .max(1_000),
});
export type VectorStoreDocumentsInput = z.infer<typeof VectorStoreDocumentsInputSchema>;

export const VectorStoreIngestionChainSchema = z.strictObject({
  attachmentId: UuidSchema,
  transformationOperationId: UuidSchema,
  chunkSetId: UuidSchema,
  chunkSetOperationId: UuidSchema,
  promotionProposalId: UuidSchema,
  promotionProposalOperationId: UuidSchema,
  promotionDecisionId: UuidSchema,
  promotionDecisionOperationId: UuidSchema,
  embeddingRunId: UuidSchema,
  embeddingOperationId: UuidSchema,
  publicationId: UuidSchema,
  publicationOperationId: UuidSchema,
});
export const VectorStoreIngestionInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.vector-store-ingestion/v1"),
  vectorStoreId: UuidSchema,
  chains: z.array(VectorStoreIngestionChainSchema).min(1).max(1_000),
  a2a: A2AOperationBindingSchema.optional(),
});
export type VectorStoreIngestionInput = z.infer<typeof VectorStoreIngestionInputSchema>;

const CandidateOperationReceiptSchema = z.strictObject({ operationId: UuidSchema, receiptId: UuidSchema });
/** Candidate index reconciliation precedes independent evaluation and publication. */
export const SelectedCandidateIndexInputSchema = z
  .strictObject({
    schemaVersion: z.literal("knowledge.selected-candidate-index/v1"),
    selection: PromotionSelectionSchema,
    selectionArtifact: z.strictObject({ id: UuidSchema, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
    preparation: CandidateOperationReceiptSchema.extend({ proposalId: UuidSchema }),
    review: CandidateOperationReceiptSchema.extend({ decisionId: UuidSchema }),
    embeddings: z
      .array(
        CandidateOperationReceiptSchema.extend({
          embeddingRunId: UuidSchema,
          vectorSpaceVersionId: UuidSchema,
          projectionIds: z.array(UuidSchema).min(1).max(10000),
        }),
      )
      .min(1)
      .max(32),
  })
  .superRefine((input, ctx) => {
    if (new Set(input.embeddings.map((item) => item.vectorSpaceVersionId)).size !== input.embeddings.length)
      ctx.addIssue({ code: "custom", path: ["embeddings"], message: "Each candidate space version must occur once" });
    for (const [index, item] of input.embeddings.entries()) {
      if (new Set(item.projectionIds).size !== item.projectionIds.length)
        ctx.addIssue({
          code: "custom",
          path: ["embeddings", index, "projectionIds"],
          message: "Candidate projections must be unique",
        });
    }
  });
export type SelectedCandidateIndexInput = z.infer<typeof SelectedCandidateIndexInputSchema>;

const CandidateEvidenceDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const EvaluationQuerySchema = z.strictObject({
  queryId: z.string().trim().min(1).max(256),
  embedding: z.array(z.number().finite()).length(1_536),
});

/**
 * Independent evaluation of one immutable candidate. The evaluator is bound to
 * the candidate evidence digest, never to a caller-supplied score.
 */
export const SelectedCandidateEvaluationInputSchema = z
  .strictObject({
    schemaVersion: z.literal("knowledge.selected-candidate-evaluation/v1"),
    candidate: SelectedCandidateIndexInputSchema,
    candidateEvidenceDigest: CandidateEvidenceDigestSchema,
    evaluatorIdentity: z.string().trim().min(1).max(256),
    queries: z.array(EvaluationQuerySchema).min(1).max(16),
    resultLimit: z.int().positive().max(100).default(20),
    minimumRecallAtK: z.number().min(0).max(1).default(1),
  })
  .superRefine((input, ctx) => {
    if (new Set(input.queries.map((query) => query.queryId)).size !== input.queries.length)
      ctx.addIssue({ code: "custom", path: ["queries"], message: "Evaluation query identifiers must be unique" });
  });
export type SelectedCandidateEvaluationInput = z.infer<typeof SelectedCandidateEvaluationInputSchema>;

/** Activation of one evaluated candidate through the existing publication switch. */
export const SelectedSpacePublicationInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.selected-space-publication/v1"),
  candidate: SelectedCandidateIndexInputSchema,
  candidateEvidenceDigest: CandidateEvidenceDigestSchema,
  evaluationResultId: UuidSchema,
  evaluationDigest: CandidateEvidenceDigestSchema,
  vectorStoreSpaceId: UuidSchema,
  vectorSpaceVersionId: UuidSchema,
});
export type SelectedSpacePublicationInput = z.infer<typeof SelectedSpacePublicationInputSchema>;
