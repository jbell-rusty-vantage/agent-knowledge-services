import { z } from "zod";
import {
  StructuredExtractionFailureCodeSchema,
  StructuredExtractionFailureLifecycleSnapshotSchema,
  StructuredExtractionProviderCallSnapshotSchema,
  VerificationArtifactHandleSchema,
  VerificationStructuredExtractionExecutionSchema,
  VerificationStructuredExtractionFailureSchema,
  VerificationStructuredExtractionSourceCustodySchema,
  type StructuredExtractionFailureCode,
  type StructuredExtractionFailureLifecycleSnapshot,
  type StructuredExtractionProviderCallSnapshot,
  type VerificationArtifactHandle,
  type VerificationStructuredExtractionExecution,
  type VerificationStructuredExtractionFailure,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  admitExtractionSchema,
  canonicalizeJson,
  digestCanonicalJson,
  projectionSelectorResolver,
  providerDigest,
  registeredProvider,
  sha256Digest,
  type AuditBundleSigner,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import {
  structuredExtractionExecutionParentArtifactIds,
  structuredExtractionExecutionTransformationSignature,
  structuredExtractionProviderCallDigest,
} from "./verification-structured-extraction-publication.js";
import {
  StructuredExtractionCapturedReplayService,
  type StructuredExtractionReplayResult,
} from "./verification-structured-extraction-replay.js";
import {
  VerificationStructuredExtractionProducerProfileSchema,
  type PreparedStructuredExtraction,
} from "./verification-structured-extraction-profile.js";
import { VerificationExtractionProfileSchema } from "./verification-service.js";
import {
  VerificationProviderTransportResponseSchema,
  prepareVerificationProviderTransportResponse,
} from "./verification-provider-transport.js";

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

export const VERIFICATION_STRUCTURED_EXTRACTION_FAILURE_ARTIFACT_TYPE =
  "verification_structured_extraction_failure" as const;

export interface StructuredExtractionFailureArtifactPort {
  register(input: {
    readonly tenantId: string;
    readonly producerAttemptId: string;
    readonly artifactType: typeof VERIFICATION_STRUCTURED_EXTRACTION_FAILURE_ARTIFACT_TYPE;
    readonly bytes: Uint8Array;
    readonly createdAt: string;
    readonly parentArtifactIds: readonly string[];
    readonly transformationSignature: `sha256:${string}`;
  }): Promise<VerificationArtifactHandle>;
}

const failureSignatureInputSchema = z.strictObject({
  payloadDigest: digestSchema,
  sealPayloadDigest: digestSchema,
  tenantId: canonicalUuidSchema,
  operationId: canonicalUuidSchema,
  operationStepId: canonicalUuidSchema,
  producerAttemptId: canonicalUuidSchema,
  executionDigest: digestSchema,
  providerCallDigest: digestSchema,
  failureCode: StructuredExtractionFailureCodeSchema,
  originalDispatchFencingToken: z.int().positive(),
  startedAt: canonicalInstantSchema,
  retentionStartedAt: canonicalInstantSchema,
  completedAt: canonicalInstantSchema,
  parentArtifactIds: z.array(canonicalUuidSchema).min(10).max(11),
});

export interface StructuredExtractionFailureSignatureInput {
  readonly payloadDigest: `sha256:${string}`;
  readonly sealPayloadDigest: `sha256:${string}`;
  readonly tenantId: string;
  readonly operationId: string;
  readonly operationStepId: string;
  readonly producerAttemptId: string;
  readonly executionDigest: `sha256:${string}`;
  readonly providerCallDigest: `sha256:${string}`;
  readonly failureCode: StructuredExtractionFailureCode;
  readonly originalDispatchFencingToken: number;
  readonly startedAt: string;
  readonly retentionStartedAt: string;
  readonly completedAt: string;
  readonly parentArtifactIds: readonly string[];
}

/** SQL can reproduce this digest with digest(concat_ws('|', ...), 'sha256'). */
export function structuredExtractionFailureTransformationSignature(
  input: StructuredExtractionFailureSignatureInput,
): `sha256:${string}` {
  const value = failureSignatureInputSchema.parse(input);
  return pipeDigest([
    "verification-structured-extraction-failure-artifact.v1",
    value.payloadDigest,
    value.sealPayloadDigest,
    value.tenantId,
    value.operationId,
    value.operationStepId,
    value.producerAttemptId,
    value.executionDigest,
    value.providerCallDigest,
    value.failureCode,
    String(value.originalDispatchFencingToken),
    value.startedAt,
    value.retentionStartedAt,
    value.completedAt,
    ...value.parentArtifactIds,
  ]);
}

/** Exact ordered custody ancestry used by Storage registration and SQL admission. */
export function structuredExtractionFailureParentArtifactIds(
  manifest: VerificationStructuredExtractionFailure,
): readonly string[] {
  const ids = [
    manifest.execution.artifact.artifactId,
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
  if (new Set(ids).size !== ids.length) throw new Error("STRUCTURED_EXTRACTION_FAILURE_ANCESTRY_INVALID");
  return deepFreeze(ids);
}

const envelopeSchema = z.strictObject({
  schemaVersion: z.literal("verification-provider-response-envelope.v1"),
  requestDigest: digestSchema,
  requestArtifactId: canonicalUuidSchema,
  rawResponseArtifactId: canonicalUuidSchema,
  rawResponseDigest: digestSchema,
});

/** Publishes one issuer-branded captured provider failure. It cannot publish accepted output or create retry policy. */
export class StructuredExtractionFailureArtifactBuilder {
  constructor(
    private readonly replayService: StructuredExtractionCapturedReplayService,
    private readonly ports: {
      readonly artifacts: StructuredExtractionFailureArtifactPort;
      readonly createResolver: () => TrustedArtifactResolver;
      readonly signer: AuditBundleSigner;
    },
  ) {}

  async publish(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly providerAttemptId: string;
    readonly preparation: PreparedStructuredExtraction;
    readonly replay: StructuredExtractionReplayResult;
    readonly lifecycle: StructuredExtractionFailureLifecycleSnapshot;
    readonly completedAt: string;
    readonly executionArtifact: VerificationArtifactHandle;
    readonly providerCall: StructuredExtractionProviderCallSnapshot;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly manifest: VerificationStructuredExtractionFailure;
    readonly artifact: VerificationArtifactHandle;
    readonly payloadDigest: `sha256:${string}`;
  }> {
    this.replayService.assertReplayResult({
      tenantId: input.tenantId,
      operationId: input.operationId,
      providerAttemptId: input.providerAttemptId,
      preparation: input.preparation,
      result: input.replay,
    });
    if (input.replay.kind !== "failed" || input.replay.automaticRetry !== false)
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_REPLAY_NOT_FAILED");
    if (input.replay.precontextBytes !== null) throw new Error("STRUCTURED_EXTRACTION_FAILURE_PRECONTEXT_FORBIDDEN");

    // Every caller-owned value is parsed or cloned before the first await. The issuer-branded
    // preparation and replay objects themselves are checked above before cloning.
    const scope = deepFreeze(
      z
        .strictObject({
          tenantId: canonicalUuidSchema,
          operationId: canonicalUuidSchema,
          providerAttemptId: canonicalUuidSchema,
        })
        .parse({
          tenantId: input.tenantId,
          operationId: input.operationId,
          providerAttemptId: input.providerAttemptId,
        }),
    );
    const lifecycle = deepFreeze(StructuredExtractionFailureLifecycleSnapshotSchema.parse(input.lifecycle));
    const completedAt = canonicalInstantSchema.parse(input.completedAt);
    const executionArtifact = deepFreeze(VerificationArtifactHandleSchema.parse(input.executionArtifact));
    const providerCall = deepFreeze(StructuredExtractionProviderCallSnapshotSchema.parse(input.providerCall));
    const replay = deepFreeze(structuredClone(input.replay));
    const preparation = deepFreeze(structuredClone(input.preparation));
    const signer = {
      algorithm: this.ports.signer.algorithm,
      keyId: this.ports.signer.keyId,
      sign: this.ports.signer.sign.bind(this.ports.signer),
    } as const;
    active(input.signal);

    const identity = lifecycle.identity;
    if (
      scope.tenantId !== identity.tenantId ||
      scope.operationId !== identity.operationId ||
      scope.providerAttemptId !== lifecycle.capture.providerAttemptId ||
      digestCanonicalJson(identity) !== lifecycle.identityDigest
    )
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_IDENTITY_INVALID");
    if (Date.parse(completedAt) < Date.parse(lifecycle.retentionStartedAt))
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_TIMING_INVALID");
    validatePreparation(preparation, lifecycle);
    validateReplay(replay, lifecycle);

    const executionHydration = await hydrateExact(
      this.ports.createResolver,
      identity.tenantId,
      executionArtifact,
      256_000,
      input.signal,
      "STRUCTURED_EXTRACTION_FAILURE_EXECUTION_INVALID",
    );
    const execution = parseCanonicalJson(
      VerificationStructuredExtractionExecutionSchema,
      executionHydration.bytes,
      "STRUCTURED_EXTRACTION_FAILURE_EXECUTION_INVALID",
    );
    const runtimeDigest = digestCanonicalJson(execution.runtime);
    validateExecution(execution, executionArtifact, runtimeDigest, lifecycle);

    const profileHydration = await hydrateExact(
      this.ports.createResolver,
      identity.tenantId,
      identity.profileArtifact,
      128_000,
      input.signal,
      "STRUCTURED_EXTRACTION_FAILURE_PROFILE_INVALID",
    );
    const profile = parseCanonicalJson(
      VerificationStructuredExtractionProducerProfileSchema,
      profileHydration.bytes,
      "STRUCTURED_EXTRACTION_FAILURE_PROFILE_INVALID",
    );
    if (
      !same(profile, preparation.producerProfile) ||
      profile.tenantId !== identity.tenantId ||
      !same(profile.extractionSchema, identity.schemaArtifact)
    )
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_PROFILE_INVALID");

    const schemaHydration = await hydrateExact(
      this.ports.createResolver,
      identity.tenantId,
      identity.schemaArtifact,
      128_000,
      input.signal,
      "STRUCTURED_EXTRACTION_FAILURE_SCHEMA_INVALID",
    );
    const extractionProfile = parseCanonicalJson(
      VerificationExtractionProfileSchema,
      schemaHydration.bytes,
      "STRUCTURED_EXTRACTION_FAILURE_SCHEMA_INVALID",
    );
    const admitted = admitExtractionSchema(extractionProfile.extractionSchema);
    if (
      !admitted.admitted ||
      !admitted.schema ||
      !same(extractionProfile, preparation.extractionProfile) ||
      !same(admitted.schema, preparation.schema) ||
      admitted.schema.schemaDigest !== identity.schemaDigest
    )
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_SCHEMA_INVALID");

    const registered = registeredProvider(profile.providerId);
    if (
      preparation.provider.providerId !== profile.providerId ||
      preparation.provider.model !== registered.model ||
      preparation.provider.configurationDigest !== profile.providerConfigurationDigest ||
      registered.configurationDigest !== profile.providerConfigurationDigest ||
      providerCall.providerAttemptId !== scope.providerAttemptId ||
      providerCall.budgetId !== profile.budget.budgetId ||
      providerCall.providerId !== profile.providerId ||
      providerCall.model !== registered.model ||
      providerCall.configurationDigest !== profile.providerConfigurationDigest ||
      providerCall.reservationCostMicros !== profile.budget.reservationCostMicros ||
      !same(providerCall.costEvidenceArtifact, lifecycle.rawResponseArtifact)
    )
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_PROVIDER_CALL_INVALID");
    if ((execution.execution.mode === "synthetic_transport") !== (providerCall.pricingBasis === "synthetic_transport"))
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_PROVIDER_CALL_INVALID");

    const dirty = execution.runtime.code.dirtyStateArtifact;
    if (dirty) {
      const sourceCustody = await hydrateExact(
        this.ports.createResolver,
        identity.tenantId,
        dirty,
        1_500_000,
        input.signal,
        "STRUCTURED_EXTRACTION_FAILURE_DIRTY_STATE_INVALID",
      );
      validateSourceCustody(sourceCustody.bytes, identity.tenantId);
    }
    await hydrateExact(
      this.ports.createResolver,
      identity.tenantId,
      identity.sourceArtifact,
      16_000_000,
      input.signal,
      "STRUCTURED_EXTRACTION_FAILURE_SOURCE_INVALID",
    );
    const representationHydration = await hydrateExact(
      this.ports.createResolver,
      identity.tenantId,
      identity.representationArtifact,
      16_000_000,
      input.signal,
      "STRUCTURED_EXTRACTION_FAILURE_REPRESENTATION_INVALID",
    );
    await hydrateExact(
      this.ports.createResolver,
      identity.tenantId,
      identity.transformationArtifact,
      2_000_000,
      input.signal,
      "STRUCTURED_EXTRACTION_FAILURE_TRANSFORMATION_INVALID",
    );
    validateSelectedEvidence(preparation, representationHydration.bytes);

    const transportHydration = await hydrateExact(
      this.ports.createResolver,
      identity.tenantId,
      lifecycle.transportArtifact,
      32_000,
      input.signal,
      "STRUCTURED_EXTRACTION_FAILURE_TRANSPORT_INVALID",
    );
    const transport = parseCanonicalJson(
      VerificationProviderTransportResponseSchema,
      transportHydration.bytes,
      "STRUCTURED_EXTRACTION_FAILURE_TRANSPORT_INVALID",
    );
    const preparedTransport = prepareVerificationProviderTransportResponse(transport);
    if (
      !sameBytes(preparedTransport.bytes, transportHydration.bytes) ||
      lifecycle.transportArtifact.transformationSignature !== preparedTransport.transformationSignature ||
      !same(lifecycle.transportArtifact.parentArtifactIds, preparedTransport.parentArtifactIds)
    )
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_TRANSPORT_INVALID");
    validateTransport(transport, lifecycle);

    const envelopeHydration = await hydrateExact(
      this.ports.createResolver,
      identity.tenantId,
      lifecycle.responseEnvelopeArtifact,
      32_000,
      input.signal,
      "STRUCTURED_EXTRACTION_FAILURE_ENVELOPE_INVALID",
    );
    const envelope = parseCanonicalJson(
      envelopeSchema,
      envelopeHydration.bytes,
      "STRUCTURED_EXTRACTION_FAILURE_ENVELOPE_INVALID",
    );
    if (
      envelope.requestArtifactId !== lifecycle.providerRequestArtifact.artifactId ||
      envelope.rawResponseArtifactId !== lifecycle.rawResponseArtifact.artifactId ||
      envelope.rawResponseDigest !== lifecycle.rawResponseArtifact.digest ||
      envelope.requestDigest !== transport.requestDigest ||
      !same(lifecycle.responseEnvelopeArtifact.parentArtifactIds, [
        lifecycle.providerRequestArtifact.artifactId,
        lifecycle.rawResponseArtifact.artifactId,
      ]) ||
      lifecycle.responseEnvelopeArtifact.transformationSignature !==
        providerDigest({
          kind: "verification_provider_response_envelope.v1",
          requestDigest: envelope.requestDigest,
          rawResponseDigest: envelope.rawResponseDigest,
        })
    )
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_ENVELOPE_INVALID");

    const requestHydration = await hydrateExact(
      this.ports.createResolver,
      identity.tenantId,
      lifecycle.providerRequestArtifact,
      160_000,
      input.signal,
      "STRUCTURED_EXTRACTION_FAILURE_REQUEST_INVALID",
    );
    const request = parseCanonicalUnknown(requestHydration.bytes, "STRUCTURED_EXTRACTION_FAILURE_REQUEST_INVALID");
    if (
      providerDigest(request) !== envelope.requestDigest ||
      lifecycle.providerRequestArtifact.parentArtifactIds.length === 0 ||
      lifecycle.providerRequestArtifact.transformationSignature !==
        providerDigest({ kind: "verification_provider_request.v1", requestDigest: envelope.requestDigest })
    )
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_REQUEST_INVALID");
    await hydrateExact(
      this.ports.createResolver,
      identity.tenantId,
      lifecycle.rawResponseArtifact,
      160_000,
      input.signal,
      "STRUCTURED_EXTRACTION_FAILURE_RAW_RESPONSE_INVALID",
    );

    const failureCode = StructuredExtractionFailureCodeSchema.parse(replay.code);
    const isHttpFailure = failureCode === "PROVIDER_HTTP_FAILURE";
    if (
      isHttpFailure
        ? lifecycle.capture.httpStatus < 300
        : lifecycle.capture.httpStatus < 200 || lifecycle.capture.httpStatus > 299
    )
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_CODE_STATUS_INVALID");
    const providerCallDigest = structuredExtractionProviderCallDigest(providerCall);
    const rawBody = {
      schemaVersion: "verification-structured-extraction-failure.v1",
      verificationContractVersion: "verification.v1",
      tenantId: identity.tenantId,
      operationId: identity.operationId,
      operationStepId: identity.operationStepId,
      producerAttemptId: identity.producerAttemptId,
      requestDigest: identity.requestDigest,
      stepInputDigest: identity.stepInputDigest,
      lifecycleIdentityDigest: lifecycle.identityDigest,
      execution: {
        artifact: executionArtifact,
        payloadDigest: executionArtifact.digest,
        runtimeDigest,
        manifest: execution,
      },
      input: {
        captureId: identity.captureId,
        profileArtifact: identity.profileArtifact,
        schemaArtifact: identity.schemaArtifact,
        sourceArtifact: identity.sourceArtifact,
        representationArtifact: identity.representationArtifact,
        transformationArtifact: identity.transformationArtifact,
        promptDigest: identity.promptDigest,
        schemaDigest: identity.schemaDigest,
      },
      response: {
        capture: lifecycle.capture,
        providerRequestArtifact: lifecycle.providerRequestArtifact,
        rawResponseArtifact: lifecycle.rawResponseArtifact,
        responseEnvelopeArtifact: lifecycle.responseEnvelopeArtifact,
        transportArtifact: lifecycle.transportArtifact,
      },
      providerCall,
      providerCallDigest,
      failure: {
        code: failureCode,
        category: isHttpFailure ? "provider_http" : "producer_contract",
        automaticRetry: false,
        candidateArtifact: null,
      },
      startedAt: lifecycle.startedAt,
      retentionStartedAt: lifecycle.retentionStartedAt,
      completedAt,
    } as const;
    const presealed = VerificationStructuredExtractionFailureSchema.parse({
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
    active(input.signal);
    const signatureBase64 = await signer.sign(signableBytes);
    active(input.signal);
    const manifest = deepFreeze(
      VerificationStructuredExtractionFailureSchema.parse({
        ...body,
        seal: {
          payloadDigest: sealPayloadDigest,
          purpose: "artifact_custody_only",
          signature: { algorithm: signer.algorithm, keyId: signer.keyId, signatureBase64 },
        },
      }),
    );
    const parentArtifactIds = structuredExtractionFailureParentArtifactIds(manifest);
    const bytes = encoder.encode(canonicalizeJson(manifest));
    const payloadDigest = sha256Digest(bytes);
    const transformationSignature = structuredExtractionFailureTransformationSignature({
      payloadDigest,
      sealPayloadDigest,
      tenantId: manifest.tenantId,
      operationId: manifest.operationId,
      operationStepId: manifest.operationStepId,
      producerAttemptId: manifest.producerAttemptId,
      executionDigest: manifest.execution.artifact.digest as `sha256:${string}`,
      providerCallDigest: manifest.providerCallDigest as `sha256:${string}`,
      failureCode,
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
        artifactType: VERIFICATION_STRUCTURED_EXTRACTION_FAILURE_ARTIFACT_TYPE,
        bytes,
        createdAt: completedAt,
        parentArtifactIds,
        transformationSignature,
      },
      input.signal,
    );
    return deepFreeze({ manifest, artifact, payloadDigest });
  }
}

function validatePreparation(
  preparation: PreparedStructuredExtraction,
  lifecycle: StructuredExtractionFailureLifecycleSnapshot,
): void {
  const i = lifecycle.identity;
  if (
    preparation.tenantId !== i.tenantId ||
    preparation.captureId !== i.captureId ||
    !same(preparation.artifacts.producerProfile, i.profileArtifact) ||
    !same(preparation.artifacts.extractionSchema, i.schemaArtifact) ||
    !same(preparation.artifacts.source, i.sourceArtifact) ||
    !same(preparation.representation, i.representationArtifact) ||
    !same(preparation.artifacts.transformation, i.transformationArtifact) ||
    preparation.promptDigest !== i.promptDigest ||
    preparation.schema.schemaDigest !== i.schemaDigest
  )
    throw new Error("STRUCTURED_EXTRACTION_FAILURE_PREPARATION_INVALID");
}

function validateReplay(
  replay: Extract<StructuredExtractionReplayResult, { kind: "failed" }>,
  lifecycle: StructuredExtractionFailureLifecycleSnapshot,
): void {
  if (
    !same(replay.capture, lifecycle.capture) ||
    !same(replay.transportArtifact, lifecycle.transportArtifact) ||
    !same(replay.responseEnvelopeArtifact, lifecycle.responseEnvelopeArtifact) ||
    !same(replay.requestArtifact, lifecycle.providerRequestArtifact) ||
    !same(replay.rawResponseArtifact, lifecycle.rawResponseArtifact) ||
    replay.externalRequests !== 0 ||
    replay.memoryFetches !== 1 ||
    replay.automaticRetry !== false ||
    replay.precontextBytes !== null
  )
    throw new Error("STRUCTURED_EXTRACTION_FAILURE_REPLAY_BINDING_INVALID");
}

function validateExecution(
  execution: VerificationStructuredExtractionExecution,
  artifact: VerificationArtifactHandle,
  runtimeDigest: `sha256:${string}`,
  lifecycle: StructuredExtractionFailureLifecycleSnapshot,
): void {
  const parents = structuredExtractionExecutionParentArtifactIds(execution);
  const payloadDigest = sha256Digest(encoder.encode(canonicalizeJson(execution)));
  const signature = structuredExtractionExecutionTransformationSignature({
    payloadDigest,
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
  const i = lifecycle.identity;
  if (
    artifact.digest !== payloadDigest ||
    artifact.byteLength !== encoder.encode(canonicalizeJson(execution)).byteLength ||
    artifact.createdAt !== execution.createdAt ||
    !same(artifact.parentArtifactIds, parents) ||
    artifact.transformationSignature !== signature ||
    execution.tenantId !== i.tenantId ||
    execution.operationId !== i.operationId ||
    execution.operationStepId !== i.operationStepId ||
    execution.producerAttemptId !== i.producerAttemptId ||
    execution.requestDigest !== i.requestDigest ||
    execution.stepInputDigest !== i.stepInputDigest ||
    !same(execution.profileArtifact, i.profileArtifact) ||
    Date.parse(execution.createdAt) > Date.parse(lifecycle.startedAt)
  )
    throw new Error("STRUCTURED_EXTRACTION_FAILURE_EXECUTION_INVALID");
}

function validateTransport(
  transport: z.infer<typeof VerificationProviderTransportResponseSchema>,
  lifecycle: StructuredExtractionFailureLifecycleSnapshot,
): void {
  const b = transport.binding,
    c = lifecycle.capture,
    i = lifecycle.identity;
  if (
    b.tenantId !== i.tenantId ||
    b.operationId !== i.operationId ||
    b.operationStepId !== i.operationStepId ||
    b.providerAttemptId !== c.providerAttemptId ||
    b.profileArtifactId !== i.profileArtifact.artifactId ||
    b.profileDigest !== i.profileArtifact.digest ||
    b.dispatchFencingToken !== c.dispatchFencingToken ||
    transport.httpStatus !== c.httpStatus ||
    !same(transport.responseEnvelope, lifecycle.responseEnvelopeArtifact) ||
    !same(transport.rawResponse, lifecycle.rawResponseArtifact)
  )
    throw new Error("STRUCTURED_EXTRACTION_FAILURE_TRANSPORT_INVALID");
}

function validateSelectedEvidence(preparation: PreparedStructuredExtraction, representationBytes: Uint8Array): void {
  const expected = new Map(preparation.selectedEvidence.map((item) => [item.path, item.selectedContentDigest]));
  if (
    expected.size !== preparation.selectedEvidence.length ||
    preparation.extractionProfile.evidence.length !== expected.size
  )
    throw new Error("STRUCTURED_EXTRACTION_FAILURE_REPRESENTATION_INVALID");
  for (const edge of preparation.extractionProfile.evidence) {
    if (
      edge.captureId !== preparation.captureId ||
      edge.projectionArtifactId !== preparation.representation.artifactId ||
      edge.transformationArtifactId !== preparation.artifacts.transformation.artifactId
    )
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_REPRESENTATION_INVALID");
    const resolved = projectionSelectorResolver.resolve({
      captureId: preparation.captureId,
      representationArtifactId: preparation.representation.artifactId,
      representationDigest: preparation.representation.digest,
      selector: edge.selector,
      content: representationBytes,
    });
    if (
      resolved.resolution.status !== "resolved" ||
      resolved.resolution.occurrenceCount !== 1 ||
      resolved.resolution.selectedContentDigest !== expected.get(edge.path)
    )
      throw new Error("STRUCTURED_EXTRACTION_FAILURE_REPRESENTATION_INVALID");
  }
}

async function hydrateExact(
  createResolver: () => TrustedArtifactResolver,
  tenantId: string,
  expected: VerificationArtifactHandle,
  limit: number,
  signal: AbortSignal | undefined,
  code: string,
): Promise<{ readonly bytes: Uint8Array }> {
  active(signal);
  if (expected.tenantId !== tenantId || expected.byteLength > limit) throw new Error(code);
  const resolver = createResolver();
  await resolver.authorizeArtifact({ tenantId, artifactId: expected.artifactId, purpose: "verification_admission" });
  active(signal);
  const loaded = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId: expected.artifactId });
  active(signal);
  const registration = VerificationArtifactHandleSchema.parse(loaded.registration);
  if (
    !same(registration, expected) ||
    loaded.bytes.byteLength !== expected.byteLength ||
    sha256Digest(loaded.bytes) !== expected.digest
  )
    throw new Error(code);
  return { bytes: loaded.bytes.slice() };
}

async function registerExact(
  port: StructuredExtractionFailureArtifactPort,
  input: Parameters<StructuredExtractionFailureArtifactPort["register"]>[0],
  signal?: AbortSignal,
): Promise<VerificationArtifactHandle> {
  active(signal);
  const bytes = input.bytes.slice();
  const artifact = VerificationArtifactHandleSchema.parse(
    await port.register({ ...input, bytes, parentArtifactIds: [...input.parentArtifactIds] }),
  );
  active(signal);
  if (
    sha256Digest(bytes) !== sha256Digest(input.bytes) ||
    artifact.tenantId !== input.tenantId ||
    artifact.createdAt !== input.createdAt ||
    artifact.digest !== sha256Digest(input.bytes) ||
    artifact.byteLength !== input.bytes.byteLength ||
    !same(artifact.parentArtifactIds, input.parentArtifactIds) ||
    artifact.transformationSignature !== input.transformationSignature
  )
    throw new Error("STRUCTURED_EXTRACTION_FAILURE_REGISTERED_ARTIFACT_MISMATCH");
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

function parseCanonicalUnknown(bytes: Uint8Array, code: string): unknown {
  try {
    const text = decoder.decode(bytes),
      parsed = JSON.parse(text) as unknown;
    if (canonicalizeJson(parsed) !== text) throw new Error(code);
    return deepFreeze(parsed);
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code);
  }
}

function validateSourceCustody(bytes: Uint8Array, tenantId: string): void {
  const code = "STRUCTURED_EXTRACTION_FAILURE_DIRTY_STATE_INVALID";
  const custody = parseCanonicalJson(VerificationStructuredExtractionSourceCustodySchema, bytes, code);
  if (custody.tenantId !== tenantId) throw new Error(code);
  let total = 0;
  for (const file of custody.files) {
    const fileBytes = base64ToBytes(file.bytesBase64, code);
    if (
      bytesToBase64(fileBytes) !== file.bytesBase64 ||
      fileBytes.byteLength !== file.byteLength ||
      sha256Digest(fileBytes) !== file.sha256
    )
      throw new Error(code);
    total += fileBytes.byteLength;
  }
  if (total !== custody.totalByteLength) throw new Error(code);
}

function base64ToBytes(value: string, code: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(value, "base64"));
  } catch {
    throw new Error(code);
  }
}

function bytesToBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function pipeDigest(fields: readonly string[]): `sha256:${string}` {
  if (fields.some((field) => field.length === 0 || field.includes("|")))
    throw new Error("STRUCTURED_EXTRACTION_FAILURE_SIGNATURE_FIELD_INVALID");
  return sha256Digest(encoder.encode(fields.join("|")));
}

function active(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("STRUCTURED_EXTRACTION_FAILURE_CANCELLED");
}

function same(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
