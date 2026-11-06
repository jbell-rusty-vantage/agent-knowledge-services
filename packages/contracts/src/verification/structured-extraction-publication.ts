import { z } from "zod";
import { IsoDateTimeSchema, Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import { VerificationArtifactHandleSchema, VerificationContractVersionSchema } from "./primitives.js";

const canonicalTime = IsoDateTimeSchema.refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}, "timestamps must use canonical UTC milliseconds");
const boundedName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u);
const boundedPipeField = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("|"), "field must be pipe-delimiter safe");
const gitIdentity = z.union([z.literal("uncommitted"), z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u)]);
const canonicalUuid = UuidSchema.refine(
  (value) => value === value.toLowerCase(),
  "UUID must use canonical lower-case form",
);
const logicalSourcePath = z
  .string()
  .min(4)
  .max(512)
  .regex(/^(?:KS|DB)\/[A-Za-z0-9._/-]+$/u)
  .refine(
    (value) => value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "source paths must use safe logical workspace-relative segments",
  );

export const VerificationStructuredExtractionSourceCustodySchema = z
  .strictObject({
    schemaVersion: z.literal("verification-structured-extraction-source-custody.v1"),
    tenantId: canonicalUuid,
    scope: z.literal("listed_files"),
    files: z
      .array(
        z.strictObject({
          path: logicalSourcePath,
          sha256: Sha256DigestSchema,
          byteLength: z.int().nonnegative().max(262_144),
          bytesBase64: z
            .string()
            .max(349_528)
            .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
        }),
      )
      .min(1)
      .max(32),
    totalByteLength: z.int().positive().max(1_048_576),
  })
  .superRefine((value, context) => {
    if (new Set(value.files.map((file) => file.path)).size !== value.files.length)
      context.addIssue({ code: "custom", path: ["files"], message: "source custody paths must be unique" });
    if (value.files.reduce((sum, file) => sum + file.byteLength, 0) !== value.totalByteLength)
      context.addIssue({
        code: "custom",
        path: ["totalByteLength"],
        message: "source custody total must equal the declared file byte lengths",
      });
  });
export type VerificationStructuredExtractionSourceCustody = z.infer<
  typeof VerificationStructuredExtractionSourceCustodySchema
>;

export const VerificationStructuredExtractionRuntimeSchema = z
  .strictObject({
    deploymentId: boundedName,
    capabilityVersion: boundedName,
    platform: boundedName,
    containerImageDigest: Sha256DigestSchema.optional(),
    code: z.strictObject({
      gitSha: gitIdentity,
      dirty: z.boolean(),
      dirtyStateArtifact: VerificationArtifactHandleSchema.optional(),
    }),
  })
  .superRefine((runtime, context) => {
    if (runtime.code.dirty !== (runtime.code.dirtyStateArtifact !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["code", "dirtyStateArtifact"],
        message: "dirty runtime requires source custody and clean runtime forbids a dirty-state artifact",
      });
    }
    if (!runtime.code.dirty && runtime.code.gitSha === "uncommitted") {
      context.addIssue({
        code: "custom",
        path: ["code", "gitSha"],
        message: "clean runtime requires a committed source identity",
      });
    }
  });
export type VerificationStructuredExtractionRuntime = z.infer<typeof VerificationStructuredExtractionRuntimeSchema>;

export const VerificationStructuredExtractionExecutionSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-structured-extraction-execution.v1"),
    verificationContractVersion: VerificationContractVersionSchema,
    tenantId: canonicalUuid,
    operationId: canonicalUuid,
    operationStepId: canonicalUuid,
    producerAttemptId: canonicalUuid,
    requestDigest: Sha256DigestSchema,
    stepInputDigest: Sha256DigestSchema,
    profileArtifact: VerificationArtifactHandleSchema,
    runtime: VerificationStructuredExtractionRuntimeSchema,
    execution: z.strictObject({
      mode: z.enum(["synthetic_transport", "live_provider"]),
      networkPolicy: z.enum(["disabled", "allowlisted"]),
    }),
    versions: z.strictObject({
      parser: boundedName,
      extractor: boundedName,
      canonicalization: boundedName,
    }),
    createdAt: canonicalTime,
  })
  .superRefine((value, context) => {
    if (value.profileArtifact.tenantId !== value.tenantId) {
      context.addIssue({
        code: "custom",
        path: ["profileArtifact"],
        message: "profile artifact must belong to the execution tenant",
      });
    }
    if (value.runtime.code.dirtyStateArtifact && value.runtime.code.dirtyStateArtifact.tenantId !== value.tenantId) {
      context.addIssue({
        code: "custom",
        path: ["runtime", "code", "dirtyStateArtifact"],
        message: "dirty-state artifact must belong to the execution tenant",
      });
    }
    if ((value.execution.mode === "synthetic_transport") !== (value.execution.networkPolicy === "disabled")) {
      context.addIssue({
        code: "custom",
        path: ["execution", "networkPolicy"],
        message:
          "synthetic transport requires disabled networking and live provider execution requires allowlisted networking",
      });
    }
  });
export type VerificationStructuredExtractionExecution = z.infer<typeof VerificationStructuredExtractionExecutionSchema>;

const capture = z.strictObject({
  tenantId: canonicalUuid,
  providerAttemptId: canonicalUuid,
  operationId: canonicalUuid,
  operationStepId: canonicalUuid,
  profileArtifactId: canonicalUuid,
  profileDigest: Sha256DigestSchema,
  dispatchFencingToken: z.int().positive(),
  httpStatus: z.int().min(200).max(599),
  responseEnvelopeArtifactId: canonicalUuid,
  transportArtifactId: canonicalUuid,
  transportDigest: Sha256DigestSchema,
  capturedAt: canonicalTime,
});

/** Application-owned snapshot contract matching the retained canonical lifecycle without importing persistence. */
export const StructuredExtractionPublicationLifecycleSnapshotSchema = z
  .strictObject({
    identity: z.strictObject({
      tenantId: canonicalUuid,
      operationId: canonicalUuid,
      operationStepId: canonicalUuid,
      producerAttemptId: canonicalUuid,
      requestDigest: Sha256DigestSchema,
      stepInputDigest: Sha256DigestSchema,
      captureId: canonicalUuid,
      profileArtifact: VerificationArtifactHandleSchema,
      schemaArtifact: VerificationArtifactHandleSchema,
      sourceArtifact: VerificationArtifactHandleSchema,
      representationArtifact: VerificationArtifactHandleSchema,
      transformationArtifact: VerificationArtifactHandleSchema,
      promptDigest: Sha256DigestSchema,
      schemaDigest: Sha256DigestSchema,
    }),
    identityDigest: Sha256DigestSchema,
    status: z.literal("retained"),
    startedAt: canonicalTime,
    retentionStartedAt: canonicalTime,
    completedAt: canonicalTime,
    capture,
    providerRequestArtifact: VerificationArtifactHandleSchema,
    rawResponseArtifact: VerificationArtifactHandleSchema,
    responseEnvelopeArtifact: VerificationArtifactHandleSchema,
    transportArtifact: VerificationArtifactHandleSchema,
    candidateArtifact: VerificationArtifactHandleSchema,
    precontextArtifact: VerificationArtifactHandleSchema.nullable(),
    provenanceArtifact: VerificationArtifactHandleSchema,
  })
  .superRefine((value, context) => {
    const { identity } = value;
    const handles = [
      identity.profileArtifact,
      identity.schemaArtifact,
      identity.sourceArtifact,
      identity.representationArtifact,
      identity.transformationArtifact,
      value.providerRequestArtifact,
      value.rawResponseArtifact,
      value.responseEnvelopeArtifact,
      value.transportArtifact,
      value.candidateArtifact,
      value.provenanceArtifact,
      ...(value.precontextArtifact ? [value.precontextArtifact] : []),
    ];
    if (handles.some((handle) => handle.tenantId !== identity.tenantId))
      context.addIssue({
        code: "custom",
        path: ["identity", "tenantId"],
        message: "all lifecycle artifacts must belong to the lifecycle tenant",
      });
    if (
      value.capture.tenantId !== identity.tenantId ||
      value.capture.operationId !== identity.operationId ||
      value.capture.operationStepId !== identity.operationStepId ||
      value.capture.profileArtifactId !== identity.profileArtifact.artifactId ||
      value.capture.profileDigest !== identity.profileArtifact.digest ||
      value.capture.responseEnvelopeArtifactId !== value.responseEnvelopeArtifact.artifactId ||
      value.capture.transportArtifactId !== value.transportArtifact.artifactId ||
      value.capture.transportDigest !== value.transportArtifact.digest
    )
      context.addIssue({
        code: "custom",
        path: ["capture"],
        message: "capture must bind the original lifecycle and retained response artifacts",
      });
    if (
      Date.parse(value.capture.capturedAt) < Date.parse(value.startedAt) ||
      Date.parse(value.retentionStartedAt) < Date.parse(value.capture.capturedAt) ||
      Date.parse(value.completedAt) < Date.parse(value.retentionStartedAt)
    )
      context.addIssue({ code: "custom", path: ["completedAt"], message: "lifecycle timestamps are out of order" });
  });
export type StructuredExtractionPublicationLifecycleSnapshot = z.infer<
  typeof StructuredExtractionPublicationLifecycleSnapshotSchema
>;

export const StructuredExtractionProviderCallSnapshotSchema = z
  .strictObject({
    providerAttemptId: canonicalUuid,
    budgetId: canonicalUuid,
    providerId: z.enum(["gateway-structured-extraction.v1", "interfaze-extraction.v1"]),
    model: boundedPipeField,
    configurationDigest: Sha256DigestSchema,
    attemptOrdinal: z.int().nonnegative().max(8),
    reservationCostMicros: z.int().positive().max(20_000_000),
    state: z.enum(["dispatched", "uncertain", "settled"]),
    actualCostMicros: z.int().nonnegative().max(20_000_000).nullable(),
    pricingBasis: z.enum(["synthetic_transport", "provider_reported_response"]),
    costEvidenceArtifact: VerificationArtifactHandleSchema,
    supplierBillingVerified: z.literal(false),
  })
  .superRefine((value, context) => {
    if (
      value.state === "settled" &&
      (value.actualCostMicros === null || value.actualCostMicros > value.reservationCostMicros)
    )
      context.addIssue({
        code: "custom",
        path: ["actualCostMicros"],
        message: "settled calls require bounded actual cost",
      });
    if (value.state !== "settled" && value.actualCostMicros !== null)
      context.addIssue({ code: "custom", path: ["actualCostMicros"], message: "unknown actual cost must remain null" });
  });
export type StructuredExtractionProviderCallSnapshot = z.infer<typeof StructuredExtractionProviderCallSnapshotSchema>;

/** Custody publication for one schema-valid producer candidate. It makes no quality-verification claim. */
export const VerificationStructuredExtractionPublicationSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-structured-extraction-publication.v1"),
    verificationContractVersion: VerificationContractVersionSchema,
    tenantId: canonicalUuid,
    operationId: canonicalUuid,
    operationStepId: canonicalUuid,
    producerAttemptId: canonicalUuid,
    requestDigest: Sha256DigestSchema,
    stepInputDigest: Sha256DigestSchema,
    lifecycleIdentityDigest: Sha256DigestSchema,
    execution: z.strictObject({
      artifact: VerificationArtifactHandleSchema,
      payloadDigest: Sha256DigestSchema,
      runtimeDigest: Sha256DigestSchema,
      manifest: VerificationStructuredExtractionExecutionSchema,
    }),
    input: z.strictObject({
      captureId: canonicalUuid,
      profileArtifact: VerificationArtifactHandleSchema,
      schemaArtifact: VerificationArtifactHandleSchema,
      sourceArtifact: VerificationArtifactHandleSchema,
      representationArtifact: VerificationArtifactHandleSchema,
      transformationArtifact: VerificationArtifactHandleSchema,
      promptDigest: Sha256DigestSchema,
      schemaDigest: Sha256DigestSchema,
    }),
    response: z.strictObject({
      capture,
      providerRequestArtifact: VerificationArtifactHandleSchema,
      rawResponseArtifact: VerificationArtifactHandleSchema,
      responseEnvelopeArtifact: VerificationArtifactHandleSchema,
      transportArtifact: VerificationArtifactHandleSchema,
    }),
    providerCall: StructuredExtractionProviderCallSnapshotSchema,
    providerCallDigest: Sha256DigestSchema,
    output: z.strictObject({
      status: z.literal("unverified_candidate"),
      schemaValidation: z.literal("shape_only"),
      candidateArtifact: VerificationArtifactHandleSchema,
      provenanceArtifact: VerificationArtifactHandleSchema,
      precontextArtifact: VerificationArtifactHandleSchema.nullable(),
      outputDigest: Sha256DigestSchema,
    }),
    startedAt: canonicalTime,
    retentionStartedAt: canonicalTime,
    completedAt: canonicalTime,
    seal: z.strictObject({
      payloadDigest: Sha256DigestSchema,
      purpose: z.literal("artifact_custody_only"),
      signature: z.strictObject({
        algorithm: z.literal("Ed25519"),
        keyId: boundedName,
        signatureBase64: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
      }),
    }),
  })
  .superRefine((value, context) => {
    const execution = value.execution.manifest;
    if (
      value.execution.artifact.digest !== value.execution.payloadDigest ||
      execution.tenantId !== value.tenantId ||
      execution.operationId !== value.operationId ||
      execution.operationStepId !== value.operationStepId ||
      execution.producerAttemptId !== value.producerAttemptId ||
      execution.requestDigest !== value.requestDigest ||
      execution.stepInputDigest !== value.stepInputDigest
    )
      context.addIssue({
        code: "custom",
        path: ["execution"],
        message: "execution artifact and decoded execution must bind the publication identity",
      });
    if (
      execution.profileArtifact.artifactId !== value.input.profileArtifact.artifactId ||
      execution.profileArtifact.digest !== value.input.profileArtifact.digest
    )
      context.addIssue({
        code: "custom",
        path: ["input", "profileArtifact"],
        message: "execution and lifecycle profile must match",
      });
    const handles = [
      value.execution.artifact,
      value.input.profileArtifact,
      value.input.schemaArtifact,
      value.input.sourceArtifact,
      value.input.representationArtifact,
      value.input.transformationArtifact,
      value.response.providerRequestArtifact,
      value.response.rawResponseArtifact,
      value.response.responseEnvelopeArtifact,
      value.response.transportArtifact,
      value.output.candidateArtifact,
      value.output.provenanceArtifact,
      ...(value.output.precontextArtifact ? [value.output.precontextArtifact] : []),
      ...(execution.runtime.code.dirtyStateArtifact ? [execution.runtime.code.dirtyStateArtifact] : []),
    ];
    if (handles.some((handle) => handle.tenantId !== value.tenantId))
      context.addIssue({
        code: "custom",
        path: ["tenantId"],
        message: "all publication artifacts must belong to the publication tenant",
      });
    const c = value.response.capture;
    if (
      c.tenantId !== value.tenantId ||
      c.operationId !== value.operationId ||
      c.operationStepId !== value.operationStepId ||
      c.profileArtifactId !== value.input.profileArtifact.artifactId ||
      c.profileDigest !== value.input.profileArtifact.digest ||
      c.responseEnvelopeArtifactId !== value.response.responseEnvelopeArtifact.artifactId ||
      c.transportArtifactId !== value.response.transportArtifact.artifactId ||
      c.transportDigest !== value.response.transportArtifact.digest
    )
      context.addIssue({
        code: "custom",
        path: ["response", "capture"],
        message: "response capture ancestry is inconsistent",
      });
    if (
      value.providerCall.providerAttemptId !== c.providerAttemptId ||
      value.providerCall.costEvidenceArtifact.artifactId !== value.response.rawResponseArtifact.artifactId ||
      value.providerCall.costEvidenceArtifact.digest !== value.response.rawResponseArtifact.digest
    )
      context.addIssue({
        code: "custom",
        path: ["providerCall"],
        message: "provider call must bind the original attempt and raw response cost evidence",
      });
    if (
      (execution.execution.mode === "synthetic_transport") !==
      (value.providerCall.pricingBasis === "synthetic_transport")
    )
      context.addIssue({
        code: "custom",
        path: ["providerCall", "pricingBasis"],
        message: "pricing basis must match execution mode",
      });
    if (
      Date.parse(value.startedAt) < Date.parse(execution.createdAt) ||
      Date.parse(c.capturedAt) < Date.parse(value.startedAt) ||
      Date.parse(value.retentionStartedAt) < Date.parse(c.capturedAt) ||
      Date.parse(value.completedAt) < Date.parse(value.retentionStartedAt)
    )
      context.addIssue({ code: "custom", path: ["completedAt"], message: "publication timestamps are out of order" });
  });
export type VerificationStructuredExtractionPublication = z.infer<
  typeof VerificationStructuredExtractionPublicationSchema
>;
