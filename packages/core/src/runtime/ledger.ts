import type { JsonValue } from "@aiengineer/knowledge-contracts";
import { canonicalJson, sha256Digest } from "../domain/index.js";
import { deterministicUuid } from "./artifacts.js";

export type OperationState =
  | "queued"
  | "running"
  | "needs_review"
  | "quarantined"
  | "succeeded"
  | "failed"
  | "cancelled";
export type StepState = "pending" | "leased" | "succeeded" | "failed";
export interface OperationContext {
  tenantId: string;
  operationId: string;
  attemptId: string;
  workItemId?: string;
  missionId?: string;
  correlationId: string;
  causationId?: string;
  actor: string;
  capabilityVersion: string;
}
export interface OperationRecord {
  context: OperationContext;
  idempotencyKey: string;
  inputDigest: string;
  state: OperationState;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}
export interface StepRecord {
  id: string;
  operationId: string;
  name: string;
  ordinal: number;
  state: StepState;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  attempts: number;
  outputDigest?: string;
}
export interface LedgerEvent {
  id: string;
  operationId: string;
  sequence: number;
  type: string;
  occurredAt: string;
  payload: JsonValue;
  payloadDigest: string;
}
export interface ActivityReceipt {
  id: string;
  operationId: string;
  stepId: string;
  idempotencyKey: string;
  inputDigest: string;
  outputDigest: string;
  eventId: string;
  completedAt: string;
}
export interface OperationLedgerSnapshot {
  operations: OperationRecord[];
  steps: StepRecord[];
  events: LedgerEvent[];
  receipts: ActivityReceipt[];
}
export interface Clock {
  now(): Date;
}

export class InMemoryOperationLedger {
  readonly #operations = new Map<string, OperationRecord>();
  readonly #idempotency = new Map<string, string>();
  readonly #steps = new Map<string, StepRecord>();
  readonly #events: LedgerEvent[] = [];
  readonly #receipts = new Map<string, ActivityReceipt>();
  constructor(
    private readonly clock: Clock = { now: () => new Date() },
    snapshot?: OperationLedgerSnapshot,
  ) {
    for (const operation of snapshot?.operations ?? []) {
      this.#operations.set(operation.context.operationId, structuredClone(operation));
      this.#idempotency.set(`${operation.context.tenantId}:${operation.idempotencyKey}`, operation.context.operationId);
    }
    for (const step of snapshot?.steps ?? [])
      this.#steps.set(`${step.operationId}:${step.ordinal}`, structuredClone(step));
    this.#events.push(...(snapshot?.events ?? []).map((event) => structuredClone(event)));
    for (const receipt of snapshot?.receipts ?? [])
      this.#receipts.set(`${receipt.operationId}:${receipt.stepId}:${receipt.inputDigest}`, structuredClone(receipt));
  }

  create(
    context: OperationContext,
    idempotencyKey: string,
    input: JsonValue,
    stepNames: readonly string[],
  ): OperationRecord {
    const inputDigest = sha256Digest(input);
    const priorId = this.#idempotency.get(`${context.tenantId}:${idempotencyKey}`);
    if (priorId) {
      const prior = this.#operations.get(priorId)!;
      if (prior.inputDigest !== inputDigest) throw new Error("IDEMPOTENCY_CONFLICT");
      return structuredClone(prior);
    }
    if (this.#operations.has(context.operationId)) throw new Error("IDEMPOTENCY_CONFLICT");
    const now = this.clock.now().toISOString();
    const operation = {
      context: structuredClone(context),
      idempotencyKey,
      inputDigest,
      state: "queued",
      rowVersion: 1,
      createdAt: now,
      updatedAt: now,
    } satisfies OperationRecord;
    this.#operations.set(context.operationId, operation);
    this.#idempotency.set(`${context.tenantId}:${idempotencyKey}`, context.operationId);
    stepNames.forEach((name, ordinal) =>
      this.#steps.set(`${context.operationId}:${ordinal}`, {
        id: deterministicUuid("step", `${context.operationId}:${ordinal}:${name}`),
        operationId: context.operationId,
        name,
        ordinal,
        state: "pending",
        attempts: 0,
      }),
    );
    this.#append(context.operationId, "operation.created", {
      inputDigest,
    } as JsonValue);
    return structuredClone(operation);
  }
  get(operationId: string) {
    const value = this.#operations.get(operationId);
    return value && structuredClone(value);
  }
  list() {
    return [...this.#operations.values()].map((operation) => structuredClone(operation));
  }
  listSteps(operationId: string) {
    return [...this.#steps.values()]
      .filter((step) => step.operationId === operationId)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((step) => structuredClone(step));
  }
  events(operationId: string) {
    return this.#events.filter((event) => event.operationId === operationId).map((event) => structuredClone(event));
  }
  receipts(operationId: string) {
    return [...this.#receipts.values()]
      .filter((receipt) => receipt.operationId === operationId)
      .map((receipt) => structuredClone(receipt));
  }

  claim(operationId: string, owner: string, leaseMs: number): StepRecord | undefined {
    const now = this.clock.now();
    const step = this.listSteps(operationId).find(
      (candidate) =>
        candidate.state === "pending" ||
        (candidate.state === "leased" && Date.parse(candidate.leaseExpiresAt!) <= now.getTime()),
    );
    if (!step) return undefined;
    const stored = this.#steps.get(`${operationId}:${step.ordinal}`)!;
    const leaseToken = sha256Digest(
      canonicalJson({
        operationId,
        stepId: stored.id,
        owner,
        attempts: stored.attempts + 1,
        now: now.toISOString(),
      }),
    );
    Object.assign(stored, {
      state: "leased",
      leaseOwner: owner,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      attempts: stored.attempts + 1,
    });
    const operation = this.#operations.get(operationId)!;
    operation.state = "running";
    operation.rowVersion++;
    operation.updatedAt = now.toISOString();
    this.#append(operationId, "step.leased", {
      stepId: stored.id,
      owner,
      leaseToken,
    } as JsonValue);
    return structuredClone(stored);
  }
  heartbeat(operationId: string, stepId: string, leaseToken: string, leaseMs: number): StepRecord {
    const stored = this.#findStep(operationId, stepId);
    this.#assertLease(stored, leaseToken);
    stored.leaseExpiresAt = new Date(this.clock.now().getTime() + leaseMs).toISOString();
    return structuredClone(stored);
  }
  complete(
    operationId: string,
    stepId: string,
    leaseToken: string,
    inputDigest: string,
    output: JsonValue,
  ): ActivityReceipt {
    const key = `${operationId}:${stepId}:${inputDigest}`;
    const previous = this.#receipts.get(key);
    const outputDigest = sha256Digest(output);
    if (previous) {
      if (previous.outputDigest !== outputDigest) throw new Error("IDEMPOTENCY_CONFLICT");
      return structuredClone(previous);
    }
    const stored = this.#findStep(operationId, stepId);
    this.#assertLease(stored, leaseToken);
    stored.state = "succeeded";
    stored.outputDigest = outputDigest;
    delete stored.leaseOwner;
    delete stored.leaseToken;
    delete stored.leaseExpiresAt;
    const event = this.#append(operationId, "step.succeeded", {
      stepId,
      inputDigest,
      outputDigest,
    } as JsonValue);
    const receipt = {
      id: deterministicUuid("receipt", key),
      operationId,
      stepId,
      idempotencyKey: key,
      inputDigest,
      outputDigest,
      eventId: event.id,
      completedAt: this.clock.now().toISOString(),
    } satisfies ActivityReceipt;
    this.#receipts.set(key, receipt);
    this.reconcile(operationId);
    return structuredClone(receipt);
  }
  fail(operationId: string, stepId: string, leaseToken: string, retryable: boolean): void {
    const stored = this.#findStep(operationId, stepId);
    this.#assertLease(stored, leaseToken);
    stored.state = retryable ? "pending" : "failed";
    delete stored.leaseOwner;
    delete stored.leaseToken;
    delete stored.leaseExpiresAt;
    this.#append(operationId, "step.failed", { stepId, retryable });
    this.reconcile(operationId);
  }
  cancel(operationId: string): OperationRecord {
    const operation = this.#operations.get(operationId);
    if (!operation) throw new Error("Operation not found");
    if (["succeeded", "cancelled"].includes(operation.state)) return structuredClone(operation);
    if (operation.state === "failed") throw new Error("INVALID_STATE_TRANSITION");
    operation.state = "cancelled";
    operation.rowVersion++;
    operation.updatedAt = this.clock.now().toISOString();
    this.#append(operationId, "operation.cancelled", {});
    return structuredClone(operation);
  }
  retry(operationId: string): OperationRecord {
    const operation = this.#operations.get(operationId);
    if (!operation) throw new Error("Operation not found");
    if (operation.state !== "failed") throw new Error("INVALID_STATE_TRANSITION");
    for (const step of this.#steps.values())
      if (step.operationId === operationId && step.state === "failed") {
        step.state = "pending";
        delete step.outputDigest;
      }
    operation.state = "queued";
    operation.rowVersion++;
    operation.updatedAt = this.clock.now().toISOString();
    this.#append(operationId, "operation.retried", {
      attempt: operation.rowVersion,
    });
    return structuredClone(operation);
  }
  snapshot(): OperationLedgerSnapshot {
    return {
      operations: this.list(),
      steps: [...this.#steps.values()].map((step) => structuredClone(step)),
      events: this.#events.map((event) => structuredClone(event)),
      receipts: [...this.#receipts.values()].map((receipt) => structuredClone(receipt)),
    };
  }
  reconcile(operationId: string): OperationRecord {
    const operation = this.#operations.get(operationId);
    if (!operation) throw new Error("Operation not found");
    const steps = this.listSteps(operationId);
    const desired: OperationState = steps.some((step) => step.state === "failed")
      ? "failed"
      : steps.length > 0 && steps.every((step) => step.state === "succeeded")
        ? "succeeded"
        : steps.some((step) => step.state === "leased")
          ? "running"
          : "queued";
    if (operation.state !== desired) {
      const previous = operation.state;
      operation.state = desired;
      operation.rowVersion++;
      operation.updatedAt = this.clock.now().toISOString();
      this.#append(operationId, "operation.reconciled", {
        previous,
        resulting: desired,
      });
    }
    return structuredClone(operation);
  }
  #findStep(operationId: string, stepId: string) {
    const value = [...this.#steps.values()].find((step) => step.operationId === operationId && step.id === stepId);
    if (!value) throw new Error("Step not found");
    return value;
  }
  #assertLease(step: StepRecord, token: string) {
    if (
      step.state !== "leased" ||
      step.leaseToken !== token ||
      Date.parse(step.leaseExpiresAt!) <= this.clock.now().getTime()
    )
      throw new Error("STALE_LEASE");
  }
  #append(operationId: string, type: string, payload: JsonValue): LedgerEvent {
    const sequence = this.#events.filter((event) => event.operationId === operationId).length + 1;
    const event = {
      id: deterministicUuid("event", `${operationId}:${sequence}`),
      operationId,
      sequence,
      type,
      occurredAt: this.clock.now().toISOString(),
      payload: structuredClone(payload),
      payloadDigest: sha256Digest(payload),
    };
    this.#events.push(event);
    return event;
  }
}
