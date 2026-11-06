import { z } from "zod";
import {
  ActorSchema,
  ArtifactReferenceSchema,
  ContractVersionSchema,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  NonEmptyStringSchema,
  Sha256DigestSchema,
  UuidSchema,
} from "./index-primitives.js";

export const VerificationContractVersionSchema = z.literal("verification.v1");
export const VerificationIdSchema = z.string().trim().min(1).max(255);
export const VerificationDataClassificationSchema = z.enum(["public", "internal", "confidential", "restricted"]);

export const VerificationArtifactHandleSchema = ArtifactReferenceSchema.extend({
  byteLength: z.int().nonnegative(),
  objectKey: NonEmptyStringSchema,
  contentEncoding: NonEmptyStringSchema.optional(),
  createdAt: IsoDateTimeSchema,
  producerActivityId: VerificationIdSchema,
  producerVersion: NonEmptyStringSchema,
  encryptionClass: NonEmptyStringSchema,
  retentionClass: NonEmptyStringSchema,
  dataClassification: VerificationDataClassificationSchema,
  parentArtifactIds: z.array(UuidSchema),
  transformationSignature: Sha256DigestSchema.optional(),
  attestationArtifactId: UuidSchema.optional(),
});
export type VerificationArtifactHandle = z.infer<typeof VerificationArtifactHandleSchema>;

export const VerificationActorDeploymentSchema = z.strictObject({
  deploymentId: VerificationIdSchema,
  attemptId: VerificationIdSchema,
  capabilityVersion: NonEmptyStringSchema,
});
export type VerificationActorDeployment = z.infer<typeof VerificationActorDeploymentSchema>;

export const VerificationOperationContextSchema = z.strictObject({
  contractVersion: ContractVersionSchema,
  verificationContractVersion: VerificationContractVersionSchema,
  tenantId: UuidSchema,
  operationId: UuidSchema,
  missionId: UuidSchema.optional(),
  workItemId: UuidSchema.optional(),
  attemptId: UuidSchema,
  correlationId: NonEmptyStringSchema,
  causationId: NonEmptyStringSchema.optional(),
  actor: ActorSchema,
  capabilityVersion: NonEmptyStringSchema,
  idempotencyKey: IdempotencyKeySchema,
  requestedAt: IsoDateTimeSchema,
  dataClassification: VerificationDataClassificationSchema,
  requestedPolicyVersion: NonEmptyStringSchema,
  inputArtifacts: z.array(
    z.strictObject({
      artifactId: UuidSchema,
      digest: Sha256DigestSchema,
    }),
  ),
});
export type VerificationOperationContext = z.infer<typeof VerificationOperationContextSchema>;

export const VerificationFailureCategorySchema = z.enum([
  "producer_contract_failure",
  "capture_unavailable",
  "capture_forbidden",
  "capture_oversized",
  "capture_drifted",
  "locator_missing",
  "locator_ambiguous",
  "locator_invalid",
  "parser_failure",
  "conversion_failure",
  "ocr_failure",
  "extraction_schema_failure",
  "extraction_value_failure",
  "identity_missing",
  "identity_ambiguous",
  "identity_conflicted",
  "metric_semantics_failure",
  "unit_failure",
  "period_failure",
  "comparability_failure",
  "computation_replay_failure",
  "semantic_quality_failure",
  "claim_decomposition_failure",
  "judge_output_failure",
  "provider_authentication_failure",
  "provider_rate_limit",
  "provider_timeout",
  "provider_upstream_failure",
  "harness_failure",
  "persistence_failure",
  "artifact_registration_failure",
  "policy_rejection",
  "human_review_timeout",
  "cancelled",
]);
export type VerificationFailureCategory = z.infer<typeof VerificationFailureCategorySchema>;

export const VerificationErrorSchema = z.strictObject({
  contractVersion: VerificationContractVersionSchema,
  errorId: VerificationIdSchema,
  operationId: UuidSchema,
  category: VerificationFailureCategorySchema,
  stage: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  retryable: z.boolean(),
  qualityFailure: z.boolean(),
  artifactIds: z.array(UuidSchema),
  details: z.record(z.string(), JsonValueSchema),
  occurredAt: IsoDateTimeSchema,
});
export type VerificationError = z.infer<typeof VerificationErrorSchema>;

export const VerificationCheckSchema = z.strictObject({
  code: NonEmptyStringSchema,
  status: z.enum(["passed", "failed", "review_required"]),
  deterministic: z.literal(true),
  severity: z.enum(["hard", "review"]),
  detail: NonEmptyStringSchema,
  targetId: VerificationIdSchema.optional(),
});
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

export const CanonicalizationDescriptorSchema = z.strictObject({
  algorithm: z.literal("RFC8785"),
  implementationVersion: NonEmptyStringSchema,
  manifestDigest: Sha256DigestSchema,
});

export type VerificationJsonValue = z.infer<typeof JsonValueSchema>;
