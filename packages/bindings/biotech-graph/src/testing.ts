import type { ComponentDatabase, SqlClient } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import type { FetchLike } from "./client.js";
import {
  ADMISSION_ACK_V1,
  ADMISSION_CONSUME_REPORT_V1,
  ADMISSION_DISPATCH_V1,
  ADMISSION_PAYLOAD_MEDIA_TYPE,
  BKS_MARKER_DIGEST_V1,
  type DispatchOutcome,
  ELIGIBILITY_V1,
  INTENT_MARKER_V2,
  READ_INTENT_V3,
  READ_RESULT_DIGEST_V2,
  READ_RESULT_V3,
  TARGET_BINDING,
} from "./contracts.js";
import { jcs, jcsDigest, sha256Bytes } from "./jcs.js";

/**
 * T0 conformance consumer (NOT a graph qualification): an in-process stand-in for the BKS executor's
 * `POST /kg/admission/dispatch/consume` and v3 `POST /kg/read` (`marker`, `list Report`, official `report`) that runs
 * against the REAL knowledge_verification component as the outbox worker and keeps its "graph" in memory. It follows
 * the D1 consumer order (claim -> payload custody + digest -> row revoked -> existing marker = duplicate -> apply
 * effect + marker atomically -> acknowledge) and acknowledges with the component's expected marker digest
 * (`dispatch_outbox.expected_marker_digest`, ks-intent-marker.v1), which is the 2.2.0 acknowledgment contract.
 * Faults: graph unavailable (fail_dispatch, retry), native rollback (nothing written, fail_dispatch), lost ack.
 */
export interface StubMarker {
  markerKey: string;
  effectKey: string;
  status: "applied";
  intentDigest: string;
  planRef: string;
  planDigest: string;
  receiptId: string;
  graphRevision: number;
  markerSchemaVersion: typeof INTENT_MARKER_V2;
  dispatchId: string;
  markerDigest: string;
  payloadDigest: string;
  boundEffectDigest: string;
  useDecisionRef: string;
  useDecisionDigest: string;
  revocationEpoch: number;
  appliedAt: string;
}

export interface StubReport {
  uid: string;
  reportRevisionRef: string;
  reportKind: string;
  reportKindRef: string;
  bodyDigest: string;
  ledgerDigest: string;
  structuredBodyDigest: string;
  useDecisionRef: string;
  useDecisionDigest: string;
  effectKey: string;
}

export interface StubFaults {
  graphUnavailable?: boolean;
  /** The next apply fails after the effect write and before the marker (the whole native transaction rolls back). */
  rollbackNextApply?: boolean;
  /** Runs once between the claim and the processing of the claimed rows (a revocation racing the consumer). */
  afterClaim?: () => Promise<void>;
  /** The next acknowledgment call is lost after the graph commit. */
  loseNextAck?: boolean;
}

export class StubBksExecutor {
  readonly markers = new Map<string, StubMarker>();
  readonly reports = new Map<string, StubReport>();
  readonly faults: StubFaults = {};
  graphRevision = 0;
  calls = 0;

  constructor(
    private readonly db: ComponentDatabase,
    private readonly scope: { installationId: string; applicationId: string; tenantId: string },
    private readonly token = "stub-service-token",
  ) {}

  private worker<T>(work: (c: SqlClient) => Promise<T>): Promise<T> {
    return this.db.transaction({ tenantId: this.scope.tenantId, role: "knowledge_verification_outbox_worker" }, work);
  }

  readonly fetch: FetchLike = async (url, init) => {
    this.calls += 1;
    if (init.headers.authorization !== `Bearer ${this.token}`)
      return json(401, { ok: false, code: "BKS_UNAUTHORIZED", message: "token" });
    const path = new URL(url).pathname;
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (path === "/kg/admission/dispatch/consume") {
      if (body.tenantId !== this.scope.tenantId)
        return json(403, { ok: false, code: "BKS_FORBIDDEN_SCOPE", message: "tenant" });
      return json(200, await this.consume(Number(body.limit ?? 10)));
    }
    if (path === "/kg/read") return json(200, await this.read(body));
    return json(404, { ok: false, code: "NOT_FOUND", message: path });
  };

  private async consume(limit: number) {
    const startedAt = new Date().toISOString();
    const rows = await this.worker(
      async (c) =>
        (
          await c.query<Record<string, unknown>>(
            "select * from knowledge_verification.claim_dispatches($1, $2, now(), $3)",
            [this.scope.tenantId, limit, TARGET_BINDING],
          )
        ).rows,
    );
    // UPDATE ... RETURNING has no order; process in enqueue order like the BKS consumer (created_at, dispatch id).
    rows.sort(
      (a, b) =>
        Number(a.created_at) - Number(b.created_at) || String(a.dispatch_id).localeCompare(String(b.dispatch_id)),
    );
    const hook = this.faults.afterClaim;
    if (hook) {
      delete this.faults.afterClaim;
      await hook();
    }
    const results = [];
    for (const row of rows) results.push(await this.process(row));
    return {
      schemaVersion: ADMISSION_CONSUME_REPORT_V1,
      tenantId: this.scope.tenantId,
      claimed: rows.length,
      results,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  private ack(row: Record<string, unknown>, outcome: DispatchOutcome, extra: Record<string, unknown> = {}) {
    return {
      schemaVersion: ADMISSION_ACK_V1,
      tenantId: this.scope.tenantId,
      dispatchId: String(row.dispatch_id),
      effectKey: String(row.effect_key),
      outcome,
      markerDigest: null,
      payloadDigest: String(row.payload_digest),
      planDigest: null,
      receiptId: null,
      graph: { bookmark: null, graphRevision: null, markerKey: null },
      appliedAt: null,
      componentState: null,
      acknowledged: false,
      reason: null,
      retryAfterSeconds: null,
      processedAt: new Date().toISOString(),
      ...extra,
    };
  }

  private async park(row: Record<string, unknown>, outcome: DispatchOutcome, code: string) {
    const state = await this.worker(async (c) => {
      const r = await c.query<{ state: string }>(
        "select state from knowledge_verification.fail_dispatch($1, $2, $3, interval '0 seconds')",
        [this.scope.tenantId, row.dispatch_id, `${code}: stub consumer`],
      );
      return r.rows[0]?.state ?? null;
    });
    return this.ack(row, outcome, {
      reason: { code, message: "stub consumer" },
      componentState: state,
      retryAfterSeconds: 0,
    });
  }

  /** Terminal not-applied settlement (component 2.2.0 settle_dispatch). */
  private async settle(row: Record<string, unknown>, outcome: "revoked" | "refused", code: string) {
    const state = await this.worker(
      async (c) =>
        (
          await c.query<{ state: string }>(
            "select state from knowledge_verification.settle_dispatch($1, $2, $3, $4::jsonb)",
            [this.scope.tenantId, row.dispatch_id, outcome, JSON.stringify({ reason: code, consumer: "stub" })],
          )
        ).rows[0]?.state ?? null,
    );
    return this.ack(row, outcome, { componentState: state, reason: { code, message: "stub consumer" } });
  }

  private async acknowledge(row: Record<string, unknown>, outcome: "applied" | "duplicate", marker: StubMarker) {
    const extra = {
      markerDigest: marker.markerDigest,
      planDigest: marker.planDigest,
      receiptId: marker.receiptId,
      appliedAt: marker.appliedAt,
      graph: { bookmark: null, graphRevision: marker.graphRevision, markerKey: marker.markerKey },
    };
    if (this.faults.loseNextAck) {
      this.faults.loseNextAck = false;
      return this.ack(row, outcome, {
        ...extra,
        reason: { code: "ACK_PENDING", message: "lost acknowledgment (stub fault)" },
      });
    }
    try {
      const state = await this.worker(
        async (c) =>
          (
            await c.query<{ state: string }>(
              "select state from knowledge_verification.acknowledge_dispatch($1, $2, $3, now(), $4::jsonb)",
              [
                this.scope.tenantId,
                row.dispatch_id,
                row.expected_marker_digest,
                JSON.stringify({
                  outcome: "applied",
                  payloadDigest: marker.payloadDigest,
                  planDigest: marker.planDigest,
                  markerDigest: marker.markerDigest,
                  graphTxRef: `stub-rev-${marker.graphRevision}`,
                }),
              ],
            )
          ).rows[0]?.state,
      );
      return this.ack(row, outcome, { ...extra, acknowledged: true, componentState: state ?? null });
    } catch (error) {
      const code = /DISPATCH_REVOKED/.test((error as Error).message) ? "REVOKED_AFTER_APPLY" : "ACK_PENDING";
      return this.ack(row, code === "REVOKED_AFTER_APPLY" ? "revoked" : outcome, {
        ...extra,
        reason: { code, message: (error as Error).message.slice(0, 200) },
      });
    }
  }

  private async process(row: Record<string, unknown>) {
    if (row.target_binding !== TARGET_BINDING) return this.park(row, "refused", "TARGET_BINDING_MISMATCH");
    const artifact = await this.worker(
      async (c) =>
        (
          await c.query<{ inline_bytes: Buffer | null; media_type: string }>(
            "select inline_bytes, media_type from knowledge_verification.artifact_custody where tenant_id = $1 and digest = $2",
            [this.scope.tenantId, row.payload_digest],
          )
        ).rows[0],
    );
    if (!artifact?.inline_bytes || artifact.media_type !== ADMISSION_PAYLOAD_MEDIA_TYPE)
      return this.park(row, "refused", "PAYLOAD_NOT_FOUND");
    if (sha256Bytes(artifact.inline_bytes) !== row.payload_digest)
      return this.park(row, "refused", "PAYLOAD_DIGEST_MISMATCH");
    const payload = JSON.parse(artifact.inline_bytes.toString("utf8")) as Record<string, unknown>;
    if (
      payload.schemaVersion !== ADMISSION_DISPATCH_V1 ||
      payload.dispatchId !== row.dispatch_id ||
      payload.effectKey !== row.effect_key
    )
      return this.park(row, "refused", "PAYLOAD_ROW_MISMATCH");
    if (sha256Bytes(Buffer.from(jcs(payload.intent), "utf8")) !== payload.semanticPayloadDigest)
      return this.park(row, "refused", "NATIVE_PAYLOAD_MISMATCH");
    const current = await this.worker(
      async (c) =>
        (
          await c.query<{ state: string }>(
            "select state from knowledge_verification.dispatch_outbox where tenant_id = $1 and dispatch_id = $2",
            [this.scope.tenantId, row.dispatch_id],
          )
        ).rows[0],
    );
    if (current?.state === "revoked") return this.settle(row, "revoked", "DISPATCH_REVOKED");
    const markerKey = `${this.scope.installationId}/${this.scope.applicationId}/${this.scope.tenantId}/${String(row.effect_key)}`;
    const existing = this.markers.get(markerKey);
    if (existing) return this.acknowledge(row, "duplicate", existing);
    if (this.faults.graphUnavailable) return this.park(row, "deferred", "GRAPH_UNAVAILABLE");
    // One native transaction: report + marker are written together or not at all.
    if (this.faults.rollbackNextApply) {
      this.faults.rollbackNextApply = false;
      return this.park(row, "deferred", "NATIVE_ROLLBACK");
    }
    const intentDigest = jcsDigest(payload.intent);
    const planDigest = jcsDigest({ stubPlan: intentDigest, decidedAt: payload.decidedAt });
    const useDecision = payload.useDecision as { id: string; digest: string };
    this.graphRevision += 1;
    const marker: StubMarker = {
      markerKey,
      effectKey: String(row.effect_key),
      status: "applied",
      intentDigest,
      planRef: `plan-${planDigest.slice(7, 23)}`,
      planDigest,
      receiptId: `rcpt-${planDigest.slice(7, 23)}`,
      graphRevision: this.graphRevision,
      markerSchemaVersion: INTENT_MARKER_V2,
      dispatchId: String(row.dispatch_id),
      markerDigest: jcsDigest({ format: BKS_MARKER_DIGEST_V1, payloadDigest: row.payload_digest, planDigest }),
      payloadDigest: String(row.payload_digest),
      boundEffectDigest: String(payload.boundEffectDigest),
      useDecisionRef: useDecision.id,
      useDecisionDigest: useDecision.digest,
      revocationEpoch: Number(row.revocation_epoch ?? 0),
      appliedAt: new Date().toISOString(),
    };
    const intent = payload.intent as { proposals?: Record<string, unknown>[] };
    const publish = intent.proposals?.find((p) => p.kind === "report.publish");
    if (publish) {
      const uid = `rep-${planDigest.slice(7, 23)}`;
      this.reports.set(uid, {
        uid,
        reportRevisionRef: String(publish.reportRevisionRef),
        reportKind: String(publish.reportKind),
        reportKindRef: String(publish.reportKindRef),
        bodyDigest: String(publish.bodyDigest),
        ledgerDigest: String(publish.ledgerDigest),
        structuredBodyDigest: String(publish.structuredBodyDigest),
        useDecisionRef: useDecision.id,
        useDecisionDigest: useDecision.digest,
        effectKey: String(row.effect_key),
      });
    }
    this.markers.set(markerKey, marker);
    return this.acknowledge(row, "applied", marker);
  }

  /** Eligibility of decisions as the BKS read path computes it (SELECT over use_decision / invalidation_affected / epoch). */
  private async eligibility(refs: { opId: string; recordUid: string; id: string; digest: string }[]) {
    return this.worker(async (c) => {
      const epoch = Number(
        (
          await c.query<{ e: string }>("select knowledge_verification.current_revocation_epoch($1)::text as e", [
            this.scope.tenantId,
          ])
        ).rows[0]?.e ?? 0,
      );
      const items = [];
      for (const ref of refs) {
        const d = (
          await c.query<{ digest: string; disposition: string; revocation_epoch: string; invalidated: boolean }>(
            `select u.digest, u.disposition, u.revocation_epoch::text, exists (select 1 from knowledge_verification.invalidation_affected a
              where a.tenant_id = u.tenant_id and a.affected_kind = 'use_decision' and a.affected_id = u.use_decision_id) as invalidated
             from knowledge_verification.use_decision u where u.tenant_id = $1 and u.use_decision_id = $2`,
            [this.scope.tenantId, ref.id],
          )
        ).rows[0];
        const state =
          d === undefined
            ? "unadmitted"
            : d.invalidated || d.digest !== ref.digest || d.disposition !== "admitted"
              ? "revoked"
              : "eligible";
        items.push({
          opId: ref.opId,
          recordUid: ref.recordUid,
          useDecisionId: ref.id,
          useDecisionDigest: ref.digest,
          state,
          served: state === "eligible",
          reason: null,
          decisionEpoch: d ? Number(d.revocation_epoch) : null,
          disposition: d?.disposition ?? null,
          expiresAt: null,
        });
      }
      const excluded = items.filter((i) => !i.served).length;
      return {
        format: ELIGIBILITY_V1,
        checkedAt: new Date().toISOString(),
        authoritativeEpoch: epoch,
        decisionEpoch: null,
        state: excluded === 0 ? "eligible" : "revoked",
        authority: {
          component: "knowledge_verification",
          available: true,
          tenantId: this.scope.tenantId,
          detail: null,
        },
        items,
        excluded,
        held: 0,
      };
    });
  }

  private async read(intent: Record<string, unknown>) {
    if (intent.schemaVersion !== READ_INTENT_V3) throw new Error("stub reads v3 only");
    const use = (intent.use ?? {}) as { officialUse?: boolean; useName?: string; audience?: string };
    const official = use.officialUse === true;
    const refs: { opId: string; recordUid: string; id: string; digest: string }[] = [];
    const parts = ((intent.operations as Record<string, unknown>[]) ?? []).map((op) => {
      const opId = String(op.opId);
      let rows: Record<string, unknown>[] = [];
      if (op.op === "marker") {
        const m = [...this.markers.values()].find((x) =>
          op.effectKey
            ? x.effectKey === op.effectKey
            : op.dispatchId
              ? x.dispatchId === op.dispatchId
              : x.markerDigest === op.markerDigest,
        );
        rows = m ? [{ marker: m, finishedAt: m.appliedAt }] : [];
        if (m) refs.push({ opId, recordUid: m.markerKey, id: m.useDecisionRef, digest: m.useDecisionDigest });
      } else if (op.op === "list") {
        const where = (op.where ?? {}) as Record<string, unknown>;
        rows = [...this.reports.values()]
          .filter((r) => r.reportRevisionRef === where.reportRevisionRef)
          .map((r) => ({ node: { uid: r.uid, reportRevisionRef: r.reportRevisionRef } }));
      } else if (op.op === "report") {
        const r = this.reports.get(String(op.reportUid));
        rows = r
          ? [
              {
                report: { ...r },
                admission: [
                  { effectKey: r.effectKey, useDecisionRef: r.useDecisionRef, useDecisionDigest: r.useDecisionDigest },
                ],
              },
            ]
          : [];
        if (r) refs.push({ opId, recordUid: r.uid, id: r.useDecisionRef, digest: r.useDecisionDigest });
      }
      return {
        opId,
        op: String(op.op),
        status: rows.length ? "ok" : "empty",
        reasons: [] as unknown[],
        columns: rows.length ? Object.keys(rows[0] as object) : [],
        rows,
        rowCount: rows.length,
        truncations: [] as unknown[],
      };
    });
    let eligibility: Awaited<ReturnType<StubBksExecutor["eligibility"]>> | null = null;
    if (official) {
      eligibility = await this.eligibility(refs);
      const excludedOps = new Set(eligibility.items.filter((i) => !i.served).map((i) => i.opId));
      for (const p of parts) {
        if (excludedOps.has(p.opId)) {
          p.rows = [];
          p.rowCount = 0;
          p.status = "forbidden";
        }
      }
    }
    const status = "ok";
    const digestParts = parts.map((p) => ({
      opId: p.opId,
      op: p.op,
      status: p.status,
      reasons: p.reasons,
      columns: p.columns,
      rows: p.rows,
      truncations: p.truncations,
    }));
    const resultDigest = eligibility
      ? jcsDigest({
          format: READ_RESULT_DIGEST_V2,
          status,
          reasons: [],
          ordering: "operation",
          parts: digestParts,
          eligibility: {
            state: eligibility.state,
            authoritativeEpoch: eligibility.authoritativeEpoch,
            items: eligibility.items,
          },
        })
      : jcsDigest({
          format: "bks-read-result-digest.v1",
          status,
          reasons: [],
          ordering: "operation",
          parts: digestParts,
        });
    const zero = `sha256:${"0".repeat(64)}`;
    return {
      schemaVersion: READ_RESULT_V3,
      intentId: intent.intentId,
      intentKind: READ_INTENT_V3,
      status,
      reasons: [],
      parts,
      ordering: "operation",
      pins: {
        releaseId: "stub",
        schemaReleaseDigest: (intent.pins as { schemaReleaseDigest: string }).schemaReleaseDigest,
      },
      digests: { queryDigest: zero, resultDigest, receiptDigest: zero },
      use: { officialUse: official, useName: use.useName ?? null, audience: use.audience ?? null },
      eligibility,
    };
  }
}

function json(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return Promise.resolve({ status, text: () => Promise.resolve(text) });
}
