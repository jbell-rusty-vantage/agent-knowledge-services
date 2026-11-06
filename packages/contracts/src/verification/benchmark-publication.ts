import { z } from "zod";
import { IsoDateTimeSchema, Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationArtifactHandleSchema, VerificationContractVersionSchema } from "./primitives.js";

const name = z.string().min(1).max(255);
const canonicalTime = IsoDateTimeSchema.refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}, "publication timestamps must use canonical UTC milliseconds");

/** An evaluation publication, separate from assertion/metric verification bundles. */
export const VerificationBenchmarkPublicationManifestSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-benchmark-publication.v1"),
    verificationContractVersion: VerificationContractVersionSchema,
    tenantId: UuidSchema,
    runId: UuidSchema,
    operationId: UuidSchema,
    dataset: z.strictObject({
      artifact: VerificationArtifactHandleSchema,
      datasetId: UuidSchema,
      datasetVersionId: UuidSchema,
      version: z.int().positive(),
      caseCount: z.int().positive().max(10_000),
      manifestDigest: Sha256DigestSchema,
      labelProvenance: z.enum(["engineering_expectations", "mixed_pending"]),
    }),
    experiment: z.strictObject({
      artifact: VerificationArtifactHandleSchema,
      experimentId: UuidSchema,
      runnerVersion: z.literal("verification-benchmark-runner.v1"),
      randomSeed: z.int(),
      repetitions: z.int().min(1).max(10),
    }),
    runnerPayload: VerificationArtifactHandleSchema,
    runnerManifestDigest: Sha256DigestSchema,
    checkpointPlanDigest: Sha256DigestSchema,
    summaryArtifact: VerificationArtifactHandleSchema,
    provenanceArtifact: VerificationArtifactHandleSchema,
    arms: z
      .array(
        z.strictObject({
          armId: name,
          experimentArmId: UuidSchema,
          evalRunId: UuidSchema,
          configurationArtifact: VerificationArtifactHandleSchema,
          policyArtifact: VerificationArtifactHandleSchema,
          isControl: z.boolean(),
          terminalStatus: z.enum(["succeeded", "failed", "review", "abstained"]),
          dispositionBasis: z.literal("source_authority_unassessed"),
          summaryDigest: Sha256DigestSchema,
        }),
      )
      .min(2)
      .max(16),
    runtime: z.strictObject({
      deploymentId: name,
      attemptId: UuidSchema,
      capabilityVersion: name,
      targetCodeRef: z.string().min(1).max(1024),
      gitSha: name,
      dirty: z.boolean(),
      dirtyStateArtifact: VerificationArtifactHandleSchema.optional(),
    }),
    execution: z.strictObject({ mode: z.literal("offline_recorded"), externalProviderRequests: z.literal(0) }),
    qualityClaims: z.strictObject({
      humanGoldValidated: z.literal(false),
      sourceAuthorityAssessed: z.literal(false),
      calibrated: z.literal(false),
    }),
    startedAt: canonicalTime,
    completedAt: canonicalTime,
    seal: z.strictObject({
      payloadDigest: Sha256DigestSchema,
      signature: z
        .strictObject({
          algorithm: z.literal("Ed25519"),
          keyId: name,
          signatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
        })
        .optional(),
    }),
  })
  .superRefine((manifest, context) => {
    if (Date.parse(manifest.completedAt) < Date.parse(manifest.startedAt))
      context.addIssue({ code: "custom", path: ["completedAt"], message: "completion precedes original start" });
    if (manifest.arms.filter((arm) => arm.isControl).length !== 1)
      context.addIssue({ code: "custom", path: ["arms"], message: "exactly one control arm is required" });
    for (const field of ["armId", "experimentArmId", "evalRunId"] as const)
      if (new Set(manifest.arms.map((arm) => arm[field])).size !== manifest.arms.length)
        context.addIssue({ code: "custom", path: ["arms"], message: `${field} must be unique` });
    const handles = [
      manifest.dataset.artifact,
      manifest.experiment.artifact,
      manifest.runnerPayload,
      manifest.summaryArtifact,
      manifest.provenanceArtifact,
      ...manifest.arms.flatMap((arm) => [arm.configurationArtifact, arm.policyArtifact]),
      ...(manifest.runtime.dirtyStateArtifact ? [manifest.runtime.dirtyStateArtifact] : []),
    ];
    if (handles.some((handle) => handle.tenantId !== manifest.tenantId))
      context.addIssue({
        code: "custom",
        path: ["tenantId"],
        message: "all publication artifact handles must belong to the publication tenant",
      });
    const seen = new Map<string, string>();
    for (const handle of handles) {
      const previous = seen.get(handle.artifactId);
      if (previous !== undefined && previous !== JSON.stringify(handle))
        context.addIssue({
          code: "custom",
          path: ["runnerPayload"],
          message: "one artifact identity cannot have conflicting metadata",
        });
      seen.set(handle.artifactId, JSON.stringify(handle));
    }
  });

export type VerificationBenchmarkPublicationManifest = z.infer<typeof VerificationBenchmarkPublicationManifestSchema>;

export const VerificationBenchmarkOperationResultSchema = z.strictObject({
  benchmarkRunId: UuidSchema,
  evalRunIds: z
    .array(UuidSchema)
    .min(2)
    .max(16)
    .refine((ids) => new Set(ids).size === ids.length),
  manifestDigest: Sha256DigestSchema,
  qualityClaims: VerificationBenchmarkPublicationManifestSchema.shape.qualityClaims,
});
export type VerificationBenchmarkOperationResult = z.infer<typeof VerificationBenchmarkOperationResultSchema>;
