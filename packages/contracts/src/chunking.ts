import { z } from "zod";
import {
  ImmutableResourceSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  SourceLocatorSchema,
  UuidSchema,
} from "./primitives.js";
import { DocumentNodeKindSchema } from "./content.js";
import { VectorSpaceSchema } from "./spaces.js";

export const ChunkSetSchema = ImmutableResourceSchema.extend({
  representationId: UuidSchema,
  procedureVersionId: UuidSchema,
  tokenizer: NonEmptyStringSchema,
  configurationDigest: Sha256DigestSchema,
  inputManifestDigest: Sha256DigestSchema,
  outputManifestDigest: Sha256DigestSchema,
  status: z.enum(["candidate", "validated", "accepted", "rejected", "superseded"]),
  qaEvaluationId: UuidSchema.optional(),
  promotionProposalId: UuidSchema.optional(),
  supersedesId: UuidSchema.optional(),
});
export type ChunkSet = z.infer<typeof ChunkSetSchema>;

export const RetrievalChunkSchema = ImmutableResourceSchema.extend({
  chunkSetId: UuidSchema,
  ordinal: z.int().nonnegative(),
  parentChunkId: UuidSchema.optional(),
  sourceText: NonEmptyStringSchema,
  sourceTextDigest: Sha256DigestSchema,
  contextualPrefix: z.string(),
  embeddingText: NonEmptyStringSchema,
  embeddingTextDigest: Sha256DigestSchema,
  sourceTokenCount: z.int().nonnegative(),
  embeddingTokenCount: z.int().positive(),
  role: NonEmptyStringSchema,
  language: NonEmptyStringSchema.optional(),
  lifecycle: z.enum(["candidate", "accepted", "superseded", "withdrawn"]),
});
export type RetrievalChunk = z.infer<typeof RetrievalChunkSchema>;

export const ChunkSpanSchema = ImmutableResourceSchema.extend({
  chunkId: UuidSchema,
  ordinal: z.int().nonnegative(),
  nodeId: UuidSchema,
  locator: SourceLocatorSchema,
});
export type ChunkSpan = z.infer<typeof ChunkSpanSchema>;
export const ChunkEdgeSchema = z.strictObject({
  fromChunkId: UuidSchema,
  toChunkId: UuidSchema,
  relation: z.enum([
    "parent",
    "continuation",
    "overlap",
    "elaboration",
    "summary",
    "same_table",
    "same_symbol",
    "cross_reference",
    "supersedes",
  ]),
});
export type ChunkEdge = z.infer<typeof ChunkEdgeSchema>;

// Admitted chunk profiles. The table is the one place a profile is admitted;
// hosts select from it and skills teach from it, so a receipt can cite
// `name@version` and a reader can replay the bounds it ran under.
export const ChunkStrategySchema = z.enum(["transcripts", "headings", "claims", "entities", "tools", "code", "tables"]);
export type ChunkStrategy = z.infer<typeof ChunkStrategySchema>;

export const ChunkProfileSchema = z.strictObject({
  name: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
  strategy: ChunkStrategySchema,
  spaces: z.array(VectorSpaceSchema).min(1),
  nodeKinds: z.array(DocumentNodeKindSchema).min(1),
  tokenizer: z.literal("unicode-word-punctuation-v1"),
  targetTokens: z.int().positive(),
  minimumTokens: z.int().positive(),
  maximumTokens: z.int().positive(),
  overlapTokens: z.int().nonnegative(),
  maximumDuplicatedTokenRatio: z.number().min(0).max(1),
  boilerplateOccurrences: z.int().positive(),
  contextualHeadingPrefix: z.boolean(),
});
export type ChunkProfile = z.infer<typeof ChunkProfileSchema>;

export const CHUNK_PROFILE_TABLE_SCHEMA_VERSION = "chunk-profile-table.v1" as const;
export const ChunkProfileTableSchema = z.strictObject({
  schemaVersion: z.literal(CHUNK_PROFILE_TABLE_SCHEMA_VERSION),
  profiles: z.array(ChunkProfileSchema).min(1),
});
export type ChunkProfileTable = z.infer<typeof ChunkProfileTableSchema>;
