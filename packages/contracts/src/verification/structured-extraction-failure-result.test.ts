import { describe, expect, it } from "vitest";
import { VerificationStructuredExtractionFailureResultSchema } from "./structured-extraction-failure-result.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const digest = (value: number) => `sha256:${String(value).repeat(64).slice(0, 64)}`;
const artifact = (value: number) => ({
  artifactId: id(value),
  tenantId: id(1),
  digest: digest(value),
  byteLength: 1,
  mediaType: "application/json",
  objectKey: `private/${id(value)}`,
  createdAt: "2026-09-06T00:00:00.000Z",
  producerActivityId: "fixture",
  producerVersion: "1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
});

function result() {
  return {
    schemaVersion: "verification-operation-result.v1",
    operationId: id(2),
    useCase: "extractStructuredData",
    requestDigest: digest(3),
    output: {
      status: "failed",
      code: "PROVIDER_HTTP_FAILURE",
      category: "provider_http",
      automaticRetry: false,
      candidateArtifact: null,
      executionArtifact: { artifactId: id(4), digest: digest(4) },
      manifestDigest: digest(5),
      providerCallDigest: digest(6),
    },
    resultArtifact: artifact(7),
  };
}

describe("VerificationStructuredExtractionFailureResultSchema", () => {
  it("accepts only the bounded native provider-failure terminal payload", () => {
    expect(VerificationStructuredExtractionFailureResultSchema.parse(result())).toMatchObject({
      schemaVersion: "verification-operation-result.v1",
      useCase: "extractStructuredData",
      output: {
        status: "failed",
        code: "PROVIDER_HTTP_FAILURE",
        category: "provider_http",
        automaticRetry: false,
        candidateArtifact: null,
      },
    });
  });

  it("rejects candidate, accepted, retry, quality, and partial-artifact drift", () => {
    expect(() =>
      VerificationStructuredExtractionFailureResultSchema.parse({
        ...result(),
        output: { ...result().output, candidateArtifact: { artifactId: id(8), digest: digest(8) } },
      }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionFailureResultSchema.parse({
        ...result(),
        output: { ...result().output, status: "unverified_candidate" },
      }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionFailureResultSchema.parse({
        ...result(),
        output: { ...result().output, category: "producer_contract" },
      }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionFailureResultSchema.parse({
        ...result(),
        output: { ...result().output, automaticRetry: true },
      }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionFailureResultSchema.parse({ ...result(), qualityClaims: { verified: true } }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionFailureResultSchema.parse({
        ...result(),
        resultArtifact: { artifactId: id(7), digest: digest(7) },
      }),
    ).toThrow();
  });
});
