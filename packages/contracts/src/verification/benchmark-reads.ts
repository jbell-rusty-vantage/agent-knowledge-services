import { z } from "zod";
import { IsoDateTimeSchema, NonEmptyStringSchema, Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationArtifactReferenceSchema } from "./reads.js";

const PublicStringSchema = NonEmptyStringSchema.max(4_096);
const ArmIdSchema = NonEmptyStringSchema.max(255);
const QualityClaimsSchema = z.strictObject({
  humanGoldValidated: z.literal(false),
  sourceAuthorityAssessed: z.literal(false),
  calibrated: z.literal(false),
});

const BenchmarkArmSummarySchema = z.strictObject({
  armId: ArmIdSchema,
  experimentArmId: UuidSchema,
  evalRunId: UuidSchema,
  isControl: z.boolean(),
  terminalStatus: z.enum(["succeeded", "failed", "review", "abstained"]),
  summaryDigest: Sha256DigestSchema,
});

const BenchmarkReadCoreObjectSchema = z.strictObject({
  verificationContractVersion: z.literal("verification.v1"),
  tenantId: UuidSchema,
  runId: UuidSchema,
  operationId: UuidSchema,
  publication: z.strictObject({
    artifact: VerificationArtifactReferenceSchema,
    payloadDigest: Sha256DigestSchema,
    signatureStatus: z.literal("verified"),
  }),
  dataset: z.strictObject({
    artifact: VerificationArtifactReferenceSchema,
    datasetId: UuidSchema,
    datasetVersionId: UuidSchema,
    version: z.int().positive(),
    caseCount: z.int().positive().max(10_000),
    manifestDigest: Sha256DigestSchema,
    labelProvenance: z.enum(["engineering_expectations", "mixed_pending"]),
  }),
  experiment: z.strictObject({
    artifact: VerificationArtifactReferenceSchema,
    experimentId: UuidSchema,
    runnerVersion: z.literal("verification-benchmark-runner.v1"),
    randomSeed: z.int(),
    repetitions: z.int().min(1).max(10),
  }),
  lifecycle: z.strictObject({ startedAt: IsoDateTimeSchema, completedAt: IsoDateTimeSchema }),
  qualityClaims: QualityClaimsSchema,
  arms: z.array(BenchmarkArmSummarySchema).min(2).max(16),
});

function validateCore(value: z.infer<typeof BenchmarkReadCoreObjectSchema>, context: z.RefinementCtx) {
  if (Date.parse(value.lifecycle.completedAt) < Date.parse(value.lifecycle.startedAt))
    context.addIssue({ code: "custom", path: ["lifecycle"], message: "completion precedes start" });
  if (value.arms.filter((arm) => arm.isControl).length !== 1)
    context.addIssue({ code: "custom", path: ["arms"], message: "exactly one control arm is required" });
  for (const field of ["armId", "experimentArmId", "evalRunId"] as const)
    if (new Set(value.arms.map((arm) => arm[field])).size !== value.arms.length)
      context.addIssue({ code: "custom", path: ["arms"], message: `${field} must be unique` });
}

/** Compact terminal benchmark state; no result/checkpoint/report bytes or seal material. */
export const VerificationBenchmarkRunSummaryResourceSchema = BenchmarkReadCoreObjectSchema.superRefine(validateCore);
export type VerificationBenchmarkRunSummaryResource = z.infer<typeof VerificationBenchmarkRunSummaryResourceSchema>;

/** Bounded reproducibility metadata from the verified detached benchmark publication. */
export const VerificationBenchmarkRunManifestResourceSchema = BenchmarkReadCoreObjectSchema.extend({
  runtime: z.strictObject({
    deploymentId: PublicStringSchema,
    attemptId: UuidSchema,
    capabilityVersion: PublicStringSchema,
    targetCodeRef: PublicStringSchema,
    gitSha: PublicStringSchema,
    dirty: z.boolean(),
  }),
  execution: z.strictObject({ mode: z.literal("offline_recorded"), externalProviderRequests: z.literal(0) }),
  runnerManifestDigest: Sha256DigestSchema,
  checkpointPlanDigest: Sha256DigestSchema,
  arms: z
    .array(
      BenchmarkArmSummarySchema.extend({
        configurationArtifact: VerificationArtifactReferenceSchema,
        policyArtifact: VerificationArtifactReferenceSchema,
      }),
    )
    .min(2)
    .max(16),
}).superRefine(validateCore);
export type VerificationBenchmarkRunManifestResource = z.infer<typeof VerificationBenchmarkRunManifestResourceSchema>;
