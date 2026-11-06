import {
  type JsonValue,
  type OperationHandle,
  OperationHandleSchema,
  type OperationState,
  type OperationStatus,
  type ProtocolErrorCode,
  type Ref,
  canonicalJson,
  digestCanonical,
  isTerminal,
  protocolError,
  sameRef,
} from "@aiengineer/knowledge-operation-protocol";
import { type AuthScope, type EvidenceFragment, recordRef } from "@aiengineer/knowledge-research-core";
import {
  type Clock,
  type ReportAssessment,
  type ResearchCoordinator,
  ResearchCoordinatorError,
} from "./coordinator.js";
import {
  type AuditorDiscovery,
  type OperationRecord,
  type OperationStore,
  OperationStoreError,
  REPORT_ASSESSMENT_SCHEMA_VERSION,
  type ReportAssessmentRecord,
  type ResearchBinding,
} from "./ports.js";

/** The binding-native operation name the K01 tool adapter selects for `report.assess` (design §4, §8). */
export const REPORT_ASSESS_OPERATION = "report.assess" as const;

export class ReportAssessmentError extends Error {
  readonly code: "SCOPE_DENIED" | "NOT_FOUND" | "REPORT_MISMATCH" | "EFFECT_CONFLICT";
  constructor(code: ReportAssessmentError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "ReportAssessmentError";
    this.code = code;
  }
}

export interface ReportAssessmentDependencies {
  readonly binding: ResearchBinding;
  readonly coordinator: ResearchCoordinator;
  readonly operations: OperationStore;
  readonly auditor: AuditorDiscovery;
  readonly clock: Clock;
  /** Polling hint for non-terminal states; clamped to K01's bounded 100 ms .. 300 s. */
  readonly retryAfterMs?: number;
  /** Evidence supplied to the auditor independently of the producer; defaults to none (the auditor retrieves its own). */
  readonly evidenceFor?: (scope: AuthScope, runId: string) => Promise<readonly EvidenceFragment[]>;
}

/**
 * The asynchronous `report.assess` operation at the application layer (design §4, SV-06). `start` records a durable
 * operation and returns a K01 `OperationHandle`; `status` returns the typed status with monotonic revision and bounded
 * retry-after; `cancel` is idempotent by cancel request id and stops new work; `run` executes the independent census
 * and report aggregation under the same run and moves to a terminal state. `held`/`rejected` are domain outcomes, not
 * failures. Transport-free: HTTP/MCP exposure is SV-16.
 */
export class ReportAssessmentService {
  private readonly retryAfterMs: number;

  constructor(private readonly deps: ReportAssessmentDependencies) {
    this.retryAfterMs = Math.min(300000, Math.max(100, deps.retryAfterMs ?? 1000));
  }

  async start(
    scope: AuthScope,
    input: { runId: string; reportRef: Ref<"report">; requestId: string },
  ): Promise<OperationHandle> {
    const context = await this.deps.binding.loadRunContext(scope, input.runId);
    if (context.report === null || !sameRef(recordRef("report", context.report.revision), input.reportRef)) {
      throw new ReportAssessmentError("REPORT_MISMATCH", `run ${input.runId} does not hold ${input.reportRef.id}`);
    }
    const request = { operation: REPORT_ASSESS_OPERATION, runId: input.runId, report: input.reportRef };
    const operationId = `op-assess-${digestCanonical({
      tenant: scope.tenant,
      application: scope.application,
      binding: scope.binding,
      operation: REPORT_ASSESS_OPERATION,
      requestId: input.requestId,
    }).slice(7, 39)}`;
    try {
      const record = await this.deps.operations.start(scope, {
        operationId,
        operation: REPORT_ASSESS_OPERATION,
        requestId: input.requestId,
        request: request as unknown as JsonValue,
        requestDigest: digestCanonical(request as unknown as JsonValue),
        runId: input.runId,
        subject: input.reportRef,
        retryAfterMs: this.retryAfterMs,
        at: this.deps.clock.now(),
      });
      return record.status.handle;
    } catch (error) {
      if (error instanceof OperationStoreError && error.code === "REQUEST_CONFLICT") {
        throw new ReportAssessmentError("EFFECT_CONFLICT", error.message);
      }
      throw error;
    }
  }

  async status(scope: AuthScope, handle: OperationHandle): Promise<OperationStatus> {
    return (await this.load(scope, handle)).status;
  }

  async cancel(scope: AuthScope, handle: OperationHandle, cancelRequestId: string): Promise<OperationStatus> {
    await this.load(scope, handle);
    const record = await this.deps.operations.cancel(scope, {
      operationId: handle.operationId,
      cancelRequestId,
      at: this.deps.clock.now(),
    });
    return record.status;
  }

  /** Execute (or resume) the operation. Safe to call repeatedly: a terminal operation returns its status unchanged. */
  async run(scope: AuthScope, handle: OperationHandle): Promise<OperationStatus> {
    let record = await this.load(scope, handle);
    if (isTerminal(record.status.state)) return record.status;
    if (record.status.state === "cancelling") return (await this.settleCancelled(scope, record)).status;
    if (record.status.state === "waiting_review") {
      // SV-07: resume only from the pending reviewer adjudication (waiting_review -> running | held | rejected). No
      // adjudication yet: still waiting. Approval resumes the assessment; it never waives the census or aggregation.
      const pending = record.status.pendingReviewRef;
      const adjudication = pending ? await this.deps.binding.loadAdjudication(scope, pending.id) : null;
      if (adjudication === null) return record.status;
      if (adjudication.outcome !== "approve") {
        const settled = await this.cas(scope, record, adjudication.outcome === "reject" ? "rejected" : "held");
        return settled?.status ?? this.status(scope, handle);
      }
      const resumed = await this.cas(scope, record, "running");
      if (resumed === null) return this.status(scope, handle);
      record = resumed;
    }
    if (record.status.state === "queued") {
      const claimed = await this.cas(scope, record, "running");
      if (claimed === null) return this.status(scope, handle); // another runner won the claim
      record = claimed;
    }
    const runId = record.runId;
    if (runId === null || record.subject === null) throw new ReportAssessmentError("NOT_FOUND", "operation has no run");

    let assessment: ReportAssessment;
    let context: Awaited<ReturnType<ResearchBinding["loadRunContext"]>>;
    try {
      context = await this.deps.binding.loadRunContext(scope, runId);
      const current = await this.load(scope, handle);
      if (current.status.state === "cancelling") return (await this.settleCancelled(scope, current)).status;
      record = current;
      if (context.state !== "sealed" && context.state !== "superseded") {
        await this.deps.coordinator.auditReport(scope, {
          runId,
          auditor: this.deps.auditor,
          evidence: (await this.deps.evidenceFor?.(scope, runId)) ?? [],
        });
      }
      // A sealed run cannot take new observations: aggregation then uses whatever census it sealed (or holds).
      assessment = await this.deps.coordinator.assessReport(scope, runId);
      if (!sameRef(assessment.report, record.subject as Ref<"report">)) {
        throw new ReportAssessmentError("REPORT_MISMATCH", "the run's report changed under the operation");
      }
    } catch (error) {
      return this.fail(scope, handle, error);
    }
    const latest = await this.load(scope, handle);
    const outcome = outcomeState(assessment);
    const revision = context.report?.revision;
    if (revision === undefined) return this.fail(scope, handle, new ReportAssessmentError("NOT_FOUND", "no report"));
    const census = assessment.census;
    const assessmentRecord: ReportAssessmentRecord = {
      schemaVersion: REPORT_ASSESSMENT_SCHEMA_VERSION,
      id: `assessment-${handle.operationId}`,
      tenant: scope.tenant,
      binding: scope.binding,
      report: assessment.report,
      runId,
      task: revision.task,
      kind: revision.kind,
      census:
        census.status === "assessed"
          ? { status: "assessed", observation: census.observation, holds: [...census.holds] }
          : census.status === "stale"
            ? { status: "stale", observation: census.observation, reason: census.reason }
            : { status: "not_run" },
      aggregate: assessment.aggregate,
      aggregateDigest: digestCanonical(assessment.aggregate as unknown as JsonValue),
      outcome: outcome as ReportAssessmentRecord["outcome"],
      assessedAt: this.deps.clock.now(),
    };
    const resultRef = await this.deps.binding.custody.put(
      scope,
      Buffer.from(canonicalJson(assessmentRecord as unknown as JsonValue), "utf8"),
      "application/json",
    );
    await this.deps.binding.recordAssessment(scope, {
      record: assessmentRecord,
      artifact: resultRef,
      operationId: handle.operationId,
    });
    const settled = await this.cas(scope, latest, outcome, { resultRef });
    return settled?.status ?? this.status(scope, handle);
  }

  private async load(scope: AuthScope, handle: OperationHandle): Promise<OperationRecord> {
    const parsed = OperationHandleSchema.parse(handle);
    if (
      parsed.tenant !== scope.tenant ||
      parsed.application !== scope.application ||
      parsed.binding !== scope.binding
    ) {
      throw new ReportAssessmentError("SCOPE_DENIED", "the handle names another tenant, application or binding");
    }
    const record = await this.deps.operations.get(scope, parsed.operationId);
    if (record === null || record.operation !== REPORT_ASSESS_OPERATION) {
      throw new ReportAssessmentError("NOT_FOUND", parsed.operationId);
    }
    return record;
  }

  /** Compare-and-set one transition; `null` when a concurrent writer already advanced the revision. */
  private async cas(
    scope: AuthScope,
    record: OperationRecord,
    to: OperationState,
    extra: { resultRef?: Ref | null; error?: ReturnType<typeof protocolError> | null } = {},
  ): Promise<OperationRecord | null> {
    try {
      return await this.deps.operations.transition(scope, {
        operationId: record.status.handle.operationId,
        expectedRevision: record.status.revision,
        to,
        at: this.deps.clock.now(),
        retryAfterMs: this.retryAfterMs,
        ...extra,
      });
    } catch (error) {
      if (error instanceof OperationStoreError && error.code === "REVISION_MISMATCH") return null;
      throw error;
    }
  }

  private async settleCancelled(scope: AuthScope, record: OperationRecord): Promise<OperationRecord> {
    return (await this.cas(scope, record, "cancelled")) ?? record;
  }

  private async fail(scope: AuthScope, handle: OperationHandle, error: unknown): Promise<OperationStatus> {
    const record = await this.load(scope, handle);
    const { state, code } = classify(error);
    const typed = protocolError({
      code,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      occurredAt: this.deps.clock.now(),
      correlation: { operationId: handle.operationId },
    });
    const settled = await this.cas(scope, record, state, { error: typed });
    return settled?.status ?? record.status;
  }
}

/**
 * Domain outcome of an assessment: complete -> succeeded (partial when optional weight is uncovered). Missing evidence
 * holds; only a contradiction or an L0 integrity failure on a required obligation rejects (design §1).
 */
function outcomeState(assessment: ReportAssessment): "succeeded" | "partial" | "held" | "rejected" {
  const { aggregate } = assessment;
  if (aggregate.complete) return aggregate.coveredWeight === aggregate.totalWeight ? "succeeded" : "partial";
  return aggregate.rejectingRequired.length > 0 ? "rejected" : "held";
}

/** Exact-revision integrity refusals are domain rejections; anything else is an infrastructure failure. */
function classify(error: unknown): { state: OperationState; code: ProtocolErrorCode } {
  if (error instanceof ResearchCoordinatorError) {
    if (error.code === "BODY_DIGEST_MISMATCH") return { state: "rejected", code: "EXACT_REVISION_UNAVAILABLE" };
    if (error.code === "SCHEMA_UNSUPPORTED") return { state: "rejected", code: "SCHEMA_UNSUPPORTED" };
  }
  if (error instanceof ReportAssessmentError && error.code === "REPORT_MISMATCH") {
    return { state: "rejected", code: "EXACT_REVISION_UNAVAILABLE" };
  }
  return { state: "failed", code: "INTERNAL" };
}
