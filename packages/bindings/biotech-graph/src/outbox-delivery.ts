import type { Delivery, OperationReceipt } from "@aiengineer/knowledge-operation-protocol";
import type { ComponentDatabase } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import type { DeliveryReader } from "@aiengineer/knowledge-host/knowledge-operation";
import type { AuthScope } from "@aiengineer/knowledge-research-core";

const READER = "knowledge_verification_reader" as const;

/**
 * Delivery state of a `pending_dispatch` effect, read from the component `dispatch_outbox` row its receipt names
 * (`nativeReceiptRef.id` = the outbox dispatch id). `applied` only for an acknowledged row whose ack digest equals the
 * row's expected marker digest (the verified acknowledgment, ks-intent-marker.v1); an acknowledged row that does not
 * verify reports `dispatched` (unresolved). `revoked` and `refused` are terminal not-applied (`revoked`).
 */
export class PostgresOutboxDelivery implements DeliveryReader {
  constructor(private readonly db: ComponentDatabase) {}

  async delivery(scope: AuthScope, receipt: OperationReceipt): Promise<Delivery | null> {
    const row = (
      await this.db.transaction({ tenantId: scope.tenant, role: READER, readOnly: true }, (c) =>
        c.query<{
          dispatch_id: string;
          target_binding: string;
          state: string;
          ack_digest: string | null;
          expected_marker_digest: string | null;
          acknowledged_at: Date | null;
          graph_tx_ref: string | null;
          effect_key: string;
        }>(
          `select dispatch_id, target_binding, state, ack_digest, expected_marker_digest, acknowledged_at, graph_tx_ref, effect_key
             from knowledge_verification.dispatch_outbox where tenant_id = $1 and dispatch_id = $2`,
          [scope.tenant, receipt.nativeReceiptRef.id],
        ),
      )
    ).rows[0];
    if (row === undefined || row.effect_key !== receipt.effect.effectKey) return null;
    const verified =
      row.state === "acknowledged" &&
      row.ack_digest !== null &&
      (row.expected_marker_digest === null || row.ack_digest === row.expected_marker_digest);
    const state: Delivery["state"] =
      row.state === "acknowledged"
        ? verified
          ? "applied"
          : "dispatched"
        : row.state === "revoked" || row.state === "refused"
          ? "revoked"
          : row.state === "failed"
            ? "failed"
            : row.state === "dispatched"
              ? "dispatched"
              : "pending";
    return {
      state,
      dispatchId: row.dispatch_id,
      targetBinding: row.target_binding,
      nativeState: row.state,
      ackDigest: row.ack_digest,
      ackedAt: row.acknowledged_at ? toInstant(row.acknowledged_at) : null,
      graphTxRef: row.graph_tx_ref,
      checkedAt: toInstant(new Date()),
    };
  }
}

function toInstant(date: Date): string {
  return date.toISOString().replace(/\.(\d*?)0+Z$/, (_m, d: string) => (d ? `.${d}Z` : "Z"));
}
