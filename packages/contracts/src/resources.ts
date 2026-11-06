import { z } from "zod";
import {
  IsoDateTimeSchema,
  JsonValueSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  UuidSchema,
} from "./primitives.js";

const HexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const VectorStoreResourceSchema = z.strictObject({
  id: UuidSchema,
  tenantId: UuidSchema,
  ownerIdentity: NonEmptyStringSchema,
  storeClass: z.enum(["official_canonical", "internal_exploratory", "user_managed"]),
  slug: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  purpose: NonEmptyStringSchema,
  visibility: z.enum(["private", "tenant", "public"]),
  lifecycle: z.enum(["active", "suspended", "superseded", "deleted"]),
  quotaProfile: JsonValueSchema,
  retentionPolicy: JsonValueSchema,
  deletionPolicy: JsonValueSchema,
  createdByAttemptId: UuidSchema.optional(),
  supersedesId: UuidSchema.optional(),
  createdAt: IsoDateTimeSchema,
  documentCount: z.int().nonnegative(),
  spaces: z
    .array(
      z.strictObject({
        id: UuidSchema,
        vectorSpaceId: UuidSchema,
        activeSpaceVersionId: UuidSchema.optional(),
        authorityClass: z.enum(["official", "exploratory", "user_managed"]),
        createdAt: IsoDateTimeSchema,
      }),
    )
    .max(100),
  spacesTruncated: z.boolean(),
});
export type VectorStoreResource = z.infer<typeof VectorStoreResourceSchema>;

export const ArtifactResourceSchema = z.strictObject({
  artifactId: UuidSchema,
  tenantId: UuidSchema,
  artifactType: NonEmptyStringSchema,
  schemaVersion: z.int().positive(),
  digest: Sha256DigestSchema,
  bucketClass: NonEmptyStringSchema,
  mediaType: NonEmptyStringSchema.optional(),
  byteLength: z.int().nonnegative().optional(),
  supersededById: UuidSchema.optional(),
  createdAt: IsoDateTimeSchema,
});
export type ArtifactResource = z.infer<typeof ArtifactResourceSchema>;

export const DurableReceiptResourceSchema = z
  .strictObject({
    id: UuidSchema,
    tenantId: UuidSchema,
    operationId: UuidSchema,
    stepId: UuidSchema.optional(),
    receiptKind: NonEmptyStringSchema,
    idempotencyKey: NonEmptyStringSchema,
    executorIdentity: NonEmptyStringSchema,
    inputSha256: HexSha256Schema,
    inputDigest: Sha256DigestSchema,
    outputSha256: HexSha256Schema.optional(),
    outputDigest: Sha256DigestSchema.optional(),
    outcome: NonEmptyStringSchema,
    body: JsonValueSchema,
    createdAt: IsoDateTimeSchema,
  })
  .superRefine((receipt, context) => {
    if (receipt.inputDigest !== `sha256:${receipt.inputSha256}`)
      context.addIssue({ code: "custom", path: ["inputDigest"], message: "input digest forms disagree" });
    if ((receipt.outputSha256 === undefined) !== (receipt.outputDigest === undefined))
      context.addIssue({ code: "custom", path: ["outputDigest"], message: "output digest forms must appear together" });
    if (receipt.outputSha256 && receipt.outputDigest !== `sha256:${receipt.outputSha256}`)
      context.addIssue({ code: "custom", path: ["outputDigest"], message: "output digest forms disagree" });
  });
export type DurableReceiptResource = z.infer<typeof DurableReceiptResourceSchema>;

export const RetrievalRunResourceSchema = z.strictObject({
  id: UuidSchema,
  tenantId: UuidSchema,
  plan: z.strictObject({
    id: UuidSchema,
    queryIntent: NonEmptyStringSchema,
    decomposition: JsonValueSchema,
    spaces: JsonValueSchema,
    filters: JsonValueSchema,
    policyVersion: z.int().positive(),
    validated: z.boolean(),
    validationErrors: JsonValueSchema.optional(),
    createdAt: IsoDateTimeSchema,
  }),
  stageTimings: JsonValueSchema,
  fusionParameters: JsonValueSchema,
  rerankerId: NonEmptyStringSchema.optional(),
  executedAt: IsoDateTimeSchema,
  evidencePacketIds: z.array(UuidSchema).max(100),
});
export type RetrievalRunResource = z.infer<typeof RetrievalRunResourceSchema>;

const CandidateSourceExplanationSchema = z.strictObject({
  channel: z.enum(["vector", "lexical", "exact", "graph", "rerank"]),
  searchProjectionId: UuidSchema.optional(),
  vectorItemId: UuidSchema.optional(),
  sourceRank: z.int().positive(),
  score: z.number().finite(),
  explanation: JsonValueSchema,
});
export const RetrievalExplanationResourceSchema = z.strictObject({
  retrievalRunId: UuidSchema,
  stageTimings: JsonValueSchema,
  fusionParameters: JsonValueSchema,
  rerankerId: NonEmptyStringSchema.optional(),
  candidates: z
    .array(
      z.strictObject({
        id: UuidSchema,
        vectorItemId: UuidSchema.optional(),
        lexicalReference: NonEmptyStringSchema.optional(),
        stageScores: JsonValueSchema,
        finalScore: z.number().finite().optional(),
        rank: z.int().positive().optional(),
        sources: z.array(CandidateSourceExplanationSchema),
      }),
    )
    .max(100),
  truncated: z.boolean(),
});
export type RetrievalExplanationResource = z.infer<typeof RetrievalExplanationResourceSchema>;

export const EvaluationReportResourceSchema = z.strictObject({
  id: UuidSchema,
  tenantId: UuidSchema,
  datasetId: UuidSchema,
  targetKind: NonEmptyStringSchema,
  configuration: JsonValueSchema,
  codeReference: NonEmptyStringSchema.optional(),
  executedAt: IsoDateTimeSchema,
  metrics: z
    .array(
      z.strictObject({
        id: UuidSchema,
        metricDefinitionId: UuidSchema,
        caseId: UuidSchema.optional(),
        value: z.number().finite().optional(),
        details: JsonValueSchema,
        createdAt: IsoDateTimeSchema,
      }),
    )
    .max(1000),
  gates: z
    .array(
      z.strictObject({
        id: UuidSchema,
        gateVersionId: UuidSchema,
        passed: z.boolean(),
        falseAcceptanceCount: z.int().nonnegative(),
        observations: JsonValueSchema,
        resultDigest: Sha256DigestSchema,
        createdAt: IsoDateTimeSchema,
      }),
    )
    .max(100),
});
export type EvaluationReportResource = z.infer<typeof EvaluationReportResourceSchema>;

export const EvaluationFailuresResourceSchema = z.strictObject({
  evaluationRunId: UuidSchema,
  failures: z
    .array(
      z.strictObject({
        caseId: UuidSchema,
        metrics: JsonValueSchema,
        falseAcceptance: z.boolean(),
        falseRejection: z.boolean(),
        output: JsonValueSchema.optional(),
      }),
    )
    .max(100),
  truncated: z.boolean(),
});
export type EvaluationFailuresResource = z.infer<typeof EvaluationFailuresResourceSchema>;
