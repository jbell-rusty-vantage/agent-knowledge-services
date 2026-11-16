import { z } from "zod";
import { JsonValueSchema } from "../primitives.js";

const FilterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);
const ExpectedFilterSchema = z.strictObject({
  field: z.string().trim().min(1),
  value: FilterValueSchema,
});

/** One retrieval evaluation case: a query, its domain and class, and graded relevance judgments. */
export const EvaluationCaseInputSchema = z.strictObject({
  id: z.string().trim().min(1),
  query: z.string().trim().min(1),
  domain: z.enum([
    "engineering_claims",
    "tool_capabilities",
    "implementation_examples",
    "paper_case_study_knowledge",
    "entity_profiles",
    "model_capabilities",
    "benchmark_intelligence",
    "source_native_sections",
  ]),
  queryClass: z.enum([
    "semantic",
    "lexical",
    "filtered",
    "graph",
    "temporal",
    "exact",
    "conceptual",
    "mixed",
    "constraint",
    "multi_hop",
    "code",
    "contradiction",
    "freshness_temporal",
    "negative_abstention",
    "adversarial",
  ]),
  provenance: z.array(z.string().trim().min(1)).min(1),
  relevanceJudgments: z.array(
    z.strictObject({
      recordId: z.string().trim().min(1),
      grade: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
      rationale: z.string().trim().min(1),
    }),
  ),
  expectedFilters: z.array(ExpectedFilterSchema).optional(),
  expectedAbstain: z.boolean().optional(),
  partition: z.enum(["dev", "calibration", "heldout"]).optional(),
  sourceFamily: z.string().optional(),
  entityFamily: z.string().optional(),
  forbiddenResultIds: z.array(z.string()).optional(),
  forbiddenFilters: z.array(ExpectedFilterSchema).optional(),
  authorProvenance: z.string().optional(),
  reviewerProvenance: z.string().optional(),
  fixtureKind: z.enum(["real_bundle_grounded", "synthetic_gap", "reviewed_negative", "adversarial"]).optional(),
  expectedFacts: z.array(z.string()).optional(),
  expectedLocatorDigests: z.array(z.string()).optional(),
  requiredResultType: z.string().optional(),
  requiredResultTypes: z.array(z.string()).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  tags: z.array(z.string()).optional(),
  policySlice: z.string().optional(),
  expectedGraphPath: z.array(z.string()).optional(),
});

const EvaluationReviewArtifactSchema = z.strictObject({
  candidateManifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  authorIdentity: z.string().trim().min(1),
  reviewerIdentity: z.string().trim().min(1),
  decision: z.enum(["accept", "reject"]),
  reviewedCaseIds: z.array(z.string().trim().min(1)),
  reviewedAt: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

/** Input of the `evaluation_dataset` operation: the cases to freeze into one versioned dataset. */
export const EvaluationDatasetInputSchema = z.strictObject({
  id: z.string().trim().min(1),
  version: z.int().positive(),
  name: z.string().trim().min(1),
  cases: z.array(EvaluationCaseInputSchema).min(1),
  reviewed: z.boolean(),
  reviewMode: z.enum(["independent", "development"]).optional(),
  reviewArtifact: EvaluationReviewArtifactSchema.optional(),
});

/** What one retrieval arm returned for one case. */
export const EvaluationOutputInputSchema = z.strictObject({
  caseId: z.string().trim().min(1),
  items: z.array(
    z.strictObject({
      recordId: z.string().trim().min(1),
      rank: z.int().positive(),
      score: z.number().finite(),
      matchedFilters: z.record(z.string(), FilterValueSchema).optional(),
      citation: z.strictObject({ entailed: z.boolean(), locatorValid: z.boolean() }).optional(),
      resultType: z.string().optional(),
      locatorDigests: z.array(z.string()).optional(),
      graphPaths: z.array(z.array(z.string())).optional(),
      contentDigest: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .optional(),
    }),
  ),
  abstained: z.boolean(),
  latencyMs: z.number().nonnegative(),
  costMicros: z.number().nonnegative(),
});

/** Input of the `evaluation_run` operation: a dataset and the recorded outputs to score against it. */
export const EvaluationRunInputSchema = z.strictObject({
  dataset: EvaluationDatasetInputSchema,
  outputs: z.array(EvaluationOutputInputSchema),
  k: z.int().positive().max(100).default(10),
});

/** Input of the read of an evaluation run's failing cases. */
export const EvaluationRunReadInputSchema = z.strictObject({ runId: z.uuid() });

/** Input of the `experiment` operation: one dataset scored for a control arm and one or more other arms. */
export const ExperimentInputSchema = z.strictObject({
  schemaVersion: z.literal("knowledge.experiment/v1"),
  id: z.string().trim().min(1).max(255),
  hypothesis: z.string().trim().min(1).max(2_000),
  dataset: EvaluationDatasetInputSchema,
  k: z.int().positive().max(100).default(10),
  arms: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(255),
        name: z.string().trim().min(1).max(255),
        control: z.boolean(),
        configuration: JsonValueSchema,
        outputs: z.array(EvaluationOutputInputSchema),
      }),
    )
    .min(2)
    .max(20),
});
