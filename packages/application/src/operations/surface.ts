import {
  MutationEnvelopeSchema,
  OperationContextSchema,
  RetrievalPlanSchema,
  type AcceptedOperation,
  type JsonValue,
  type MutationEnvelope,
  type OperationContext,
  type OperationKind,
  type OperationStatus,
} from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import {
  InMemoryOperationLedger,
  deterministicUuid,
  type ActivityReceipt,
  type Clock,
  type OperationLedgerSnapshot,
  type StepRecord,
} from "@aiengineer/knowledge-core";

export const operationStepsByKind: Readonly<Record<OperationKind, readonly string[]>> = {
  source_discovery: ["discover"],
  source_resolution: ["resolve"],
  capture: ["acquire", "seal"],
  capture_inspection: ["inspect"],
  capture_comparison: ["compare"],
  source_vetting: ["vet"],
  vector_store_create: ["create"],
  vector_store_documents: ["validate", "attach"],
  vector_store_ingestion: ["prepare", "embed", "index"],
  vector_store_search: ["retrieve", "packet"],
  vector_store_evaluation: ["evaluate"],
  document: ["record"],
  document_version: ["version"],
  representation: ["represent"],
  transformation: ["convert", "inspect"],
  representation_inspection: ["inspect"],
  representation_comparison: ["compare"],
  representation_decision: ["decide"],
  chunk_preview: ["preview"],
  chunk_comparison: ["compare"],
  chunk_set: ["chunk", "verify"],
  chunk_set_inspection: ["inspect"],
  promotion_proposal: ["propose"],
  promotion_decision: ["decide"],
  embedding_run: ["embed", "verify"],
  space_publication: ["publish", "verify"],
  publication_verification: ["verify"],
  publication_rollback: ["rollback", "verify"],
  retrieval_run: ["retrieve", "packet"],
  evidence_packet: ["packet"],
  evaluation_dataset: ["freeze"],
  experiment: ["record"],
  evaluation_run: ["evaluate", "report"],
  review: ["review"],
  review_decision: ["decide"],
  verification_capture: ["register_and_admit"],
  verification_extraction: ["verify_and_register"],
  verification_replay: ["hydrate_and_recompute"],
  verification_parse_artifact: ["parse_and_admit"],
  verification_benchmark: ["replay_recorded_and_register"],
  verification_benchmark_compare: ["compare_registered_and_publish"],
  verification_structured_extraction: ["extract_and_register"],
};

/**
 * Durable operations that have complete, fail-closed production worker
 * implementations. Keep this map intentionally smaller than the contract
 * vocabulary above: a contract name is not, by itself, an executable
 * capability.
 */
export const productionWorkerStepsByKind = Object.freeze({
  source_discovery: operationStepsByKind.source_discovery,
  source_resolution: operationStepsByKind.source_resolution,
  vector_store_create: operationStepsByKind.vector_store_create,
  vector_store_documents: operationStepsByKind.vector_store_documents,
  vector_store_ingestion: operationStepsByKind.vector_store_ingestion,
  capture: operationStepsByKind.capture,
  transformation: operationStepsByKind.transformation,
  chunk_set: operationStepsByKind.chunk_set,
  chunk_preview: operationStepsByKind.chunk_preview,
  chunk_comparison: operationStepsByKind.chunk_comparison,
  source_vetting: operationStepsByKind.source_vetting,
  representation_decision: operationStepsByKind.representation_decision,
  promotion_proposal: operationStepsByKind.promotion_proposal,
  promotion_decision: operationStepsByKind.promotion_decision,
  embedding_run: operationStepsByKind.embedding_run,
  space_publication: operationStepsByKind.space_publication,
  publication_verification: operationStepsByKind.publication_verification,
  publication_rollback: operationStepsByKind.publication_rollback,
  evaluation_dataset: operationStepsByKind.evaluation_dataset,
  evaluation_run: operationStepsByKind.evaluation_run,
  vector_store_evaluation: operationStepsByKind.vector_store_evaluation,
  evidence_packet: operationStepsByKind.evidence_packet,
  representation_comparison: operationStepsByKind.representation_comparison,
  experiment: operationStepsByKind.experiment,
  review_decision: operationStepsByKind.review_decision,
} satisfies Partial<Record<OperationKind, readonly string[]>>);

/** Operations executed synchronously by the canonical HTTP runtime. */
export const apiOwnedStepsByKind = Object.freeze({
  retrieval_run: operationStepsByKind.retrieval_run,
} satisfies Partial<Record<OperationKind, readonly string[]>>);

export const productionWorkerOperationKinds = Object.freeze(
  Object.keys(productionWorkerStepsByKind) as OperationKind[],
);
export const apiOwnedOperationKinds = Object.freeze(Object.keys(apiOwnedStepsByKind) as OperationKind[]);
export const productionAdmittedOperationKinds = Object.freeze([
  ...productionWorkerOperationKinds,
  ...apiOwnedOperationKinds,
]);

export class OperationCapabilityUnavailableError extends Error {
  readonly code = "CAPABILITY_NOT_ADMITTED" as const;
  constructor(readonly operationKind: OperationKind) {
    super(`CAPABILITY_NOT_ADMITTED:${operationKind}`);
    this.name = "OperationCapabilityUnavailableError";
  }
}

export function assertOperationKindAdmitted(kind: OperationKind, admittedKinds: readonly OperationKind[]): void {
  if (!admittedKinds.includes(kind)) throw new OperationCapabilityUnavailableError(kind);
}

export const KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION = "knowledge-operation-request/v1" as const;

export interface IntegrationSnapshot {
  ledger: OperationLedgerSnapshot;
  kinds: [string, OperationKind][];
  inputs: [string, JsonValue][];
  contexts: [string, OperationContext][];
  results: [string, JsonValue][];
}
export interface WorkerClaim {
  operation: OperationStatus;
  step: StepRecord;
}

export type Awaitable<T> = T | Promise<T>;

/** The application port shared by HTTP/MCP surfaces and durable infrastructure adapters. */
export interface KnowledgeOperationPort {
  submit(kind: OperationKind, envelopeValue: unknown, origin: string): Awaitable<AcceptedOperation>;
  get(operationId: string, tenantId?: string): Awaitable<OperationStatus | undefined>;
  input(operationId: string, tenantId?: string): Awaitable<JsonValue | undefined>;
  list(tenantId: string): Awaitable<readonly OperationStatus[]>;
  events(operationId: string, tenantId?: string, afterSequence?: number): Awaitable<readonly unknown[] | undefined>;
  cancel(operationId: string, tenantId?: string, context?: OperationContext): Awaitable<OperationStatus | undefined>;
  retry(operationId: string, tenantId?: string, context?: OperationContext): Awaitable<OperationStatus | undefined>;
  reconcile(operationId: string, tenantId?: string, context?: OperationContext): Awaitable<OperationStatus | undefined>;
}

export class KnowledgeIntegrationService implements KnowledgeOperationPort {
  readonly ledger: InMemoryOperationLedger;
  readonly #kinds = new Map<string, OperationKind>();
  readonly #inputs = new Map<string, JsonValue>();
  readonly #contexts = new Map<string, OperationContext>();
  readonly #results = new Map<string, JsonValue>();
  constructor(snapshot?: IntegrationSnapshot, clock?: Clock) {
    this.ledger = new InMemoryOperationLedger(clock, snapshot?.ledger);
    for (const [id, kind] of snapshot?.kinds ?? []) this.#kinds.set(id, kind);
    for (const [id, input] of snapshot?.inputs ?? []) this.#inputs.set(id, structuredClone(input));
    for (const [id, context] of snapshot?.contexts ?? []) this.#contexts.set(id, structuredClone(context));
    for (const [id, result] of snapshot?.results ?? []) this.#results.set(id, structuredClone(result));
  }

  submit(kind: OperationKind, envelopeValue: unknown, origin: string): AcceptedOperation {
    const envelope = MutationEnvelopeSchema.parse(envelopeValue);
    const input = { kind, input: envelope.input, expectedVersions: envelope.expectedVersions } as JsonValue;
    const ledgerContext = this.#toLedgerContext(envelope.context);
    const operation = this.ledger.create(
      ledgerContext,
      envelope.context.idempotencyKey,
      input,
      operationStepsByKind[kind],
    );
    const knownKind = this.#kinds.get(operation.context.operationId);
    if (knownKind && knownKind !== kind) throw new Error("IDEMPOTENCY_CONFLICT");
    this.#kinds.set(operation.context.operationId, kind);
    this.#inputs.set(operation.context.operationId, structuredClone(envelope.input));
    return this.#accepted(operation.context.operationId, origin);
  }

  get(operationId: string, tenantId?: string): OperationStatus | undefined {
    const operation = this.ledger.get(operationId);
    if (!operation || (tenantId && operation.context.tenantId !== tenantId)) return undefined;
    const context = OperationContextSchema.parse(this.#contexts.get(operationId) ?? this.#contextFromLedger(operation));
    return {
      operationId,
      kind: this.#kinds.get(operationId) ?? "retrieval_run",
      state: operation.state,
      context,
      inputDigest: operation.inputDigest,
      rowVersion: operation.rowVersion,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      receiptIds: this.ledger.receipts(operationId).map((receipt) => receipt.id),
    };
  }

  list(tenantId: string): OperationStatus[] {
    return this.ledger
      .list()
      .filter((item) => item.context.tenantId === tenantId)
      .map((item) => this.get(item.context.operationId, tenantId)!);
  }
  events(operationId: string, tenantId?: string, afterSequence = 0) {
    if (!this.get(operationId, tenantId)) return undefined;
    return this.ledger
      .events(operationId)
      .filter((event) => event.sequence > afterSequence)
      .slice(0, 100);
  }
  receipts(operationId: string, tenantId?: string) {
    if (!this.get(operationId, tenantId)) return undefined;
    return this.ledger.receipts(operationId);
  }
  cancel(operationId: string, tenantId?: string, _context?: OperationContext) {
    if (!this.get(operationId, tenantId)) return undefined;
    this.ledger.cancel(operationId);
    return this.get(operationId, tenantId);
  }
  retry(operationId: string, tenantId?: string, _context?: OperationContext) {
    if (!this.get(operationId, tenantId)) return undefined;
    this.ledger.retry(operationId);
    return this.get(operationId, tenantId);
  }
  reconcile(operationId: string, tenantId?: string, _context?: OperationContext) {
    if (!this.get(operationId, tenantId)) return undefined;
    this.ledger.reconcile(operationId);
    return this.get(operationId, tenantId);
  }
  input(operationId: string, tenantId?: string): JsonValue | undefined {
    if (!this.get(operationId, tenantId)) return undefined;
    const value = this.#inputs.get(operationId);
    return value && structuredClone(value);
  }
  result(operationId: string): JsonValue | undefined {
    const value = this.#results.get(operationId);
    return value && structuredClone(value);
  }
  setResult(operationId: string, value: JsonValue) {
    if (!this.ledger.get(operationId)) throw new Error("Operation not found");
    this.#results.set(operationId, structuredClone(value));
  }

  validateRetrievalPlan(value: unknown) {
    return RetrievalPlanSchema.parse(value);
  }
  claimNext(owner: string, leaseMs = 30_000): WorkerClaim | undefined {
    for (const operation of this.ledger.list().filter((item) => !["succeeded", "cancelled"].includes(item.state))) {
      const step = this.ledger.claim(operation.context.operationId, owner, leaseMs);
      if (step) return { operation: this.get(operation.context.operationId)!, step };
    }
    return undefined;
  }
  claimOperation(operationId: string, owner: string, leaseMs = 30_000): WorkerClaim | undefined {
    const step = this.ledger.claim(operationId, owner, leaseMs);
    return step ? { operation: this.get(operationId)!, step } : undefined;
  }
  heartbeat(claim: WorkerClaim, leaseMs = 30_000) {
    return this.ledger.heartbeat(claim.operation.operationId, claim.step.id, claim.step.leaseToken!, leaseMs);
  }
  execute(claim: WorkerClaim, output?: JsonValue): ActivityReceipt {
    const operation = this.ledger.get(claim.operation.operationId);
    if (!operation) throw new Error("Operation not found");
    return this.ledger.complete(
      claim.operation.operationId,
      claim.step.id,
      claim.step.leaseToken!,
      sha256Digest({ operationInput: operation.inputDigest, step: claim.step.name }),
      output ?? { step: claim.step.name, state: "succeeded" },
    );
  }
  snapshot(): IntegrationSnapshot {
    return {
      ledger: this.ledger.snapshot(),
      kinds: [...this.#kinds.entries()],
      inputs: [...this.#inputs.entries()].map(([id, input]) => [id, structuredClone(input)]),
      contexts: [...this.#contexts.entries()].map(([id, context]) => [id, structuredClone(context)]),
      results: [...this.#results.entries()].map(([id, result]) => [id, structuredClone(result)]),
    };
  }

  #accepted(id: string, origin: string): AcceptedOperation {
    const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
    return {
      operationId: id,
      state: "queued",
      contractVersion: "v1",
      statusUrl: `${base}/v1/operations/${id}`,
      eventStreamUrl: `${base}/v1/operations/${id}/events`,
      cancellationUrl: `${base}/v1/operations/${id}:cancel`,
      retryUrl: `${base}/v1/operations/${id}:retry`,
      reconcileUrl: `${base}/v1/operations/${id}:reconcile`,
    };
  }
  #toLedgerContext(context: OperationContext) {
    this.#contexts.set(context.operationId, structuredClone(context));
    return {
      tenantId: context.tenantId,
      operationId: context.operationId,
      attemptId: context.attemptId,
      ...(context.workItemId ? { workItemId: context.workItemId } : {}),
      ...(context.missionId ? { missionId: context.missionId } : {}),
      correlationId: context.correlationId,
      ...(context.causationId ? { causationId: context.causationId } : {}),
      actor: `${context.actor.kind}:${context.actor.id}`,
      capabilityVersion: context.capabilityVersion,
    };
  }
  #contextFromLedger(
    operation: ReturnType<InMemoryOperationLedger["get"]> extends infer T ? NonNullable<T> : never,
  ): OperationContext {
    return {
      tenantId: operation.context.tenantId,
      operationId: operation.context.operationId,
      attemptId: operation.context.attemptId,
      ...(operation.context.workItemId ? { workItemId: operation.context.workItemId } : {}),
      ...(operation.context.missionId ? { missionId: operation.context.missionId } : {}),
      correlationId: operation.context.correlationId,
      ...(operation.context.causationId ? { causationId: operation.context.causationId } : {}),
      actor: {
        kind: "service",
        id: deterministicUuid("restored-actor", operation.context.actor),
        serviceIdentity: "knowledge_worker",
      },
      capabilityVersion: operation.context.capabilityVersion,
      idempotencyKey: operation.idempotencyKey,
      reason: "restored durable operation",
      contractVersion: "v1",
    };
  }
}

let singleton: KnowledgeIntegrationService | undefined;
export function createIntegrationService() {
  return (singleton ??= new KnowledgeIntegrationService());
}
export function resetIntegrationService() {
  singleton = undefined;
}
