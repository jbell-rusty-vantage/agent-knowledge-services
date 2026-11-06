import { describe, expect, it } from "vitest";
import {
  StructuredExtractionPublicationLifecycleSnapshotSchema,
  type StructuredExtractionProviderCallSnapshot,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import {
  canonicalizeJson,
  digestCanonicalJson,
  registeredProvider,
  sha256Digest,
  type AuditBundleSigner,
  type TrustedArtifactResolver,
} from "@aiengineer/knowledge-verification";
import { structuredExtractionArtifactTransformationSignature } from "./verification-structured-extraction-candidate.js";
import {
  StructuredExtractionExecutionArtifactBuilder,
  StructuredExtractionPublicationArtifactBuilder,
  structuredExtractionExecutionTransformationSignature,
  structuredExtractionProviderCallDigest,
  structuredExtractionPublicationParentArtifactIds,
  structuredExtractionPublicationTransformationSignature,
  type StructuredExtractionPublicationArtifactPort,
} from "./verification-structured-extraction-publication.js";

const encoder = new TextEncoder();
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const executionAt = "2026-09-06T04:20:00.000Z";
const startedAt = "2026-09-06T04:20:01.000Z";
const capturedAt = "2026-09-06T04:20:02.000Z";
const retentionStartedAt = "2026-09-06T04:20:03.000Z";
const completedAt = "2026-09-06T04:20:04.000Z";
const bytes = (value: unknown) => encoder.encode(canonicalizeJson(value));

interface Stored {
  registration: VerificationArtifactHandle;
  bytes: Uint8Array;
}

function fixture(withPrecontext = false) {
  const tenantId = id(1);
  const stored = new Map<string, Stored>();
  let nextArtifact = 100;
  const seed = (
    number: number,
    value: unknown,
    options: Partial<VerificationArtifactHandle> = {},
  ): VerificationArtifactHandle => {
    const payload = bytes(value);
    const registration: VerificationArtifactHandle = {
      artifactId: id(number),
      tenantId,
      digest: sha256Digest(payload),
      mediaType: "application/json",
      byteLength: payload.byteLength,
      objectKey: `${tenantId}/${number}`,
      createdAt: options.createdAt ?? executionAt,
      producerActivityId: "fixture",
      producerVersion: "1",
      encryptionClass: "managed",
      retentionClass: "audit",
      dataClassification: "restricted",
      parentArtifactIds: [],
      ...options,
    };
    stored.set(registration.artifactId, { registration: structuredClone(registration), bytes: payload.slice() });
    return structuredClone(registration);
  };
  const schemaArtifact = seed(7, { schemaVersion: "fixture-schema.v1" });
  const provider = registeredProvider("gateway-structured-extraction.v1");
  const budgetId = id(21);
  const profileValue = {
    schemaVersion: "verification-structured-extraction-profile.v1",
    tenantId,
    profileId: "registered_default",
    profileVersion: "fixture.v1",
    extractionSchema: schemaArtifact,
    providerId: "gateway-structured-extraction.v1",
    providerConfigurationDigest: provider.configurationDigest,
    externalProcessing: { classification: "synthetic", modality: "text" },
    budget: { budgetId, budgetKey: "fixture-budget", ceilingCostMicros: 1000, reservationCostMicros: 100 },
    maximumPromptBytes: 24_000,
  } as const;
  const profileArtifact = seed(6, profileValue);
  const sourceFileBytes = encoder.encode("export const fixture = 42;\n");
  const dirtyStateArtifact = seed(22, {
    schemaVersion: "verification-structured-extraction-source-custody.v1",
    tenantId,
    scope: "listed_files",
    files: [
      {
        path: "KS/packages/application/src/fixture.ts",
        sha256: sha256Digest(sourceFileBytes),
        byteLength: sourceFileBytes.byteLength,
        bytesBase64: Buffer.from(sourceFileBytes).toString("base64"),
      },
    ],
    totalByteLength: sourceFileBytes.byteLength,
  });
  const sourceArtifact = seed(8, { source: true });
  const representationArtifact = seed(9, { text: "42" });
  const transformationArtifact = seed(10, { transform: "native-text.v1" });
  const providerRequestArtifact = seed(13, { request: true });
  const rawResponseArtifact = seed(14, { value: "42", usage: { costMicros: 10 } });
  const responseEnvelopeArtifact = seed(
    15,
    { envelope: true },
    { parentArtifactIds: [providerRequestArtifact.artifactId, rawResponseArtifact.artifactId] },
  );
  const transportArtifact = seed(16, { transport: true });
  const operationId = id(2),
    operationStepId = id(3),
    producerAttemptId = id(4),
    providerAttemptId = id(12),
    captureId = id(5);
  const requestDigest = digestCanonicalJson("request"),
    stepInputDigest = digestCanonicalJson("step"),
    promptDigest = digestCanonicalJson("prompt"),
    schemaDigest = digestCanonicalJson("schema");
  const baseParents = [
    profileArtifact.artifactId,
    schemaArtifact.artifactId,
    sourceArtifact.artifactId,
    representationArtifact.artifactId,
    transformationArtifact.artifactId,
    transportArtifact.artifactId,
    responseEnvelopeArtifact.artifactId,
    providerRequestArtifact.artifactId,
    rawResponseArtifact.artifactId,
  ];
  const output = { value: "42" },
    outputDigest = sha256Digest(bytes(output));
  const candidateEnvelope = {
    schemaVersion: "verification-extraction-candidate.v1",
    tenantId,
    operationId,
    providerAttemptId,
    originalDispatchFencingToken: 7,
    profileArtifactId: profileArtifact.artifactId,
    profileDigest: profileArtifact.digest,
    promptDigest,
    schemaDigest,
    outputDigest,
    outputVerification: "unverified_candidate",
    output,
  } as const;
  const candidatePayload = bytes(candidateEnvelope),
    candidateDigest = sha256Digest(candidatePayload);
  const candidateArtifact = seed(17, candidateEnvelope, {
    createdAt: retentionStartedAt,
    parentArtifactIds: baseParents,
    transformationSignature: structuredExtractionArtifactTransformationSignature({
      artifactType: "verification_extraction_candidate",
      payloadDigest: candidateDigest,
      tenantId,
      operationId,
      providerAttemptId,
      originalDispatchFencingToken: 7,
      profileArtifactId: profileArtifact.artifactId,
      profileDigest: profileArtifact.digest as `sha256:${string}`,
      promptDigest,
      schemaDigest,
      parentArtifactIds: baseParents,
    }),
  });
  const precontextParents = [
    transportArtifact.artifactId,
    responseEnvelopeArtifact.artifactId,
    providerRequestArtifact.artifactId,
    rawResponseArtifact.artifactId,
    profileArtifact.artifactId,
  ];
  const rawPrecontext = encoder.encode("retained provider precontext");
  const precontextEnvelope = {
    schemaVersion: "verification-structured-extraction-precontext.v1",
    tenantId,
    operationId,
    providerAttemptId,
    originalDispatchFencingToken: 7,
    profileArtifactId: profileArtifact.artifactId,
    profileDigest: profileArtifact.digest,
    promptDigest,
    schemaDigest,
    precontextDigest: sha256Digest(rawPrecontext),
    precontextBase64: Buffer.from(rawPrecontext).toString("base64"),
  } as const;
  const precontextPayload = bytes(precontextEnvelope);
  const precontextArtifact = withPrecontext
    ? seed(19, precontextEnvelope, {
        createdAt: retentionStartedAt,
        parentArtifactIds: precontextParents,
        transformationSignature: structuredExtractionArtifactTransformationSignature({
          artifactType: "verification_structured_extraction_precontext",
          payloadDigest: sha256Digest(precontextPayload),
          tenantId,
          operationId,
          providerAttemptId,
          originalDispatchFencingToken: 7,
          profileArtifactId: profileArtifact.artifactId,
          profileDigest: profileArtifact.digest as `sha256:${string}`,
          promptDigest,
          schemaDigest,
          parentArtifactIds: precontextParents,
        }),
      })
    : null;
  const provenance = {
    schemaVersion: "verification-structured-extraction-provenance.v1",
    tenantId,
    operationId,
    providerAttemptId,
    operationStepId,
    originalDispatchFencingToken: 7,
    createdAt: retentionStartedAt,
    producerAttemptId,
    status: "unverified_candidate",
    profile: {
      artifact: profileArtifact,
      profileId: "registered_default",
      profileVersion: "fixture.v1",
      providerId: provider.providerId,
      providerConfigurationDigest: provider.configurationDigest,
    },
    extraction: {
      schemaArtifact,
      schemaId: "fixture",
      schemaVersion: "1",
      schemaDigest,
      promptDigest,
      selectedEvidence: [{ path: "/value", selectedContentDigest: digestCanonicalJson("42") }],
    },
    input: { captureId, sourceArtifact, representationArtifact, transformationArtifact },
    response: {
      transportArtifact,
      responseEnvelopeArtifact,
      requestArtifact: providerRequestArtifact,
      rawResponseArtifact,
      httpStatus: 200,
      capturedAt,
      externalRequests: 0,
      memoryFetches: 1,
    },
    candidate: {
      artifact: candidateArtifact,
      digest: candidateArtifact.digest,
      outputDigest,
      byteLength: candidateArtifact.byteLength,
      status: "unverified_candidate",
    },
    precontext: precontextArtifact
      ? { artifact: precontextArtifact, digest: precontextArtifact.digest, byteLength: precontextArtifact.byteLength }
      : null,
  } as const;
  const provenanceParents = [
      candidateArtifact.artifactId,
      ...(precontextArtifact ? [precontextArtifact.artifactId] : []),
      ...baseParents,
    ],
    provenancePayload = bytes(provenance),
    provenanceDigest = sha256Digest(provenancePayload);
  const provenanceArtifact = seed(18, provenance, {
    createdAt: retentionStartedAt,
    parentArtifactIds: provenanceParents,
    transformationSignature: structuredExtractionArtifactTransformationSignature({
      artifactType: "verification_structured_extraction_provenance",
      payloadDigest: provenanceDigest,
      tenantId,
      operationId,
      providerAttemptId,
      originalDispatchFencingToken: 7,
      profileArtifactId: profileArtifact.artifactId,
      profileDigest: profileArtifact.digest as `sha256:${string}`,
      promptDigest,
      schemaDigest,
      parentArtifactIds: provenanceParents,
    }),
  });
  const identity = {
    tenantId,
    operationId,
    operationStepId,
    producerAttemptId,
    requestDigest,
    stepInputDigest,
    captureId,
    profileArtifact,
    schemaArtifact,
    sourceArtifact,
    representationArtifact,
    transformationArtifact,
    promptDigest,
    schemaDigest,
  };
  const lifecycle = StructuredExtractionPublicationLifecycleSnapshotSchema.parse({
    identity,
    identityDigest: digestCanonicalJson(identity),
    status: "retained",
    startedAt,
    retentionStartedAt,
    completedAt,
    capture: {
      tenantId,
      providerAttemptId,
      operationId,
      operationStepId,
      profileArtifactId: profileArtifact.artifactId,
      profileDigest: profileArtifact.digest,
      dispatchFencingToken: 7,
      httpStatus: 200,
      responseEnvelopeArtifactId: responseEnvelopeArtifact.artifactId,
      transportArtifactId: transportArtifact.artifactId,
      transportDigest: transportArtifact.digest,
      capturedAt,
    },
    providerRequestArtifact,
    rawResponseArtifact,
    responseEnvelopeArtifact,
    transportArtifact,
    candidateArtifact,
    precontextArtifact,
    provenanceArtifact,
  });
  const writes: Parameters<StructuredExtractionPublicationArtifactPort["register"]>[0][] = [];
  const artifacts: StructuredExtractionPublicationArtifactPort = {
    register: async (input) => {
      writes.push({ ...input, bytes: input.bytes.slice(), parentArtifactIds: [...input.parentArtifactIds] });
      const registration: VerificationArtifactHandle = {
        artifactId: id(nextArtifact++),
        tenantId: input.tenantId,
        digest: sha256Digest(input.bytes),
        mediaType: "application/json",
        byteLength: input.bytes.byteLength,
        objectKey: `${input.tenantId}/generated/${nextArtifact}`,
        createdAt: input.createdAt,
        producerActivityId: input.producerAttemptId,
        producerVersion: "1",
        encryptionClass: "managed",
        retentionClass: "audit",
        dataClassification: "restricted",
        parentArtifactIds: [...input.parentArtifactIds],
        transformationSignature: input.transformationSignature,
      };
      stored.set(registration.artifactId, { registration: structuredClone(registration), bytes: input.bytes.slice() });
      return registration;
    },
  };
  const createResolver = (): TrustedArtifactResolver => {
    let authorized: string | undefined;
    return {
      authorizeArtifact: async ({ tenantId: scopedTenant, artifactId }) => {
        if (scopedTenant !== tenantId || !stored.has(artifactId)) throw new Error("DENIED");
        authorized = artifactId;
      },
      hydrateRegisteredArtifact: async ({ tenantId: scopedTenant, artifactId }) => {
        if (scopedTenant !== tenantId || authorized !== artifactId) throw new Error("NOT_AUTHORIZED");
        const value = stored.get(artifactId)!;
        authorized = undefined;
        return { registration: structuredClone(value.registration), bytes: value.bytes.slice() };
      },
    };
  };
  const signer: AuditBundleSigner = {
    algorithm: "Ed25519",
    keyId: "fixture-custody-key.v1",
    sign: async () => Buffer.alloc(64, 7).toString("base64"),
  };
  const providerCall: StructuredExtractionProviderCallSnapshot = {
    providerAttemptId,
    budgetId,
    providerId: provider.providerId as "gateway-structured-extraction.v1",
    model: provider.model,
    configurationDigest: provider.configurationDigest,
    attemptOrdinal: 0,
    reservationCostMicros: 100,
    state: "settled",
    actualCostMicros: 10,
    pricingBasis: "synthetic_transport",
    costEvidenceArtifact: rawResponseArtifact,
    supplierBillingVerified: false,
  };
  return {
    tenantId,
    stored,
    writes,
    artifacts,
    createResolver,
    signer,
    lifecycle,
    providerCall,
    profileArtifact,
    dirtyStateArtifact,
    identity,
    provider,
    seed,
  };
}

async function prepareExecution(value: ReturnType<typeof fixture>, dirtyStateArtifact = value.dirtyStateArtifact) {
  return new StructuredExtractionExecutionArtifactBuilder({
    artifacts: value.artifacts,
    createResolver: value.createResolver,
  }).prepare({
    identity: {
      tenantId: value.identity.tenantId,
      operationId: value.identity.operationId,
      operationStepId: value.identity.operationStepId,
      producerAttemptId: value.identity.producerAttemptId,
      requestDigest: value.identity.requestDigest,
      stepInputDigest: value.identity.stepInputDigest,
    },
    profileArtifact: value.profileArtifact,
    runtime: {
      deploymentId: "worker.local",
      capabilityVersion: "extract.v1",
      platform: "node24-win32-x64",
      code: { gitSha: "uncommitted", dirty: true, dirtyStateArtifact },
    },
    execution: { mode: "synthetic_transport", networkPolicy: "disabled" },
    versions: { parser: "gateway-json.v1", extractor: "structured-extraction.v1", canonicalization: "rfc8785.v1" },
    createdAt: executionAt,
  });
}

describe("structured extraction execution and publication builders", () => {
  it("hydrates runtime custody before dispatch and publishes the retained candidate with exact signed ancestry", async () => {
    const value = fixture(true),
      execution = await prepareExecution(value);
    expect(execution.artifact.parentArtifactIds).toEqual([
      value.profileArtifact.artifactId,
      value.dirtyStateArtifact.artifactId,
    ]);
    expect(execution.artifact.transformationSignature).toBe(
      structuredExtractionExecutionTransformationSignature({
        payloadDigest: execution.payloadDigest,
        tenantId: value.identity.tenantId,
        operationId: value.identity.operationId,
        operationStepId: value.identity.operationStepId,
        producerAttemptId: value.identity.producerAttemptId,
        requestDigest: value.identity.requestDigest,
        stepInputDigest: value.identity.stepInputDigest,
        profileDigest: value.profileArtifact.digest as `sha256:${string}`,
        runtimeDigest: execution.runtimeDigest,
        mode: "synthetic_transport",
        createdAt: executionAt,
        parentArtifactIds: execution.artifact.parentArtifactIds,
      }),
    );
    const publication = await new StructuredExtractionPublicationArtifactBuilder({
      artifacts: value.artifacts,
      createResolver: value.createResolver,
      signer: value.signer,
    }).publish({ lifecycle: value.lifecycle, executionArtifact: execution.artifact, providerCall: value.providerCall });
    expect(publication.manifest.output).toMatchObject({
      status: "unverified_candidate",
      schemaValidation: "shape_only",
    });
    expect(publication.manifest.providerCallDigest).toBe(structuredExtractionProviderCallDigest(value.providerCall));
    expect(publication.manifest.seal).toMatchObject({
      purpose: "artifact_custody_only",
      signature: { algorithm: "Ed25519", keyId: value.signer.keyId },
    });
    expect(publication.artifact.parentArtifactIds).toEqual(
      structuredExtractionPublicationParentArtifactIds(publication.manifest),
    );
    expect(publication.artifact.transformationSignature).toBe(
      structuredExtractionPublicationTransformationSignature({
        payloadDigest: publication.payloadDigest,
        sealPayloadDigest: publication.manifest.seal.payloadDigest as `sha256:${string}`,
        tenantId: value.identity.tenantId,
        operationId: value.identity.operationId,
        operationStepId: value.identity.operationStepId,
        producerAttemptId: value.identity.producerAttemptId,
        executionDigest: execution.artifact.digest as `sha256:${string}`,
        candidateDigest: value.lifecycle.candidateArtifact.digest as `sha256:${string}`,
        provenanceDigest: value.lifecycle.provenanceArtifact.digest as `sha256:${string}`,
        providerCallDigest: publication.manifest.providerCallDigest as `sha256:${string}`,
        originalDispatchFencingToken: 7,
        startedAt,
        retentionStartedAt,
        completedAt,
        parentArtifactIds: publication.artifact.parentArtifactIds,
      }),
    );
    expect(value.writes.map((item) => item.artifactType)).toEqual([
      "verification_structured_extraction_execution",
      "verification_structured_extraction_publication",
    ]);
  });

  it("rejects a structurally forged profile handle before the execution write", async () => {
    const value = fixture();
    await expect(
      new StructuredExtractionExecutionArtifactBuilder({
        artifacts: value.artifacts,
        createResolver: value.createResolver,
      }).prepare({
        identity: {
          tenantId: value.identity.tenantId,
          operationId: value.identity.operationId,
          operationStepId: value.identity.operationStepId,
          producerAttemptId: value.identity.producerAttemptId,
          requestDigest: value.identity.requestDigest,
          stepInputDigest: value.identity.stepInputDigest,
        },
        profileArtifact: { ...value.profileArtifact, objectKey: "forged" },
        runtime: {
          deploymentId: "worker.local",
          capabilityVersion: "extract.v1",
          platform: "node24",
          code: { gitSha: "uncommitted", dirty: true, dirtyStateArtifact: value.dirtyStateArtifact },
        },
        execution: { mode: "synthetic_transport", networkPolicy: "disabled" },
        versions: { parser: "gateway-json.v1", extractor: "extract.v1", canonicalization: "rfc8785.v1" },
        createdAt: executionAt,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_EXECUTION_PROFILE_INVALID");
    expect(value.writes).toHaveLength(0);
  });

  it("rejects an unrelated registered artifact as dirty source custody before writing", async () => {
    const value = fixture(),
      unrelated = value.seed(23, { schemaVersion: "unrelated.v1", value: true });
    await expect(prepareExecution(value, unrelated)).rejects.toThrow(
      "STRUCTURED_EXTRACTION_EXECUTION_DIRTY_STATE_INVALID",
    );
    expect(value.writes).toHaveLength(0);
  });

  it("checks every source-custody file's native bytes, digest, length, and canonical base64", async () => {
    const value = fixture(),
      fileBytes = encoder.encode("different bytes\n");
    const invalid = value.seed(24, {
      schemaVersion: "verification-structured-extraction-source-custody.v1",
      tenantId: value.tenantId,
      scope: "listed_files",
      files: [
        {
          path: "DB/supabase/migrations/example.sql",
          sha256: digestCanonicalJson("wrong"),
          byteLength: fileBytes.byteLength,
          bytesBase64: Buffer.from(fileBytes).toString("base64"),
        },
      ],
      totalByteLength: fileBytes.byteLength,
    });
    await expect(prepareExecution(value, invalid)).rejects.toThrow(
      "STRUCTURED_EXTRACTION_EXECUTION_DIRTY_STATE_INVALID",
    );
    expect(value.writes).toHaveLength(0);
  });

  it("rejects drifted native candidate bytes before signing or publication", async () => {
    const value = fixture(),
      execution = await prepareExecution(value);
    const drifted = value.stored.get(value.lifecycle.candidateArtifact.artifactId)!.bytes;
    drifted[0] = (drifted[0] ?? 0) ^ 1;
    await expect(
      new StructuredExtractionPublicationArtifactBuilder({
        artifacts: value.artifacts,
        createResolver: value.createResolver,
        signer: value.signer,
      }).publish({
        lifecycle: value.lifecycle,
        executionArtifact: execution.artifact,
        providerCall: value.providerCall,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_PUBLICATION_CANDIDATE_INVALID");
    expect(value.writes).toHaveLength(1);
  });

  it("rehydrates dirty source custody and rejects tampering before publication", async () => {
    const value = fixture(),
      execution = await prepareExecution(value);
    const drifted = value.stored.get(value.dirtyStateArtifact.artifactId)!.bytes;
    drifted[0] = (drifted[0] ?? 0) ^ 1;
    await expect(
      new StructuredExtractionPublicationArtifactBuilder({
        artifacts: value.artifacts,
        createResolver: value.createResolver,
        signer: value.signer,
      }).publish({
        lifecycle: value.lifecycle,
        executionArtifact: execution.artifact,
        providerCall: value.providerCall,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_PUBLICATION_DIRTY_STATE_INVALID");
    expect(value.writes).toHaveLength(1);
  });

  it("rehydrates and validates retained precontext envelope bytes", async () => {
    const value = fixture(true),
      execution = await prepareExecution(value);
    const drifted = value.stored.get(value.lifecycle.precontextArtifact!.artifactId)!.bytes;
    drifted[0] = (drifted[0] ?? 0) ^ 1;
    await expect(
      new StructuredExtractionPublicationArtifactBuilder({
        artifacts: value.artifacts,
        createResolver: value.createResolver,
        signer: value.signer,
      }).publish({
        lifecycle: value.lifecycle,
        executionArtifact: execution.artifact,
        providerCall: value.providerCall,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_PUBLICATION_PRECONTEXT_INVALID");
    expect(value.writes).toHaveLength(1);
  });

  it("rejects provider-accounting or registered-provider drift", async () => {
    const value = fixture(),
      execution = await prepareExecution(value);
    await expect(
      new StructuredExtractionPublicationArtifactBuilder({
        artifacts: value.artifacts,
        createResolver: value.createResolver,
        signer: value.signer,
      }).publish({
        lifecycle: value.lifecycle,
        executionArtifact: execution.artifact,
        providerCall: { ...value.providerCall, configurationDigest: digestCanonicalJson("forged") },
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_PUBLICATION_PROVIDER_CALL_INVALID");
    await expect(
      new StructuredExtractionPublicationArtifactBuilder({
        artifacts: value.artifacts,
        createResolver: value.createResolver,
        signer: value.signer,
      }).publish({
        lifecycle: value.lifecycle,
        executionArtifact: execution.artifact,
        providerCall: { ...value.providerCall, state: "uncertain", actualCostMicros: 0 },
      }),
    ).rejects.toThrow();
    expect(value.writes).toHaveLength(1);
  });

  it("checks cancellation after the custody signature and before the publication write", async () => {
    const value = fixture(),
      execution = await prepareExecution(value),
      controller = new AbortController();
    const signer: AuditBundleSigner = {
      algorithm: "Ed25519",
      keyId: "fixture-custody-key.v1",
      sign: async () => {
        controller.abort();
        return Buffer.alloc(64, 1).toString("base64");
      },
    };
    await expect(
      new StructuredExtractionPublicationArtifactBuilder({
        artifacts: value.artifacts,
        createResolver: value.createResolver,
        signer,
      }).publish({
        lifecycle: value.lifecycle,
        executionArtifact: execution.artifact,
        providerCall: value.providerCall,
        signal: controller.signal,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_PUBLICATION_CANCELLED");
    expect(value.writes).toHaveLength(1);
  });
});
