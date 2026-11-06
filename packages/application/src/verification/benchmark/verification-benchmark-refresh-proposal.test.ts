import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";

import { prepareDiagnosticsBenchmarkRefreshProposal } from "./verification-benchmark-refresh-proposal.js";

const catalog = resolve(import.meta.dirname, "../../../../../catalog/verification-benchmarks/diagnostics-companies-v1");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = (value: string) => `sha256:${value.repeat(64)}`;
const read = async (name: string) => JSON.parse(await readFile(resolve(catalog, name), "utf8"));
const tenantId = id(1);
const artifact = (n: number, value: string, mediaType = "application/json") => ({
  artifactId: id(n),
  digest: digest(value),
  mediaType,
  sizeBytes: n,
});

function pdfCapture(source: any) {
  const content = artifact(900, "a", "application/pdf"),
    native = artifact(901, "b"),
    text = artifact(902, "c"),
    textTransform = artifact(903, "d"),
    geometry = artifact(904, "e"),
    geometryTransform = artifact(905, "f");
  return {
    verificationContractVersion: "verification.v1",
    tenantId,
    operationId: id(906),
    state: "succeeded",
    disposition: "captured_without_admission",
    requestDigest: digestCanonicalJson({
      verificationContractVersion: "verification.v1",
      source: { mode: "acquire", sourceKind: "pdf", sourceUri: source.url },
      requestedProjectionKinds: ["pdf_text", "geometry"],
    }),
    source: { sourceId: id(907), kind: "pdf", canonicalUri: source.url, logicalIdentity: source.sourceKey },
    capture: {
      captureId: id(908),
      sourceId: id(907),
      capturedAt: "2026-09-08T00:00:00.000Z",
      captureMethod: "https_acquire",
      captureMethodVersion: "verification-source-acquisition.v1",
      contentArtifact: content,
    },
    projections: [
      {
        schemaVersion: "verification-projection-admission.v1",
        captureId: id(908),
        projectionKind: "pdf_text",
        projectionOrdinal: 0,
        sourceArtifact: content,
        nativeOutputArtifact: native,
        projectionArtifact: text,
        transformationArtifact: textTransform,
        parserVersion: "verification-native-parser.v1",
        imageDigest: digest("1"),
        parserOptionsDigest: digest("2"),
        parserTransformationSignature: digest("3"),
        residualsDigest: digest("4"),
      },
      {
        schemaVersion: "verification-projection-admission.v1",
        captureId: id(908),
        projectionKind: "geometry",
        projectionOrdinal: 1,
        sourceArtifact: content,
        nativeOutputArtifact: native,
        projectionArtifact: geometry,
        transformationArtifact: geometryTransform,
        parserVersion: "verification-native-parser.v1",
        imageDigest: digest("1"),
        parserOptionsDigest: digest("2"),
        parserTransformationSignature: digest("3"),
        residualsDigest: digest("4"),
      },
    ],
    resultArtifact: artifact(909, "5"),
    captureMode: "acquire",
    acquisitionReceipt: artifact(910, "6"),
  };
}

async function input() {
  const [baselineDataset, baselineSourceLedger] = await Promise.all([read("dataset.json"), read("source-ledger.json")]);
  const authenticatedCaptureOutcomes = baselineSourceLedger.sources.map((source: any, index: number) =>
    index === 15
      ? { sourceKey: source.sourceKey, state: "unavailable", unavailableCode: "SOURCE_CAPTURE_UNAVAILABLE" }
      : {
          sourceKey: source.sourceKey,
          state: "succeeded",
          capture: {
            verificationContractVersion: "verification.v1",
            tenantId,
            operationId: id(100 + index),
            state: "succeeded",
            disposition: "captured_without_admission",
            requestDigest: digestCanonicalJson({
              verificationContractVersion: "verification.v1",
              source: { mode: "acquire", sourceKind: "web_page", sourceUri: source.url },
              requestedProjectionKinds: ["html_dom"],
            }),
            source: {
              sourceId: `source-${index}`,
              kind: "web_page",
              canonicalUri: source.url,
              logicalIdentity: source.sourceKey,
            },
            capture: {
              captureId: id(200 + index),
              sourceId: `source-${index}`,
              capturedAt: "2026-09-07T00:00:00.000Z",
              captureMethod: "https_acquire",
              captureMethodVersion: "verification-source-acquisition.v1",
              contentArtifact:
                index === 0
                  ? { ...artifact(300 + index, "b", "text/html"), digest: source.sourceArtifactDigest }
                  : artifact(300 + index, "b", "text/html"),
            },
            projections: [
              {
                schemaVersion: "verification-projection-admission.v1",
                captureId: id(200 + index),
                projectionKind: "html_dom",
                projectionOrdinal: 0,
                sourceArtifact:
                  index === 0
                    ? { ...artifact(300 + index, "b", "text/html"), digest: source.sourceArtifactDigest }
                    : artifact(300 + index, "b", "text/html"),
                nativeOutputArtifact: artifact(400 + index, "c"),
                projectionArtifact: artifact(500 + index, "d"),
                transformationArtifact: artifact(600 + index, "e"),
                parserVersion: "verification-native-parser.v1",
                imageDigest: digest("f"),
                parserOptionsDigest: digest("a"),
                parserTransformationSignature: digest("c"),
                residualsDigest: digest("d"),
              },
            ],
            resultArtifact: artifact(700 + index, "e"),
            captureMode: "acquire",
            acquisitionReceipt: artifact(800 + index, "f"),
          },
        },
  );
  return {
    tenantId,
    baselineDataset,
    baselineSourceLedger,
    baselineCatalogManifestDigest: "sha256:fc927c53f8bc308227fe3e9f1f5d321e3075986140a25ce07755208c86ac09e1",
    baselineSourceLedgerCanonicalDigest: digestCanonicalJson(baselineSourceLedger),
    authenticatedCaptureOutcomes,
  };
}

describe("diagnostics benchmark refresh proposal preparation", () => {
  it("retains every historical source and evidence reference while exposing only review-gated fresh capture drift", async () => {
    const result = prepareDiagnosticsBenchmarkRefreshProposal(await input());
    expect(result).toMatchObject({
      schemaVersion: "diagnostics-benchmark-refresh-proposal.v1",
      tenantId,
      baseline: { datasetId: "diagnostics-companies", version: 1 },
      proposedDataset: { datasetId: "diagnostics-companies", version: 2 },
      review: {
        sourceLicenseReviewRequired: true,
        sourceDriftReviewRequired: true,
        selectorRevalidationRequired: true,
        leakageReviewRequired: true,
        goldLabelUpdateRequired: true,
        humanGoldScoringEligible: false,
        humanApprovalGranted: false,
        frozenSuccessorDatasetCreated: false,
      },
    });
    expect(result.sourceDiff).toHaveLength(16);
    expect(result.sourceDiff.filter((item) => item.status === "changed")).toHaveLength(14);
    expect(result.sourceDiff.filter((item) => item.status === "unchanged")).toHaveLength(1);
    expect(result.sourceDiff.filter((item) => item.status === "unavailable")).toHaveLength(1);
    expect(result.historicalCases).toHaveLength(40);
    expect(JSON.stringify(result.historicalCases)).not.toContain("domPath");
    expect(JSON.stringify(result.historicalCases)).not.toContain('"assertion"');
    expect(result.proposalDigest).toMatch(/^sha256:/);
  });

  it("rejects incomplete, duplicated, and URI-drifted authenticated outcome sets", async () => {
    const value = await input();
    expect(() =>
      prepareDiagnosticsBenchmarkRefreshProposal({
        ...value,
        authenticatedCaptureOutcomes: value.authenticatedCaptureOutcomes.slice(1),
      }),
    ).toThrow();
    const duplicate = structuredClone(value);
    duplicate.authenticatedCaptureOutcomes[1]!.sourceKey = duplicate.authenticatedCaptureOutcomes[0]!.sourceKey;
    expect(() => prepareDiagnosticsBenchmarkRefreshProposal(duplicate)).toThrow(
      "BENCHMARK_REFRESH_PROPOSAL_OUTCOME_SET_INVALID",
    );
    const uriDrift = structuredClone(value);
    (uriDrift.authenticatedCaptureOutcomes[0] as any).capture.source.canonicalUri = "https://other.example/not-granted";
    expect(() => prepareDiagnosticsBenchmarkRefreshProposal(uriDrift)).toThrow(
      "BENCHMARK_REFRESH_PROPOSAL_CAPTURE_BINDING_INVALID",
    );
  });

  it("rejects foreign custody and duplicated native operation or capture identities", async () => {
    const foreignTenant = structuredClone(await input());
    (foreignTenant.authenticatedCaptureOutcomes[0] as any).capture.tenantId = id(999);
    expect(() => prepareDiagnosticsBenchmarkRefreshProposal(foreignTenant)).toThrow(
      "BENCHMARK_REFRESH_PROPOSAL_CAPTURE_BINDING_INVALID",
    );

    const duplicateOperation = structuredClone(await input());
    (duplicateOperation.authenticatedCaptureOutcomes[1] as any).capture.operationId = (
      duplicateOperation.authenticatedCaptureOutcomes[0] as any
    ).capture.operationId;
    expect(() => prepareDiagnosticsBenchmarkRefreshProposal(duplicateOperation)).toThrow(
      "BENCHMARK_REFRESH_PROPOSAL_CAPTURE_IDENTITY_DUPLICATE",
    );

    const duplicateCapture = structuredClone(await input());
    (duplicateCapture.authenticatedCaptureOutcomes[1] as any).capture.capture.captureId = (
      duplicateCapture.authenticatedCaptureOutcomes[0] as any
    ).capture.capture.captureId;
    (duplicateCapture.authenticatedCaptureOutcomes[1] as any).capture.projections[0].captureId = (
      duplicateCapture.authenticatedCaptureOutcomes[0] as any
    ).capture.capture.captureId;
    expect(() => prepareDiagnosticsBenchmarkRefreshProposal(duplicateCapture)).toThrow(
      "BENCHMARK_REFRESH_PROPOSAL_CAPTURE_IDENTITY_DUPLICATE",
    );
  });

  it("pins the supplied v1 dataset and canonical source ledger rather than trusting a re-sealed input", async () => {
    const forgedBaseline = structuredClone(await input());
    forgedBaseline.baselineDataset.manifestDigest = digest("a");
    expect(() => prepareDiagnosticsBenchmarkRefreshProposal(forgedBaseline)).toThrow();

    const forgedLedger = structuredClone(await input());
    forgedLedger.baselineSourceLedgerCanonicalDigest = digest("a") as `sha256:${string}`;
    expect(() => prepareDiagnosticsBenchmarkRefreshProposal(forgedLedger)).toThrow(
      "BENCHMARK_REFRESH_PROPOSAL_BASELINE_LEDGER_INVALID",
    );
  });

  it("rejects oversized raw input before parsing or cloning it", async () => {
    const value = await input();
    value.baselineSourceLedger = { padding: "x".repeat(8 * 1024 * 1024) };
    expect(() => prepareDiagnosticsBenchmarkRefreshProposal(value)).toThrow(
      "BENCHMARK_REFRESH_PROPOSAL_INPUT_BOUND_EXCEEDED",
    );
  });

  it("preserves both exact PDF projection and transformation bindings without a first-projection shortcut", async () => {
    const value = await input();
    const pdfIndex = value.baselineSourceLedger.sources.findIndex(
      (source: any) => source.sourceKey === "tru-sample-report",
    );
    value.authenticatedCaptureOutcomes[pdfIndex] = {
      sourceKey: "tru-sample-report",
      state: "succeeded",
      capture: pdfCapture(value.baselineSourceLedger.sources[pdfIndex]),
    };
    value.authenticatedCaptureOutcomes[0] = {
      sourceKey: value.baselineSourceLedger.sources[0].sourceKey,
      state: "unavailable",
      unavailableCode: "SOURCE_CAPTURE_UNAVAILABLE",
    };
    const result = prepareDiagnosticsBenchmarkRefreshProposal(value);
    const pdf = result.sourceDiff.find((item) => item.sourceKey === "tru-sample-report") as any;
    expect(pdf.projections).toEqual([
      expect.objectContaining({
        projectionKind: "pdf_text",
        projectionOrdinal: 0,
        projectionArtifact: expect.objectContaining({ artifactId: id(902) }),
        transformationArtifact: expect.objectContaining({ artifactId: id(903) }),
      }),
      expect.objectContaining({
        projectionKind: "geometry",
        projectionOrdinal: 1,
        projectionArtifact: expect.objectContaining({ artifactId: id(904) }),
        transformationArtifact: expect.objectContaining({ artifactId: id(905) }),
      }),
    ]);
    expect(pdf).not.toHaveProperty("projectionArtifact");
    const missingGeometry = structuredClone(value);
    (missingGeometry.authenticatedCaptureOutcomes[pdfIndex] as any).capture.projections.pop();
    expect(() => prepareDiagnosticsBenchmarkRefreshProposal(missingGeometry)).toThrow();
  });
});
