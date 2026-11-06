import {
  KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION,
  assertOperationKindAdmitted,
  operationStepsByKind,
  productionWorkerOperationKinds,
  verificationOwnedOperationKinds,
  type KnowledgeOperationPort,
} from "@aiengineer/knowledge-application";
import {
  MutationEnvelopeSchema,
  OperationContextSchema,
  OperationKindSchema,
  type AcceptedOperation,
  type JsonValue,
  type MutationEnvelope,
  type OperationContext,
  type OperationFailureSummary,
  type OperationKind,
  type OperationStatus,
} from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import { PostgresCanonicalRepository } from "./postgres.js";
import type { CanonicalOperationRecord, CanonicalStep } from "./types.js";

interface DurableOperationRequest {
  readonly schemaVersion: typeof KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION;
  readonly kind: OperationKind;
  readonly input: JsonValue;
  readonly expectedVersions: Readonly<Record<string, string>>;
  readonly authenticatedContext?: OperationContext;
}

interface DurableStepInput {
  readonly schemaVersion: typeof KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION;
  readonly kind: OperationKind;
  readonly operationInput: JsonValue;
  readonly expectedVersions: Readonly<Record<string, string>>;
  readonly context: OperationContext;
  readonly step: { readonly name: string; readonly ordinal: number };
}

/** PostgreSQL-backed implementation of the operation application port used by process-separated surfaces and workers. */
export class PostgresKnowledgeOperationService implements KnowledgeOperationPort {
  readonly #admittedOperationKinds: readonly OperationKind[];

  constructor(
    private readonly repository: PostgresCanonicalRepository,
    options: { readonly admittedOperationKinds?: readonly OperationKind[] } = {},
  ) {
    this.#admittedOperationKinds = Object.freeze([
      ...(options.admittedOperationKinds ?? productionWorkerOperationKinds),
    ]);
  }

  async submit(kind: OperationKind, envelopeValue: unknown, origin: string): Promise<AcceptedOperation> {
    // Admission must fail before parsing, hashing, or writing any caller data.
    // API-owned executors opt in explicitly at their dedicated endpoint.
    assertOperationKindAdmitted(kind, this.#admittedOperationKinds);
    const envelope = MutationEnvelopeSchema.parse(envelopeValue);
    const verificationOwned = (verificationOwnedOperationKinds as readonly OperationKind[]).includes(kind);
    const request: DurableOperationRequest = {
      schemaVersion: KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION,
      kind,
      input: envelope.input,
      expectedVersions: envelope.expectedVersions,
      // Bind trusted ownership into the existing repository request digest. Step
      // inputs alone do not participate in duplicate submission admission.
      ...(verificationOwned ? { authenticatedContext: envelope.context } : {}),
    };
    const stepNames = operationStepsByKind[kind];
    const ownership = ownershipFrom(envelope);
    const operation = await this.repository.createOperation({
      id: envelope.context.operationId,
      tenantId: envelope.context.tenantId,
      operationKind: kind,
      idempotencyKey: envelope.context.idempotencyKey,
      ownershipMode: ownership.mode,
      ...(verificationOwned
        ? {
            attemptId: envelope.context.attemptId,
            ...(envelope.context.workItemId ? { workItemId: envelope.context.workItemId } : {}),
            ...(envelope.context.missionId ? { missionId: envelope.context.missionId } : {}),
          }
        : {}),
      ...(ownership.externalRunId ? { externalRunId: ownership.externalRunId } : {}),
      correlationId: databaseUuid("correlation", envelope.context.correlationId),
      ...(envelope.context.causationId ? { causationId: databaseUuid("causation", envelope.context.causationId) } : {}),
      actorIdentity: `${envelope.context.actor.kind}:${envelope.context.actor.id}`,
      request,
      steps: stepNames.map((name, ordinal) => ({
        id: deterministicUuid("step", `${envelope.context.operationId}:${ordinal}:${name}`),
        key: name,
        kind: name,
        input: {
          schemaVersion: KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION,
          kind,
          operationInput: envelope.input,
          expectedVersions: envelope.expectedVersions,
          context: envelope.context,
          step: { name, ordinal },
        } satisfies DurableStepInput,
      })),
    });
    return acceptedOperation(operation.id, origin);
  }

  async get(operationId: string, tenantId?: string): Promise<OperationStatus | undefined> {
    if (!tenantId) return undefined;
    const record = await this.repository.getOperationRecord(tenantId, operationId);
    return record ? this.#status(record) : undefined;
  }

  async input(operationId: string, tenantId?: string): Promise<JsonValue | undefined> {
    if (!tenantId) return undefined;
    const record = await this.repository.getOperationRecord(tenantId, operationId);
    const request = record ? parseDurableRequest(record.request) : undefined;
    return request?.input;
  }

  async list(tenantId: string): Promise<readonly OperationStatus[]> {
    const records = await this.repository.listOperations(tenantId);
    const statuses = await Promise.all(records.map((record) => this.#status(record)));
    return statuses.filter((status): status is OperationStatus => status !== undefined);
  }

  async events(operationId: string, tenantId?: string, afterSequence = 0): Promise<readonly unknown[] | undefined> {
    if (!tenantId) return undefined;
    const events = await this.repository.listOperationEvents(tenantId, operationId, afterSequence);
    return events?.map((event) => ({ ...event, payloadDigest: sha256Digest(event.payload as JsonValue) }));
  }

  async cancel(
    operationId: string,
    tenantId?: string,
    context?: OperationContext,
  ): Promise<OperationStatus | undefined> {
    if (!tenantId || !context) return undefined;
    const record = await this.repository.cancelOperation(tenantId, operationId, controlFrom(context));
    return record ? this.#status(record) : undefined;
  }

  async retry(
    operationId: string,
    tenantId?: string,
    context?: OperationContext,
  ): Promise<OperationStatus | undefined> {
    if (!tenantId || !context) return undefined;
    const record = await this.repository.retryOperation(tenantId, operationId, controlFrom(context));
    return record ? this.#status(record) : undefined;
  }

  async reconcile(
    operationId: string,
    tenantId?: string,
    _context?: OperationContext,
  ): Promise<OperationStatus | undefined> {
    if (!tenantId) return undefined;
    const record = await this.repository.reconcileOperation(tenantId, operationId);
    return record ? this.#status(record) : undefined;
  }

  async #status(record: CanonicalOperationRecord): Promise<OperationStatus | undefined> {
    const request = parseDurableRequest(record.request);
    const kind = OperationKindSchema.safeParse(record.operationKind);
    if (!request || !kind.success || request.kind !== kind.data || !isWireState(record.status)) return undefined;
    const steps = await this.repository.listSteps(record.tenantId, record.id);
    const context = contextFromSteps(steps);
    if (
      !context ||
      context.operationId !== record.id ||
      context.tenantId !== record.tenantId ||
      context.idempotencyKey !== record.idempotencyKey
    )
      return undefined;
    const receipts = await this.repository.listReceipts(record.tenantId, record.id);
    const failure = operationFailureSummary(receipts, record.status);
    return {
      operationId: record.id,
      kind: kind.data,
      state: record.status,
      context,
      inputDigest: sha256Digest({
        kind: request.kind,
        input: request.input,
        expectedVersions: request.expectedVersions,
      }),
      rowVersion: record.rowVersion + 1,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      receiptIds: receipts.map((receipt) => receipt.id),
      ...(failure ? { failure } : {}),
    };
  }
}

const failureClassification: Readonly<Record<string, Pick<OperationFailureSummary, "category" | "qualityFailure">>> =
  Object.freeze({
    PROVIDER_HTTP_FAILURE: { category: "provider_upstream_failure", qualityFailure: false },
    PROVIDER_HTTP_FAILURE_CAPTURED: { category: "provider_upstream_failure", qualityFailure: false },
    PROVIDER_NETWORK_FAILURE: { category: "provider_upstream_failure", qualityFailure: false },
    PROVIDER_RESPONSE_INVALID: { category: "provider_upstream_failure", qualityFailure: false },
    PROVIDER_RESPONSE_TOO_LARGE: { category: "provider_upstream_failure", qualityFailure: false },
    PROVIDER_RESPONSE_SCHEMA_INVALID: { category: "provider_upstream_failure", qualityFailure: false },
    PROVIDER_OUTPUT_SCHEMA_INVALID_CAPTURED: { category: "judge_output_failure", qualityFailure: false },
    PROVIDER_AUTHENTICATION_FAILURE: { category: "provider_authentication_failure", qualityFailure: false },
    PROVIDER_KEY_REQUIRED: { category: "provider_authentication_failure", qualityFailure: false },
    PROVIDER_RATE_LIMIT: { category: "provider_rate_limit", qualityFailure: false },
    PROVIDER_DEADLINE_EXCEEDED: { category: "provider_timeout", qualityFailure: false },
    PROVIDER_CANCELLED: { category: "cancelled", qualityFailure: false },
    PROVIDER_CONFIGURATION_INVALID: { category: "harness_failure", qualityFailure: false },
    PROVIDER_UNSUPPORTED_TASK: { category: "harness_failure", qualityFailure: false },
    PROVIDER_ARTIFACT_PERSISTENCE_FAILURE: { category: "artifact_registration_failure", qualityFailure: false },
    PROVIDER_INPUT_POLICY_REJECTED: { category: "policy_rejection", qualityFailure: false },
    POLICY_OVERRIDE_FAIL_CLOSED: { category: "policy_rejection", qualityFailure: false },
  });

/** Only canonical failure receipts are trusted; unknown exact classes deliberately remain harness failures. */
const publicErrorClass = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{2,79}$/u.test(value);

export function operationFailureSummary(
  receipts: readonly {
    readonly id: string;
    readonly receiptKind: string;
    readonly outcome: string;
    readonly body: unknown;
  }[],
  terminalState: string,
): OperationFailureSummary | undefined {
  if (terminalState !== "failed") return undefined;
  const receipt = [...receipts]
    .reverse()
    .find((candidate) => candidate.receiptKind === "failure" && candidate.outcome === "failed");
  if (
    !receipt ||
    !isRecord(receipt.body) ||
    !publicErrorClass(receipt.body.errorClass) ||
    typeof receipt.body.retryable !== "boolean"
  )
    return undefined;
  const classification = failureClassification[receipt.body.errorClass] ?? {
    category: "harness_failure" as const,
    qualityFailure: false,
  };
  return {
    receiptId: receipt.id,
    errorClass: receipt.body.errorClass,
    retryable: receipt.body.retryable,
    ...classification,
  };
}

function parseDurableRequest(value: unknown): DurableOperationRequest | undefined {
  if (!isRecord(value) || value.schemaVersion !== KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION) return undefined;
  const kind = OperationKindSchema.safeParse(value.kind);
  if (
    !kind.success ||
    !("input" in value) ||
    !isStringRecord(value.expectedVersions) ||
    Object.keys(value.expectedVersions).length === 0
  )
    return undefined;
  return {
    schemaVersion: KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION,
    kind: kind.data,
    input: value.input as JsonValue,
    expectedVersions: value.expectedVersions,
  };
}

function contextFromSteps(steps: readonly CanonicalStep[]): OperationContext | undefined {
  for (const candidate of steps) {
    if (!isRecord(candidate.input) || candidate.input.schemaVersion !== KNOWLEDGE_OPERATION_REQUEST_SCHEMA_VERSION)
      continue;
    const parsed = OperationContextSchema.safeParse(candidate.input.context);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function acceptedOperation(id: string, origin: string): AcceptedOperation {
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

function ownershipFrom(envelope: MutationEnvelope): {
  mode: "standalone" | "mission_control" | "eve";
  externalRunId?: string;
} {
  const external = envelope.context.externalExecution;
  if (external?.runtime === "eve") return { mode: "eve", externalRunId: external.runId };
  if (external?.runtime === "mission_control") return { mode: "mission_control", externalRunId: external.runId };
  return external ? { mode: "standalone", externalRunId: external.runId } : { mode: "standalone" };
}

function controlFrom(context: OperationContext) {
  return {
    actorIdentity: `${context.actor.kind}:${context.actor.id}`,
    correlationId: databaseUuid("correlation", context.correlationId),
    ...(context.causationId ? { causationId: databaseUuid("causation", context.causationId) } : {}),
  };
}

function databaseUuid(namespace: string, value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : deterministicUuid(namespace, value);
}

function isWireState(value: string): value is OperationStatus["state"] {
  return ["queued", "running", "needs_review", "quarantined", "succeeded", "failed", "cancelled"].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
