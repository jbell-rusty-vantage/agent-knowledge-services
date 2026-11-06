import { z } from "zod";
import { NonEmptyStringSchema, Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationContractVersionSchema } from "./primitives.js";

export const VerificationBenchmarkEngineeringMetricSchema = z.enum([
  "schema_validity",
  "locator_resolution_validity",
  "locator_expectation_agreement",
  "field_mechanics",
  "support_agreement",
  "authority_agreement",
  "world_correctness_agreement",
  "policy_agreement",
  "engineering_expectation_agreement",
]);

export const VerificationBenchmarkComparisonProfileIdSchema = z.enum(["paired_default", "regression_gate"]);

const ArmPairSchema = z.strictObject({
  pairId: NonEmptyStringSchema.max(255),
  baselineArmId: NonEmptyStringSchema.max(255),
  candidateArmId: NonEmptyStringSchema.max(255),
});

export const VerificationBenchmarkComparisonProfileSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-benchmark-comparison-profile.v1"),
    verificationContractVersion: VerificationContractVersionSchema,
    tenantId: UuidSchema,
    profileId: VerificationBenchmarkComparisonProfileIdSchema,
    version: z.int().positive(),
    armPairs: z.array(ArmPairSchema).min(1).max(16),
    clusterUnit: z.enum(["source_family", "report_cluster"]),
    seed: z.int().min(0).max(0xffffffff),
    bootstrapReplicates: z.int().min(100).max(10_000),
    correction: z.literal("holm"),
    primaryMetric: VerificationBenchmarkEngineeringMetricSchema,
    regressionGate: z.strictObject({ maximumAllowedObservedDecrease: z.number().min(0).max(1) }).nullable(),
  })
  .superRefine((profile, context) => {
    const pairIds = profile.armPairs.map((pair) => pair.pairId);
    const pairs = profile.armPairs.map((pair) => `${pair.baselineArmId}\u0000${pair.candidateArmId}`);
    if (new Set(pairIds).size !== pairIds.length)
      context.addIssue({ code: "custom", path: ["armPairs"], message: "pair IDs must be unique" });
    if (new Set(pairs).size !== pairs.length)
      context.addIssue({ code: "custom", path: ["armPairs"], message: "ordered arm pairs must be unique" });
    if (profile.profileId === "paired_default" && profile.regressionGate !== null)
      context.addIssue({
        code: "custom",
        path: ["regressionGate"],
        message: "paired_default does not declare a regression gate",
      });
    if (profile.profileId === "regression_gate" && profile.regressionGate === null)
      context.addIssue({
        code: "custom",
        path: ["regressionGate"],
        message: "regression_gate requires an observed-decrease threshold",
      });
  });

export const VerificationBenchmarkComparisonProfileArtifactReferenceSchema = z.strictObject({
  artifactId: UuidSchema,
  digest: Sha256DigestSchema,
});

export type VerificationBenchmarkEngineeringMetric = z.infer<typeof VerificationBenchmarkEngineeringMetricSchema>;
export type VerificationBenchmarkComparisonProfileId = z.infer<typeof VerificationBenchmarkComparisonProfileIdSchema>;
export type VerificationBenchmarkComparisonProfile = z.infer<typeof VerificationBenchmarkComparisonProfileSchema>;
export type VerificationBenchmarkComparisonProfileArtifactReference = z.infer<
  typeof VerificationBenchmarkComparisonProfileArtifactReferenceSchema
>;
