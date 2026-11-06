import { describe, expect, it } from "vitest";
import { VerificationExtractionFieldEvidenceResultSchema as schema } from "./extraction-field-evidence.js";

const id = "11111111-1111-4111-8111-111111111111";
const digest = `sha256:${"a".repeat(64)}`;
const artifact = { artifactId: id, digest };
function fixture() {
  return {
    schemaVersion: "verification-extraction-field-evidence.v1",
    valid: true,
    candidateValid: true,
    checks: [{ code: "FIELD_MATCH", path: "/a~1b", status: "passed", detail: "Matched admitted evidence" }],
    acceptedLeaves: [
      {
        path: "/a~1b",
        value: null,
        rawValue: null,
        derivation: { kind: "direct", comparison: "exact" },
        source: {
          captureId: id,
          representationArtifactId: id,
          representationDigest: digest,
          selector: { kind: "json_pointer", pointer: "/a~1b" },
          selectedContentDigest: digest,
          fragmentId: `fragment:${"b".repeat(64)}`,
        },
        lineage: {
          schemaVersion: "verification-extraction-leaf-lineage.v1",
          sourceArtifact: artifact,
          nativeOutputArtifact: artifact,
          transformationArtifact: artifact,
          projectionArtifact: artifact,
          parserVersion: "verification-native-parser.v1",
          imageDigest: digest,
          parserOptionsDigest: digest,
          parserTransformationSignature: digest,
        },
      },
    ],
  };
}
describe("persisted extraction leaf evidence", () => {
  it("accepts null scalar evidence and escaped pointer with complete admitted lineage", () => {
    expect(schema.parse(fixture()).acceptedLeaves[0]?.value).toBeNull();
  });
  it("rejects invented lineage, non-scalar values and malformed paths", () => {
    const missing = fixture();
    Reflect.deleteProperty(missing.acceptedLeaves[0]!, "lineage");
    expect(schema.safeParse(missing).success).toBe(false);
    const mismatch = fixture();
    mismatch.acceptedLeaves[0]!.source.representationDigest = `sha256:${"c".repeat(64)}`;
    expect(schema.safeParse(mismatch).success).toBe(false);
    const badPath = fixture();
    badPath.acceptedLeaves[0]!.path = "/bad~2escape";
    expect(schema.safeParse(badPath).success).toBe(false);
    const nonScalar = fixture();
    Object.assign(nonScalar.acceptedLeaves[0]!, { value: { unverified: true } });
    expect(schema.safeParse(nonScalar).success).toBe(false);
  });
  it("rejects duplicate paths and acceptance alongside failed verification", () => {
    const duplicate = fixture();
    duplicate.acceptedLeaves.push(structuredClone(duplicate.acceptedLeaves[0]!));
    expect(schema.safeParse(duplicate).success).toBe(false);
    const rejected = fixture();
    rejected.valid = false;
    expect(schema.safeParse(rejected).success).toBe(false);
    const invalid = fixture();
    invalid.candidateValid = false;
    expect(schema.safeParse(invalid).success).toBe(false);
    const failed = fixture();
    failed.checks[0]!.status = "failed";
    expect(schema.safeParse(failed).success).toBe(false);
  });
  it("permits a rejected candidate without accepted leaves and with schema diagnostic paths", () => {
    const value = fixture();
    value.valid = false;
    value.candidateValid = false;
    value.acceptedLeaves = [];
    value.checks = [{ code: "SCHEMA_INVALID", path: "#", status: "failed", detail: "Schema rejected" }];
    expect(schema.safeParse(value).success).toBe(true);
  });
  it("rejects extra claims and unknown result versions", () => {
    expect(schema.safeParse({ ...fixture(), humanGoldValidated: true }).success).toBe(false);
    expect(schema.safeParse({ ...fixture(), schemaVersion: "verification-extraction-field-evidence.v2" }).success).toBe(
      false,
    );
  });
  it("rejects false direct derivation and unrelated normalization operations", () => {
    const direct = fixture();
    Object.assign(direct.acceptedLeaves[0]!, { value: "changed" });
    expect(schema.safeParse(direct).success).toBe(false);
    const normalized = fixture();
    Object.assign(normalized.acceptedLeaves[0]!, {
      value: "1.0",
      rawValue: "1",
      derivation: { kind: "normalized", comparison: "decimal", operation: "trim_ascii" },
    });
    expect(schema.safeParse(normalized).success).toBe(false);
    Object.assign(normalized.acceptedLeaves[0]!, {
      derivation: { kind: "normalized", comparison: "decimal", operation: "decimal_exact" },
    });
    expect(schema.safeParse(normalized).success).toBe(true);
  });
});
