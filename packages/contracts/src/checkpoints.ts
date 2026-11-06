import { z } from "zod";
import { IsoDateTimeSchema, NonEmptyStringSchema, Sha256DigestSchema, UuidSchema } from "./primitives.js";
import { VerificationArtifactHandleSchema } from "./verification/primitives.js";
const IdentitySchema = NonEmptyStringSchema.max(256);
export const CheckpointRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !/[\\:\u0000-\u001f\u007f]/u.test(path) &&
      !path.startsWith("/") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Expected a normalized relative path",
  );
export const CheckpointScopeSchema = z
  .strictObject({
    tenantId: UuidSchema,
    runId: IdentitySchema,
    producerAttemptId: IdentitySchema,
    sessionId: IdentitySchema,
    sandboxId: IdentitySchema,
    namespace: CheckpointRelativePathSchema,
    parentScopeId: UuidSchema.optional(),
    childId: IdentitySchema.optional(),
  })
  .superRefine((scope, context) => {
    if (Boolean(scope.parentScopeId) !== Boolean(scope.childId))
      context.addIssue({ code: "custom", message: "Child scope requires both parentScopeId and childId" });
  });
export type CheckpointScope = z.infer<typeof CheckpointScopeSchema>;
export const CheckpointProfilePinsSchema = z.strictObject({
  storageProfileVersion: IdentitySchema,
  storageProfileDigest: Sha256DigestSchema,
  retentionPolicyVersion: IdentitySchema,
  retentionPolicyDigest: Sha256DigestSchema,
  capabilityProfileVersion: IdentitySchema,
  capabilityProfileDigest: Sha256DigestSchema,
});
export type CheckpointProfilePins = z.infer<typeof CheckpointProfilePinsSchema>;
export const CheckpointPendingOperationSchema = z.strictObject({
  owner: z.enum(["source_discovery", "verification", "ingestion", "report", "publication", "external_tool"]),
  operationId: IdentitySchema,
  requestDigest: Sha256DigestSchema,
});
export type CheckpointPendingOperation = z.infer<typeof CheckpointPendingOperationSchema>;
export const CheckpointSemanticHandoffSchema = z.strictObject({
  schemaVersion: z.literal("checkpoint-handoff.v1"),
  scope: CheckpointScopeSchema,
  pendingOperations: z.array(CheckpointPendingOperationSchema).max(1000),
  notesArtifact: VerificationArtifactHandleSchema,
  status: z.enum(["partial", "ready_for_continuation"]),
});
export type CheckpointSemanticHandoff = z.infer<typeof CheckpointSemanticHandoffSchema>;
export const CheckpointManifestSchema = z
  .strictObject({
    schemaVersion: z.literal("scoped-checkpoint.v1"),
    scope: CheckpointScopeSchema,
    parentCheckpointId: UuidSchema.nullable(),
    ...CheckpointProfilePinsSchema.shape,
    mode: z.enum(["archive", "continuation"]),
    boundary: z.enum([
      "dirty_interval",
      "source",
      "verification",
      "ingestion",
      "report",
      "publication",
      "transfer",
      "failure",
      "cancellation",
      "completion",
      "manual",
    ]),
    files: z
      .array(z.strictObject({ path: CheckpointRelativePathSchema, artifact: VerificationArtifactHandleSchema }))
      .max(2000),
    executorStateArtifact: VerificationArtifactHandleSchema.optional(),
    requiredArtifacts: z.array(VerificationArtifactHandleSchema).max(10000),
    semanticHandoffArtifact: VerificationArtifactHandleSchema.optional(),
    pendingOperations: z.array(CheckpointPendingOperationSchema).max(1000),
  })
  .superRefine((manifest, context) => {
    if (manifest.mode === "continuation" && (!manifest.executorStateArtifact || !manifest.semanticHandoffArtifact))
      context.addIssue({ code: "custom", message: "Continuation requires executor state and semantic handoff" });
    if (new Set(manifest.files.map((file) => file.path.toLowerCase())).size !== manifest.files.length)
      context.addIssue({ code: "custom", message: "File paths must be unique including case folding" });
    const operations = manifest.pendingOperations.map((operation) => `${operation.owner}:${operation.operationId}`);
    if (new Set(operations).size !== operations.length)
      context.addIssue({ code: "custom", message: "Pending operation identity must be unique" });
  });
export type CheckpointManifest = z.infer<typeof CheckpointManifestSchema>;
export const CheckpointCommitRequestSchema = z
  .strictObject({
    idempotencyKey: IdentitySchema,
    harnessRequestDigest: Sha256DigestSchema.optional(),
    expectedHead: UuidSchema.nullable(),
    manifest: CheckpointManifestSchema,
  })
  .superRefine((request, context) => {
    if (request.expectedHead !== request.manifest.parentCheckpointId)
      context.addIssue({ code: "custom", message: "Expected head must equal manifest parent" });
  });
export type CheckpointCommitRequest = z.infer<typeof CheckpointCommitRequestSchema>;
export const CheckpointReceiptSchema = z.strictObject({
  checkpointId: UuidSchema,
  scopeId: UuidSchema,
  manifestArtifact: VerificationArtifactHandleSchema,
  revision: z.int().positive(),
  mode: z.enum(["archive", "continuation"]),
  committedAt: IsoDateTimeSchema,
  harnessRequestDigest: Sha256DigestSchema.optional(),
});
export type CheckpointReceipt = z.infer<typeof CheckpointReceiptSchema>;
export const CheckpointRestoreRequestSchema = z.strictObject({
  checkpointId: UuidSchema,
  expectedScope: CheckpointScopeSchema,
  expectedProfilePins: CheckpointProfilePinsSchema,
});
export type CheckpointRestoreRequest = z.infer<typeof CheckpointRestoreRequestSchema>;
export const CheckpointOperationOutcomeSchema = z
  .strictObject({
    ...CheckpointPendingOperationSchema.shape,
    state: z.enum(["settled", "unresolved"]),
    outcome: z.enum(["succeeded", "failed", "cancelled", "uncertain"]).optional(),
    artifacts: z.array(VerificationArtifactHandleSchema).max(1000),
    detail: NonEmptyStringSchema.max(2000).optional(),
  })
  .refine(
    (value) => value.state !== "settled" || (value.outcome !== undefined && value.outcome !== "uncertain"),
    "Settled operation requires an exact terminal outcome",
  );
export type CheckpointOperationOutcome = z.infer<typeof CheckpointOperationOutcomeSchema>;
export const CheckpointRestoreResultSchema = z.strictObject({
  receipt: CheckpointReceiptSchema,
  manifest: CheckpointManifestSchema,
  ready: z.boolean(),
  operationOutcomes: z.array(CheckpointOperationOutcomeSchema).max(1000),
  unresolved: z.array(CheckpointPendingOperationSchema).max(1000),
});
export type CheckpointRestoreResult = z.infer<typeof CheckpointRestoreResultSchema>;
export const CheckpointTombstoneRequestSchema = z.strictObject({
  artifactId: UuidSchema,
  reason: NonEmptyStringSchema.max(2000),
});
export type CheckpointTombstoneRequest = z.infer<typeof CheckpointTombstoneRequestSchema>;
