import type { OperationHandle, Ref } from "@aiengineer/knowledge-operation-protocol";
import type { Interval } from "../records/common.js";
import type { StructuredBody } from "../records/report.js";
import type { DerivedProposals } from "../report/derive.js";
import type { AuthScope } from "./scope.js";

/** What a producer registers; the service renders, freezes, builds the ledger and mints the revision. */
export interface ReportDraft {
  readonly kind: Ref<"report_kind">;
  readonly task: Ref<"task">;
  readonly structuredBody: StructuredBody;
  readonly assertions: readonly Ref<"assertion">[];
  readonly timeCoverage: {
    readonly world: Interval | null;
    readonly observed: Interval | null;
    readonly knowledgeHead: string | null;
  };
  readonly supersedes: Ref<"report"> | null;
}

/** `ReportService` (design §4). `assess` always runs under the host, never on a producer claim. */
export interface ReportService {
  register(scope: AuthScope, input: ReportDraft): Promise<Ref<"report">>;
  assess(scope: AuthScope, report: Ref<"report">, task: Ref<"task">): Promise<OperationHandle>;
  derive(scope: AuthScope, report: Ref<"report">, mapping: Ref<"mapping">): Promise<DerivedProposals>;
}
