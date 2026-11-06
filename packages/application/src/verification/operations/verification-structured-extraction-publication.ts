import { z } from "zod";
import {
  StructuredExtractionPublicationLifecycleSnapshotSchema,
  StructuredExtractionProviderCallSnapshotSchema,
  VerificationArtifactHandleSchema,
  VerificationStructuredExtractionExecutionSchema,
  VerificationStructuredExtractionPublicationSchema,
  VerificationStructuredExtractionSourceCustodySchema,
  type StructuredExtractionPublicationLifecycleSnapshot,
  type StructuredExtractionProviderCallSnapshot,
  type VerificationArtifactHandle,
  type VerificationStructuredExtractionExecution,
  type VerificationStructuredExtractionPublication,
  type VerificationStructuredExtractionRuntime,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  registeredProvider,
  type AuditBundleSigner,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import { structuredExtractionArtifactTransformationSignature } from "./verification-structured-extraction-candidate.js";
import { VerificationStructuredExtractionProducerProfileSchema } from "./verification-structured-extraction-profile.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const canonicalUuidSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), "UUID must use canonical lower-case form");
const canonicalInstantSchema = z.iso.datetime().refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}, "Timestamp must use canonical UTC millisecond form");

export const VERIFICATION_STRUCTURED_EXTRACTION_EXECUTION_ARTIFACT_TYPE =
  "verification_structured_extraction_execution" as const;
export const VERIFICATION_STRUCTURED_EXTRACTION_PUBLICATION_ARTIFACT_TYPE =
  "verification_structured_extraction_publication" as const;
export const VERIFICATION_STRUCTURED_EXTRACTION_SOURCE_CUSTODY_ARTIFACT_TYPE =
  "verification_structured_extraction_source_custody" as const;

export interface StructuredExtractionPublicationArtifactPort {
  register(input: {
    readonly tenantId: string;
    readonly producerAttemptId: string;
    readonly artifactType:
      | typeof VERIFICATION_STRUCTURED_EXTRACTION_EXECUTION_ARTIFACT_TYPE
      | typeof VERIFICATION_STRUCTURED_EXTRACTION_PUBLICATION_ARTIFACT_TYPE;
    readonly bytes: Uint8Array;
    readonly createdAt: string;
    readonly parentArtifactIds: readonly string[];
    readonly transformationSignature: `sha256:${string}`;
  }): Promise<VerificationArtifactHandle>;
}

const executionSignatureInputSchema = z.strictObject({
  payloadDigest: digestSchema,
  tenantId: canonicalUuidSchema,
  operationId: canonicalUuidSchema,
  operationStepId: canonicalUuidSchema,
  producerAttemptId: canonicalUuidSchema,
  requestDigest: digestSchema,
  stepInputDigest: digestSchema,
  profileDigest: digestSchema,
  runtimeDigest: digestSchema,
  mode: z.enum(["synthetic_transport", "live_provider"]),
  createdAt: canonicalInstantSchema,
  parentArtifactIds: z.array(canonicalUuidSchema).min(1).max(2),
});

export interface StructuredExtractionExecutionSignatureInput {
  readonly payloadDigest: `sha256:${string}`;
  readonly tenantId: string;
  readonly operationId: string;
  readonly operationStepId: string;
  readonly producerAttemptId: string;
  readonly requestDigest: `sha256:${string}`;
  readonly stepInputDigest: `sha256:${string}`;
  readonly profileDigest: `sha256:${string}`;
  readonly runtimeDigest: `sha256:${string}`;
  readonly mode: "synthetic_transport" | "live_provider";
  readonly createdAt: string;
  readonly parentArtifactIds: readonly string[];
}

/** SQL can reproduce this digest with digest(concat_ws('|', ...), 'sha256'). */
export function structuredExtractionExecutionTransformationSignature(
  input: StructuredExtractionExecutionSignatureInput,
): `sha256:${string}` {
  const value = executionSignatureInputSchema.parse(input);
  return pipeDigest([
    "verification-structured-extraction-execution-artifact.v1",
    value.payloadDigest,
    value.tenantId,
    value.operationId,
    value.operationStepId,
    value.producerAttemptId,
    value.requestDigest,
    value.stepInputDigest,
    value.profileDigest,
    value.runtimeDigest,
    value.mode,
    value.createdAt,
    ...value.parentArtifactIds,
  ]);
}

const publicationSignatureInputSchema = z.strictObject({
  payloadDigest: digestSchema,
  sealPayloadDigest: digestSchema,
  tenantId: canonicalUuidSchema,
  operationId: canonicalUuidSchema,
  operationStepId: canonicalUuidSchema,
  producerAttemptId: canonicalUuidSchema,
  executionDigest: digestSchema,
  candidateDigest: digestSchema,
  provenanceDigest: digestSchema,
  providerCallDigest: digestSchema,
  originalDispatchFencingToken: z.int().positive(),
  startedAt: canonicalInstantSchema,
  retentionStartedAt: canonicalInstantSchema,
  completedAt: canonicalInstantSchema,
  parentArtifactIds: z.array(canonicalUuidSchema).min(12).max(14),
});

export interface StructuredExtractionPublicationSignatureInput {
  readonly payloadDigest: `sha256:${string}`;
  readonly sealPayloadDigest: `sha256:${string}`;
  readonly tenantId: string;
  readonly operationId: string;
  readonly operationStepId: string;
  readonly producerAttemptId: string;
  readonly executionDigest: `sha256:${string}`;
  readonly candidateDigest: `sha256:${string}`;
  readonly provenanceDigest: `sha256:${string}`;
  readonly providerCallDigest: `sha256:${string}`;
  readonly originalDispatchFencingToken: number;
  readonly startedAt: string;
  readonly retentionStartedAt: string;
  readonly completedAt: string;
  readonly parentArtifactIds: readonly string[];
}

/** SQL can reproduce this digest with digest(concat_ws('|', ...), 'sha256'). */
export function structuredExtractionPublicationTransformationSignature(
  input: StructuredExtractionPublicationSignatureInput,
): `sha256:${string}` {
  const value = publicationSignatureInputSchema.parse(input);
  return pipeDigest([
    "verification-structured-extraction-publication-artifact.v1",
    value.payloadDigest,
    value.sealPayloadDigest,
    value.tenantId,
    value.operationId,
    value.operationStepId,
    value.producerAttemptId,
    value.executionDigest,
    value.candidateDigest,
    value.provenanceDigest,
    value.providerCallDigest,
    String(value.originalDispatchFencingToken),
    value.startedAt,
    value.retentionStartedAt,
    value.completedAt,
    ...value.parentArtifactIds,
  ]);
}

const providerCallDigestInputSchema = StructuredExtractionProviderCallSnapshotSchema;

/** SQL-reproducible semantic digest of canonical provider-accounting fields. */
export function structuredExtractionProviderCallDigest(
  input: StructuredExtractionProviderCallSnapshot,
): `sha256:${string}` {
  const value = providerCallDigestInputSchema.parse(input);
  return pipeDigest([
    "verification-structured-extraction-provider-call.v1",
    value.providerAttemptId,
    value.budgetId,
    value.providerId,
    value.model,
    String(value.attemptOrdinal),
    String(value.reservationCostMicros),
    value.state,
    value.actualCostMicros === null ? "unknown" : String(value.actualCostMicros),
    value.pricingBasis,
    value.costEvidenceArtifact.artifactId,
    value.costEvidenceArtifact.digest,
    "false",
  ]);
}

export function structuredExtractionExecutionParentArtifactIds(
  execution: VerificationStructuredExtractionExecution,
): readonly string[] {
  return deepFreeze([
    execution.profileArtifact.artifactId,
    ...(execution.runtime.code.dirtyStateArtifact ? [execution.runtime.code.dirtyStateArtifact.artifactId] : []),
  ]);
}

export function structuredExtractionPublicationParentArtifactIds(
  manifest: VerificationStructuredExtractionPublication,
): readonly string[] {
  const ids = [
    manifest.execution.artifact.artifactId,
    manifest.output.candidateArtifact.artifactId,
    manifest.output.provenanceArtifact.artifactId,
    ...(manifest.output.precontextArtifact ? [manifest.output.precontextArtifact.artifactId] : []),
    manifest.input.profileArtifact.artifactId,
    ...(manifest.execution.manifest.runtime.code.dirtyStateArtifact
      ? [manifest.execution.manifest.runtime.code.dirtyStateArtifact.artifactId]
      : []),
    manifest.input.schemaArtifact.artifactId,
    manifest.input.sourceArtifact.artifactId,
    manifest.input.representationArtifact.artifactId,
    manifest.input.transformationArtifact.artifactId,
    manifest.response.transportArtifact.artifactId,
    manifest.response.responseEnvelopeArtifact.artifactId,
    manifest.response.providerRequestArtifact.artifactId,
    manifest.response.rawResponseArtifact.artifactId,
  ];
  if (new Set(ids).size !== ids.length) throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_ANCESTRY_INVALID");
  return deepFreeze(ids);
}

export class StructuredExtractionExecutionArtifactBuilder {
  constructor(
    private readonly ports: {
      readonly artifacts: StructuredExtractionPublicationArtifactPort;
      readonly createResolver: () => TrustedArtifactResolver;
    },
  ) {}

  async prepare(input: {
    readonly identity: {
      readonly tenantId: string;
      readonly operationId: string;
      readonly operationStepId: string;
      readonly producerAttemptId: string;
      readonly requestDigest: `sha256:${string}`;
      readonly stepInputDigest: `sha256:${string}`;
    };
    readonly profileArtifact: VerificationArtifactHandle;
    readonly runtime: VerificationStructuredExtractionRuntime;
    readonly execution: VerificationStructuredExtractionExecution["execution"];
    readonly versions: VerificationStructuredExtractionExecution["versions"];
    readonly createdAt: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly execution: VerificationStructuredExtractionExecution;
    readonly artifact: VerificationArtifactHandle;
    readonly payloadDigest: `sha256:${string}`;
    readonly runtimeDigest: `sha256:${string}`;
  }> {
    const snapshot = deepFreeze(
      VerificationStructuredExtractionExecutionSchema.parse({
        schemaVersion: "verification-structured-extraction-execution.v1",
        verificationContractVersion: "verification.v1",
        ...input.identity,
        profileArtifact: input.profileArtifact,
        runtime: input.runtime,
        execution: input.execution,
        versions: input.versions,
        createdAt: input.createdAt,
      }),
    );
    active(input.signal, "STRUCTURED_EXTRACTION_EXECUTION_CANCELLED");
    const profile = await hydrateExact(
      this.ports.createResolver,
      snapshot.tenantId,
      snapshot.profileArtifact,
      128_000,
      input.signal,
      "STRUCTURED_EXTRACTION_EXECUTION_PROFILE_INVALID",
      "STRUCTURED_EXTRACTION_EXECUTION_CANCELLED",
    );
    const decodedProfile = VerificationStructuredExtractionProducerProfileSchema.parse(
      JSON.parse(decoder.decode(profile.bytes)),
    );
    if (
      canonicalizeJson(decodedProfile) !== decoder.decode(profile.bytes) ||
      decodedProfile.tenantId !== snapshot.tenantId
    )
      throw new Error("STRUCTURED_EXTRACTION_EXECUTION_PROFILE_INVALID");
    const dirty = snapshot.runtime.code.dirtyStateArtifact;
    if (dirty) {
      const sourceCustody = await hydrateExact(
        this.ports.createResolver,
        snapshot.tenantId,
        dirty,
        1_500_000,
        input.signal,
        "STRUCTURED_EXTRACTION_EXECUTION_DIRTY_STATE_INVALID",
        "STRUCTURED_EXTRACTION_EXECUTION_CANCELLED",
      );
      validateSourceCustody(
        sourceCustody.bytes,
        snapshot.tenantId,
        "STRUCTURED_EXTRACTION_EXECUTION_DIRTY_STATE_INVALID",
      );
    }
    const parentArtifactIds = structuredExtractionExecutionParentArtifactIds(snapshot);
    if (new Set(parentArtifactIds).size !== parentArtifactIds.length)
      throw new Error("STRUCTURED_EXTRACTION_EXECUTION_ANCESTRY_INVALID");
    const bytes = encoder.encode(canonicalizeJson(snapshot));
    const payloadDigest = sha256Digest(bytes);
    const runtimeDigest = digestCanonicalJson(snapshot.runtime);
    const transformationSignature = structuredExtractionExecutionTransformationSignature({
      payloadDigest,
      tenantId: snapshot.tenantId,
      operationId: snapshot.operationId,
      operationStepId: snapshot.operationStepId,
      producerAttemptId: snapshot.producerAttemptId,
      requestDigest: snapshot.requestDigest as `sha256:${string}`,
      stepInputDigest: snapshot.stepInputDigest as `sha256:${string}`,
      profileDigest: snapshot.profileArtifact.digest as `sha256:${string}`,
      runtimeDigest,
      mode: snapshot.execution.mode,
      createdAt: snapshot.createdAt,
      parentArtifactIds,
    });
    const artifact = await registerExact(
      this.ports.artifacts,
      {
        tenantId: snapshot.tenantId,
        producerAttemptId: snapshot.producerAttemptId,
        artifactType: VERIFICATION_STRUCTURED_EXTRACTION_EXECUTION_ARTIFACT_TYPE,
        bytes,
        createdAt: snapshot.createdAt,
        parentArtifactIds,
        transformationSignature,
      },
      input.signal,
      "STRUCTURED_EXTRACTION_EXECUTION_REGISTERED_ARTIFACT_MISMATCH",
    );
    return deepFreeze({ execution: snapshot, artifact, payloadDigest, runtimeDigest });
  }
}

const candidateEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal("verification-extraction-candidate.v1"),
  tenantId: canonicalUuidSchema,
  operationId: canonicalUuidSchema,
  providerAttemptId: canonicalUuidSchema,
  originalDispatchFencingToken: z.int().positive(),
  profileArtifactId: canonicalUuidSchema,
  profileDigest: digestSchema,
  promptDigest: digestSchema,
  schemaDigest: digestSchema,
  outputDigest: digestSchema,
  outputVerification: z.literal("unverified_candidate"),
  output: z.unknown(),
});

const provenanceSchema = z.strictObject({
  schemaVersion: z.literal("verification-structured-extraction-provenance.v1"),
  tenantId: canonicalUuidSchema,
  operationId: canonicalUuidSchema,
  providerAttemptId: canonicalUuidSchema,
  operationStepId: canonicalUuidSchema,
  originalDispatchFencingToken: z.int().positive(),
  createdAt: canonicalInstantSchema,
  producerAttemptId: canonicalUuidSchema,
  status: z.literal("unverified_candidate"),
  profile: z.strictObject({
    artifact: VerificationArtifactHandleSchema,
    profileId: z.literal("registered_default"),
    profileVersion: z.string().min(1).max(120),
    providerId: z.string().min(1).max(120),
    providerConfigurationDigest: digestSchema,
  }),
  extraction: z.strictObject({
    schemaArtifact: VerificationArtifactHandleSchema,
    schemaId: z.string().min(1).max(255),
    schemaVersion: z.string().min(1).max(120),
    schemaDigest: digestSchema,
    promptDigest: digestSchema,
    selectedEvidence: z
      .array(z.strictObject({ path: z.string().min(1).max(1024), selectedContentDigest: digestSchema }))
      .max(128),
  }),
  input: z.strictObject({
    captureId: canonicalUuidSchema,
    sourceArtifact: VerificationArtifactHandleSchema,
    representationArtifact: VerificationArtifactHandleSchema,
    transformationArtifact: VerificationArtifactHandleSchema,
  }),
  response: z.strictObject({
    transportArtifact: VerificationArtifactHandleSchema,
    responseEnvelopeArtifact: VerificationArtifactHandleSchema,
    requestArtifact: VerificationArtifactHandleSchema,
    rawResponseArtifact: VerificationArtifactHandleSchema,
    httpStatus: z.int().min(200).max(599),
    capturedAt: canonicalInstantSchema,
    externalRequests: z.literal(0),
    memoryFetches: z.int().min(0).max(16),
  }),
  candidate: z.strictObject({
    artifact: VerificationArtifactHandleSchema,
    digest: digestSchema,
    outputDigest: digestSchema,
    byteLength: z.int().positive().max(1_050_624),
    status: z.literal("unverified_candidate"),
  }),
  precontext: z
    .strictObject({
      artifact: VerificationArtifactHandleSchema,
      digest: digestSchema,
      byteLength: z.int().positive().max(220_000),
    })
    .nullable(),
});

const precontextEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal("verification-structured-extraction-precontext.v1"),
  tenantId: canonicalUuidSchema,
  operationId: canonicalUuidSchema,
  providerAttemptId: canonicalUuidSchema,
  originalDispatchFencingToken: z.int().positive(),
  profileArtifactId: canonicalUuidSchema,
  profileDigest: digestSchema,
  promptDigest: digestSchema,
  schemaDigest: digestSchema,
  precontextDigest: digestSchema,
  precontextBase64: z
    .string()
    .max(214_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
});

export class StructuredExtractionPublicationArtifactBuilder {
  constructor(
    private readonly ports: {
      readonly artifacts: StructuredExtractionPublicationArtifactPort;
      readonly createResolver: () => TrustedArtifactResolver;
      readonly signer: AuditBundleSigner;
    },
  ) {}

  async publish(input: {
    readonly lifecycle: StructuredExtractionPublicationLifecycleSnapshot;
    readonly executionArtifact: VerificationArtifactHandle;
    readonly providerCall: StructuredExtractionProviderCallSnapshot;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly manifest: VerificationStructuredExtractionPublication;
    readonly artifact: VerificationArtifactHandle;
    readonly payloadDigest: `sha256:${string}`;
  }> {
    const lifecycle = deepFreeze(StructuredExtractionPublicationLifecycleSnapshotSchema.parse(input.lifecycle));
    const executionArtifact = deepFreeze(VerificationArtifactHandleSchema.parse(input.executionArtifact));
    const providerCall = deepFreeze(StructuredExtractionProviderCallSnapshotSchema.parse(input.providerCall));
    const signer = {
      algorithm: this.ports.signer.algorithm,
      keyId: this.ports.signer.keyId,
      sign: this.ports.signer.sign.bind(this.ports.signer),
    } as const;
    active(input.signal, "STRUCTURED_EXTRACTION_PUBLICATION_CANCELLED");
    if (digestCanonicalJson(lifecycle.identity) !== lifecycle.identityDigest)
      throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_IDENTITY_INVALID");
    const executionHydration = await hydrateExact(
      this.ports.createResolver,
      lifecycle.identity.tenantId,
      executionArtifact,
      256_000,
      input.signal,
      "STRUCTURED_EXTRACTION_PUBLICATION_EXECUTION_INVALID",
    );
    const execution = parseCanonicalJson(
      VerificationStructuredExtractionExecutionSchema,
      executionHydration.bytes,
      "STRUCTURED_EXTRACTION_PUBLICATION_EXECUTION_INVALID",
    );
    const runtimeDigest = digestCanonicalJson(execution.runtime);
    validateExecutionArtifact(execution, executionArtifact, runtimeDigest);
    validateExecutionLifecycle(execution, lifecycle);
    const profileHydration = await hydrateExact(
      this.ports.createResolver,
      lifecycle.identity.tenantId,
      execution.profileArtifact,
      128_000,
      input.signal,
      "STRUCTURED_EXTRACTION_PUBLICATION_PROFILE_INVALID",
    );
    const profile = parseCanonicalJson(
      VerificationStructuredExtractionProducerProfileSchema,
      profileHydration.bytes,
      "STRUCTURED_EXTRACTION_PUBLICATION_PROFILE_INVALID",
    );
    const registered = registeredProvider(profile.providerId);
    if (
      providerCall.providerAttemptId !== lifecycle.capture.providerAttemptId ||
      providerCall.budgetId !== profile.budget.budgetId ||
      providerCall.providerId !== profile.providerId ||
      providerCall.model !== registered.model ||
      providerCall.configurationDigest !== profile.providerConfigurationDigest ||
      registered.configurationDigest !== profile.providerConfigurationDigest ||
      providerCall.reservationCostMicros !== profile.budget.reservationCostMicros ||
      !same(providerCall.costEvidenceArtifact, lifecycle.rawResponseArtifact)
    )
      throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_PROVIDER_CALL_INVALID");
    await hydrateExact(
      this.ports.createResolver,
      lifecycle.identity.tenantId,
      providerCall.costEvidenceArtifact,
      160_000,
      input.signal,
      "STRUCTURED_EXTRACTION_PUBLICATION_COST_EVIDENCE_INVALID",
    );
    const dirtyStateArtifact = execution.runtime.code.dirtyStateArtifact;
    if (dirtyStateArtifact) {
      const sourceCustody = await hydrateExact(
        this.ports.createResolver,
        lifecycle.identity.tenantId,
        dirtyStateArtifact,
        1_500_000,
        input.signal,
        "STRUCTURED_EXTRACTION_PUBLICATION_DIRTY_STATE_INVALID",
      );
      validateSourceCustody(
        sourceCustody.bytes,
        lifecycle.identity.tenantId,
        "STRUCTURED_EXTRACTION_PUBLICATION_DIRTY_STATE_INVALID",
      );
    }
    if ((execution.execution.mode === "synthetic_transport") !== (providerCall.pricingBasis === "synthetic_transport"))
      throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_PROVIDER_CALL_INVALID");

    const candidateHydration = await hydrateExact(
      this.ports.createResolver,
      lifecycle.identity.tenantId,
      lifecycle.candidateArtifact,
      1_050_624,
      input.signal,
      "STRUCTURED_EXTRACTION_PUBLICATION_CANDIDATE_INVALID",
    );
    const candidate = parseCanonicalJson(
      candidateEnvelopeSchema,
      candidateHydration.bytes,
      "STRUCTURED_EXTRACTION_PUBLICATION_CANDIDATE_INVALID",
    );
    const provenanceHydration = await hydrateExact(
      this.ports.createResolver,
      lifecycle.identity.tenantId,
      lifecycle.provenanceArtifact,
      256_000,
      input.signal,
      "STRUCTURED_EXTRACTION_PUBLICATION_PROVENANCE_INVALID",
    );
    const provenance = parseCanonicalJson(
      provenanceSchema,
      provenanceHydration.bytes,
      "STRUCTURED_EXTRACTION_PUBLICATION_PROVENANCE_INVALID",
    );
    validateCandidateAndProvenance(lifecycle, candidate, provenance);
    if (lifecycle.precontextArtifact) {
      const precontextHydration = await hydrateExact(
        this.ports.createResolver,
        lifecycle.identity.tenantId,
        lifecycle.precontextArtifact,
        220_000,
        input.signal,
        "STRUCTURED_EXTRACTION_PUBLICATION_PRECONTEXT_INVALID",
      );
      const precontext = parseCanonicalJson(
        precontextEnvelopeSchema,
        precontextHydration.bytes,
        "STRUCTURED_EXTRACTION_PUBLICATION_PRECONTEXT_INVALID",
      );
      const rawPrecontext = base64ToBytes(precontext.precontextBase64);
      const precontextParents = [
        lifecycle.transportArtifact.artifactId,
        lifecycle.responseEnvelopeArtifact.artifactId,
        lifecycle.providerRequestArtifact.artifactId,
        lifecycle.rawResponseArtifact.artifactId,
        lifecycle.identity.profileArtifact.artifactId,
      ];
      const precontextSignature = structuredExtractionArtifactTransformationSignature({
        artifactType: "verification_structured_extraction_precontext",
        payloadDigest: lifecycle.precontextArtifact.digest as `sha256:${string}`,
        tenantId: lifecycle.identity.tenantId,
        operationId: lifecycle.identity.operationId,
        providerAttemptId: lifecycle.capture.providerAttemptId,
        originalDispatchFencingToken: lifecycle.capture.dispatchFencingToken,
        profileArtifactId: lifecycle.identity.profileArtifact.artifactId,
        profileDigest: lifecycle.identity.profileArtifact.digest as `sha256:${string}`,
        promptDigest: lifecycle.identity.promptDigest as `sha256:${string}`,
        schemaDigest: lifecycle.identity.schemaDigest as `sha256:${string}`,
        parentArtifactIds: precontextParents,
      });
      if (
        precontext.tenantId !== lifecycle.identity.tenantId ||
        precontext.operationId !== lifecycle.identity.operationId ||
        precontext.providerAttemptId !== lifecycle.capture.providerAttemptId ||
        precontext.originalDispatchFencingToken !== lifecycle.capture.dispatchFencingToken ||
        precontext.profileArtifactId !== lifecycle.identity.profileArtifact.artifactId ||
        precontext.profileDigest !== lifecycle.identity.profileArtifact.digest ||
        precontext.promptDigest !== lifecycle.identity.promptDigest ||
        precontext.schemaDigest !== lifecycle.identity.schemaDigest ||
        precontext.precontextDigest !== sha256Digest(rawPrecontext) ||
        bytesToBase64(rawPrecontext) !== precontext.precontextBase64 ||
        lifecycle.precontextArtifact.createdAt !== lifecycle.retentionStartedAt ||
        !same(lifecycle.precontextArtifact.parentArtifactIds, precontextParents) ||
        lifecycle.precontextArtifact.transformationSignature !== precontextSignature
      )
        throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_PRECONTEXT_INVALID");
    }

    const rawBody = {
      schemaVersion: "verification-structured-extraction-publication.v1",
      verificationContractVersion: "verification.v1",
      tenantId: lifecycle.identity.tenantId,
      operationId: lifecycle.identity.operationId,
      operationStepId: lifecycle.identity.operationStepId,
      producerAttemptId: lifecycle.identity.producerAttemptId,
      requestDigest: lifecycle.identity.requestDigest,
      stepInputDigest: lifecycle.identity.stepInputDigest,
      lifecycleIdentityDigest: lifecycle.identityDigest,
      execution: {
        artifact: executionArtifact,
        payloadDigest: executionArtifact.digest,
        runtimeDigest,
        manifest: execution,
      },
      input: {
        captureId: lifecycle.identity.captureId,
        profileArtifact: lifecycle.identity.profileArtifact,
        schemaArtifact: lifecycle.identity.schemaArtifact,
        sourceArtifact: lifecycle.identity.sourceArtifact,
        representationArtifact: lifecycle.identity.representationArtifact,
        transformationArtifact: lifecycle.identity.transformationArtifact,
        promptDigest: lifecycle.identity.promptDigest,
        schemaDigest: lifecycle.identity.schemaDigest,
      },
      response: {
        capture: lifecycle.capture,
        providerRequestArtifact: lifecycle.providerRequestArtifact,
        rawResponseArtifact: lifecycle.rawResponseArtifact,
        responseEnvelopeArtifact: lifecycle.responseEnvelopeArtifact,
        transportArtifact: lifecycle.transportArtifact,
      },
      providerCall,
      providerCallDigest: structuredExtractionProviderCallDigest(providerCall),
      output: {
        status: "unverified_candidate",
        schemaValidation: "shape_only",
        candidateArtifact: lifecycle.candidateArtifact,
        provenanceArtifact: lifecycle.provenanceArtifact,
        precontextArtifact: lifecycle.precontextArtifact,
        outputDigest: candidate.outputDigest,
      },
      startedAt: lifecycle.startedAt,
      retentionStartedAt: lifecycle.retentionStartedAt,
      completedAt: lifecycle.completedAt,
    };
    const presealed = VerificationStructuredExtractionPublicationSchema.parse({
      ...rawBody,
      seal: {
        payloadDigest: `sha256:${"0".repeat(64)}`,
        purpose: "artifact_custody_only",
        signature: { algorithm: "Ed25519", keyId: signer.keyId, signatureBase64: `${"A".repeat(86)}==` },
      },
    });
    const { seal: _placeholderSeal, ...body } = presealed;
    const sealPayloadDigest = digestCanonicalJson(body);
    const signableBytes = encoder.encode(canonicalizeJson(body));
    active(input.signal, "STRUCTURED_EXTRACTION_PUBLICATION_CANCELLED");
    const signatureBase64 = await signer.sign(signableBytes);
    active(input.signal, "STRUCTURED_EXTRACTION_PUBLICATION_CANCELLED");
    const manifest = deepFreeze(
      VerificationStructuredExtractionPublicationSchema.parse({
        ...body,
        seal: {
          payloadDigest: sealPayloadDigest,
          purpose: "artifact_custody_only",
          signature: { algorithm: signer.algorithm, keyId: signer.keyId, signatureBase64 },
        },
      }),
    );
    const parentArtifactIds = structuredExtractionPublicationParentArtifactIds(manifest);
    const bytes = encoder.encode(canonicalizeJson(manifest));
    const payloadDigest = sha256Digest(bytes);
    const transformationSignature = structuredExtractionPublicationTransformationSignature({
      payloadDigest,
      sealPayloadDigest,
      tenantId: manifest.tenantId,
      operationId: manifest.operationId,
      operationStepId: manifest.operationStepId,
      producerAttemptId: manifest.producerAttemptId,
      executionDigest: manifest.execution.artifact.digest as `sha256:${string}`,
      candidateDigest: manifest.output.candidateArtifact.digest as `sha256:${string}`,
      provenanceDigest: manifest.output.provenanceArtifact.digest as `sha256:${string}`,
      providerCallDigest: manifest.providerCallDigest as `sha256:${string}`,
      originalDispatchFencingToken: manifest.response.capture.dispatchFencingToken,
      startedAt: manifest.startedAt,
      retentionStartedAt: manifest.retentionStartedAt,
      completedAt: manifest.completedAt,
      parentArtifactIds,
    });
    const artifact = await registerExact(
      this.ports.artifacts,
      {
        tenantId: manifest.tenantId,
        producerAttemptId: manifest.producerAttemptId,
        artifactType: VERIFICATION_STRUCTURED_EXTRACTION_PUBLICATION_ARTIFACT_TYPE,
        bytes,
        createdAt: manifest.completedAt,
        parentArtifactIds,
        transformationSignature,
      },
      input.signal,
      "STRUCTURED_EXTRACTION_PUBLICATION_REGISTERED_ARTIFACT_MISMATCH",
    );
    return deepFreeze({ manifest, artifact, payloadDigest });
  }
}

function validateExecutionArtifact(
  execution: VerificationStructuredExtractionExecution,
  artifact: VerificationArtifactHandle,
  runtimeDigest: `sha256:${string}`,
): void {
  const parents = structuredExtractionExecutionParentArtifactIds(execution);
  const bytes = encoder.encode(canonicalizeJson(execution));
  const signature = structuredExtractionExecutionTransformationSignature({
    payloadDigest: sha256Digest(bytes),
    tenantId: execution.tenantId,
    operationId: execution.operationId,
    operationStepId: execution.operationStepId,
    producerAttemptId: execution.producerAttemptId,
    requestDigest: execution.requestDigest as `sha256:${string}`,
    stepInputDigest: execution.stepInputDigest as `sha256:${string}`,
    profileDigest: execution.profileArtifact.digest as `sha256:${string}`,
    runtimeDigest,
    mode: execution.execution.mode,
    createdAt: execution.createdAt,
    parentArtifactIds: parents,
  });
  if (
    artifact.digest !== sha256Digest(bytes) ||
    artifact.byteLength !== bytes.byteLength ||
    artifact.createdAt !== execution.createdAt ||
    !same(artifact.parentArtifactIds, parents) ||
    artifact.transformationSignature !== signature
  )
    throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_EXECUTION_INVALID");
}

function validateExecutionLifecycle(
  execution: VerificationStructuredExtractionExecution,
  lifecycle: StructuredExtractionPublicationLifecycleSnapshot,
): void {
  const identity = lifecycle.identity;
  if (
    execution.tenantId !== identity.tenantId ||
    execution.operationId !== identity.operationId ||
    execution.operationStepId !== identity.operationStepId ||
    execution.producerAttemptId !== identity.producerAttemptId ||
    execution.requestDigest !== identity.requestDigest ||
    execution.stepInputDigest !== identity.stepInputDigest ||
    !same(execution.profileArtifact, identity.profileArtifact) ||
    Date.parse(execution.createdAt) > Date.parse(lifecycle.startedAt)
  )
    throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_EXECUTION_LIFECYCLE_MISMATCH");
}

function validateCandidateAndProvenance(
  lifecycle: StructuredExtractionPublicationLifecycleSnapshot,
  candidate: z.infer<typeof candidateEnvelopeSchema>,
  provenance: z.infer<typeof provenanceSchema>,
): void {
  const i = lifecycle.identity,
    c = lifecycle.capture;
  const baseParents = [
    i.profileArtifact.artifactId,
    i.schemaArtifact.artifactId,
    i.sourceArtifact.artifactId,
    i.representationArtifact.artifactId,
    i.transformationArtifact.artifactId,
    lifecycle.transportArtifact.artifactId,
    lifecycle.responseEnvelopeArtifact.artifactId,
    lifecycle.providerRequestArtifact.artifactId,
    lifecycle.rawResponseArtifact.artifactId,
  ];
  const outputBytes = encoder.encode(canonicalizeJson(candidate.output));
  const candidateBytes = encoder.encode(canonicalizeJson(candidate));
  const candidateSignature = structuredExtractionArtifactTransformationSignature({
    artifactType: "verification_extraction_candidate",
    payloadDigest: sha256Digest(candidateBytes),
    tenantId: i.tenantId,
    operationId: i.operationId,
    providerAttemptId: c.providerAttemptId,
    originalDispatchFencingToken: c.dispatchFencingToken,
    profileArtifactId: i.profileArtifact.artifactId,
    profileDigest: i.profileArtifact.digest as `sha256:${string}`,
    promptDigest: i.promptDigest as `sha256:${string}`,
    schemaDigest: i.schemaDigest as `sha256:${string}`,
    parentArtifactIds: baseParents,
  });
  if (
    candidate.tenantId !== i.tenantId ||
    candidate.operationId !== i.operationId ||
    candidate.providerAttemptId !== c.providerAttemptId ||
    candidate.originalDispatchFencingToken !== c.dispatchFencingToken ||
    candidate.profileArtifactId !== i.profileArtifact.artifactId ||
    candidate.profileDigest !== i.profileArtifact.digest ||
    candidate.promptDigest !== i.promptDigest ||
    candidate.schemaDigest !== i.schemaDigest ||
    candidate.outputDigest !== sha256Digest(outputBytes) ||
    candidate.outputVerification !== "unverified_candidate" ||
    !same(lifecycle.candidateArtifact.parentArtifactIds, baseParents) ||
    lifecycle.candidateArtifact.createdAt !== lifecycle.retentionStartedAt ||
    lifecycle.candidateArtifact.transformationSignature !== candidateSignature
  )
    throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_CANDIDATE_INVALID");
  if (
    provenance.tenantId !== i.tenantId ||
    provenance.operationId !== i.operationId ||
    provenance.operationStepId !== i.operationStepId ||
    provenance.providerAttemptId !== c.providerAttemptId ||
    provenance.producerAttemptId !== i.producerAttemptId ||
    provenance.originalDispatchFencingToken !== c.dispatchFencingToken ||
    provenance.createdAt !== lifecycle.retentionStartedAt ||
    provenance.input.captureId !== i.captureId ||
    !same(provenance.profile.artifact, i.profileArtifact) ||
    !same(provenance.extraction.schemaArtifact, i.schemaArtifact) ||
    !same(provenance.input.sourceArtifact, i.sourceArtifact) ||
    !same(provenance.input.representationArtifact, i.representationArtifact) ||
    !same(provenance.input.transformationArtifact, i.transformationArtifact) ||
    provenance.extraction.promptDigest !== i.promptDigest ||
    provenance.extraction.schemaDigest !== i.schemaDigest ||
    !same(provenance.response.transportArtifact, lifecycle.transportArtifact) ||
    !same(provenance.response.responseEnvelopeArtifact, lifecycle.responseEnvelopeArtifact) ||
    !same(provenance.response.requestArtifact, lifecycle.providerRequestArtifact) ||
    !same(provenance.response.rawResponseArtifact, lifecycle.rawResponseArtifact) ||
    provenance.response.httpStatus !== c.httpStatus ||
    provenance.response.capturedAt !== c.capturedAt ||
    !same(provenance.candidate.artifact, lifecycle.candidateArtifact) ||
    provenance.candidate.digest !== lifecycle.candidateArtifact.digest ||
    provenance.candidate.outputDigest !== candidate.outputDigest ||
    provenance.candidate.byteLength !== lifecycle.candidateArtifact.byteLength ||
    provenance.candidate.status !== "unverified_candidate"
  )
    throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_PROVENANCE_INVALID");
  if (
    (lifecycle.precontextArtifact === null) !== (provenance.precontext === null) ||
    (lifecycle.precontextArtifact &&
      (!same(provenance.precontext!.artifact, lifecycle.precontextArtifact) ||
        provenance.precontext!.digest !== lifecycle.precontextArtifact.digest ||
        provenance.precontext!.byteLength !== lifecycle.precontextArtifact.byteLength))
  )
    throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_PRECONTEXT_INVALID");
  const provenanceParents = [
    lifecycle.candidateArtifact.artifactId,
    ...(lifecycle.precontextArtifact ? [lifecycle.precontextArtifact.artifactId] : []),
    ...baseParents,
  ];
  const provenanceBytes = encoder.encode(canonicalizeJson(provenance));
  const provenanceSignature = structuredExtractionArtifactTransformationSignature({
    artifactType: "verification_structured_extraction_provenance",
    payloadDigest: sha256Digest(provenanceBytes),
    tenantId: i.tenantId,
    operationId: i.operationId,
    providerAttemptId: c.providerAttemptId,
    originalDispatchFencingToken: c.dispatchFencingToken,
    profileArtifactId: i.profileArtifact.artifactId,
    profileDigest: i.profileArtifact.digest as `sha256:${string}`,
    promptDigest: i.promptDigest as `sha256:${string}`,
    schemaDigest: i.schemaDigest as `sha256:${string}`,
    parentArtifactIds: provenanceParents,
  });
  if (
    lifecycle.provenanceArtifact.createdAt !== lifecycle.retentionStartedAt ||
    !same(lifecycle.provenanceArtifact.parentArtifactIds, provenanceParents) ||
    lifecycle.provenanceArtifact.transformationSignature !== provenanceSignature
  )
    throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_PROVENANCE_INVALID");
}

async function hydrateExact(
  createResolver: () => TrustedArtifactResolver,
  tenantId: string,
  expected: VerificationArtifactHandle,
  limit: number,
  signal: AbortSignal | undefined,
  code: string,
  cancellationCode = "STRUCTURED_EXTRACTION_PUBLICATION_CANCELLED",
): Promise<{ readonly bytes: Uint8Array }> {
  active(signal, cancellationCode);
  if (expected.tenantId !== tenantId || expected.byteLength > limit) throw new Error(code);
  const resolver = createResolver();
  await resolver.authorizeArtifact({ tenantId, artifactId: expected.artifactId, purpose: "verification_admission" });
  active(signal, cancellationCode);
  const loaded = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId: expected.artifactId });
  active(signal, cancellationCode);
  const registration = VerificationArtifactHandleSchema.parse(loaded.registration);
  if (
    !same(registration, expected) ||
    registration.tenantId !== tenantId ||
    loaded.bytes.byteLength !== registration.byteLength ||
    sha256Digest(loaded.bytes) !== registration.digest
  )
    throw new Error(code);
  return { bytes: loaded.bytes.slice() };
}

async function registerExact(
  port: StructuredExtractionPublicationArtifactPort,
  input: Parameters<StructuredExtractionPublicationArtifactPort["register"]>[0],
  signal: AbortSignal | undefined,
  code: string,
): Promise<VerificationArtifactHandle> {
  active(
    signal,
    code.includes("EXECUTION")
      ? "STRUCTURED_EXTRACTION_EXECUTION_CANCELLED"
      : "STRUCTURED_EXTRACTION_PUBLICATION_CANCELLED",
  );
  const bytes = input.bytes.slice();
  const artifact = VerificationArtifactHandleSchema.parse(
    await port.register({ ...input, bytes, parentArtifactIds: [...input.parentArtifactIds] }),
  );
  active(
    signal,
    code.includes("EXECUTION")
      ? "STRUCTURED_EXTRACTION_EXECUTION_CANCELLED"
      : "STRUCTURED_EXTRACTION_PUBLICATION_CANCELLED",
  );
  if (
    sha256Digest(bytes) !== sha256Digest(input.bytes) ||
    artifact.tenantId !== input.tenantId ||
    artifact.createdAt !== input.createdAt ||
    artifact.digest !== sha256Digest(input.bytes) ||
    artifact.byteLength !== input.bytes.byteLength ||
    !same(artifact.parentArtifactIds, input.parentArtifactIds) ||
    artifact.transformationSignature !== input.transformationSignature
  )
    throw new Error(code);
  return deepFreeze(artifact);
}

function parseCanonicalJson<T extends z.ZodType>(schema: T, bytes: Uint8Array, code: string): z.infer<T> {
  try {
    const text = decoder.decode(bytes);
    const parsed = schema.parse(JSON.parse(text));
    if (canonicalizeJson(parsed) !== text) throw new Error(code);
    return deepFreeze(parsed) as z.infer<T>;
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code);
  }
}

function pipeDigest(fields: readonly string[]): `sha256:${string}` {
  if (fields.some((field) => field.length === 0 || field.includes("|")))
    throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_SIGNATURE_FIELD_INVALID");
  return sha256Digest(encoder.encode(fields.join("|")));
}

function active(signal: AbortSignal | undefined, code: string): void {
  if (signal?.aborted) throw new Error(code);
}

function same(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function base64ToBytes(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.length % 4 !== 0) throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_PRECONTEXT_INVALID");
  const output = new Uint8Array((value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0));
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const chunk = value.slice(index, index + 4);
    const numbers = [...chunk].map((character) => (character === "=" ? 0 : alphabet.indexOf(character)));
    if (numbers.some((number) => number < 0)) throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_PRECONTEXT_INVALID");
    const packed = (numbers[0]! << 18) | (numbers[1]! << 12) | (numbers[2]! << 6) | numbers[3]!;
    if (offset < output.byteLength) output[offset++] = (packed >>> 16) & 255;
    if (offset < output.byteLength) output[offset++] = (packed >>> 8) & 255;
    if (offset < output.byteLength) output[offset++] = packed & 255;
  }
  return output;
}

function bytesToBase64(value: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < value.byteLength; index += 3) {
    const first = value[index]!,
      second = value[index + 1] ?? 0,
      third = value[index + 2] ?? 0;
    const packed = (first << 16) | (second << 8) | third;
    output += alphabet[(packed >>> 18) & 63]! + alphabet[(packed >>> 12) & 63]!;
    output += index + 1 < value.byteLength ? alphabet[(packed >>> 6) & 63]! : "=";
    output += index + 2 < value.byteLength ? alphabet[packed & 63]! : "=";
  }
  return output;
}

function validateSourceCustody(bytes: Uint8Array, tenantId: string, code: string): void {
  const custody = parseCanonicalJson(VerificationStructuredExtractionSourceCustodySchema, bytes, code);
  if (custody.tenantId !== tenantId) throw new Error(code);
  let totalByteLength = 0;
  for (const file of custody.files) {
    const fileBytes = base64ToBytes(file.bytesBase64);
    if (
      bytesToBase64(fileBytes) !== file.bytesBase64 ||
      fileBytes.byteLength !== file.byteLength ||
      sha256Digest(fileBytes) !== file.sha256
    )
      throw new Error(code);
    totalByteLength += fileBytes.byteLength;
  }
  if (totalByteLength !== custody.totalByteLength) throw new Error(code);
}
