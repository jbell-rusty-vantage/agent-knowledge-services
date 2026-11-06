import { verificationProviderHostTuple, type VerificationProviderHost } from "./verification-provider-host.js";
import type { PostgresCanonicalRepository } from "./postgres.js";
import type { LeasedStep } from "./types.js";

export type ProviderAttemptState = "reserved" | "dispatched" | "settled" | "uncertain" | "cancelled";
export interface ProviderBudgetSnapshot {
  readonly budgetId: string;
  readonly tenantId: string;
  readonly budgetKey: string;
  readonly ceilingCostMicros: number;
  readonly reservedCostMicros: number;
  readonly settledCostMicros: number;
}
export interface ProviderAttemptSnapshot {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly budgetId: string;
  readonly requestDigest: `sha256:${string}`;
  readonly attemptOrdinal: number;
  readonly providerId: string;
  readonly model: string;
  readonly reservationCostMicros: number;
  readonly state: ProviderAttemptState;
  readonly dispatchFence?: string;
  readonly operationId?: string;
  readonly operationStepId?: string;
  readonly profileArtifactId?: string;
  readonly profileDigest?: `sha256:${string}`;
  readonly reservedFencingToken?: number;
  readonly dispatchFencingToken?: number;
  readonly estimatedCostMicros?: number;
  readonly actualCostMicros?: number;
  readonly requestArtifactId?: string;
  readonly responseArtifactId?: string;
}

const validDigest = (value: string): string => {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("PROVIDER_ACCOUNTING_DIGEST_INVALID");
  return value.slice(7);
};
const validUuid = (value: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error("PROVIDER_ACCOUNTING_UUID_INVALID");
  return value;
};
const validMicros = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 20_000_000)
    throw new Error("PROVIDER_ACCOUNTING_COST_INVALID");
  return value;
};
const validText = (value: string, code: string): string => {
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(value)) throw new Error(code);
  return value;
};
const databaseNumber = (value: unknown): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("PROVIDER_ACCOUNTING_ROW_INVALID");
  return result;
};
const absent = (value: unknown): boolean => value === null || value === undefined;
const frozenScope = (scope: VerificationProviderOperationScope): VerificationProviderOperationScope =>
  Object.freeze({
    ...scope,
    lease: Object.freeze({ ...scope.lease }),
  });

function toBudget(row: Record<string, unknown>): ProviderBudgetSnapshot {
  return Object.freeze({
    budgetId: String(row.id),
    tenantId: String(row.tenant_id),
    budgetKey: String(row.budget_key),
    ceilingCostMicros: databaseNumber(row.ceiling_cost_micros),
    reservedCostMicros: databaseNumber(row.reserved_cost_micros),
    settledCostMicros: databaseNumber(row.settled_cost_micros),
  });
}

function toAttempt(row: Record<string, unknown>): ProviderAttemptSnapshot {
  const state = String(row.state);
  if (!(["reserved", "dispatched", "settled", "uncertain", "cancelled"] as readonly string[]).includes(state))
    throw new Error("PROVIDER_ACCOUNTING_ROW_INVALID");
  return Object.freeze({
    attemptId: String(row.id),
    tenantId: String(row.tenant_id),
    budgetId: String(row.budget_id),
    requestDigest: `sha256:${String(row.request_sha256)}`,
    attemptOrdinal: databaseNumber(row.attempt_ordinal),
    providerId: String(row.provider_id),
    model: String(row.model),
    reservationCostMicros: databaseNumber(row.reservation_cost_micros),
    state: state as ProviderAttemptState,
    ...(absent(row.dispatch_fence) ? {} : { dispatchFence: String(row.dispatch_fence) }),
    ...(absent(row.operation_id) ? {} : { operationId: String(row.operation_id) }),
    ...(absent(row.operation_step_id) ? {} : { operationStepId: String(row.operation_step_id) }),
    ...(absent(row.profile_artifact_id) ? {} : { profileArtifactId: String(row.profile_artifact_id) }),
    ...(absent(row.profile_sha256)
      ? {}
      : { profileDigest: `sha256:${String(row.profile_sha256)}` as `sha256:${string}` }),
    ...(absent(row.reserved_fencing_token) ? {} : { reservedFencingToken: databaseNumber(row.reserved_fencing_token) }),
    ...(absent(row.dispatch_fencing_token) ? {} : { dispatchFencingToken: databaseNumber(row.dispatch_fencing_token) }),
    ...(absent(row.estimated_cost_micros) ? {} : { estimatedCostMicros: databaseNumber(row.estimated_cost_micros) }),
    ...(absent(row.actual_cost_micros) ? {} : { actualCostMicros: databaseNumber(row.actual_cost_micros) }),
    ...(absent(row.request_artifact_id) ? {} : { requestArtifactId: String(row.request_artifact_id) }),
    ...(absent(row.response_artifact_id) ? {} : { responseArtifactId: String(row.response_artifact_id) }),
  });
}

export interface VerificationProviderOperationScope {
  readonly host?: VerificationProviderHost;
  readonly lease: LeasedStep;
  readonly profileArtifactId: string;
  readonly profileDigest: `sha256:${string}`;
}

export class PostgresVerificationProviderAccounting {
  readonly #scope?: VerificationProviderOperationScope;
  constructor(
    private readonly database: PostgresCanonicalRepository,
    scope?: VerificationProviderOperationScope,
  ) {
    if (scope) {
      verificationProviderHostTuple(scope.host);
      validUuid(scope.lease.tenantId);
      validUuid(scope.lease.operationId);
      validUuid(scope.lease.id);
      validUuid(scope.lease.leaseToken);
      validUuid(scope.profileArtifactId);
      validDigest(scope.profileDigest);
      if (
        !scope.lease.holderIdentity.trim() ||
        !Number.isSafeInteger(scope.lease.fencingToken) ||
        scope.lease.fencingToken < 1
      )
        throw new Error("PROVIDER_ACCOUNTING_SCOPE_LEASE_INVALID");
      this.#scope = frozenScope(structuredClone(scope));
    }
  }

  #scopeFor(tenantId: string): VerificationProviderOperationScope | undefined {
    if (this.#scope && this.#scope.lease.tenantId !== tenantId)
      throw new Error("PROVIDER_ACCOUNTING_SCOPE_TENANT_MISMATCH");
    return this.#scope;
  }

  async #assertScope(
    client: {
      query<T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<{ rows: T[] }>;
    },
    tenantId: string,
  ): Promise<void> {
    const scope = this.#scopeFor(tenantId);
    if (!scope) return;
    const host = verificationProviderHostTuple(scope.host);
    const claim = JSON.stringify({
      stepId: scope.lease.id,
      leaseToken: scope.lease.leaseToken,
      fencingToken: scope.lease.fencingToken,
      holderIdentity: scope.lease.holderIdentity,
    });
    await client.query("select set_config('verification.provider_claim',$1,true)", [claim]);
    const operation = (
      await client.query<{ id: string }>(
        "select id from knowledge_service.operation where tenant_id=$1 and id=$2 and operation_kind=$3 and status='running' for update",
        [tenantId, scope.lease.operationId, host.operationKind],
      )
    ).rows[0];
    if (!operation) throw new Error("PROVIDER_ACCOUNTING_STALE_OPERATION_LEASE");
    const active = (
      await client.query<{ id: string }>(
        "select step.id from knowledge_service.operation_step step join knowledge_service.lease lease on lease.tenant_id=step.tenant_id and lease.operation_step_id=step.id where step.tenant_id=$1 and step.id=$2 and step.operation_id=$3 and step.step_key=$7 and step.step_kind=$7 and step.status='running' and lease.lease_token=$4 and lease.fencing_token=$5 and lease.holder_identity=$6 and lease.released_at is null and lease.expires_at>clock_timestamp() for update",
        [
          tenantId,
          scope.lease.id,
          scope.lease.operationId,
          scope.lease.leaseToken,
          scope.lease.fencingToken,
          scope.lease.holderIdentity,
          host.stepKey,
        ],
      )
    ).rows[0];
    if (!active) throw new Error("PROVIDER_ACCOUNTING_STALE_OPERATION_LEASE");
  }
  #assertScopeRow(row: Record<string, unknown>, scope: VerificationProviderOperationScope | undefined): void {
    if (!scope) {
      if (!absent(row.operation_id)) throw new Error("PROVIDER_ACCOUNTING_SCOPED_ATTEMPT_REQUIRED");
      return;
    }
    if (
      String(row.operation_id) !== scope.lease.operationId ||
      String(row.operation_step_id) !== scope.lease.id ||
      String(row.profile_artifact_id) !== scope.profileArtifactId ||
      String(row.profile_sha256) !== validDigest(scope.profileDigest)
    )
      throw new Error("PROVIDER_ACCOUNTING_SCOPE_ATTEMPT_MISMATCH");
  }

  /** Recover one exact logical call. Semantic hosts must identify the request and ordinal. Never authorizes dispatch. */
  async readOriginalAttempt(
    tenantId: string,
    identity?: { readonly requestDigest: `sha256:${string}`; readonly attemptOrdinal: number },
  ): Promise<ProviderAttemptSnapshot | undefined> {
    validUuid(tenantId);
    const scope = this.#scopeFor(tenantId);
    if (!scope) throw new Error("PROVIDER_ACCOUNTING_SCOPED_ATTEMPT_REQUIRED");
    if (scope.host && scope.host !== "structured_extraction" && !identity)
      throw new Error("PROVIDER_ACCOUNTING_LOGICAL_CALL_IDENTITY_REQUIRED");
    const selected = identity
      ? { requestSha256: validDigest(identity.requestDigest), attemptOrdinal: identity.attemptOrdinal }
      : undefined;
    if (
      selected &&
      (!Number.isSafeInteger(selected.attemptOrdinal) || selected.attemptOrdinal < 0 || selected.attemptOrdinal > 8)
    )
      throw new Error("PROVIDER_ACCOUNTING_ATTEMPT_ORDINAL_INVALID");
    return this.database.transaction(tenantId, async (client) => {
      await this.#assertScope(client, tenantId);
      const row = (
        await client.query<Record<string, unknown>>(
          selected
            ? "select * from orchestration.verification_provider_attempt where tenant_id=$1 and operation_id=$2 and request_sha256=$3 and attempt_ordinal=$4 for update"
            : "select * from orchestration.verification_provider_attempt where tenant_id=$1 and operation_id=$2 and attempt_ordinal=0 for update",
          selected
            ? [tenantId, scope.lease.operationId, selected.requestSha256, selected.attemptOrdinal]
            : [tenantId, scope.lease.operationId],
        )
      ).rows[0];
      if (!row) return undefined;
      this.#assertScopeRow(row, scope);
      if (
        selected &&
        (String(row.request_sha256) !== selected.requestSha256 ||
          Number(row.attempt_ordinal) !== selected.attemptOrdinal)
      )
        throw new Error("PROVIDER_ACCOUNTING_LOGICAL_CALL_IDENTITY_MISMATCH");
      return toAttempt(row);
    });
  }

  async reserve(input: {
    readonly tenantId: string;
    readonly budgetId: string;
    readonly budgetKey: string;
    readonly ceilingCostMicros: number;
    readonly attemptId: string;
    readonly requestDigest: `sha256:${string}`;
    readonly attemptOrdinal: number;
    readonly providerId: string;
    readonly model: string;
    readonly reservationCostMicros: number;
    readonly estimatedCostMicros?: number;
    readonly requestArtifactId?: string;
  }): Promise<{
    readonly budget: ProviderBudgetSnapshot;
    readonly attempt: ProviderAttemptSnapshot;
    readonly reused: boolean;
  }> {
    validUuid(input.tenantId);
    validUuid(input.budgetId);
    validUuid(input.attemptId);
    if (input.requestArtifactId) validUuid(input.requestArtifactId);
    if (this.#scope && !input.requestArtifactId)
      throw new Error("PROVIDER_ACCOUNTING_SCOPED_REQUEST_ARTIFACT_REQUIRED");
    validText(input.budgetKey, "PROVIDER_ACCOUNTING_BUDGET_KEY_INVALID");
    validText(input.providerId, "PROVIDER_ACCOUNTING_PROVIDER_INVALID");
    if (
      !input.model ||
      input.model.length > 160 ||
      !Number.isInteger(input.attemptOrdinal) ||
      input.attemptOrdinal < 0 ||
      input.attemptOrdinal > 8 ||
      validMicros(input.ceilingCostMicros) === 0 ||
      validMicros(input.reservationCostMicros) === 0 ||
      input.reservationCostMicros > input.ceilingCostMicros
    ) {
      throw new Error("PROVIDER_ACCOUNTING_RESERVATION_INVALID");
    }
    if (input.estimatedCostMicros !== undefined && validMicros(input.estimatedCostMicros) > input.reservationCostMicros)
      throw new Error("PROVIDER_ACCOUNTING_ESTIMATE_INVALID");
    const requestSha256 = validDigest(input.requestDigest);

    return this.database.transaction(input.tenantId, async (client) => {
      const scope = this.#scopeFor(input.tenantId);
      await this.#assertScope(client, input.tenantId);
      // DO NOTHING arbitrates both the key and primary-key races; identity is checked below.
      await client.query(
        "insert into orchestration.verification_provider_budget(id,tenant_id,budget_key,ceiling_cost_micros) values($1,$2,$3,$4) on conflict do nothing",
        [input.budgetId, input.tenantId, input.budgetKey, input.ceilingCostMicros],
      );
      const budgetRow = (
        await client.query<Record<string, unknown>>(
          "select * from orchestration.verification_provider_budget where tenant_id=$1 and budget_key=$2 for update",
          [input.tenantId, input.budgetKey],
        )
      ).rows[0];
      if (
        !budgetRow ||
        String(budgetRow.id) !== input.budgetId ||
        databaseNumber(budgetRow.ceiling_cost_micros) !== input.ceilingCostMicros
      ) {
        throw new Error("PROVIDER_ACCOUNTING_BUDGET_IDENTITY_CONFLICT");
      }
      const semantic = scope?.host === "claims" || scope?.host === "report";
      const existingRow = (
        await client.query<Record<string, unknown>>(
          semantic
            ? "select * from orchestration.verification_provider_attempt where tenant_id=$1 and operation_id=$2 and attempt_ordinal=$3 and request_sha256=$4 for update"
            : scope
              ? "select * from orchestration.verification_provider_attempt where tenant_id=$1 and operation_id=$2 and attempt_ordinal=$3 for update"
              : "select * from orchestration.verification_provider_attempt where tenant_id=$1 and request_sha256=$2 and attempt_ordinal=$3 and operation_id is null for update",
          semantic
            ? [input.tenantId, scope!.lease.operationId, input.attemptOrdinal, requestSha256]
            : scope
              ? [input.tenantId, scope.lease.operationId, input.attemptOrdinal]
              : [input.tenantId, requestSha256, input.attemptOrdinal],
        )
      ).rows[0];
      if (existingRow) {
        const existing = toAttempt(existingRow);
        this.#assertScopeRow(existingRow, scope);
        if (
          existing.budgetId !== input.budgetId ||
          existing.attemptId !== input.attemptId ||
          existing.providerId !== input.providerId ||
          existing.model !== input.model ||
          existing.reservationCostMicros !== input.reservationCostMicros ||
          existing.estimatedCostMicros !== input.estimatedCostMicros ||
          existing.requestArtifactId !== input.requestArtifactId ||
          existing.requestDigest !== input.requestDigest
        ) {
          throw new Error("PROVIDER_ACCOUNTING_ATTEMPT_IDENTITY_CONFLICT");
        }
        return { budget: toBudget(budgetRow), attempt: existing, reused: true };
      }
      if (
        databaseNumber(budgetRow.reserved_cost_micros) +
          databaseNumber(budgetRow.settled_cost_micros) +
          input.reservationCostMicros >
        input.ceilingCostMicros
      ) {
        throw new Error("PROVIDER_BUDGET_EXCEEDED");
      }
      await client.query(
        "update orchestration.verification_provider_budget set reserved_cost_micros=reserved_cost_micros+$3 where tenant_id=$1 and id=$2",
        [input.tenantId, input.budgetId, input.reservationCostMicros],
      );
      const attemptRow = (
        await client.query<Record<string, unknown>>(
          scope
            ? "insert into orchestration.verification_provider_attempt(id,tenant_id,budget_id,request_sha256,attempt_ordinal,provider_id,model,reservation_cost_micros,state,estimated_cost_micros,request_artifact_id,operation_id,operation_step_id,profile_artifact_id,profile_sha256,reserved_fencing_token) values($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$10,$11,$12,$13,$14,$15) returning *"
            : "insert into orchestration.verification_provider_attempt(id,tenant_id,budget_id,request_sha256,attempt_ordinal,provider_id,model,reservation_cost_micros,state,estimated_cost_micros,request_artifact_id) values($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$10) returning *",
          scope
            ? [
                input.attemptId,
                input.tenantId,
                input.budgetId,
                requestSha256,
                input.attemptOrdinal,
                input.providerId,
                input.model,
                input.reservationCostMicros,
                input.estimatedCostMicros ?? null,
                input.requestArtifactId ?? null,
                scope.lease.operationId,
                scope.lease.id,
                scope.profileArtifactId,
                validDigest(scope.profileDigest),
                scope.lease.fencingToken,
              ]
            : [
                input.attemptId,
                input.tenantId,
                input.budgetId,
                requestSha256,
                input.attemptOrdinal,
                input.providerId,
                input.model,
                input.reservationCostMicros,
                input.estimatedCostMicros ?? null,
                input.requestArtifactId ?? null,
              ],
        )
      ).rows[0]!;
      const updatedBudget = (
        await client.query<Record<string, unknown>>(
          "select * from orchestration.verification_provider_budget where tenant_id=$1 and id=$2",
          [input.tenantId, input.budgetId],
        )
      ).rows[0]!;
      return { budget: toBudget(updatedBudget), attempt: toAttempt(attemptRow), reused: false };
    });
  }

  async claimDispatch(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly dispatchFence: string;
  }): Promise<{ readonly claimed: boolean; readonly attempt: ProviderAttemptSnapshot }> {
    validUuid(input.tenantId);
    validUuid(input.attemptId);
    validUuid(input.dispatchFence);
    return this.database.transaction(input.tenantId, async (client) => {
      const scope = this.#scopeFor(input.tenantId);
      await this.#assertScope(client, input.tenantId);
      const probe = (
        await client.query<Record<string, unknown>>(
          "select budget_id from orchestration.verification_provider_attempt where tenant_id=$1 and id=$2",
          [input.tenantId, input.attemptId],
        )
      ).rows[0];
      if (!probe) throw new Error("PROVIDER_ACCOUNTING_ATTEMPT_NOT_FOUND");
      const budgetRow = (
        await client.query<Record<string, unknown>>(
          "select * from orchestration.verification_provider_budget where tenant_id=$1 and id=$2 for update",
          [input.tenantId, String(probe.budget_id)],
        )
      ).rows[0];
      if (!budgetRow) throw new Error("PROVIDER_ACCOUNTING_BUDGET_NOT_FOUND");
      if (
        databaseNumber(budgetRow.reserved_cost_micros) + databaseNumber(budgetRow.settled_cost_micros) >
        databaseNumber(budgetRow.ceiling_cost_micros)
      )
        throw new Error("PROVIDER_BUDGET_EXCEEDED");
      const locked = (
        await client.query<Record<string, unknown>>(
          "select * from orchestration.verification_provider_attempt where tenant_id=$1 and id=$2 for update",
          [input.tenantId, input.attemptId],
        )
      ).rows[0]!;
      const current = toAttempt(locked);
      this.#assertScopeRow(locked, scope);
      if (current.state !== "reserved") return { claimed: false, attempt: current };
      const updated = (
        await client.query<Record<string, unknown>>(
          scope
            ? "update orchestration.verification_provider_attempt set state='dispatched',dispatched_at=clock_timestamp(),dispatch_fence=$3,dispatch_fencing_token=$4 where tenant_id=$1 and id=$2 returning *"
            : "update orchestration.verification_provider_attempt set state='dispatched',dispatched_at=clock_timestamp(),dispatch_fence=$3 where tenant_id=$1 and id=$2 returning *",
          scope
            ? [input.tenantId, input.attemptId, input.dispatchFence, scope.lease.fencingToken]
            : [input.tenantId, input.attemptId, input.dispatchFence],
        )
      ).rows[0]!;
      return { claimed: true, attempt: toAttempt(updated) };
    });
  }

  async settle(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly actualCostMicros: number;
    readonly responseArtifactId: string;
  }): Promise<{ readonly budget: ProviderBudgetSnapshot; readonly attempt: ProviderAttemptSnapshot }> {
    validUuid(input.tenantId);
    validUuid(input.attemptId);
    validUuid(input.responseArtifactId);
    validMicros(input.actualCostMicros);
    return this.database.transaction(input.tenantId, async (client) => {
      const scope = this.#scopeFor(input.tenantId);
      await this.#assertScope(client, input.tenantId);
      const probe = (
        await client.query<Record<string, unknown>>(
          "select budget_id from orchestration.verification_provider_attempt where tenant_id=$1 and id=$2",
          [input.tenantId, input.attemptId],
        )
      ).rows[0];
      if (!probe) throw new Error("PROVIDER_ACCOUNTING_ATTEMPT_NOT_FOUND");
      const budgetRow = (
        await client.query<Record<string, unknown>>(
          "select * from orchestration.verification_provider_budget where tenant_id=$1 and id=$2 for update",
          [input.tenantId, String(probe.budget_id)],
        )
      ).rows[0];
      if (!budgetRow) throw new Error("PROVIDER_ACCOUNTING_BUDGET_NOT_FOUND");
      const attemptRow = (
        await client.query<Record<string, unknown>>(
          "select * from orchestration.verification_provider_attempt where tenant_id=$1 and id=$2 for update",
          [input.tenantId, input.attemptId],
        )
      ).rows[0]!;
      const current = toAttempt(attemptRow);
      this.#assertScopeRow(attemptRow, scope);
      if (current.state === "settled") {
        if (
          current.actualCostMicros !== input.actualCostMicros ||
          current.responseArtifactId !== input.responseArtifactId
        )
          throw new Error("PROVIDER_ACCOUNTING_SETTLEMENT_REPLAY_CONFLICT");
        return { attempt: current, budget: toBudget(budgetRow) };
      }
      if (current.state !== "dispatched" && current.state !== "uncertain")
        throw new Error("PROVIDER_ACCOUNTING_SETTLEMENT_INVALID");
      // Actual supplier evidence is authoritative. A genuine overrun remains visible and makes later reservations fail.
      await client.query(
        "update orchestration.verification_provider_budget set reserved_cost_micros=reserved_cost_micros-$3,settled_cost_micros=settled_cost_micros+$4 where tenant_id=$1 and id=$2",
        [input.tenantId, current.budgetId, current.reservationCostMicros, input.actualCostMicros],
      );
      const settledRow = (
        await client.query<Record<string, unknown>>(
          "update orchestration.verification_provider_attempt set state='settled',actual_cost_micros=$3,response_artifact_id=$4,reconciled_at=clock_timestamp() where tenant_id=$1 and id=$2 returning *",
          [input.tenantId, input.attemptId, input.actualCostMicros, input.responseArtifactId],
        )
      ).rows[0]!;
      const updatedBudget = (
        await client.query<Record<string, unknown>>(
          "select * from orchestration.verification_provider_budget where tenant_id=$1 and id=$2",
          [input.tenantId, current.budgetId],
        )
      ).rows[0]!;
      return { attempt: toAttempt(settledRow), budget: toBudget(updatedBudget) };
    });
  }

  async markUncertain(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly responseArtifactId?: string;
  }): Promise<ProviderAttemptSnapshot> {
    validUuid(input.tenantId);
    validUuid(input.attemptId);
    if (input.responseArtifactId) validUuid(input.responseArtifactId);
    return this.database.transaction(input.tenantId, async (client) => {
      const scope = this.#scopeFor(input.tenantId);
      await this.#assertScope(client, input.tenantId);
      const probe = (
        await client.query<Record<string, unknown>>(
          "select budget_id from orchestration.verification_provider_attempt where tenant_id=$1 and id=$2",
          [input.tenantId, input.attemptId],
        )
      ).rows[0];
      if (!probe) throw new Error("PROVIDER_ACCOUNTING_ATTEMPT_NOT_FOUND");
      await client.query(
        "select id from orchestration.verification_provider_budget where tenant_id=$1 and id=$2 for update",
        [input.tenantId, String(probe.budget_id)],
      );
      const row = (
        await client.query<Record<string, unknown>>(
          "select * from orchestration.verification_provider_attempt where tenant_id=$1 and id=$2 for update",
          [input.tenantId, input.attemptId],
        )
      ).rows[0]!;
      const current = toAttempt(row);
      this.#assertScopeRow(row, scope);
      if (current.state === "uncertain") return current;
      if (current.state !== "dispatched") throw new Error("PROVIDER_ACCOUNTING_UNCERTAIN_INVALID_STATE");
      const uncertainRow = (
        await client.query<Record<string, unknown>>(
          "update orchestration.verification_provider_attempt set state='uncertain',response_artifact_id=$3 where tenant_id=$1 and id=$2 returning *",
          [input.tenantId, input.attemptId, input.responseArtifactId ?? null],
        )
      ).rows[0]!;
      return toAttempt(uncertainRow);
    });
  }
}
