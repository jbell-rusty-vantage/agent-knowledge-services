import type {
  DeterministicVerificationResult,
  SemanticVerdict,
  VerificationReportLedger,
} from "@aiengineer/knowledge-contracts";

export interface ReportCitationAssessment {
  readonly citationId: string;
  readonly fragmentId: string;
  readonly pointerStatus: "valid" | "missing" | "out_of_range" | "malformed" | "misplaced";
  readonly semanticVerdict: SemanticVerdict;
  readonly sourceFamilyId: string;
  readonly sourceIndependence: "independent" | "not_independent" | "unknown";
}

export interface ReportAssertionAssessment {
  readonly assertionId: string;
  readonly exactText: string;
  readonly start: number;
  readonly end: number;
  readonly citationRequired: boolean;
  readonly claimWeight: number;
  readonly severity: "low" | "medium" | "high" | "critical";
  readonly citations: readonly ReportCitationAssessment[];
  readonly requiredQualifiers: readonly string[];
  readonly consistencyKey?: string;
  readonly consistencyFacet?: "entity" | "date" | "number" | "other";
  readonly contextKey?: string;
  readonly normalizedValue?: string;
  readonly negated?: boolean;
}

export interface ReportVerificationSummary {
  readonly claimWeightedCitationCompleteness: number;
  readonly citationCorrectness: number | null;
  readonly validPointerConditionalCitationCorrectness: number | null;
  readonly pointerFailures: readonly string[];
  readonly misplacedCitationIds: readonly string[];
  readonly duplicateAssertionGroups: readonly (readonly string[])[];
  readonly conflictAssertionGroups: readonly (readonly string[])[];
  readonly missingQualifierAssertionIds: readonly string[];
  readonly consistencyMismatchGroups: readonly (readonly string[])[];
  readonly crossSectionMismatches: readonly {
    readonly facet: "entity" | "date" | "number" | "other";
    readonly assertionIds: readonly string[];
  }[];
  readonly independentSourceFamilyCount: number;
  readonly distinctSourceFamilyCount: number;
  readonly unsupportedHighSeverityAssertionIds: readonly string[];
}

/**
 * Applies only report-wide facts that are mechanically decidable from the
 * exact report/ledger/result. Semantic correctness and unobserved claim recall
 * remain review concerns and can never be promoted by this function.
 */
export function applyReportWideMechanicalGates(
  input: DeterministicVerificationResult,
  report: ReportVerificationSummary,
): DeterministicVerificationResult {
  const hard = new Set(input.summary.failedCheckCodes);
  if (report.claimWeightedCitationCompleteness < 1) hard.add("REPORT_DECLARED_CITATION_COMPLETENESS");
  if (report.pointerFailures.length) hard.add("REPORT_CITATION_POINTER_VALID");
  if (report.missingQualifierAssertionIds.length) hard.add("REPORT_REQUIRED_QUALIFIERS_PRESERVED");
  if (report.conflictAssertionGroups.length) hard.add("REPORT_INTERNAL_CONTRADICTION_FREE");
  if (report.consistencyMismatchGroups.length || report.crossSectionMismatches.length)
    hard.add("REPORT_CROSS_SECTION_CONSISTENCY");
  const review = new Set(input.summary.reviewReasons);
  if (report.duplicateAssertionGroups.length) review.add("REPORT_DUPLICATE_ASSERTIONS");
  if (report.citationCorrectness !== 1) review.add("REPORT_CITATION_SEMANTICS_UNASSESSED");
  if (report.unsupportedHighSeverityAssertionIds.length) review.add("REPORT_HIGH_SEVERITY_SUPPORT_UNASSESSED");
  const failed = hard.size > input.summary.failedCheckCodes.length;
  return Object.freeze({
    ...input,
    status: failed ? "failed" : input.status,
    semanticEligibility: failed ? false : input.semanticEligibility,
    summary: {
      ...input.summary,
      failedCheckCodes: [...hard].sort(),
      reviewReasons: [...review].sort(),
    },
  });
}

/** Recompute the report-wide mechanical summary from an exact retained report ledger. */
export function verifyReportWideFromLedger(
  report: string,
  ledger: Pick<VerificationReportLedger, "assertions">,
  deterministicResult: DeterministicVerificationResult,
): ReportVerificationSummary {
  return verifyReportWide(
    report,
    ledger.assertions.map(({ assertion, ...item }) => ({
      assertionId: assertion.assertionId,
      exactText: item.exactText,
      start: item.start,
      end: item.end,
      citationRequired: item.citationRequired,
      claimWeight: item.claimWeight,
      severity: item.severity,
      citations: item.citations.map((citation) => {
        const edge = assertion.evidence.find((value) => value.evidenceId === citation.evidenceId)!;
        const mechanical = deterministicResult.assertions
          .find((value) => value.assertionId === assertion.assertionId)
          ?.evidence.find((value) => value.evidenceId === citation.evidenceId);
        return {
          citationId: citation.citationId,
          fragmentId: edge.fragment.fragmentId,
          pointerStatus: mechanical?.status === "passed" ? ("valid" as const) : ("missing" as const),
          semanticVerdict: "insufficient_evidence" as const,
          sourceFamilyId: "unknown",
          sourceIndependence: "unknown" as const,
        };
      }),
      requiredQualifiers: item.requiredQualifiers,
      ...(item.consistencyKey === undefined ? {} : { consistencyKey: item.consistencyKey }),
      ...(item.consistencyFacet === undefined ? {} : { consistencyFacet: item.consistencyFacet }),
      ...(item.contextKey === undefined ? {} : { contextKey: item.contextKey }),
      ...(item.normalizedValue === undefined ? {} : { normalizedValue: item.normalizedValue }),
      ...(item.negated === undefined ? {} : { negated: item.negated }),
    })),
  );
}

const supporting = new Set<SemanticVerdict>(["directly_supported", "supported_with_qualification", "derived_verified"]);

export function verifyReportWide(
  report: string,
  assertions: readonly ReportAssertionAssessment[],
): ReportVerificationSummary {
  if (report.length > 100_000 || assertions.length > 512) throw new Error("REPORT_CAPACITY_EXCEEDED");
  const ids = new Set<string>();
  const citationIds = new Set<string>();
  let totalCitations = 0;
  for (const item of assertions) {
    if (!item.assertionId.trim() || ids.has(item.assertionId)) throw new Error("REPORT_ASSERTION_ID_INVALID");
    ids.add(item.assertionId);
    if (
      !Number.isInteger(item.start) ||
      !Number.isInteger(item.end) ||
      item.start < 0 ||
      item.end <= item.start ||
      report.slice(item.start, item.end) !== item.exactText
    )
      throw new Error("REPORT_ASSERTION_RANGE_INVALID");
    if (!Number.isFinite(item.claimWeight) || item.claimWeight <= 0 || item.claimWeight > 100)
      throw new Error("REPORT_ASSERTION_WEIGHT_INVALID");
    if (item.exactText.length > 20_000 || item.citations.length > 32 || item.requiredQualifiers.length > 32)
      throw new Error("REPORT_ASSERTION_CAPACITY_EXCEEDED");
    for (const qualifier of item.requiredQualifiers)
      if (!qualifier.trim() || qualifier.length > 240) throw new Error("REPORT_QUALIFIER_INVALID");
    for (const citation of item.citations) {
      totalCitations += 1;
      if (
        totalCitations > 4_096 ||
        !citation.citationId.trim() ||
        citation.citationId.length > 255 ||
        citationIds.has(citation.citationId) ||
        citation.fragmentId.length > 255 ||
        citation.sourceFamilyId.length > 255
      )
        throw new Error("REPORT_CITATION_INVALID");
      citationIds.add(citation.citationId);
    }
  }
  const required = assertions.filter((item) => item.citationRequired);
  const totalWeight = required.reduce((sum, item) => sum + item.claimWeight, 0);
  const citedWeight = required
    .filter((item) => item.citations.some((citation) => citation.pointerStatus === "valid"))
    .reduce((sum, item) => sum + item.claimWeight, 0);
  const citations = assertions.flatMap((item) => item.citations);
  const validPointers = citations.filter((citation) => citation.pointerStatus === "valid");
  const byText = groupBy(assertions, (item) => item.exactText.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"));
  const byConsistency = groupBy(
    assertions.filter((item) => item.consistencyKey),
    (item) => `${item.consistencyKey!}:${item.contextKey ?? ""}`,
  );
  return Object.freeze({
    claimWeightedCitationCompleteness: totalWeight === 0 ? 1 : citedWeight / totalWeight,
    citationCorrectness:
      citations.length === 0
        ? null
        : citations.filter((citation) => citation.pointerStatus === "valid" && supporting.has(citation.semanticVerdict))
            .length / citations.length,
    validPointerConditionalCitationCorrectness:
      validPointers.length === 0
        ? null
        : validPointers.filter((citation) => supporting.has(citation.semanticVerdict)).length / validPointers.length,
    pointerFailures: Object.freeze(
      citations
        .filter((citation) => !["valid", "misplaced"].includes(citation.pointerStatus))
        .map((citation) => citation.citationId),
    ),
    misplacedCitationIds: Object.freeze(
      citations.filter((citation) => citation.pointerStatus === "misplaced").map((citation) => citation.citationId),
    ),
    duplicateAssertionGroups: Object.freeze(
      [...byText.values()]
        .filter((items) => items.length > 1)
        .map((items) => Object.freeze(items.map((item) => item.assertionId))),
    ),
    conflictAssertionGroups: Object.freeze(
      [...byConsistency.values()]
        .filter(
          (items) => new Set(items.map((item) => `${item.normalizedValue ?? ""}:${item.negated ?? false}`)).size > 1,
        )
        .map((items) => Object.freeze(items.map((item) => item.assertionId))),
    ),
    missingQualifierAssertionIds: Object.freeze(
      assertions
        .filter((item) => item.requiredQualifiers.some((qualifier) => !item.exactText.includes(qualifier)))
        .map((item) => item.assertionId),
    ),
    consistencyMismatchGroups: Object.freeze(
      [...byConsistency.values()]
        .filter((items) => new Set(items.map((item) => item.normalizedValue ?? "")).size > 1)
        .map((items) => Object.freeze(items.map((item) => item.assertionId))),
    ),
    crossSectionMismatches: Object.freeze(
      [...byConsistency.values()]
        .filter((items) => new Set(items.map((item) => item.normalizedValue ?? "")).size > 1)
        .map((items) =>
          Object.freeze({
            facet: items[0]!.consistencyFacet ?? "other",
            assertionIds: Object.freeze(items.map((item) => item.assertionId)),
          }),
        ),
    ),
    independentSourceFamilyCount: new Set(
      validPointers
        .filter((citation) => citation.sourceIndependence === "independent")
        .map((citation) => citation.sourceFamilyId),
    ).size,
    distinctSourceFamilyCount: new Set(validPointers.map((citation) => citation.sourceFamilyId)).size,
    unsupportedHighSeverityAssertionIds: Object.freeze(
      assertions
        .filter(
          (item) =>
            ["high", "critical"].includes(item.severity) &&
            !item.citations.some(
              (citation) => citation.pointerStatus === "valid" && supporting.has(citation.semanticVerdict),
            ),
        )
        .map((item) => item.assertionId),
    ),
  });
}

function groupBy<T>(items: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const group = groups.get(groupKey);
    if (group) group.push(item);
    else groups.set(groupKey, [item]);
  }
  return groups;
}
