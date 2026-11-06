import type { AuthScope } from "@aiengineer/knowledge-research-core";
import { BksExecutorError, type BksExecutorClient } from "./client.js";
import { type Eligibility, GRAPH_REPORT_KIND, READ_INTENT_V3, type ReadResultV3 } from "./contracts.js";
import type { FrozenReportBinding } from "./report.js";

/**
 * Exact official reads through the BKS executor (v3, `use.officialUse: true`): BKS revalidates every returned record
 * against the authoritative PostgreSQL decision and epoch; the binding additionally (1) recomputes the result digest
 * (client), (2) serves a report only when its eligibility item is `eligible` and served, and (3) checks the graph
 * Report carries exactly the frozen revision's kind and body / ledger / structured-body digests. Anything else is a
 * typed non-eligible outcome; authority unavailable holds.
 */
export type OfficialReadState =
  | "eligible"
  | "revoked"
  | "stale"
  | "unadmitted"
  | "held"
  | "not_found"
  | "digest_mismatch";

export interface OfficialReportRead {
  readonly state: OfficialReadState;
  readonly reportUid: string | null;
  readonly report: Record<string, unknown> | null;
  readonly eligibility: Eligibility | null;
  readonly mismatches: readonly string[];
  readonly resultDigest: string | null;
}

let sequence = 0;
function intentId(prefix: string): string {
  sequence = (sequence + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

export interface OfficialRevisionRead {
  /** `eligible` when at least one graph Report of the revision is served as eligible with the exact digests. */
  readonly state: OfficialReadState;
  readonly reports: readonly OfficialReportRead[];
  readonly resultDigest: string | null;
}

const STATE_ORDER: readonly OfficialReadState[] = [
  "eligible",
  "held",
  "digest_mismatch",
  "stale",
  "revoked",
  "unadmitted",
  "not_found",
];

export class BiotechOfficialReads {
  constructor(
    private readonly executor: BksExecutorClient,
    private readonly schemaReleaseDigest: string,
  ) {}

  /** The graph Report uids materializing one KS report revision (non-official lookup; identifiers only). */
  async findReportUids(reportRevisionId: string, limit = 20): Promise<string[]> {
    const { result } = await this.executor.read({
      schemaVersion: READ_INTENT_V3,
      intentId: intentId("ks-find-report"),
      pins: { schemaReleaseDigest: this.schemaReleaseDigest },
      purpose: "Knowledge Services lookup of the graph Reports of a frozen report revision",
      use: { officialUse: false },
      operations: [
        { opId: "find", op: "list", nodeType: "Report", where: { reportRevisionRef: reportRevisionId }, limit },
      ],
    });
    const uids: string[] = [];
    for (const row of result.parts[0]?.rows ?? []) {
      const node = (row.node ?? row.record ?? row) as Record<string, unknown>;
      if (typeof node.uid === "string") uids.push(node.uid);
    }
    return uids.sort();
  }

  /** Official read of every graph Report of a frozen revision, each verified against that revision. */
  async report(
    _scope: AuthScope,
    input: {
      readonly expected: FrozenReportBinding;
      readonly useName: string;
      readonly audience: string;
      readonly reportUids?: readonly string[];
    },
  ): Promise<OfficialRevisionRead> {
    const uids = input.reportUids ?? (await this.findReportUids(input.expected.reportRevisionId));
    if (uids.length === 0) return { state: "not_found", reports: [], resultDigest: null };
    if (uids.length > 20)
      throw new BksExecutorError("BKS_RESPONSE_INVALID", "more than 20 graph Reports name one revision", 200);
    const { result } = await this.executor.read({
      schemaVersion: READ_INTENT_V3,
      intentId: intentId("ks-official-report"),
      pins: { schemaReleaseDigest: this.schemaReleaseDigest },
      purpose: "Knowledge Services official read of an admitted report",
      use: { officialUse: true, useName: input.useName, audience: input.audience },
      operations: uids.map((reportUid, i) => ({ opId: `rep-${i}`, op: "report", reportUid })),
    });
    const reports = uids.map((uid, i) => judgeReport(result, uid, input.expected, `rep-${i}`));
    const state = STATE_ORDER.find((s) => reports.some((r) => r.state === s)) ?? "not_found";
    return { state, reports, resultDigest: result.digests.resultDigest };
  }
}

export function judgeReport(
  result: ReadResultV3,
  reportUid: string,
  expected: FrozenReportBinding,
  opId = "rep",
): OfficialReportRead {
  const base = { reportUid, eligibility: result.eligibility, resultDigest: result.digests.resultDigest };
  const el = result.eligibility;
  if (el === null) return { ...base, state: "held", report: null, mismatches: ["NOT_OFFICIAL"] };
  if (el.state === "authority_unavailable" || !el.authority.available)
    return { ...base, state: "held", report: null, mismatches: [] };
  const item = el.items.find((i) => i.opId === opId && i.recordUid === reportUid);
  if (item === undefined) return { ...base, state: "unadmitted", report: null, mismatches: ["NO_ELIGIBILITY_ITEM"] };
  if (item.state !== "eligible" || !item.served) {
    const state: OfficialReadState =
      item.state === "authority_unavailable" ? "held" : item.state === "eligible" ? "held" : item.state;
    return { ...base, state, report: null, mismatches: [] };
  }
  const row = result.parts.find((p) => p.opId === opId)?.rows[0];
  const report = (row?.report ?? null) as Record<string, unknown> | null;
  if (report === null) return { ...base, state: "not_found", report: null, mismatches: [] };
  const want: Record<string, string> = {
    reportKind: GRAPH_REPORT_KIND[expected.reportKind],
    reportKindRef: expected.reportKindRef,
    reportRevisionRef: expected.reportRevisionId,
    bodyDigest: expected.bodyDigest,
    ledgerDigest: expected.ledgerDigest,
    structuredBodyDigest: expected.structuredBodyDigest,
  };
  const mismatches = Object.entries(want)
    .filter(([key, value]) => report[key] !== value)
    .map(([key]) => key);
  return {
    ...base,
    state: mismatches.length === 0 ? "eligible" : "digest_mismatch",
    report: mismatches.length === 0 ? report : null,
    mismatches,
  };
}
