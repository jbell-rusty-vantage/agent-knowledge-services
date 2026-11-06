import { type ComponentDatabase, componentError } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import type { AuthScope } from "@aiengineer/knowledge-research-core";
import { type DispatchReceiptState, expectedMarkerDigest, receiptState } from "./admission.js";
import type { BksExecutorClient } from "./client.js";
import {
  type Acknowledgment,
  BKS_MARKER_DIGEST_V1,
  INTENT_MARKER_V2,
  KS_MARKER_SCHEME,
  type Marker,
} from "./contracts.js";
import { jcsDigest } from "./jcs.js";

/**
 * Verified acknowledgment (design section 7): the BKS consumer applies the effect and its marker in one Neo4j
 * transaction and acknowledges in PostgreSQL; KS treats the component row (`state`, `ack_digest`) as the truth and
 * confirms it against the principal-scoped marker read. A receipt moves `pending_dispatch -> applied` ONLY after a
 * verified acknowledgment; a marker without a verified acknowledgment stays `pending_dispatch` (graph applied, not
 * acknowledged) and a revoked row is `revoked` whatever the graph holds (official reads exclude it).
 */
export interface OutboxRowView {
  readonly dispatchId: string;
  readonly effectKey: string;
  readonly targetBinding: string;
  readonly payloadDigest: string;
  readonly state: string;
  readonly attempts: number;
  readonly ackDigest: string | null;
  readonly lastError: string | null;
  readonly boundEffectDigest: string | null;
  readonly useDecisionId: string | null;
  readonly revocationEpoch: number | null;
  readonly markerScheme: string | null;
  readonly expectedMarkerDigest: string | null;
  /** The acknowledgment record the target stored with its acknowledgment (component 2.2.0 `ack_record`). */
  readonly ackRecord: Record<string, unknown> | null;
}

export interface OutboxReader {
  row(scope: AuthScope, dispatchId: string): Promise<OutboxRowView | null>;
}

/** Reader-role view of `knowledge_verification.dispatch_outbox`. */
export class PostgresOutboxReader implements OutboxReader {
  constructor(private readonly db: ComponentDatabase) {}

  async row(scope: AuthScope, dispatchId: string): Promise<OutboxRowView | null> {
    return this.db.transaction(
      { tenantId: scope.tenant, role: "knowledge_verification_reader", readOnly: true },
      async (c) => {
        try {
          const res = await c.query<Record<string, unknown>>(
            "select * from knowledge_verification.dispatch_outbox where tenant_id = $1 and dispatch_id = $2",
            [scope.tenant, dispatchId],
          );
          const r = res.rows[0];
          if (r === undefined) return null;
          const text = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
          return {
            dispatchId: String(r.dispatch_id),
            effectKey: String(r.effect_key),
            targetBinding: String(r.target_binding),
            payloadDigest: String(r.payload_digest),
            state: String(r.state),
            attempts: Number(r.attempts),
            ackDigest: text("ack_digest"),
            lastError: text("last_error"),
            boundEffectDigest: text("bound_effect_digest"),
            useDecisionId: text("use_decision_id"),
            revocationEpoch:
              r.revocation_epoch === null || r.revocation_epoch === undefined ? null : Number(r.revocation_epoch),
            markerScheme: text("marker_scheme"),
            expectedMarkerDigest: text("expected_marker_digest"),
            ackRecord:
              r.ack_record && typeof r.ack_record === "object" ? (r.ack_record as Record<string, unknown>) : null,
          };
        } catch (error) {
          throw componentError(error);
        }
      },
    );
  }
}

export interface DeliveryResult {
  readonly state: DispatchReceiptState;
  readonly dispatchId: string;
  /** The consumer's acknowledgment record for this dispatch when this call triggered it (null on pure reconciliation). */
  readonly ack: Acknowledgment | null;
  readonly row: OutboxRowView;
  readonly marker: Marker | null;
  /** True when a native marker of this effect exists (the graph holds the effect), acknowledged or not. */
  readonly graphApplied: boolean;
  readonly verified: boolean;
  /** Why an acknowledged row did not verify, or why a pending row is pending (stable codes). */
  readonly findings: readonly string[];
}

/** Checks binding the component row, its acknowledgment and the native marker to one exact effect. */
export function verifyAcknowledgment(tenantId: string, row: OutboxRowView, marker: Marker | null): readonly string[] {
  const findings: string[] = [];
  if (row.state !== "acknowledged" || row.ackDigest === null) findings.push("NOT_ACKNOWLEDGED");
  if (row.markerScheme === KS_MARKER_SCHEME) {
    if (
      row.boundEffectDigest === null ||
      row.useDecisionId === null ||
      row.revocationEpoch === null ||
      row.expectedMarkerDigest === null
    ) {
      findings.push("OUTBOX_BINDING_INCOMPLETE");
    } else {
      const recomputed = expectedMarkerDigest({
        tenantId,
        dispatchId: row.dispatchId,
        effectKey: row.effectKey,
        boundEffectDigest: row.boundEffectDigest,
        useDecisionId: row.useDecisionId,
        revocationEpoch: row.revocationEpoch,
      });
      if (recomputed !== row.expectedMarkerDigest) findings.push("EXPECTED_MARKER_DIGEST_MISMATCH");
      if (row.ackDigest !== null && row.ackDigest !== row.expectedMarkerDigest)
        findings.push("ACK_NOT_EXPECTED_MARKER");
    }
  } else if (row.markerScheme === BKS_MARKER_DIGEST_V1) {
    // BKS-native scheme: the component verified sha256(JCS {format, payloadDigest = payload_digest, planDigest}).
    const planDigest = row.ackRecord?.planDigest;
    if (
      typeof planDigest !== "string" ||
      row.ackDigest !== jcsDigest({ format: BKS_MARKER_DIGEST_V1, payloadDigest: row.payloadDigest, planDigest })
    ) {
      findings.push("ACK_NOT_BKS_MARKER");
    }
    if (marker !== null && row.ackDigest !== marker.markerDigest) findings.push("ACK_NOT_MARKER");
  } else if (row.markerScheme !== null) {
    findings.push(`MARKER_SCHEME_UNKNOWN:${row.markerScheme}`);
  }
  if (marker === null) {
    findings.push("MARKER_NOT_FOUND");
    return findings;
  }
  if (marker.status !== "applied") findings.push(`MARKER_STATUS:${marker.status}`);
  if (marker.markerSchemaVersion !== INTENT_MARKER_V2) findings.push("MARKER_SCHEMA");
  if (marker.effectKey !== row.effectKey) findings.push("MARKER_EFFECT_KEY");
  if (row.boundEffectDigest !== null && marker.boundEffectDigest !== row.boundEffectDigest)
    findings.push("MARKER_BOUND_EFFECT");
  if (row.useDecisionId !== null && marker.useDecisionRef !== row.useDecisionId) findings.push("MARKER_USE_DECISION");
  // BKS self-consistency: the native marker digest binds the applied payload and plan.
  if (
    !marker.markerDigest ||
    !marker.payloadDigest ||
    !marker.planDigest ||
    marker.markerDigest !==
      jcsDigest({ format: BKS_MARKER_DIGEST_V1, payloadDigest: marker.payloadDigest, planDigest: marker.planDigest })
  ) {
    findings.push("MARKER_DIGEST_UNVERIFIED");
  }
  // Rows without the 2.2.0 expected-marker scheme are acknowledged with the native marker digest itself.
  if (row.markerScheme === null && row.ackDigest !== null && row.ackDigest !== marker.markerDigest)
    findings.push("ACK_NOT_MARKER");
  return findings;
}

export interface DeliveryOptions {
  readonly outbox: OutboxReader;
  readonly executor: BksExecutorClient;
  /** The served schema release pin of v3 reads. */
  readonly schemaReleaseDigest: string;
  readonly consumeLimit?: number;
}

export class BiotechGraphDelivery {
  constructor(private readonly options: DeliveryOptions) {}

  /** Push-trigger the BKS consumer for the tenant, then reconcile this dispatch from the component row and the marker. */
  async deliver(scope: AuthScope, dispatchId: string): Promise<DeliveryResult> {
    const report = await this.options.executor.consume(scope.tenant, this.options.consumeLimit ?? 10);
    const ack = report.results.find((r) => r.dispatchId === dispatchId) ?? null;
    return this.reconcile(scope, dispatchId, ack);
  }

  /** Receipt-first reconciliation: never trusts the consumer's report alone; reads the row, then the marker. */
  async reconcile(scope: AuthScope, dispatchId: string, ack: Acknowledgment | null = null): Promise<DeliveryResult> {
    const row = await this.options.outbox.row(scope, dispatchId);
    if (row === null) throw new Error(`DISPATCH_NOT_FOUND: ${dispatchId}`);
    const { marker } = await this.options.executor.marker(
      { effectKey: row.effectKey },
      { schemaReleaseDigest: this.options.schemaReleaseDigest },
      `ks-ack-${dispatchId.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 100)}`,
    );
    const graphApplied = marker !== null && marker.status === "applied";
    const state = receiptState(row.state);
    if (state !== "applied") {
      const findings = [
        `ROW_${row.state.toUpperCase()}`,
        ...(row.lastError ? [`LAST_ERROR:${row.lastError.split(":")[0]}`] : []),
      ];
      return { state, dispatchId, ack, row, marker, graphApplied, verified: false, findings };
    }
    const findings = verifyAcknowledgment(scope.tenant, row, marker);
    // An acknowledged row that does not verify is never reported as applied.
    return {
      state: findings.length === 0 ? "applied" : "pending_dispatch",
      dispatchId,
      ack,
      row,
      marker,
      graphApplied,
      verified: findings.length === 0,
      findings,
    };
  }
}
