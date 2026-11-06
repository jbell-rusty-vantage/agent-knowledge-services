import type { ResearchBinding, ResearchCoordinator } from "@aiengineer/knowledge-application";
import { digestBytes, digestCanonical, sameRef, type Ref } from "@aiengineer/knowledge-operation-protocol";
import {
  AuditorInventorySchema,
  ReportLedgerSchema,
  recordRef,
  type AuthScope,
  type AssertionOccurrence,
  type DiscoveredOccurrence,
} from "@aiengineer/knowledge-research-core";

/** Read canonical aggregation of the observations already authenticated by report.observe. No new census, seal or decision. */
export async function qualiaAssessmentPreview(input: {
  report: Ref<"report">;
  scope: AuthScope;
  research: {
    locator: { runOf(scope: AuthScope, report: Ref<"report">): Promise<string | null> };
    binding: Pick<ResearchBinding, "loadRunContext" | "custody">;
    coordinator: Pick<ResearchCoordinator, "assessReport">;
  };
}) {
  const { report, scope, research } = input;
  if (report.tenant !== scope.tenant || report.binding !== scope.binding)
    throw new Error("Assessment preview report scope mismatch");
  const runId = await research.locator.runOf(scope, report);
  if (!runId) throw new Error("Unknown exact report for assessment preview");
  const context = await research.binding.loadRunContext(scope, runId);
  if (!context.report || !sameRef(recordRef("report", context.report.revision), report))
    throw new Error("Assessment preview report identity or digest mismatch");
  const assessment = await research.coordinator.assessReport(scope, runId);
  if (!sameRef(assessment.report, report)) throw new Error("Canonical assessment names another exact report");
  const revision = context.report.revision;
  const bytes = async (ref: Ref<"artifact">) => {
    if (ref.tenant !== scope.tenant || ref.binding !== scope.binding)
      throw new Error("Assessment preview custody scope mismatch");
    const value = await research.binding.custody.get(scope, ref);
    if (digestBytes(value) !== ref.digest) throw new Error("Assessment preview custody digest mismatch");
    return value;
  };
  const body = Buffer.from(await bytes(revision.body)).toString("utf8");
  const ledger = ReportLedgerSchema.parse(JSON.parse(Buffer.from(await bytes(revision.ledger)).toString("utf8")));
  if (
    !sameRef(ledger.body, revision.body) ||
    digestCanonical(ledger) !== digestCanonical(context.report.ledger) ||
    digestCanonical([...ledger.entries].sort((a, b) => a.id.localeCompare(b.id))) !==
      digestCanonical([...context.occurrences].sort((a, b) => a.id.localeCompare(b.id)))
  )
    throw new Error("Assessment preview producer ledger mismatch");
  const describe = (occurrence: AssertionOccurrence | DiscoveredOccurrence) => {
    if (!sameRef(occurrence.body, revision.body) || occurrence.span.start < 0 || occurrence.span.end > body.length)
      throw new Error("Assessment preview occurrence body or span mismatch");
    const quote = body.slice(occurrence.span.start, occurrence.span.end);
    if (digestBytes(quote) !== occurrence.quoteDigest) throw new Error("Assessment preview occurrence quote mismatch");
    return {
      occurrenceId: occurrence.id,
      blockPath: occurrence.blockPath,
      span: occurrence.span,
      quote,
      assertion: occurrence.assertion,
      ...("negated" in occurrence ? { negated: occurrence.negated, interrogative: occurrence.interrogative } : {}),
    };
  };
  type Description = ReturnType<typeof describe>;
  const repairFeedback: {
    unexplainedAuditorOnly: Description[];
    unexplainedProducerOnly: Description[];
    screening: Array<
      Description & { flags: string[]; explained: string | null; declaredNegation: boolean; declaredModality: string }
    >;
  } = { unexplainedAuditorOnly: [], unexplainedProducerOnly: [], screening: [] };
  if (assessment.census.status === "assessed") {
    const census = assessment.census.outcome;
    if (census.bodyDigest !== revision.body.digest || !sameRef(census.producerInventory, revision.ledger))
      throw new Error("Assessment preview census report binding mismatch");
    const inventory = AuditorInventorySchema.parse(
      JSON.parse(Buffer.from(await bytes(census.auditorInventory)).toString("utf8")),
    );
    if (
      !sameRef(inventory.body, revision.body) ||
      digestCanonical(inventory.occurrences.map((occurrence) => occurrence.id)) !==
        digestCanonical(census.discoveredOccurrences)
    )
      throw new Error("Assessment preview actual auditor inventory mismatch");
    const exactly = <T extends { id: string }>(values: readonly T[], id: string) => {
      const matches = values.filter((value) => value.id === id);
      if (matches.length !== 1) throw new Error("Assessment preview occurrence identity missing or ambiguous");
      return matches[0]!;
    };
    repairFeedback.unexplainedAuditorOnly = census.reconciliation.unexplainedAuditorOnly.map((id) =>
      describe(exactly(inventory.occurrences, id)),
    );
    repairFeedback.unexplainedProducerOnly = census.reconciliation.unexplainedProducerOnly.map((id) =>
      describe(exactly(ledger.entries, id)),
    );
    repairFeedback.screening = census.screening.map((entry) => {
      const occurrence = exactly(ledger.entries, entry.occurrenceId);
      const assertion = context.assertions.find((assertion) =>
        sameRef(recordRef("assertion", assertion), occurrence.assertion),
      );
      if (!assertion) throw new Error("Assessment preview screened assertion mismatch");
      return {
        ...describe(occurrence),
        flags: [...entry.flags],
        explained: entry.explained,
        declaredNegation: assertion.qualifiers.negation,
        declaredModality: assertion.qualifiers.modality,
      };
    });
  }
  return {
    schema: "qualia-assessment-preview.v1" as const,
    report,
    assessment,
    repairFeedback,
    admitted: false as const,
    qualified: false as const,
    dispatched: false as const,
  };
}
