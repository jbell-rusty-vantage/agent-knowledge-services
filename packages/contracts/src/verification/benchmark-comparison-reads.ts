import { z } from "zod";
import { UuidSchema, Sha256DigestSchema } from "./index-primitives.js";
import { VerificationContractVersionSchema } from "./primitives.js";
import {
  VerificationBenchmarkComparisonProfileIdSchema,
  VerificationBenchmarkEngineeringMetricSchema,
} from "./benchmark-comparison.js";
import { VerificationBenchmarkComparisonPublicationSchema } from "./benchmark-comparison-publication.js";
const reference = z.strictObject({ artifactId: UuidSchema, digest: Sha256DigestSchema });
const probability = z.number().min(0).max(1),
  difference = z.number().min(-1).max(1);
const rate = z.strictObject({
  successes: z.int().nonnegative(),
  denominator: z.int().positive(),
  estimate: probability,
  lower: probability,
  upper: probability,
});
export const VerificationBenchmarkComparisonMetricResourceSchema = z.strictObject({
  metric: VerificationBenchmarkEngineeringMetricSchema,
  denominator: z.int().positive(),
  baseline: rate,
  candidate: rate,
  delta: difference,
  regressionObservation: z.enum(["observed_regression", "observed_improvement", "no_observed_change"]),
  clusterBootstrap: z.strictObject({
    estimate: difference,
    lower: difference.nullable(),
    upper: difference.nullable(),
    clusters: z.int().positive(),
    cases: z.int().positive(),
    resamples: z.int().nonnegative(),
    seed: z.int().nonnegative(),
    limitation: z.string().nullable(),
  }),
  mcnemarPValue: probability,
  clusterSignFlipPValue: probability,
});
export const VerificationBenchmarkComparisonResourceSchema = z.strictObject({
  verificationContractVersion: VerificationContractVersionSchema,
  tenantId: UuidSchema,
  comparisonId: UuidSchema,
  operationId: UuidSchema,
  baselineRunId: UuidSchema,
  candidateRunId: UuidSchema,
  profile: z.strictObject({ profileId: VerificationBenchmarkComparisonProfileIdSchema, artifact: reference }),
  publication: z.strictObject({
    artifact: reference,
    payloadDigest: Sha256DigestSchema,
    signatureStatus: z.literal("verified"),
  }),
  result: z.strictObject({ artifact: reference, resultDigest: Sha256DigestSchema }),
  startedAt: VerificationBenchmarkComparisonPublicationSchema.shape.startedAt,
  completedAt: VerificationBenchmarkComparisonPublicationSchema.shape.completedAt,
  engineeringGateOutcome: VerificationBenchmarkComparisonPublicationSchema.shape.engineeringGateOutcome,
  qualityClaims: VerificationBenchmarkComparisonPublicationSchema.shape.qualityClaims,
  statisticalScope: z.literal("paired_engineering_observations_without_assessed_cluster_independence"),
  pairs: z
    .array(
      z.strictObject({
        pairId: z.string().min(1).max(255),
        caseCount: z.int().positive(),
        clusterCount: z.int().positive(),
        clusterUnit: z.enum(["source_family", "report_cluster"]),
        metrics: z.array(VerificationBenchmarkComparisonMetricResourceSchema).length(9),
      }),
    )
    .min(1)
    .max(16),
  globalInference: z.strictObject({
    correction: z.literal("holm"),
    tests: z
      .array(z.strictObject({ id: z.string().min(1).max(1024), pValue: probability, adjustedPValue: probability }))
      .min(18)
      .max(288),
  }),
});
export type VerificationBenchmarkComparisonResource = z.infer<typeof VerificationBenchmarkComparisonResourceSchema>;
