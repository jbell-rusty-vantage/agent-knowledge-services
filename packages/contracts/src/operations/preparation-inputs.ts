import { z } from "zod";
import { A2AOperationBindingSchema } from "../a2a.js";
import { DocumentNodeSchema } from "../content.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Input of the `transformation` operation: convert the bytes of a completed capture into a structural representation. */
export const TransformationInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.transformation/v1"),
  captureOperationId: z.uuid(),
  document: z.strictObject({
    documentKind: z.string().trim().min(1),
    canonicalTitle: z.string().trim().min(1),
    versionLabel: z.string().trim().min(1),
    identifier: z
      .strictObject({
        type: z.enum(["url", "doi", "arxiv", "openreview", "isbn", "repository", "media_id", "other"]),
        value: z.string().trim().min(1),
        authority: z.string().trim().min(1).optional(),
      })
      .optional(),
  }),
  profile: z.strictObject({
    profileKey: z.string().trim().min(1),
    version: z.string().trim().min(1),
    mediaType: z.string().trim().min(1),
    language: z.string().trim().min(1).optional(),
    preserveHtml: z.boolean().optional(),
    managedProcessingAllowed: z.boolean(),
    maximumPolls: z.int().positive().max(10_000).optional(),
  }),
  providerRoute: z.array(z.string().trim().min(1)).min(1),
  a2a: A2AOperationBindingSchema.optional(),
});

/** Input of the `representation_comparison` operation: two node sets compared by structural position. */
export const RepresentationComparisonInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.representation-comparison/v1"),
  left: z.strictObject({
    representationId: z.uuid(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    nodes: z.array(DocumentNodeSchema).max(10_000),
  }),
  right: z.strictObject({
    representationId: z.uuid(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    nodes: z.array(DocumentNodeSchema).max(10_000),
  }),
});

/** Input of the `representation_decision` operation: a reviewer's decision on one converted representation. */
export const RepresentationDecisionInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.representation-decision/v1"),
  representationId: z.uuid(),
  reviewSubjectId: z.uuid(),
  guardedDigest: digestSchema,
  decision: z.enum(["accept", "reject", "quarantine", "defer", "request_changes"]),
  policyVersion: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  expiresAt: z.iso.datetime().optional(),
});

/** Input of the `chunk_preview` operation: chunk caller-supplied nodes with one admitted profile, storing nothing. */
export const ChunkPreviewInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.chunk-preview/v1"),
  nodes: z.array(DocumentNodeSchema).min(1).max(10_000),
  profileName: z.string().trim().min(1).max(255),
  profileVersion: z.string().trim().min(1).max(100),
});

/** Input of the `chunk_comparison` operation: the same nodes chunked with two to twelve profiles. */
export const ChunkComparisonInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.chunk-comparison/v1"),
  nodes: z.array(DocumentNodeSchema).min(1).max(10_000),
  profiles: z
    .array(z.strictObject({ name: z.string().trim().min(1).max(255), version: z.string().trim().min(1).max(100) }))
    .min(2)
    .max(12),
});

/** Input of the `chunk_set` operation: chunk the stored nodes of one representation and persist the chunk set. */
export const ChunkSetInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.chunk-set/v1"),
  representationId: z.uuid(),
  profileName: z.string().trim().min(1),
  profileVersion: z.string().trim().min(1),
});
