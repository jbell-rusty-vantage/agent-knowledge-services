import type { CallbackReplayStore } from "@aiengineer/knowledge-application";
import { CallbackEnvelopeSchema, type CallbackEnvelope } from "@aiengineer/knowledge-contracts";
import type { PostgresCanonicalRepository } from "./postgres.js";

/** PostgreSQL-backed, tenant-scoped, append-only callback replay ledger. */
export class PostgresCallbackReplayStore implements CallbackReplayStore {
  constructor(private readonly repository: PostgresCanonicalRepository) {}

  async accept(
    envelopeValue: CallbackEnvelope,
    signingKeyReference: string,
    receivedAt: string,
    receiverIdentity: string,
  ): Promise<boolean> {
    const envelope = CallbackEnvelopeSchema.parse(envelopeValue);
    const inserted = await this.repository.transaction(envelope.tenantId, async (client) =>
      client.query<{ callback_id: string }>(
        `insert into knowledge_service.callback_delivery
            (callback_id,tenant_id,task_id,operation_id,correlation_id,causation_id,
             signing_key_reference,receiver_identity,payload_sha256,signature,
             occurred_at,received_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           on conflict(callback_id) do nothing
           returning callback_id`,
        [
          envelope.callbackId,
          envelope.tenantId,
          envelope.taskId,
          envelope.operationId,
          envelope.correlationId,
          envelope.causationId ?? null,
          signingKeyReference,
          receiverIdentity,
          envelope.payloadDigest,
          envelope.signature,
          envelope.occurredAt,
          receivedAt,
        ],
      ),
    );
    return inserted.rowCount === 1;
  }
}
