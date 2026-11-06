import { deepFreeze } from "@aiengineer/knowledge-core";
import { canonicalizeJson } from "@aiengineer/knowledge-verification";
import type {
  ProviderReconciliationAdmission,
  AdmittedProviderReconciliation,
} from "@aiengineer/knowledge-application";
import type { PostgresCanonicalRepository } from "./postgres.js";

/** Use a control-plane database connection. Admission alone never bypasses native ledger checks. */
export class PostgresProviderReconciliationStore {
  constructor(
    private readonly database: Pick<PostgresCanonicalRepository, "transaction">,
    private readonly admission: ProviderReconciliationAdmission,
  ) {}
  async apply(value: AdmittedProviderReconciliation) {
    const { receipt, artifact } = this.admission.assertPermit(value);
    return this.database.transaction(receipt.tenantId, async (client) => {
      const op = (
        await client.query(
          "select id from knowledge_service.operation where tenant_id=$1 and id=$2 and operation_kind='verification_structured_extraction' and status in ('succeeded','failed','cancelled') for update",
          [receipt.tenantId, receipt.operationId],
        )
      ).rows[0];
      if (!op) throw new Error("PROVIDER_RECONCILIATION_TERMINAL_OPERATION_REQUIRED");
      this.admission.assertPermit(value);
      let row = (
        await client.query(
          "select * from orchestration.verification_provider_reconciliation where tenant_id=$1 and provider_attempt_id=$2",
          [receipt.tenantId, receipt.providerAttemptId],
        )
      ).rows[0];
      if (row) {
        if (
          row.artifact_id !== artifact.artifactId ||
          row.artifact_sha256 !== artifact.digest.slice(7) ||
          canonicalizeJson(row.body) !== canonicalizeJson(receipt)
        )
          throw new Error("PROVIDER_RECONCILIATION_IDEMPOTENCY_CONFLICT");
      } else {
        row = (
          await client.query(
            "insert into orchestration.verification_provider_reconciliation(tenant_id,provider_attempt_id,operation_id,artifact_id,artifact_sha256,body) values($1,$2,$3,$4,$5,$6::jsonb) returning *",
            [
              receipt.tenantId,
              receipt.providerAttemptId,
              receipt.operationId,
              artifact.artifactId,
              artifact.digest.slice(7),
              JSON.stringify(receipt),
            ],
          )
        ).rows[0]!;
      }
      return deepFreeze({
        tenantId: receipt.tenantId,
        operationId: receipt.operationId,
        providerAttemptId: receipt.providerAttemptId,
        artifact: { artifactId: artifact.artifactId, digest: artifact.digest },
        actualCostMicros: receipt.decision.actualCostMicros,
        releasedReservationCostMicros: receipt.reservationCostMicros,
        appliedAt: new Date(row.applied_at as Date | string).toISOString(),
        redispatchAuthorized: false as const,
      });
    });
  }
}
