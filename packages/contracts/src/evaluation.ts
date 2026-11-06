import { z } from "zod";
import {
  ImmutableResourceSchema,
  JsonValueSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  UuidSchema,
} from "./primitives.js";
import { RetrievalPlanSchema } from "./retrieval.js";

export const EvaluationDatasetVersionSchema = ImmutableResourceSchema.extend({
  datasetId: UuidSchema,
  manifestDigest: Sha256DigestSchema,
  frozen: z.literal(true),
  caseCount: z.int().positive(),
});
export type EvaluationDatasetVersion = z.infer<typeof EvaluationDatasetVersionSchema>;
export const EvaluationCaseSchema = ImmutableResourceSchema.extend({
  datasetVersionId: UuidSchema,
  query: NonEmptyStringSchema,
  provenance: z.array(NonEmptyStringSchema).min(1),
  relevanceJudgments: z.array(
    z.strictObject({ recordId: UuidSchema, grade: z.int().min(0).max(3), reason: NonEmptyStringSchema }),
  ),
  expectedFilters: z.array(z.strictObject({ field: NonEmptyStringSchema, value: JsonValueSchema })),
  adversarial: z.boolean(),
});
export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;
export const EvaluationRunSchema = ImmutableResourceSchema.extend({
  datasetVersionId: UuidSchema,
  experimentId: UuidSchema,
  armId: UuidSchema,
  retrievalPolicyVersionId: UuidSchema,
  frozenPlanTemplate: RetrievalPlanSchema.optional(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  inputManifestDigest: Sha256DigestSchema,
  outputManifestDigest: Sha256DigestSchema.optional(),
  receiptId: UuidSchema.optional(),
});
export type EvaluationRun = z.infer<typeof EvaluationRunSchema>;
export const MetricObservationSchema = ImmutableResourceSchema.extend({
  evaluationRunId: UuidSchema,
  metric: z.enum([
    "recall_at_k",
    "precision_at_k",
    "mrr",
    "ndcg",
    "coverage",
    "citation_correctness",
    "faithfulness",
    "latency_ms",
    "cost_micros",
  ]),
  value: z.number(),
  sampleCount: z.int().positive(),
  procedureVersion: NonEmptyStringSchema,
});
export type MetricObservation = z.infer<typeof MetricObservationSchema>;
export const PromotionGateResultSchema = ImmutableResourceSchema.extend({
  evaluationRunId: UuidSchema,
  gateVersionId: UuidSchema,
  passed: z.boolean(),
  observedMetricIds: z.array(UuidSchema).min(1),
  failedConditions: z.array(NonEmptyStringSchema),
  regressionBaselineId: UuidSchema.optional(),
});
export type PromotionGateResult = z.infer<typeof PromotionGateResultSchema>;
export const JudgeOutputSchema = ImmutableResourceSchema.extend({
  evaluationRunId: UuidSchema,
  model: NonEmptyStringSchema,
  promptDigest: Sha256DigestSchema,
  outputSchemaVersion: NonEmptyStringSchema,
  calibrationId: UuidSchema,
  score: z.number(),
  rationale: NonEmptyStringSchema,
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;
