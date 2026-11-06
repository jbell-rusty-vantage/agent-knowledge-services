import { z } from "zod";
import { IsoDateTimeSchema, Sha256DigestSchema, UuidSchema } from "./index-primitives.js";
import {
  StructuredExtractionProviderCallSnapshotSchema,
  VerificationStructuredExtractionExecutionSchema,
} from "./structured-extraction-publication.js";
import { VerificationArtifactHandleSchema, VerificationContractVersionSchema } from "./primitives.js";

const canonicalTime = IsoDateTimeSchema.refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}, "timestamps must use canonical UTC milliseconds");
const canonicalUuid = UuidSchema.refine(
  (value) => value === value.toLowerCase(),
  "UUID must use canonical lower-case form",
);
const boundedName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u);

export const StructuredExtractionFailureCodeSchema = z.enum([
  "PROVIDER_HTTP_FAILURE",
  "PROVIDER_RESPONSE_TOO_LARGE",
  "PROVIDER_RESPONSE_INVALID",
  "PROVIDER_RESPONSE_SCHEMA_INVALID",
]);
export type StructuredExtractionFailureCode = z.infer<typeof StructuredExtractionFailureCodeSchema>;

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

const lifecycleIdentity = z.strictObject({
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
});

/** Snapshot taken while durable response retention is complete but before the DB-owned failure checkpoint is created. */
export const StructuredExtractionFailureLifecycleSnapshotSchema = z
  .strictObject({
    identity: lifecycleIdentity,
    identityDigest: Sha256DigestSchema,
    status: z.literal("retaining"),
    startedAt: canonicalTime,
    retentionStartedAt: canonicalTime,
    completedAt: z.null(),
    capture,
    providerRequestArtifact: VerificationArtifactHandleSchema,
    rawResponseArtifact: VerificationArtifactHandleSchema,
    responseEnvelopeArtifact: VerificationArtifactHandleSchema,
    transportArtifact: VerificationArtifactHandleSchema,
    candidateArtifact: z.null(),
    precontextArtifact: z.null(),
    provenanceArtifact: z.null(),
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
    ];
    if (identity.requestDigest === identity.stepInputDigest)
      context.addIssue({
        code: "custom",
        path: ["identity", "stepInputDigest"],
        message: "request and step-input digests must remain distinct",
      });
    if (handles.some((handle) => handle.tenantId !== identity.tenantId))
      context.addIssue({
        code: "custom",
        path: ["identity", "tenantId"],
        message: "all lifecycle artifacts must belong to the lifecycle tenant",
      });
    const c = value.capture;
    if (
      c.tenantId !== identity.tenantId ||
      c.operationId !== identity.operationId ||
      c.operationStepId !== identity.operationStepId ||
      c.profileArtifactId !== identity.profileArtifact.artifactId ||
      c.profileDigest !== identity.profileArtifact.digest ||
      c.responseEnvelopeArtifactId !== value.responseEnvelopeArtifact.artifactId ||
      c.transportArtifactId !== value.transportArtifact.artifactId ||
      c.transportDigest !== value.transportArtifact.digest
    )
      context.addIssue({
        code: "custom",
        path: ["capture"],
        message: "capture must bind the original lifecycle and retained response artifacts",
      });
    if (
      Date.parse(c.capturedAt) < Date.parse(value.startedAt) ||
      Date.parse(value.retentionStartedAt) < Date.parse(c.capturedAt)
    )
      context.addIssue({
        code: "custom",
        path: ["retentionStartedAt"],
        message: "lifecycle timestamps are out of order",
      });
  });
export type StructuredExtractionFailureLifecycleSnapshot = z.infer<
  typeof StructuredExtractionFailureLifecycleSnapshotSchema
>;

/** Signed custody publication for a captured native provider failure. It carries no candidate or quality claim. */
export const VerificationStructuredExtractionFailureSchema = z
  .strictObject({
    schemaVersion: z.literal("verification-structured-extraction-failure.v1"),
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
    failure: z.strictObject({
      code: StructuredExtractionFailureCodeSchema,
      category: z.enum(["provider_http", "producer_contract"]),
      automaticRetry: z.literal(false),
      candidateArtifact: z.null(),
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
    if (value.requestDigest === value.stepInputDigest)
      context.addIssue({
        code: "custom",
        path: ["stepInputDigest"],
        message: "request and step-input digests must remain distinct",
      });
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
        message: "execution artifact and decoded execution must bind the failure identity",
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
      value.providerCall.costEvidenceArtifact,
      ...(execution.runtime.code.dirtyStateArtifact ? [execution.runtime.code.dirtyStateArtifact] : []),
    ];
    if (handles.some((handle) => handle.tenantId !== value.tenantId))
      context.addIssue({
        code: "custom",
        path: ["tenantId"],
        message: "all failure artifacts must belong to the failure tenant",
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
    const isHttpFailure = value.failure.code === "PROVIDER_HTTP_FAILURE";
    if (value.failure.category !== (isHttpFailure ? "provider_http" : "producer_contract"))
      context.addIssue({
        code: "custom",
        path: ["failure", "category"],
        message: "failure category must be derived from the native provider failure code",
      });
    if (isHttpFailure ? c.httpStatus < 300 : c.httpStatus < 200 || c.httpStatus > 299)
      context.addIssue({
        code: "custom",
        path: ["response", "capture", "httpStatus"],
        message: "HTTP status must agree with the native provider failure code",
      });
    if (
      Date.parse(value.startedAt) < Date.parse(execution.createdAt) ||
      Date.parse(c.capturedAt) < Date.parse(value.startedAt) ||
      Date.parse(value.retentionStartedAt) < Date.parse(c.capturedAt) ||
      Date.parse(value.completedAt) < Date.parse(value.retentionStartedAt)
    )
      context.addIssue({ code: "custom", path: ["completedAt"], message: "failure timestamps are out of order" });
  });
export type VerificationStructuredExtractionFailure = z.infer<typeof VerificationStructuredExtractionFailureSchema>;
