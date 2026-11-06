import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  VerificationStructuredExtractionPublicationSchema,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import {
  canonicalizeJson,
  createEd25519Verifier,
  digestCanonicalJson,
  sha256Digest,
} from "@aiengineer/knowledge-verification";
import {
  structuredExtractionProviderCallDigest,
  structuredExtractionPublicationParentArtifactIds,
  structuredExtractionPublicationTransformationSignature,
} from "./verification-structured-extraction-publication.js";
import { createStructuredExtractionOperationResult } from "./verification-structured-extraction-result.js";

const encoder = new TextEncoder();
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const keyId = "fixture-custody-key.v1";
const verifier = createEd25519Verifier({ [keyId]: publicKeyPem });
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const now = "2026-09-06T04:20:04.000Z";

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
    candidateArtifact = handle(21),
    provenanceArtifact = handle(22),
    profileArtifact = handle(23);
  const schemaArtifact = handle(24),
    sourceArtifact = handle(25),
    representationArtifact = handle(26),
    transformationArtifact = handle(27);
  const transportArtifact = handle(28),
    responseEnvelopeArtifact = handle(29),
    providerRequestArtifact = handle(30),
    rawResponseArtifact = handle(31);
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
    schemaVersion: "verification-structured-extraction-publication.v1" as const,
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
        httpStatus: 200,
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
    output: {
      status: "unverified_candidate" as const,
      schemaValidation: "shape_only" as const,
      candidateArtifact,
      provenanceArtifact,
      precontextArtifact: null,
      outputDigest: sha256Digest("output"),
    },
    startedAt: now,
    retentionStartedAt: now,
    completedAt: now,
  };
  const payloadDigest = digestCanonicalJson(body);
  const signatureBase64 = sign(null, encoder.encode(canonicalizeJson(body)), privateKey).toString("base64");
  const manifest = VerificationStructuredExtractionPublicationSchema.parse({
    ...body,
    seal: {
      payloadDigest,
      purpose: "artifact_custody_only",
      signature: { algorithm: "Ed25519", keyId: signatureKeyId, signatureBase64 },
    },
  });
  const bytes = encoder.encode(canonicalizeJson(manifest));
  const parentArtifactIds = structuredExtractionPublicationParentArtifactIds(manifest);
  const artifact: VerificationArtifactHandle = {
    ...handle(40),
    digest: sha256Digest(bytes),
    byteLength: bytes.byteLength,
    createdAt: manifest.completedAt,
    parentArtifactIds: [...parentArtifactIds],
    transformationSignature: structuredExtractionPublicationTransformationSignature({
      payloadDigest: sha256Digest(bytes),
      sealPayloadDigest: manifest.seal.payloadDigest as `sha256:${string}`,
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
    }),
  };
  return { manifest, artifact };
}

describe("createStructuredExtractionOperationResult", () => {
  it("derives the exact bounded terminal payload from a native Ed25519-signed publication", async () => {
    const value = fixture();
    await expect(createStructuredExtractionOperationResult({ ...value, verifier })).resolves.toMatchObject({
      schemaVersion: "verification-operation-result.v1",
      operationId: value.manifest.operationId,
      useCase: "extractStructuredData",
      requestDigest: value.manifest.requestDigest,
      output: {
        status: "unverified_candidate",
        schemaValidation: "shape_only",
        manifestDigest: value.manifest.seal.payloadDigest,
        providerCallDigest: value.manifest.providerCallDigest,
      },
      resultArtifact: value.artifact,
    });
  });

  it("rejects a tampered body or unknown signature key", async () => {
    const value = fixture();
    await expect(
      createStructuredExtractionOperationResult({
        manifest: { ...value.manifest, output: { ...value.manifest.output, outputDigest: sha256Digest("tampered") } },
        artifact: value.artifact,
        verifier,
      }),
    ).rejects.toThrow("STRUCTURED_EXTRACTION_RESULT_MANIFEST_DIGEST_INVALID");
    const unknown = fixture("unknown-custody-key.v1");
    await expect(createStructuredExtractionOperationResult({ ...unknown, verifier })).rejects.toThrow(
      "STRUCTURED_EXTRACTION_RESULT_SIGNATURE_INVALID",
    );
  });

  it("denies a candidate status outside the unverified custody contract", async () => {
    const value = fixture();
    await expect(
      createStructuredExtractionOperationResult({
        manifest: { ...value.manifest, output: { ...value.manifest.output, status: "verified" } } as never,
        artifact: value.artifact,
        verifier,
      }),
    ).rejects.toThrow();
  });

  it("uses the snapshot taken before verifier await when callers mutate their inputs", async () => {
    const value = fixture();
    const result = await createStructuredExtractionOperationResult({
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
