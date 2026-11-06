import type { VerificationArtifactHandle, VerificationBenchmarkCase } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-verification";
import { describe, expect, it } from "vitest";
import type { ProjectionAdmissionReceipt } from "../verification/admission/verification-admission.js";
import { runDiagnosticsEngineeringMutations } from "./verification-diagnostics-engineering-mutations.js";

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

describe("derived engineering mutations", () => {
  const projection = { testCase: baseCase(text), receipt, content: bytes };
  it("actually changes the exact candidate and retains failed native checks", () => {
    const [record] = runDiagnosticsEngineeringMutations([
      { family: "names", original: "Results", replacement: "Invented", projection },
    ]).records;
    expect(record).toMatchObject({
      availability: "measured",
      original: { valid: true },
      mutated: { valid: false },
      degradedMechanically: true,
    });
    if (!record || !("originalCandidateDigest" in record)) throw new Error("measured record required");
    expect(record.originalCandidateDigest).not.toBe(record?.mutatedCandidateDigest);
    expect(record?.mutated?.checks.some((c) => c.status === "failed")).toBe(true);
  });
  it("rejects an unchanged replacement and an absent selected literal", () => {
    expect(
      runDiagnosticsEngineeringMutations([
        { family: "institutions", original: "Results", replacement: "Results", projection },
        { family: "biomarkers", original: "Absent", replacement: "Invented", projection },
      ]).records.every((r) => r.availability === "unavailable"),
    ).toBe(true);
  });
  it("does not use text elsewhere in the projection as selected evidence", () => {
    const content = new TextEncoder().encode(`${text} Outside Institute.`),
      changedDigest = sha256Digest(content);
    const changed = {
      testCase: {
        ...baseCase(text),
        evidence: baseCase(text).evidence.map((e) => ({ ...e, projectionDigest: changedDigest })),
      },
      receipt: {
        ...receipt,
        projectionArtifact: { ...receipt.projectionArtifact, digest: changedDigest, byteLength: content.length },
      },
      content,
    };
    expect(
      runDiagnosticsEngineeringMutations([
        { family: "institutions", original: "Outside Institute", replacement: "Other", projection: changed },
      ]).records[0]?.availability,
    ).toBe("unavailable");
  });
  it("changes the citation digest while preserving candidate text and rejects it", () => {
    const [record] = runDiagnosticsEngineeringMutations([
      { family: "citations", original: "Results", replacement: "Citation tamper", projection },
    ]).records;
    expect(record).toMatchObject({
      availability: "measured",
      mutationKind: "selected_digest_tamper",
      original: { valid: true },
      mutated: { valid: false },
      degradedMechanically: true,
    });
    if (!record || !("originalCandidateDigest" in record)) throw new Error("measured record required");
    expect(record.originalCandidateDigest).toBe(record?.mutatedCandidateDigest);
    expect(record?.mutatedSelectedContentDigest).not.toBe(record?.selectedContentDigest);
  });
  it("rejects a forged admitted projection receipt", () => {
    expect(() =>
      runDiagnosticsEngineeringMutations([
        {
          family: "names",
          original: "Results",
          replacement: "Other",
          projection: { ...projection, receipt: { ...receipt, captureId: "foreign" } },
        },
      ]),
    ).toThrow("DIAGNOSTICS_ADVERSARIAL_ADMISSION_BINDING");
  });
});
