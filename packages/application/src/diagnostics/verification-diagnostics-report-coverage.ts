import type { VerificationBenchmarkCase, VerificationBenchmarkDataset } from "@aiengineer/knowledge-contracts";
import { digestCanonicalJson, sha256Digest } from "@aiengineer/knowledge-verification";

type Digest = `sha256:${string}`;

export type DiagnosticsReportHeadingId =
  | "company_trudiagnostic"
  | "company_generation_lab"
  | "snapshot"
  | "product"
  | "method"
  | "algorithms"
  | "biomarkers"
  | "science"
  | "limitations"
  | "conflicts"
  | "unanswered"
  | "appendix"
  | "comparison"
  | "verification_audit"
  | "captured_assertions";
export type DiagnosticsReportNoticeId =
  | "frozen_snapshot"
  | "engineering_expectations_only"
  | "offline_deterministic_replay"
  | "semantic_support_not_implied"
  | "review_gated"
  | "applicability_unverified"
  | "informational_only"
  | "comparison_scope";

const headings: Readonly<Record<DiagnosticsReportHeadingId, string>> = Object.freeze({
  company_trudiagnostic: "# TruDiagnostic research report",
  company_generation_lab: "# Generation Lab research report",
  snapshot: "## Snapshot",
  product: "## Product",
  method: "## Method",
  algorithms: "## Algorithms",
  biomarkers: "## Biomarkers",
  science: "## Science",
  limitations: "## Limitations",
  conflicts: "## Conflicts",
  unanswered: "## Unanswered questions",
  appendix: "## Evidence appendix",
  comparison: "# Diagnostics comparison",
  verification_audit: "# Verification audit",
  captured_assertions: "## Captured assertions",
});
const notices: Readonly<Record<DiagnosticsReportNoticeId, string>> = Object.freeze({
  frozen_snapshot: "This report is a frozen dataset snapshot.",
  engineering_expectations_only: "All labels remain engineering expectations; no human-gold authority is claimed.",
  offline_deterministic_replay: "This report uses offline deterministic replay only.",
  semantic_support_not_implied:
    "Locator and digest resolution are mechanical custody checks and do not imply semantic support, authority, or policy admission.",
  review_gated: "This output is review-gated and does not create a frozen successor dataset or approval.",
  applicability_unverified:
    "Publication statements are retained for inspection; product applicability remains unverified.",
  informational_only: "This report is informational and does not recommend a product or provide medical advice.",
  comparison_scope:
    "Statements below retain their individual scopes; no clinical or population comparison is admitted.",
});
const sourceClassLabels: Readonly<
  Record<"first_party" | "first_party_marketing" | "publication" | "interested_party_comparison", string>
> = Object.freeze({
  first_party: "company source",
  first_party_marketing: "company marketing",
  publication: "publication source",
  interested_party_comparison: "interested-party comparison",
});

export type DiagnosticsReportBlockInput =
  | { readonly kind: "heading"; readonly headingId: DiagnosticsReportHeadingId }
  | { readonly kind: "notice"; readonly noticeId: DiagnosticsReportNoticeId }
  | { readonly kind: "assertion"; readonly caseId: string };

/** A mechanical selector result. A false locator may retain diagnostic text, but it is never rendered as evidence. */
export interface DiagnosticsReportEvidenceResolution {
  readonly caseId: string;
  readonly fragmentId: string;
  readonly locatorValid: boolean;
  readonly selectedText?: string;
  readonly selectedContentDigest?: Digest;
}

export interface DiagnosticsReportCoverageInput {
  readonly reportId: string;
  readonly datasetManifestDigest: Digest;
  readonly runManifestDigest: Digest;
  readonly dataset: VerificationBenchmarkDataset;
  readonly resolutions: ReadonlyMap<string, readonly DiagnosticsReportEvidenceResolution[]>;
  readonly blocks: readonly DiagnosticsReportBlockInput[];
  readonly appendixAnchor: string;
  readonly runManifestTarget: string;
}

export interface DiagnosticsReportCoverageBlock {
  readonly ordinal: number;
  readonly kind: "heading" | "notice" | "assertion";
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly textDigest: Digest;
  readonly caseId?: string;
  readonly assertionText?: string;
  readonly attribution?: "source_statement" | "adversarial_claim";
  readonly evidenceHref?: string;
  readonly evidence?: {
    readonly captureId: string;
    readonly fragmentId: string;
    readonly sourceClass: "first_party" | "first_party_marketing" | "publication" | "interested_party_comparison";
    readonly projectionArtifactId: string;
    readonly projectionDigest: Digest;
    readonly transformationArtifactId: string;
    readonly selectedContentDigest: Digest;
    readonly locatorValid: boolean;
  };
}

export interface DiagnosticsReportCoverage {
  readonly schemaVersion: "diagnostics-report-coverage.v1";
  readonly reportId: string;
  readonly datasetManifestDigest: Digest;
  readonly runManifestDigest: Digest;
  readonly appendixAnchor: string;
  readonly runManifestTarget: string;
  /** Retained fixed block IDs/case references let a verifier rebuild without guessing author intent. */
  readonly authoredBlocks: readonly DiagnosticsReportBlockInput[];
  readonly renderedMarkdown: string;
  readonly blocks: readonly DiagnosticsReportCoverageBlock[];
  readonly coverage: {
    readonly datasetCases: number;
    readonly factualBlocks: number;
    readonly contextBlocks: number;
    readonly mechanicallyResolved: number;
    readonly unresolved: number;
    readonly unmappedCaseIds: readonly string[];
  };
  readonly reportDigest: Digest;
}

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const localAnchor = "evidence-appendix.html#run-manifest";
const exactly = (value: object, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
const publicMedicalReportIds = new Set([
  "trudiagnostic-research-report",
  "generation-lab-research-report",
  "diagnostics-comparison-report",
]);
// This is an intentionally narrow patient-directed imperative guard. The report plan
// also permits only literal source statements, rather than semantic/adversarial claims.
const patientDirectedAdvice =
  /\b(?:you|your patient)\s+(?:should|must|need to|are advised to)\b|\b(?:take|stop|start|avoid|seek)\s+(?:a |the |your )?(?:medication|medicine|treatment|therapy)\b/iu;

function assertInput(input: DiagnosticsReportCoverageInput): void {
  if (
    !idPattern.test(input.reportId) ||
    !digestPattern.test(input.datasetManifestDigest) ||
    !digestPattern.test(input.runManifestDigest)
  )
    throw new Error("DIAGNOSTICS_REPORT_COVERAGE_ID_INVALID");
  if (
    input.dataset.manifestDigest !== input.datasetManifestDigest ||
    input.appendixAnchor !== localAnchor ||
    input.runManifestTarget !== "run-ledger.json"
  )
    throw new Error("DIAGNOSTICS_REPORT_COVERAGE_BINDING_INVALID");
  if (!Array.isArray(input.blocks) || input.blocks.length < 1 || input.blocks.length > 512)
    throw new Error("DIAGNOSTICS_REPORT_COVERAGE_BLOCKS_INVALID");
}

/** Enforces the bounded safety policy used by the three public diagnostics reports. */
function assertPublicMedicalReportSafety(
  input: DiagnosticsReportCoverageInput,
  cases: ReadonlyMap<string, VerificationBenchmarkCase>,
  resolutions: ReadonlyMap<string, DiagnosticsReportEvidenceResolution>,
): void {
  if (!publicMedicalReportIds.has(input.reportId)) return;
  if (!input.blocks.some((block) => block.kind === "notice" && block.noticeId === "informational_only"))
    throw new Error("DIAGNOSTICS_REPORT_SAFETY_QUALIFICATION_REQUIRED");
  for (const block of input.blocks) {
    if (block.kind !== "assertion") continue;
    const testCase = cases.get(block.caseId);
    if (!testCase || !testCase.tags.includes("literal") || testCase.tags.includes("adversarial"))
      throw new Error("DIAGNOSTICS_REPORT_SAFETY_ASSERTION_FORBIDDEN");
    const evidence = testCase.evidence[0];
    const resolution = evidence ? resolutions.get(`${testCase.caseId}\u0000${evidence.fragmentId}`) : undefined;
    const rendered =
      resolution?.locatorValid === true && typeof resolution.selectedText === "string"
        ? resolution.selectedText
        : testCase.assertion;
    if (patientDirectedAdvice.test(rendered)) throw new Error("DIAGNOSTICS_REPORT_PATIENT_ADVICE_FORBIDDEN");
  }
}

function resolutionIndex(
  dataset: VerificationBenchmarkDataset,
  resolutions: ReadonlyMap<string, readonly DiagnosticsReportEvidenceResolution[]>,
) {
  const cases = new Map(dataset.cases.map((item) => [item.caseId, item]));
  const indexed = new Map<string, DiagnosticsReportEvidenceResolution>();
  for (const [caseId, records] of resolutions) {
    const testCase = cases.get(caseId);
    if (!testCase || !Array.isArray(records)) throw new Error("DIAGNOSTICS_REPORT_COVERAGE_FOREIGN_RESOLUTION");
    const evidenceByFragment = new Map(testCase.evidence.map((item) => [item.fragmentId, item]));
    for (const record of records) {
      if (record.caseId !== caseId || !evidenceByFragment.has(record.fragmentId))
        throw new Error("DIAGNOSTICS_REPORT_COVERAGE_FOREIGN_RESOLUTION");
      const key = `${record.caseId}\u0000${record.fragmentId}`;
      if (indexed.has(key)) throw new Error("DIAGNOSTICS_REPORT_COVERAGE_DUPLICATE_RESOLUTION");
      const evidence = evidenceByFragment.get(record.fragmentId)!;
      if (
        record.locatorValid &&
        (typeof record.selectedText !== "string" ||
          record.selectedContentDigest !== evidence.selectedContentDigest ||
          sha256Digest(record.selectedText) !== evidence.selectedContentDigest)
      )
        throw new Error("DIAGNOSTICS_REPORT_COVERAGE_RESOLUTION_DIGEST_INVALID");
      indexed.set(key, Object.freeze({ ...record }));
    }
  }
  return indexed;
}

function assertionText(
  testCase: VerificationBenchmarkCase,
  resolution: DiagnosticsReportEvidenceResolution | undefined,
): {
  readonly text: string;
  readonly block: Omit<DiagnosticsReportCoverageBlock, "ordinal" | "startUtf16" | "endUtf16" | "textDigest">;
  readonly mechanicallyResolved: boolean;
} {
  if (testCase.evidence.length > 1) throw new Error("DIAGNOSTICS_REPORT_COVERAGE_MULTI_EVIDENCE_UNSUPPORTED");
  const evidence = testCase.evidence[0];
  const attribution = testCase.tags.includes("literal")
    ? ("source_statement" as const)
    : ("adversarial_claim" as const);
  if (!evidence)
    return {
      text: `- ${attribution === "source_statement" ? "Captured source statement:" : "Adversarial test assertion:"} ${testCase.assertion}\n  - Evidence status: unavailable; no frozen fragment is declared for this case.`,
      block: { kind: "assertion", caseId: testCase.caseId, assertionText: testCase.assertion, attribution },
      mechanicallyResolved: false,
    };
  const valid = resolution?.locatorValid === true;
  const sourceClass = evidence.sourceClass as keyof typeof sourceClassLabels;
  if (!Object.hasOwn(sourceClassLabels, sourceClass))
    throw new Error("DIAGNOSTICS_REPORT_COVERAGE_SOURCE_CLASS_INVALID");
  const attributionPrefix =
    attribution === "source_statement" ? "Captured source statement" : "Adversarial test assertion";
  const status = valid ? "resolved mechanically" : "unavailable; locator/digest resolution is not valid";
  const evidenceHref = `evidence-appendix.html#fragment-${testCase.caseId}`;
  const citation = `[case:${testCase.caseId}; capture:${evidence.captureId}; fragment:${evidence.fragmentId}]`;
  const renderedAssertion =
    attribution === "source_statement" && valid && typeof resolution?.selectedText === "string"
      ? resolution.selectedText
      : testCase.assertion;
  return {
    text: `- ${attributionPrefix} (${sourceClassLabels[sourceClass]}) : ${renderedAssertion} ${citation}\n  - Evidence status: ${status}.`,
    block: {
      kind: "assertion",
      caseId: testCase.caseId,
      assertionText: renderedAssertion,
      attribution,
      evidenceHref,
      evidence: {
        captureId: evidence.captureId,
        fragmentId: evidence.fragmentId,
        sourceClass,
        projectionArtifactId: evidence.projectionArtifactId,
        projectionDigest: evidence.projectionDigest as Digest,
        transformationArtifactId: evidence.transformationArtifactId,
        selectedContentDigest: evidence.selectedContentDigest as Digest,
        locatorValid: valid,
      },
    },
    mechanicallyResolved: valid,
  };
}

/** Builds only fixed context text and dataset-derived assertion blocks; it does not make semantic findings. */
export function buildDiagnosticsReportCoverage(input: DiagnosticsReportCoverageInput): DiagnosticsReportCoverage {
  assertInput(input);
  const cases = new Map(input.dataset.cases.map((item) => [item.caseId, item]));
  if (cases.size !== input.dataset.cases.length) throw new Error("DIAGNOSTICS_REPORT_COVERAGE_DATASET_CASE_DUPLICATE");
  const indexedResolutions = resolutionIndex(input.dataset, input.resolutions);
  assertPublicMedicalReportSafety(input, cases, indexedResolutions);
  const caseIds = new Set<string>();
  const material: Array<
    Omit<DiagnosticsReportCoverageBlock, "ordinal" | "startUtf16" | "endUtf16" | "textDigest"> & {
      readonly text: string;
      readonly mechanicallyResolved?: boolean;
    }
  > = [];
  for (const block of input.blocks) {
    if (block.kind === "heading") {
      if (!exactly(block, ["kind", "headingId"]) || !Object.hasOwn(headings, block.headingId))
        throw new Error("DIAGNOSTICS_REPORT_COVERAGE_CONTEXT_INVALID");
      const value = headings[block.headingId];
      material.push({ kind: "heading", text: value });
    } else if (block.kind === "notice") {
      if (!exactly(block, ["kind", "noticeId"]) || !Object.hasOwn(notices, block.noticeId))
        throw new Error("DIAGNOSTICS_REPORT_COVERAGE_CONTEXT_INVALID");
      const value = notices[block.noticeId];
      material.push({ kind: "notice", text: value });
    } else if (block.kind === "assertion") {
      if (!exactly(block, ["kind", "caseId"]) || typeof block.caseId !== "string")
        throw new Error("DIAGNOSTICS_REPORT_COVERAGE_BLOCKS_INVALID");
      const testCase = cases.get(block.caseId);
      if (!testCase) throw new Error("DIAGNOSTICS_REPORT_COVERAGE_FOREIGN_CASE");
      if (caseIds.has(block.caseId)) throw new Error("DIAGNOSTICS_REPORT_COVERAGE_DUPLICATE_CASE");
      caseIds.add(block.caseId);
      const evidence = testCase.evidence[0];
      const resolved = evidence ? indexedResolutions.get(`${testCase.caseId}\u0000${evidence.fragmentId}`) : undefined;
      const rendered = assertionText(testCase, resolved);
      material.push({ ...rendered.block, text: rendered.text, mechanicallyResolved: rendered.mechanicallyResolved });
    } else throw new Error("DIAGNOSTICS_REPORT_COVERAGE_BLOCKS_INVALID");
  }
  let offset = 0;
  const blocks = material.map((item, ordinal) => {
    const startUtf16 = offset,
      endUtf16 = startUtf16 + item.text.length;
    offset = endUtf16 + (ordinal === material.length - 1 ? 0 : 2);
    const { text: _text, mechanicallyResolved: _mechanicallyResolved, ...block } = item;
    return Object.freeze({ ...block, ordinal, startUtf16, endUtf16, textDigest: sha256Digest(item.text) });
  });
  const renderedMarkdown = material.map((item) => item.text).join("\n\n");
  const authoredBlocks = Object.freeze(input.blocks.map((item) => Object.freeze({ ...item })));
  const factual = material.filter((item) => item.kind === "assertion");
  const coverage = Object.freeze({
    datasetCases: input.dataset.cases.length,
    factualBlocks: factual.length,
    contextBlocks: material.length - factual.length,
    mechanicallyResolved: factual.filter((item) => item.mechanicallyResolved).length,
    unresolved: factual.filter((item) => !item.mechanicallyResolved).length,
    unmappedCaseIds: Object.freeze(
      input.dataset.cases.map((item) => item.caseId).filter((caseId) => !caseIds.has(caseId)),
    ),
  });
  const withoutDigest = {
    schemaVersion: "diagnostics-report-coverage.v1" as const,
    reportId: input.reportId,
    datasetManifestDigest: input.datasetManifestDigest,
    runManifestDigest: input.runManifestDigest,
    appendixAnchor: input.appendixAnchor,
    runManifestTarget: input.runManifestTarget,
    authoredBlocks,
    renderedMarkdown,
    blocks,
    coverage,
  };
  return Object.freeze({ ...withoutDigest, reportDigest: digestCanonicalJson(withoutDigest) });
}

/** Rebuilds trusted material and rejects any altered text, spans, references, or digest. */
export function auditDiagnosticsReportCoverage(
  input: DiagnosticsReportCoverageInput,
  report: DiagnosticsReportCoverage,
): DiagnosticsReportCoverage {
  const expected = buildDiagnosticsReportCoverage(input);
  if (report.reportDigest !== expected.reportDigest || digestCanonicalJson(report) !== digestCanonicalJson(expected))
    throw new Error("DIAGNOSTICS_REPORT_COVERAGE_AUDIT_MISMATCH");
  for (const block of report.blocks) {
    const text = report.renderedMarkdown.slice(block.startUtf16, block.endUtf16);
    if (sha256Digest(text) !== block.textDigest) throw new Error("DIAGNOSTICS_REPORT_COVERAGE_SPAN_INVALID");
  }
  return expected;
}
