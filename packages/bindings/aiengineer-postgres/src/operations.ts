import {
  type OperationRecord,
  type OperationStart,
  type OperationStore,
  OperationStoreError,
  type OperationTransition,
  toInstant,
} from "@aiengineer/knowledge-application";
import {
  type Digest,
  type JsonValue,
  OperationStatusSchema,
  PROTOCOL_VERSION,
  type Ref,
  canonicalJson,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import type { AuthScope } from "@aiengineer/knowledge-research-core";
import type { BoundedRole, ComponentDatabase, SqlClient } from "./client.js";
import { componentError, registerOrigin } from "./stores.js";

/**
 * `OperationStore` over component table `knowledge_verification.operation` (0004). Rows move only through the
 * definer functions `start_operation` / `transition_operation` / `cancel_operation`, which enforce the K01 transition
 * table, compare-and-set on revision, idempotent start by request id and idempotent cancellation.
 */
const WRITER: BoundedRole = "knowledge_verification_writer";
const READER: BoundedRole = "knowledge_verification_reader";

interface OperationRow {
  readonly operation_id: string;
  readonly protocol_version: string;
  readonly application_id: string;
  readonly binding: string;
  readonly operation_name: string;
  readonly request_id: string;
  readonly request: JsonValue;
  readonly request_digest: string;
  readonly state: string;
  readonly revision: number;
  readonly run_id: string | null;
  readonly subject_ref: JsonValue | null;
  readonly progress_ref: JsonValue | null;
  readonly pending_review_ref: JsonValue | null;
  readonly result_ref: JsonValue | null;
  readonly error: JsonValue | null;
  readonly unresolved_effects: JsonValue;
  readonly cancel_request_id: string | null;
  readonly retry_after_ms: number | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COLUMNS =
  "operation_id, protocol_version, application_id, binding, operation_name, request_id, request, request_digest, state, revision, run_id::text, subject_ref, progress_ref, pending_review_ref, result_ref, error, unresolved_effects, cancel_request_id, retry_after_ms, created_at, updated_at";

const STORE_CODES = new Set(["OPERATION_NOT_FOUND", "REVISION_MISMATCH", "ILLEGAL_TRANSITION", "REQUEST_CONFLICT"]);

function toRecord(tenant: string, row: OperationRow): OperationRecord {
  return {
    status: OperationStatusSchema.parse({
      handle: {
        protocolVersion: row.protocol_version,
        tenant,
        application: row.application_id,
        binding: row.binding,
        operationId: row.operation_id,
      },
      state: row.state,
      revision: row.revision,
      createdAt: toInstant(row.created_at),
      updatedAt: toInstant(row.updated_at),
      progressRef: row.progress_ref,
      pendingReviewRef: row.pending_review_ref,
      resultRef: row.result_ref,
      error: row.error,
      unresolvedEffects: row.unresolved_effects,
      retryAfterMs: row.retry_after_ms,
      cancelRequestId: row.cancel_request_id,
    }),
    operation: row.operation_name,
    requestId: row.request_id,
    requestDigest: row.request_digest as Digest,
    request: row.request,
    runId: row.run_id,
    subject: row.subject_ref as Ref | null,
  };
}

const json = (value: unknown) => (value === undefined || value === null ? null : canonicalJson(value as JsonValue));

export class PostgresOperationStore implements OperationStore {
  constructor(private readonly db: ComponentDatabase) {}

  private async call(scope: AuthScope, role: BoundedRole, work: (c: SqlClient) => Promise<OperationRow | null>) {
    try {
      const row = await this.db.transaction({ tenantId: scope.tenant, role, readOnly: role === READER }, work);
      return row === null ? null : toRecord(scope.tenant, row);
    } catch (error) {
      const typed = error instanceof OperationStoreError ? error : componentError(error);
      if (typed instanceof OperationStoreError) throw typed;
      if (STORE_CODES.has(typed.code)) {
        throw new OperationStoreError(typed.code as OperationStoreError["code"], typed.message);
      }
      throw typed;
    }
  }

  async start(scope: AuthScope, input: OperationStart): Promise<OperationRecord> {
    const handle = {
      protocolVersion: PROTOCOL_VERSION,
      tenant: scope.tenant,
      application: scope.application,
      binding: scope.binding,
      operationId: input.operationId,
    };
    const record = await this.call(scope, WRITER, async (c) => {
      const origin = await registerOrigin(c, scope.tenant, scope.origin);
      const rows = await c.query<OperationRow>(
        `select ${COLUMNS} from knowledge_verification.start_operation($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, null, $11::uuid, $12::jsonb, $13, $14::timestamptz)`,
        [
          scope.tenant,
          input.operationId,
          scope.application,
          scope.binding,
          input.operation,
          input.requestId,
          canonicalJson(input.request),
          input.requestDigest,
          digestCanonical(handle),
          origin,
          input.runId,
          json(input.subject),
          input.retryAfterMs,
          input.at,
        ],
      );
      return rows.rows[0] ?? null;
    });
    if (record === null) throw new OperationStoreError("OPERATION_NOT_FOUND", input.operationId);
    return record;
  }

  get(scope: AuthScope, operationId: string): Promise<OperationRecord | null> {
    return this.call(scope, READER, async (c) => {
      const rows = await c.query<OperationRow>(
        `select ${COLUMNS} from knowledge_verification.operation where tenant_id = $1 and operation_id = $2`,
        [scope.tenant, operationId],
      );
      return rows.rows[0] ?? null;
    });
  }

  async transition(scope: AuthScope, input: OperationTransition): Promise<OperationRecord> {
    const record = await this.call(scope, WRITER, async (c) => {
      const rows = await c.query<OperationRow>(
        `select ${COLUMNS} from knowledge_verification.transition_operation($1, $2, $3, $4, $5::timestamptz, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, null)`,
        [
          scope.tenant,
          input.operationId,
          input.expectedRevision,
          input.to,
          input.at,
          json(input.progressRef),
          json(input.pendingReviewRef),
          json(input.resultRef),
          json(input.error),
          input.unresolvedEffects === undefined ? null : json([...input.unresolvedEffects]),
          input.retryAfterMs ?? null,
        ],
      );
      return rows.rows[0] ?? null;
    });
    if (record === null) throw new OperationStoreError("OPERATION_NOT_FOUND", input.operationId);
    return record;
  }

  async cancel(
    scope: AuthScope,
    input: { operationId: string; cancelRequestId: string; at: string },
  ): Promise<OperationRecord> {
    const record = await this.call(scope, WRITER, async (c) => {
      const rows = await c.query<OperationRow>(
        `select ${COLUMNS} from knowledge_verification.cancel_operation($1, $2, $3, $4::timestamptz)`,
        [scope.tenant, input.operationId, input.cancelRequestId, input.at],
      );
      return rows.rows[0] ?? null;
    });
    if (record === null) throw new OperationStoreError("OPERATION_NOT_FOUND", input.operationId);
    return record;
  }
}
