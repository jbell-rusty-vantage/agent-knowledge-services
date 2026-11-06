import { describe, expect, it } from "vitest";
import { ParseArtifactRequestSchema, VerificationParseArtifactResultSchema } from "./parse.js";

const id = "11111111-1111-4111-8111-111111111111",
  digest = `sha256:${"a".repeat(64)}`;
const artifact = {
  artifactId: id,
  tenantId: id,
  digest,
  mediaType: "text/html",
  byteLength: 4,
  objectKey: "tenant/object",
  createdAt: "2026-09-05T00:00:00.000Z",
  producerActivityId: "capture",
  producerVersion: "v1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
};

describe("ParseArtifactRequestSchema", () => {
  it("accepts only a capture identifier and complete immutable registered handle", () => {
    expect(
      ParseArtifactRequestSchema.parse({
        verificationContractVersion: "verification.v1",
        captureId: id,
        sourceArtifact: artifact,
      }),
    ).toMatchObject({ captureId: id });
  });
  it("rejects partial handles and caller parser controls", () => {
    expect(() =>
      ParseArtifactRequestSchema.parse({
        verificationContractVersion: "verification.v1",
        captureId: "capture-1",
        sourceArtifact: artifact,
      }),
    ).toThrow();
    expect(() =>
      ParseArtifactRequestSchema.parse({
        verificationContractVersion: "verification.v1",
        captureId: id,
        sourceArtifact: { artifactId: id, digest },
      }),
    ).toThrow();
    expect(() =>
      ParseArtifactRequestSchema.parse({
        verificationContractVersion: "verification.v1",
        captureId: id,
        sourceArtifact: artifact,
        parserKind: "pdf",
      }),
    ).toThrow();
  });
  it("accepts the full projection admission receipt serialized by the application", () => {
    expect(
      VerificationParseArtifactResultSchema.parse({
        schemaVersion: "verification-operation-result.v1",
        operationId: id,
        useCase: "parseArtifact",
        requestDigest: digest,
        sourceArtifact: artifact,
        output: {
          status: "canonical_projection_admitted",
          projections: [
            {
              schemaVersion: "verification-projection-admission.v1",
              captureId: id,
              sourceArtifact: artifact,
              projectionKind: "html_dom",
              projectionOrdinal: 0,
              nativeOutputArtifact: artifact,
              projectionArtifact: artifact,
              transformationArtifact: artifact,
              parserVersion: "verification-native-parser.v1",
              imageDigest: digest,
              parserOptionsDigest: digest,
              parserTransformationSignature: digest,
              residualsDigest: digest,
            },
          ],
        },
        resultArtifact: artifact,
      }),
    ).toMatchObject({ output: { projections: [{ captureId: id, sourceArtifact: { artifactId: id } }] } });
  });
});
