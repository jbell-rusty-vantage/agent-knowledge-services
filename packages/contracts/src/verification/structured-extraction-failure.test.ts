import { describe, expect, it } from "vitest";
import {
  StructuredExtractionFailureCodeSchema,
  StructuredExtractionFailureLifecycleSnapshotSchema,
  VerificationStructuredExtractionFailureSchema,
  type VerificationArtifactHandle,
} from "./index.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const sha = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const at = (second: number) => `2026-09-06T05:20:${String(second).padStart(2, "0")}.000Z`;
const handle = (value: number, tenantId = id(1)): VerificationArtifactHandle => ({
  artifactId: id(value),
  tenantId,
  digest: sha(String(value % 10)),
  mediaType: "application/json",
  byteLength: 10,
  objectKey: `${tenantId}/${value}`,
  createdAt: at(0),
  producerActivityId: "fixture",
  producerVersion: "1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
});

function execution() {
  return {
    schemaVersion: "verification-structured-extraction-execution.v1",
    verificationContractVersion: "verification.v1",
    tenantId: id(1),
    operationId: id(2),
    operationStepId: id(3),
    producerAttemptId: id(4),
    requestDigest: sha("a"),
    stepInputDigest: sha("b"),
    profileArtifact: handle(5),
    runtime: {
      deploymentId: "worker.prod",
      capabilityVersion: "extract.v1",
      platform: "node24-linux-x64",
      code: { gitSha: "0123456789012345678901234567890123456789", dirty: false },
    },
    execution: { mode: "synthetic_transport", networkPolicy: "disabled" },
    versions: { parser: "gateway-json.v1", extractor: "structured-extraction.v1", canonicalization: "rfc8785.v1" },
    createdAt: at(0),
  } as const;
}

function fixture(code: "PROVIDER_HTTP_FAILURE" | "PROVIDER_RESPONSE_INVALID" = "PROVIDER_RESPONSE_INVALID") {
  const e = execution(),
    raw = handle(14),
    status = code === "PROVIDER_HTTP_FAILURE" ? 503 : 200;
  const capture = {
    tenantId: id(1),
    providerAttemptId: id(20),
    operationId: id(2),
    operationStepId: id(3),
    profileArtifactId: id(5),
    profileDigest: e.profileArtifact.digest,
    dispatchFencingToken: 7,
    httpStatus: status,
    responseEnvelopeArtifactId: id(13),
    transportArtifactId: id(12),
    transportDigest: handle(12).digest,
    capturedAt: at(2),
  };
  const identity = {
    tenantId: id(1),
    operationId: id(2),
    operationStepId: id(3),
    producerAttemptId: id(4),
    requestDigest: sha("a"),
    stepInputDigest: sha("b"),
    captureId: id(8),
    profileArtifact: handle(5),
    schemaArtifact: handle(9),
    sourceArtifact: handle(10),
    representationArtifact: handle(11),
    transformationArtifact: handle(15),
    promptDigest: sha("f"),
    schemaDigest: sha("1"),
  };
  const lifecycle = {
    identity,
    identityDigest: sha("c"),
    status: "retaining",
    startedAt: at(1),
    retentionStartedAt: at(3),
    completedAt: null,
    capture,
    providerRequestArtifact: handle(16),
    rawResponseArtifact: raw,
    responseEnvelopeArtifact: handle(13),
    transportArtifact: handle(12),
    candidateArtifact: null,
    precontextArtifact: null,
    provenanceArtifact: null,
  } as const;
  return {
    lifecycle,
    manifest: {
      schemaVersion: "verification-structured-extraction-failure.v1",
      verificationContractVersion: "verification.v1",
      tenantId: id(1),
      operationId: id(2),
      operationStepId: id(3),
      producerAttemptId: id(4),
      requestDigest: sha("a"),
      stepInputDigest: sha("b"),
      lifecycleIdentityDigest: sha("c"),
      execution: {
        artifact: { ...handle(7), digest: sha("d") },
        payloadDigest: sha("d"),
        runtimeDigest: sha("e"),
        manifest: e,
      },
      input: {
        captureId: id(8),
        profileArtifact: handle(5),
        schemaArtifact: handle(9),
        sourceArtifact: handle(10),
        representationArtifact: handle(11),
        transformationArtifact: handle(15),
        promptDigest: sha("f"),
        schemaDigest: sha("1"),
      },
      response: {
        capture,
        providerRequestArtifact: handle(16),
        rawResponseArtifact: raw,
        responseEnvelopeArtifact: handle(13),
        transportArtifact: handle(12),
      },
      providerCall: {
        providerAttemptId: id(20),
        budgetId: id(21),
        providerId: "gateway-structured-extraction.v1",
        model: "openai-gpt-5-mini",
        configurationDigest: sha("2"),
        attemptOrdinal: 0,
        reservationCostMicros: 100,
        state: "settled",
        actualCostMicros: 10,
        pricingBasis: "synthetic_transport",
        costEvidenceArtifact: raw,
        supplierBillingVerified: false,
      },
      providerCallDigest: sha("3"),
      failure: {
        code,
        category: code === "PROVIDER_HTTP_FAILURE" ? "provider_http" : "producer_contract",
        automaticRetry: false,
        candidateArtifact: null,
      },
      startedAt: at(1),
      retentionStartedAt: at(3),
      completedAt: at(4),
      seal: {
        payloadDigest: sha("5"),
        purpose: "artifact_custody_only",
        signature: { algorithm: "Ed25519", keyId: "fixture-custody-key.v1", signatureBase64: `${"A".repeat(86)}==` },
      },
    } as const,
  };
}

describe("structured extraction failure contracts", () => {
  it("accepts only the four native non-retry provider failure codes", () => {
    expect(StructuredExtractionFailureCodeSchema.options).toEqual([
      "PROVIDER_HTTP_FAILURE",
      "PROVIDER_RESPONSE_TOO_LARGE",
      "PROVIDER_RESPONSE_INVALID",
      "PROVIDER_RESPONSE_SCHEMA_INVALID",
    ]);
    expect(() => StructuredExtractionFailureCodeSchema.parse("VERIFICATION_FAILED")).toThrow();
  });

  it("requires a retaining lifecycle with full response custody and no candidate lineage", () => {
    const { lifecycle } = fixture();
    expect(StructuredExtractionFailureLifecycleSnapshotSchema.parse(lifecycle).candidateArtifact).toBeNull();
    expect(() =>
      StructuredExtractionFailureLifecycleSnapshotSchema.parse({ ...lifecycle, status: "retained" }),
    ).toThrow();
    expect(() =>
      StructuredExtractionFailureLifecycleSnapshotSchema.parse({ ...lifecycle, candidateArtifact: handle(30) }),
    ).toThrow();
    expect(() =>
      StructuredExtractionFailureLifecycleSnapshotSchema.parse({
        ...lifecycle,
        identity: { ...lifecycle.identity, stepInputDigest: lifecycle.identity.requestDigest },
      }),
    ).toThrow();
  });

  it("accepts HTTP failure only for 300..599 and producer-contract failures only for 2xx", () => {
    expect(
      VerificationStructuredExtractionFailureSchema.parse(fixture("PROVIDER_HTTP_FAILURE").manifest).failure.category,
    ).toBe("provider_http");
    expect(
      VerificationStructuredExtractionFailureSchema.parse(fixture("PROVIDER_RESPONSE_INVALID").manifest).failure
        .category,
    ).toBe("producer_contract");
    const http = fixture("PROVIDER_HTTP_FAILURE").manifest;
    expect(() =>
      VerificationStructuredExtractionFailureSchema.parse({
        ...http,
        response: { ...http.response, capture: { ...http.response.capture, httpStatus: 200 } },
      }),
    ).toThrow();
    const invalid = fixture("PROVIDER_RESPONSE_INVALID").manifest;
    expect(() =>
      VerificationStructuredExtractionFailureSchema.parse({
        ...invalid,
        response: { ...invalid.response, capture: { ...invalid.response.capture, httpStatus: 503 } },
      }),
    ).toThrow();
  });

  it("forbids candidate, output, quality, and retry claims", () => {
    const { manifest } = fixture();
    expect(() => VerificationStructuredExtractionFailureSchema.parse({ ...manifest, output: { value: 1 } })).toThrow();
    expect(() =>
      VerificationStructuredExtractionFailureSchema.parse({
        ...manifest,
        failure: { ...manifest.failure, automaticRetry: true },
      }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionFailureSchema.parse({ ...manifest, qualityClaims: { valid: false } }),
    ).toThrow();
  });
});
