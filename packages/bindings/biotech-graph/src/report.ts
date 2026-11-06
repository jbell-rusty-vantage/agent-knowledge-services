import { BIOTECH_REPORT_KINDS, type BiotechReportKind, GRAPH_REPORT_KIND } from "./contracts.js";

/**
 * Report kinds the Biotech graph binding materializes (K08 catalogue ids; BKS `ReportKind` values in
 * biotech-schema-v2.2.0) and the exact report binding of a `report.publish` proposal: the graph Report must carry the
 * frozen KS report revision's ids and digests, never caller-supplied look-alikes.
 */
export interface FrozenReportBinding {
  readonly reportRevisionId: string;
  readonly reportKind: BiotechReportKind;
  /** `<kind>@<semver>` (component `report_revision.report_kind_ref_id`). */
  readonly reportKindRef: string;
  readonly reportSchema: string;
  readonly bodyDigest: string;
  readonly ledgerDigest: string;
  readonly structuredBodyDigest: string;
}

export class ReportBindingError extends Error {
  readonly code: "REPORT_KIND_UNSUPPORTED" | "REPORT_PUBLISH_MISSING" | "REPORT_BINDING_MISMATCH";
  readonly mismatches: readonly string[];
  constructor(code: ReportBindingError["code"], message: string, mismatches: readonly string[] = []) {
    super(`${code}: ${message}`);
    this.name = "ReportBindingError";
    this.code = code;
    this.mismatches = mismatches;
  }
}

export function biotechReportKind(kindId: string): BiotechReportKind {
  const bare = kindId.split("@")[0] ?? kindId;
  if (!(BIOTECH_REPORT_KINDS as readonly string[]).includes(bare)) {
    throw new ReportBindingError("REPORT_KIND_UNSUPPORTED", `report kind ${bare} is not materialized by biotech-graph`);
  }
  return bare as BiotechReportKind;
}

/** The `report.publish` fields the frozen revision determines (merge into a proposal or compare with one). */
export function reportPublishFields(report: FrozenReportBinding): Record<string, string> {
  return {
    reportKind: GRAPH_REPORT_KIND[report.reportKind],
    reportRevisionRef: report.reportRevisionId,
    reportKindRef: report.reportKindRef,
    reportSchema: report.reportSchema,
    bodyDigest: report.bodyDigest,
    ledgerDigest: report.ledgerDigest,
    structuredBodyDigest: report.structuredBodyDigest,
    custodyKind: "knowledge_verification.artifact_custody",
  };
}

/**
 * Refuses an intent whose single `report.publish` proposal does not carry exactly the frozen revision's binding
 * (wrong revision, kind, kind version or any digest). A report effect without a `report.publish` proposal refuses.
 */
export function assertReportBinding(intent: Record<string, unknown>, report: FrozenReportBinding): void {
  const proposals = Array.isArray(intent.proposals) ? (intent.proposals as Record<string, unknown>[]) : [];
  const publishes = proposals.filter((p) => p.kind === "report.publish");
  if (publishes.length !== 1) {
    throw new ReportBindingError(
      "REPORT_PUBLISH_MISSING",
      `a report effect carries exactly one report.publish proposal (found ${publishes.length})`,
    );
  }
  const publish = publishes[0] as Record<string, unknown>;
  const expected = reportPublishFields(report);
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => publish[key] !== value)
    .map(([key]) => key);
  if (mismatches.length > 0) {
    throw new ReportBindingError(
      "REPORT_BINDING_MISMATCH",
      `report.publish differs from the frozen revision in ${mismatches.join(", ")}`,
      mismatches,
    );
  }
}
