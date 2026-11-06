import type { VerificationArtifactHandle, VerificationBenchmarkCase } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-verification";
import { describe, expect, it } from "vitest";
import type { ProjectionAdmissionReceipt } from "../verification/admission/verification-admission.js";
import { verifyDiagnosticsAdversarialProjection } from "./verification-diagnostics-adversarial.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const captureId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const projectionId = "44444444-4444-4444-8444-444444444444";
const nativeId = "55555555-5555-4555-8555-555555555555";
const transformId = "66666666-6666-4666-8666-666666666666";
const text = "Results are available within 2–4 weeks after the lab receives the sample.";
const bytes = new TextEncoder().encode(text);
const digest = sha256Digest(bytes);
const handle = (artifactId: string, valueDigest = digest): VerificationArtifactHandle => ({
  artifactId,
  tenantId: tenant,
  digest: valueDigest,
  mediaType: "application/json",
  byteLength: bytes.byteLength,
  objectKey: `fixture/${artifactId}`,
  createdAt: "2026-09-07T00:00:00.000Z",
  producerActivityId: "fixture",
  producerVersion: "v1",
  encryptionClass: "supabase-managed",
  retentionClass: "verification-audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
});
const receipt: ProjectionAdmissionReceipt = {
  schemaVersion: "verification-projection-admission.v1",
  captureId,
  sourceArtifact: handle(sourceId),
  nativeOutputArtifact: handle(nativeId),
  projectionArtifact: handle(projectionId),
  transformationArtifact: handle(transformId),
  projectionKind: "html_dom",
  projectionOrdinal: 0,
  parserVersion: "verification-native-parser.v1",
  imageDigest: `sha256:${"a".repeat(64)}`,
  parserOptionsDigest: `sha256:${"b".repeat(64)}`,
  parserTransformationSignature: `sha256:${"c".repeat(64)}`,
  residualsDigest: `sha256:${"d".repeat(64)}`,
};
const baseCase = (assertion: string): VerificationBenchmarkCase => ({
  schemaVersion: "verification-benchmark.v1",
  caseId: "adversarial-fixture",
  caseDigest: `sha256:${"e".repeat(64)}`,
  partition: "development",
  inputManifestArtifactId: sourceId,
  goldArtifactId: null,
  modality: "html",
  sourceFamily: "fixture",
  entityFamily: "fixture",
  reportCluster: "fixture",
  pairCluster: "fixture",
  tags: ["adversarial"],
  adversarialTransforms: ["count_or_timeline_swap"],
  assertion,
  evidence: [
    {
      fragmentId: `sha256:${"f".repeat(64)}`,
      captureId,
      sourceKey: "fixture",
      sourceClass: "first_party",
      projectionArtifactId: projectionId,
      projectionDigest: digest,
      transformationArtifactId: transformId,
      selector: { kind: "text_quote", quote: text, normalization: "none" },
      selectedContentDigest: digest,
      excerpt: text,
      rights: "test",
      providerUploadAuthorized: false,
    },
  ],
  expectation: {
    label: "contradicted",
    labelStatus: "engineering_expectation",
    expectedPolicy: "fail",
    expectedLocatorValid: true,
    support: "contradicted",
    authority: "interested_party_only",
    worldCorrectness: "unknown",
    rationale: "Not used by the helper.",
  },
  independentObservation: false,
  humanGoldScoringEligible: false,
  adjudicationId: null,
});

describe("verifyDiagnosticsAdversarialProjection", () => {
  it("uses immutable admitted bytes to reject corrupted locators and selected-digest tampering", () => {
    const result = verifyDiagnosticsAdversarialProjection({
      testCase: baseCase("Results are available within 24 hours."),
      receipt,
      content: bytes,
    });
    expect(result.exactSource).toMatchObject({ valid: true });
    expect(result.corruptedLocator).toMatchObject({ evaluated: true, valid: false });
    expect(result.selectedDigestTamper).toMatchObject({ valid: false });
    expect(result.assertionTextReplay).toMatchObject({ valid: false });
    expect(result.unsupportedSemanticPaths).toContain("contradiction_or_entailment");
  });

  it("does not use expectations as predictions and only reports direct mechanics", () => {
    const result = verifyDiagnosticsAdversarialProjection({ testCase: baseCase(text), receipt, content: bytes });
    expect(result.assertionTextReplay).toMatchObject({ valid: true });
    expect(result.transforms).toEqual(["count_or_timeline_swap"]);
    expect(result).not.toHaveProperty("verdict");
  });

  it("fails closed if caller supplies a receipt unrelated to frozen evidence", () => {
    const changed = { ...receipt, projectionArtifact: { ...receipt.projectionArtifact, artifactId: sourceId } };
    expect(() =>
      verifyDiagnosticsAdversarialProjection({ testCase: baseCase(text), receipt: changed, content: bytes }),
    ).toThrow("DIAGNOSTICS_ADVERSARIAL_ADMISSION_BINDING");
  });
});
