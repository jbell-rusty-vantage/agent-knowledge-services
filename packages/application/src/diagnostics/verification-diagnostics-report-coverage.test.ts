import type { VerificationBenchmarkCase, VerificationBenchmarkDataset } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-verification";
import { describe, expect, it } from "vitest";
import {
  auditDiagnosticsReportCoverage,
  buildDiagnosticsReportCoverage,
  type DiagnosticsReportCoverageInput,
} from "./verification-diagnostics-report-coverage.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const digest = (value: string): `sha256:${string}` => sha256Digest(value);
const evidence = (index: number, text: string) => ({
  fragmentId: `fragment-${index}`,
  captureId: id(index + 10),
  sourceKey: `source-${index}`,
  sourceClass: "first_party",
  projectionArtifactId: id(index + 20),
  projectionDigest: digest(`projection-${index}`),
  transformationArtifactId: id(index + 30),
  selector: { kind: "text_quote" as const, quote: text, normalization: "none" as const },
  selectedContentDigest: digest(text),
  excerpt: text,
  rights: "fixture",
  providerUploadAuthorized: false,
});
const testCase = (index: number, text: string): VerificationBenchmarkCase => ({
  schemaVersion: "verification-benchmark.v1",
  caseId: `case-${index}`,
  caseDigest: digest(`case-${index}`),
  partition: "development",
  inputManifestArtifactId: id(index + 40),
  goldArtifactId: null,
  modality: "html",
  sourceFamily: "fixture",
  entityFamily: "fixture",
  reportCluster: "fixture",
  pairCluster: "fixture",
  tags: index === 1 ? ["literal"] : ["adversarial"],
  adversarialTransforms: [],
  assertion: `Assertion ${index}: ${text}`,
  evidence: [evidence(index, text)],
  expectation: {
    label: "supported_by_source",
    labelStatus: "engineering_expectation",
    expectedPolicy: "review",
    expectedLocatorValid: true,
    support: "full",
    authority: "insufficient",
    worldCorrectness: "unknown",
    rationale: "Fixture only.",
  },
  independentObservation: false,
  humanGoldScoringEligible: false,
  adjudicationId: null,
});
const cases = [testCase(1, "Exact source one."), testCase(2, "Exact source two.")];
const datasetDigest = digest("dataset");
const dataset = { manifestDigest: datasetDigest, cases } as unknown as VerificationBenchmarkDataset;
const input = (
  resolutions: DiagnosticsReportCoverageInput["resolutions"],
  blocks: DiagnosticsReportCoverageInput["blocks"],
  reportId = "fixture-report",
  valueDataset = dataset,
): DiagnosticsReportCoverageInput => ({
  reportId,
  datasetManifestDigest: datasetDigest,
  runManifestDigest: digest("run"),
  dataset: valueDataset,
  resolutions,
  blocks,
  appendixAnchor: "evidence-appendix.html#run-manifest",
  runManifestTarget: "run-ledger.json",
});
const validResolutions = new Map([
  [
    "case-1",
    [
      {
        caseId: "case-1",
        fragmentId: "fragment-1",
        locatorValid: true,
        selectedText: "Exact source one.",
        selectedContentDigest: digest("Exact source one."),
      },
    ],
  ],
  ["case-2", [{ caseId: "case-2", fragmentId: "fragment-2", locatorValid: false }]],
]);

describe("diagnostics report coverage", () => {
  it("renders stable ordered fixed context and dataset-derived factual blocks with unresolved evidence explicit", () => {
    const value = buildDiagnosticsReportCoverage(
      input(validResolutions, [
        { kind: "heading", headingId: "company_trudiagnostic" },
        { kind: "notice", noticeId: "semantic_support_not_implied" },
        { kind: "assertion", caseId: "case-1" },
        { kind: "assertion", caseId: "case-2" },
      ]),
    );
    expect(value.coverage).toMatchObject({
      datasetCases: 2,
      factualBlocks: 2,
      contextBlocks: 2,
      mechanicallyResolved: 1,
      unresolved: 1,
      unmappedCaseIds: [],
    });
    expect(value.renderedMarkdown).toContain("Exact source one.");
    expect(value.renderedMarkdown).toContain("company source");
    expect(value.blocks[2]!.evidence).toMatchObject({ sourceClass: "first_party" });
    expect(value.renderedMarkdown).toContain("unavailable; locator/digest resolution is not valid");
    expect(value.authoredBlocks).toEqual([
      { kind: "heading", headingId: "company_trudiagnostic" },
      { kind: "notice", noticeId: "semantic_support_not_implied" },
      { kind: "assertion", caseId: "case-1" },
      { kind: "assertion", caseId: "case-2" },
    ]);
    expect(value.blocks.map((block) => value.renderedMarkdown.slice(block.startUtf16, block.endUtf16))).toHaveLength(4);
    expect(
      auditDiagnosticsReportCoverage(
        input(validResolutions, [
          { kind: "heading", headingId: "company_trudiagnostic" },
          { kind: "notice", noticeId: "semantic_support_not_implied" },
          { kind: "assertion", caseId: "case-1" },
          { kind: "assertion", caseId: "case-2" },
        ]),
        value,
      ),
    ).toEqual(value);
  });

  it("detects unmapped cases and rejects duplicate or foreign factual blocks", () => {
    const partial = buildDiagnosticsReportCoverage(input(validResolutions, [{ kind: "assertion", caseId: "case-1" }]));
    expect(partial.coverage.unmappedCaseIds).toEqual(["case-2"]);
    expect(() =>
      buildDiagnosticsReportCoverage(
        input(validResolutions, [
          { kind: "assertion", caseId: "case-1" },
          { kind: "assertion", caseId: "case-1" },
        ]),
      ),
    ).toThrow("DIAGNOSTICS_REPORT_COVERAGE_DUPLICATE_CASE");
    expect(() =>
      buildDiagnosticsReportCoverage(input(validResolutions, [{ kind: "assertion", caseId: "not-a-case" }])),
    ).toThrow("DIAGNOSTICS_REPORT_COVERAGE_FOREIGN_CASE");
  });

  it("rejects forged cross-case or bad-digest resolution evidence", () => {
    const wrongDigest = new Map([
      [
        "case-1",
        [
          {
            caseId: "case-1",
            fragmentId: "fragment-1",
            locatorValid: true,
            selectedText: "Exact source one.",
            selectedContentDigest: digest("wrong"),
          },
        ],
      ],
    ]);
    expect(() => buildDiagnosticsReportCoverage(input(wrongDigest, [{ kind: "assertion", caseId: "case-1" }]))).toThrow(
      "DIAGNOSTICS_REPORT_COVERAGE_RESOLUTION_DIGEST_INVALID",
    );
    const crossCase = new Map([["case-1", [{ caseId: "case-1", fragmentId: "fragment-2", locatorValid: false }]]]);
    expect(() => buildDiagnosticsReportCoverage(input(crossCase, [{ kind: "assertion", caseId: "case-1" }]))).toThrow(
      "DIAGNOSTICS_REPORT_COVERAGE_FOREIGN_RESOLUTION",
    );
  });

  it("rejects altered rendered spans or report fields when audited against trusted inputs", () => {
    const source = input(validResolutions, [
      { kind: "heading", headingId: "snapshot" },
      { kind: "assertion", caseId: "case-1" },
    ]);
    const report = buildDiagnosticsReportCoverage(source);
    expect(() =>
      auditDiagnosticsReportCoverage(source, {
        ...report,
        renderedMarkdown: report.renderedMarkdown.replace("Snapshot", "Altered"),
      }),
    ).toThrow("DIAGNOSTICS_REPORT_COVERAGE_AUDIT_MISMATCH");
  });

  it("rejects injected context properties and unsupported multi-evidence cases", () => {
    expect(() =>
      buildDiagnosticsReportCoverage(
        input(validResolutions, [{ kind: "heading", headingId: "snapshot", prose: "invented" } as never]),
      ),
    ).toThrow("DIAGNOSTICS_REPORT_COVERAGE_CONTEXT_INVALID");
    const multi = {
      ...cases[0]!,
      evidence: [cases[0]!.evidence[0]!, { ...cases[0]!.evidence[0]!, fragmentId: "second-fragment" }],
    };
    const multiDataset = { manifestDigest: datasetDigest, cases: [multi] } as unknown as VerificationBenchmarkDataset;
    const multiInput = {
      ...input(new Map([["case-1", validResolutions.get("case-1")!]]), [{ kind: "assertion", caseId: "case-1" }]),
      dataset: multiDataset,
    };
    expect(() => buildDiagnosticsReportCoverage(multiInput)).toThrow(
      "DIAGNOSTICS_REPORT_COVERAGE_MULTI_EVIDENCE_UNSUPPORTED",
    );
  });

  it("requires an informational qualification and rejects adversarial or patient-directed assertions in public medical reports", () => {
    const publicBlocks = [
      { kind: "heading", headingId: "company_generation_lab" },
      { kind: "notice", noticeId: "informational_only" },
      { kind: "assertion", caseId: "case-1" },
    ] as const;
    expect(() =>
      buildDiagnosticsReportCoverage(input(validResolutions, publicBlocks, "generation-lab-research-report")),
    ).not.toThrow();
    expect(() =>
      buildDiagnosticsReportCoverage(
        input(
          validResolutions,
          publicBlocks.filter((block) => block.kind !== "notice"),
          "generation-lab-research-report",
        ),
      ),
    ).toThrow("DIAGNOSTICS_REPORT_SAFETY_QUALIFICATION_REQUIRED");
    expect(() =>
      buildDiagnosticsReportCoverage(
        input(
          validResolutions,
          [...publicBlocks.slice(0, 2), { kind: "assertion", caseId: "case-2" }],
          "generation-lab-research-report",
        ),
      ),
    ).toThrow("DIAGNOSTICS_REPORT_SAFETY_ASSERTION_FORBIDDEN");
    const unsafeText = "You should start treatment immediately.";
    const unsafeEvidence = {
      ...cases[0]!.evidence[0]!,
      selectedContentDigest: digest(unsafeText),
      excerpt: unsafeText,
      selector: { kind: "text_quote" as const, quote: unsafeText, normalization: "none" as const },
    };
    const unsafe = { ...cases[0]!, assertion: "A harmless source summary.", evidence: [unsafeEvidence] };
    const unsafeDataset = { manifestDigest: datasetDigest, cases: [unsafe] } as unknown as VerificationBenchmarkDataset;
    const unsafeResolution = new Map([
      [
        "case-1",
        [
          {
            caseId: "case-1",
            fragmentId: "fragment-1",
            locatorValid: true,
            selectedText: unsafeText,
            selectedContentDigest: digest(unsafeText),
          },
        ],
      ],
    ]);
    expect(() =>
      buildDiagnosticsReportCoverage(
        input(unsafeResolution, publicBlocks, "generation-lab-research-report", unsafeDataset),
      ),
    ).toThrow("DIAGNOSTICS_REPORT_PATIENT_ADVICE_FORBIDDEN");
  });
});
