import { z } from "zod";
import { Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationArtifactHandleSchema, VerificationContractVersionSchema } from "./primitives.js";
import { VerificationBenchmarkPublicationManifestSchema } from "./benchmark-publication.js";
import { VerificationBenchmarkComparisonProfileIdSchema } from "./benchmark-comparison.js";

const side = z.strictObject({
  runId: UuidSchema,
  publicationArtifact: VerificationArtifactHandleSchema,
  payloadDigest: Sha256DigestSchema,
});
/** Signed custody and observed engineering gate; no human quality certification. */
export const VerificationBenchmarkComparisonPublicationSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-benchmark-comparison-publication.v1"),
    verificationContractVersion: VerificationContractVersionSchema,
    tenantId: UuidSchema,
    operationId: UuidSchema,
    comparisonId: UuidSchema,
    requestDigest: Sha256DigestSchema,
    baseline: side,
    candidate: side,
    profile: z.strictObject({
      profileId: VerificationBenchmarkComparisonProfileIdSchema,
      artifact: VerificationArtifactHandleSchema,
    }),
    result: z.strictObject({ artifact: VerificationArtifactHandleSchema, resultDigest: Sha256DigestSchema }),
    engineeringGateOutcome: z.enum(["not_requested", "pass", "fail"]),
    interpretation: z.literal("observed_engineering_threshold_only"),
    runtime: VerificationBenchmarkPublicationManifestSchema.shape.runtime,
    execution: VerificationBenchmarkPublicationManifestSchema.shape.execution,
    qualityClaims: VerificationBenchmarkPublicationManifestSchema.shape.qualityClaims,
    startedAt: VerificationBenchmarkPublicationManifestSchema.shape.startedAt,
    completedAt: VerificationBenchmarkPublicationManifestSchema.shape.completedAt,
    seal: VerificationBenchmarkPublicationManifestSchema.shape.seal,
  })
  .superRefine((value, context) => {
    if (
      value.baseline.runId === value.candidate.runId ||
      value.baseline.publicationArtifact.artifactId === value.candidate.publicationArtifact.artifactId
    )
      context.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "distinct benchmark runs and publications required",
      });
    if (Date.parse(value.completedAt) < Date.parse(value.startedAt))
      context.addIssue({ code: "custom", path: ["completedAt"], message: "completion precedes original start" });
    if ((value.profile.profileId === "paired_default") !== (value.engineeringGateOutcome === "not_requested"))
      context.addIssue({
        code: "custom",
        path: ["engineeringGateOutcome"],
        message: "gate must match the registered profile kind",
      });
    if (value.runtime.dirty && !value.runtime.dirtyStateArtifact)
      context.addIssue({ code: "custom", path: ["runtime"], message: "dirty runtime requires source custody" });
    const handles = [
      value.baseline.publicationArtifact,
      value.candidate.publicationArtifact,
      value.profile.artifact,
      value.result.artifact,
      ...(value.runtime.dirtyStateArtifact ? [value.runtime.dirtyStateArtifact] : []),
    ];
    if (handles.some((handle) => handle.tenantId !== value.tenantId))
      context.addIssue({
        code: "custom",
        path: ["tenantId"],
        message: "all artifacts must belong to the comparison tenant",
      });
    const seen = new Map<string, string>();
    for (const handle of handles) {
      const previous = seen.get(handle.artifactId),
        current = JSON.stringify(handle);
      if (previous !== undefined && previous !== current)
        context.addIssue({ code: "custom", path: ["result"], message: "conflicting artifact metadata" });
      seen.set(handle.artifactId, current);
    }
  });
export type VerificationBenchmarkComparisonPublication = z.infer<
  typeof VerificationBenchmarkComparisonPublicationSchema
>;
export const VerificationBenchmarkComparisonOperationResultSchema = z.strictObject({
  comparisonId: UuidSchema,
  baselineRunId: UuidSchema,
  candidateRunId: UuidSchema,
  manifestDigest: Sha256DigestSchema,
  resultDigest: Sha256DigestSchema,
  engineeringGateOutcome: z.enum(["not_requested", "pass", "fail"]),
  qualityClaims: VerificationBenchmarkPublicationManifestSchema.shape.qualityClaims,
});
export type VerificationBenchmarkComparisonOperationResult = z.infer<
  typeof VerificationBenchmarkComparisonOperationResultSchema
>;
