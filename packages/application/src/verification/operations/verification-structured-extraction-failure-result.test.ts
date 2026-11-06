import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  VerificationStructuredExtractionFailureSchema,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import {
  canonicalizeJson,
  createEd25519Verifier,
  digestCanonicalJson,
  sha256Digest,
} from "@aiengineer/knowledge-verification";
import { structuredExtractionProviderCallDigest } from "./verification-structured-extraction-publication.js";
import {
  structuredExtractionFailureParentArtifactIds,
  structuredExtractionFailureTransformationSignature,
} from "./verification-structured-extraction-failure.js";
import { createStructuredExtractionFailureOperationResult } from "./verification-structured-extraction-failure-result.js";

const encoder = new TextEncoder();
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keyId = "fixture-failure-custody-key.v1";
const verifier = createEd25519Verifier({ [keyId]: publicKey.export({ type: "spki", format: "pem" }).toString() });
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const now = "2026-09-06T05:20:04.000Z";

function handle(value: number): VerificationArtifactHandle {
  return {
    artifactId: id(value),
    tenantId: id(1),
    digest: sha256Digest(`artifact:${value}`),
    byteLength: value,
    mediaType: "application/json",
    objectKey: `private/${value}`,
    createdAt: now,
    producerActivityId: "fixture",
    producerVersion: "1",
    encryptionClass: "managed",
    retentionClass: "audit",
    dataClassification: "restricted",
    parentArtifactIds: [],
  };
}

function fixture(signatureKeyId = keyId) {
  const executionArtifact = handle(20),
    profileArtifact = handle(21),
    schemaArtifact = handle(22),
    sourceArtifact = handle(23);
  const representationArtifact = handle(24),
    transformationArtifact = handle(25),
    transportArtifact = handle(26),
    responseEnvelopeArtifact = handle(27);
  const providerRequestArtifact = handle(28),
    rawResponseArtifact = handle(29);
  const providerCall = {
    providerAttemptId: id(12),
    budgetId: id(13),
    providerId: "gateway-structured-extraction.v1" as const,
    model: "fixture-model.v1",
    configurationDigest: sha256Digest("configuration"),
    attemptOrdinal: 0,
    reservationCostMicros: 100,
    state: "settled" as const,
    actualCostMicros: 10,
    pricingBasis: "synthetic_transport" as const,
    costEvidenceArtifact: rawResponseArtifact,
    supplierBillingVerified: false as const,
  };
  const body = {
    schemaVersion: "verification-structured-extraction-failure.v1" as const,
    verificationContractVersion: "verification.v1" as const,
    tenantId: id(1),
    operationId: id(2),
    operationStepId: id(3),
    producerAttemptId: id(4),
    requestDigest: sha256Digest("request"),
    stepInputDigest: sha256Digest("step"),
    lifecycleIdentityDigest: sha256Digest("identity"),
    execution: {
      artifact: executionArtifact,
      payloadDigest: executionArtifact.digest,
      runtimeDigest: sha256Digest("runtime"),
      manifest: {
        schemaVersion: "verification-structured-extraction-execution.v1" as const,
        verificationContractVersion: "verification.v1" as const,
        tenantId: id(1),
        operationId: id(2),
        operationStepId: id(3),
        producerAttemptId: id(4),
        requestDigest: sha256Digest("request"),
        stepInputDigest: sha256Digest("step"),
        profileArtifact,
        runtime: {
          deploymentId: "worker.local",
          capabilityVersion: "fixture.v1",
          platform: "node24",
          code: { gitSha: "a".repeat(40), dirty: false },
        },
        execution: { mode: "synthetic_transport" as const, networkPolicy: "disabled" as const },
        versions: { parser: "fixture.v1", extractor: "fixture.v1", canonicalization: "rfc8785.v1" },
        createdAt: now,
      },
    },
    input: {
      captureId: id(5),
      profileArtifact,
      schemaArtifact,
      sourceArtifact,
      representationArtifact,
      transformationArtifact,
      promptDigest: sha256Digest("prompt"),
      schemaDigest: sha256Digest("schema"),
    },
    response: {
      capture: {
        tenantId: id(1),
        providerAttemptId: id(12),
        operationId: id(2),
        operationStepId: id(3),
        profileArtifactId: profileArtifact.artifactId,
        profileDigest: profileArtifact.digest,
        dispatchFencingToken: 1,
        httpStatus: 503,
        responseEnvelopeArtifactId: responseEnvelopeArtifact.artifactId,
        transportArtifactId: transportArtifact.artifactId,
        transportDigest: transportArtifact.digest,
        capturedAt: now,
      },
      providerRequestArtifact,
      rawResponseArtifact,
      responseEnvelopeArtifact,
      transportArtifact,
    },
    providerCall,
    providerCallDigest: structuredExtractionProviderCallDigest(providerCall),
    failure: {
      code: "PROVIDER_HTTP_FAILURE" as const,
      category: "provider_http" as const,
      automaticRetry: false as const,
      candidateArtifact: null,
    },
    startedAt: now,
    retentionStartedAt: now,
    completedAt: now,
  };
  const payloadDigest = digestCanonicalJson(body);
  const signatureBase64 = sign(null, encoder.encode(canonicalizeJson(body)), privateKey).toString("base64");
  const manifest = VerificationStructuredExtractionFailureSchema.parse({
    ...body,
    seal: {
      payloadDigest,
      purpose: "artifact_custody_only",
      signature: { algorithm: "Ed25519", keyId: signatureKeyId, signatureBase64 },
    },
  });
  const bytes = encoder.encode(canonicalizeJson(manifest));
  const parentArtifactIds = structuredExtractionFailureParentArtifactIds(manifest);
  const artifact: VerificationArtifactHandle = {
    ...handle(40),
    digest: sha256Digest(bytes),
    byteLength: bytes.byteLength,
    createdAt: manifest.completedAt,
    parentArtifactIds: [...parentArtifactIds],
    transformationSignature: structuredExtractionFailureTransformationSignature({
      payloadDigest: sha256Digest(bytes),
      sealPayloadDigest: manifest.seal.payloadDigest as `sha256:${string}`,
      tenantId: manifest.tenantId,
      operationId: manifest.operationId,
      operationStepId: manifest.operationStepId,
      producerAttemptId: manifest.producerAttemptId,
      executionDigest: manifest.execution.artifact.digest as `sha256:${string}`,
      providerCallDigest: manifest.providerCallDigest as `sha256:${string}`,
      failureCode: manifest.failure.code,
      originalDispatchFencingToken: manifest.response.capture.dispatchFencingToken,
      startedAt: manifest.startedAt,
      retentionStartedAt: manifest.retentionStartedAt,
      completedAt: manifest.completedAt,
      parentArtifactIds,
    }),
  };
  return { manifest, artifact };
}

describe("createStructuredExtractionFailureOperationResult", () => {
  it("derives the exact failed terminal payload from a native Ed25519-signed failure publication", async () => {
    const value = fixture();
    await expect(createStructuredExtractionFailureOperationResult({ ...value, verifier })).resolves.toMatchObject({
      schemaVersion: "verification-operation-result.v1",
      operationId: value.manifest.operationId,
      useCase: "extractStructuredData",
      requestDigest: value.manifest.requestDigest,
      output: {
        status: "failed",
        code: "PROVIDER_HTTP_FAILURE",
        category: "provider_http",
        automaticRetry: false,
        candidateArtifact: null,
        manifestDigest: value.manifest.seal.payloadDigest,
        providerCallDigest: value.manifest.providerCallDigest,
      },
      resultArtifact: value.artifact,
    });
  });

  it("rejects a forged publication artifact, unknown signing key, and non-failure result shape", async () => {
    const value = fixture();
    await expect(
      createStructuredExtractionFailureOperationResult({
        ...value,
        artifact: { ...value.artifact, byteLength: 0 },
        verifier,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_FAILURE_RESULT_ARTIFACT_INVALID");
    const unknown = fixture("unknown-custody-key.v1");
    await expect(createStructuredExtractionFailureOperationResult({ ...unknown, verifier })).rejects.toThrow(
      "STRUCTURED_EXTRACTION_FAILURE_RESULT_SIGNATURE_INVALID",
    );
    await expect(
      createStructuredExtractionFailureOperationResult({
        ...value,
        manifest: { ...value.manifest, output: { status: "unverified_candidate" } } as never,
        verifier,
      }),
    ).rejects.toThrow();
  });

  it("uses the snapshot taken before verifier await when callers mutate their inputs", async () => {
    const value = fixture();
    const result = await createStructuredExtractionFailureOperationResult({
      ...value,
      verifier: {
        verify: async (input) => {
          (value.manifest as { requestDigest: string }).requestDigest = sha256Digest("mutated-after-snapshot");
          (value.artifact as { byteLength: number }).byteLength = 0;
          return verifier.verify(input);
        },
      },
    });
    expect(result.requestDigest).toBe(sha256Digest("request"));
    expect(result.resultArtifact.byteLength).toBeGreaterThan(0);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
