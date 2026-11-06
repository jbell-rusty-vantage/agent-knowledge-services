import { describe, expect, it } from "vitest";
import { VerificationStructuredExtractionResultSchema } from "./structured-extraction-result.js";

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
      status: "unverified_candidate",
      schemaValidation: "shape_only",
      candidateArtifact: { artifactId: id(4), digest: digest(4) },
      provenanceArtifact: { artifactId: id(5), digest: digest(5) },
      precontextArtifact: null,
      executionArtifact: { artifactId: id(6), digest: digest(6) },
      manifestDigest: digest(7),
      providerCallDigest: digest(8),
    },
    resultArtifact: artifact(9),
  };
}

describe("VerificationStructuredExtractionResultSchema", () => {
  it("accepts only the bounded unverified custody terminal payload", () => {
    expect(VerificationStructuredExtractionResultSchema.parse(result())).toMatchObject({
      schemaVersion: "verification-operation-result.v1",
      useCase: "extractStructuredData",
      output: { status: "unverified_candidate", schemaValidation: "shape_only" },
    });
  });

  it("rejects an output digest, quality claim, or partial result artifact", () => {
    expect(() =>
      VerificationStructuredExtractionResultSchema.parse({
        ...result(),
        output: { ...result().output, outputDigest: digest(9) },
      }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionResultSchema.parse({ ...result(), qualityClaims: { verified: true } }),
    ).toThrow();
    expect(() =>
      VerificationStructuredExtractionResultSchema.parse({
        ...result(),
        resultArtifact: { artifactId: id(9), digest: digest(9) },
      }),
    ).toThrow();
  });
});
