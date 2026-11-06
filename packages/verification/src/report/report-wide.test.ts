import { describe, expect, it } from "vitest";
import { verifyReportWide, type ReportAssertionAssessment, type ReportCitationAssessment } from "./report-wide.js";

const report =
  "Generation Lab reports 19 systems. Another section reports 21 systems. Turnaround is 2–4 weeks for one context and 3–4 weeks for another.";

function citation(citationId: string, overrides: Partial<ReportCitationAssessment> = {}): ReportCitationAssessment {
  return {
    citationId,
    fragmentId: `f-${citationId}`,
    pointerStatus: "valid",
    semanticVerdict: "directly_supported",
    sourceFamilyId: "company",
    sourceIndependence: "not_independent",
    ...overrides,
  };
}

function assertion(
  assertionId: string,
  exactText: string,
  overrides: Partial<ReportAssertionAssessment> = {},
): ReportAssertionAssessment {
  const start = report.indexOf(exactText);
  return {
    assertionId,
    exactText,
    start,
    end: start + exactText.length,
    citationRequired: true,
    claimWeight: 1,
    severity: "medium",
    citations: [],
    requiredQualifiers: [],
    ...overrides,
  };
}

const COUNT_19 = "Generation Lab reports 19 systems.";
const COUNT_21 = "Another section reports 21 systems.";
const TURNAROUND = "Turnaround is 2–4 weeks for one context and 3–4 weeks for another.";

/** Two conflicting counts, one misplaced citation, one uncited duplicate. */
function mixedReport(): readonly ReportAssertionAssessment[] {
  return [
    assertion("count-19", COUNT_19, {
      claimWeight: 2,
      citations: [citation("c1")],
      consistencyKey: "system-count",
      consistencyFacet: "number",
      normalizedValue: "19",
    }),
    assertion("count-21", COUNT_21, {
      claimWeight: 2,
      severity: "high",
      citations: [citation("c2", { semanticVerdict: "contradicted" })],
      consistencyKey: "system-count",
      consistencyFacet: "number",
      normalizedValue: "21",
    }),
    assertion("turnaround", TURNAROUND, {
      severity: "high",
      citations: [citation("c3", { pointerStatus: "misplaced" })],
      requiredQualifiers: ["one context", "another"],
      consistencyKey: "turnaround",
      normalizedValue: "context-separated",
    }),
    assertion("duplicate-turnaround", TURNAROUND, {
      citationRequired: false,
      severity: "low",
    }),
  ];
}

describe("report-wide citation metrics", () => {
  it("weights citation completeness by claim weight", () => {
    expect(verifyReportWide(report, mixedReport()).claimWeightedCitationCompleteness).toBe(0.8);
  });

  it("counts citation correctness over every citation", () => {
    expect(verifyReportWide(report, mixedReport()).citationCorrectness).toBeCloseTo(1 / 3);
  });

  it("counts conditional correctness over valid pointers only", () => {
    expect(verifyReportWide(report, mixedReport()).validPointerConditionalCitationCorrectness).toBe(0.5);
  });

  it("lists misplaced citations", () => {
    expect(verifyReportWide(report, mixedReport()).misplacedCitationIds).toEqual(["c3"]);
  });
});

describe("report-wide consistency", () => {
  it("groups conflicting assertions under one consistency key", () => {
    expect(verifyReportWide(report, mixedReport()).conflictAssertionGroups).toEqual([["count-19", "count-21"]]);
  });

  it("reports cross-section mismatches by facet", () => {
    expect(verifyReportWide(report, mixedReport()).crossSectionMismatches).toEqual([
      { facet: "number", assertionIds: ["count-19", "count-21"] },
    ]);
  });

  it("groups assertions that repeat the same text range", () => {
    expect(verifyReportWide(report, mixedReport()).duplicateAssertionGroups).toEqual([
      ["turnaround", "duplicate-turnaround"],
    ]);
  });

  it("keeps values apart when they carry different context keys", () => {
    const text = "Product page: 2–4 weeks. FAQ: 3–4 weeks.";
    const contextual = (
      id: string,
      exactText: string,
      normalizedValue: string,
      contextKey: string,
    ): ReportAssertionAssessment => ({
      assertionId: id,
      exactText,
      start: text.indexOf(exactText),
      end: text.indexOf(exactText) + exactText.length,
      citationRequired: false,
      claimWeight: 1,
      severity: "medium",
      citations: [],
      requiredQualifiers: [],
      consistencyKey: "turnaround",
      consistencyFacet: "number",
      normalizedValue,
      contextKey,
    });
    const summary = verifyReportWide(text, [
      contextual("turnaround-product", "2–4 weeks", "2-4", "product-page"),
      contextual("turnaround-faq", "3–4 weeks", "3-4", "faq"),
    ]);
    expect(summary.conflictAssertionGroups).toEqual([]);
    expect(summary.crossSectionMismatches).toEqual([]);
  });

  it("finds entity and date drift inside one context", () => {
    const text = "Section A: TruDiagnostic in 2025. Section B: Generation Lab in 2026.";
    const inComparison = (
      id: string,
      exactText: string,
      consistencyKey: string,
      consistencyFacet: "entity" | "date",
      normalizedValue: string,
    ): ReportAssertionAssessment => ({
      assertionId: id,
      exactText,
      start: text.indexOf(exactText),
      end: text.indexOf(exactText) + exactText.length,
      citationRequired: false,
      claimWeight: 1,
      severity: "medium",
      citations: [],
      requiredQualifiers: [],
      consistencyKey,
      consistencyFacet,
      normalizedValue,
      contextKey: "comparison",
    });
    const summary = verifyReportWide(text, [
      inComparison("entity-a", "TruDiagnostic", "company", "entity", "tru"),
      inComparison("entity-b", "Generation Lab", "company", "entity", "gl"),
      inComparison("date-a", "2025", "capture-date", "date", "2025"),
      inComparison("date-b", "2026", "capture-date", "date", "2026"),
    ]);
    expect(summary.crossSectionMismatches).toEqual([
      { facet: "entity", assertionIds: ["entity-a", "entity-b"] },
      { facet: "date", assertionIds: ["date-a", "date-b"] },
    ]);
  });
});

describe("report-wide source and severity summaries", () => {
  it("counts independent and distinct source families", () => {
    const summary = verifyReportWide(report, mixedReport());
    expect(summary.independentSourceFamilyCount).toBe(0);
    expect(summary.distinctSourceFamilyCount).toBe(1);
  });

  it("lists high-severity assertions without a supporting valid citation", () => {
    expect(verifyReportWide(report, mixedReport()).unsupportedHighSeverityAssertionIds).toEqual([
      "count-21",
      "turnaround",
    ]);
  });
});

describe("report-wide capacity", () => {
  it("rejects more than 512 assertions before grouping", () => {
    expect(() =>
      verifyReportWide(
        "x",
        Array.from({ length: 513 }, (_, index) => ({
          assertionId: `a-${index}`,
          exactText: "x",
          start: 0,
          end: 1,
          citationRequired: false,
          claimWeight: 1,
          severity: "low" as const,
          citations: [],
          requiredQualifiers: [],
        })),
      ),
    ).toThrow("REPORT_CAPACITY_EXCEEDED");
  });
});
