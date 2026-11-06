// A2A task binding for the HTTP API, its only transport: maps an A2A task onto a durable
// operation submission. Callback signing, verification and replay protection stay in
// application (persistence implements CallbackReplayStore; host composes it).
import { callbackEnvelopeForA2ATask, type KnowledgeOperationPort } from "@aiengineer/knowledge-application";
import {
  A2ATaskSchema,
  type A2AStatus,
  type A2ATask,
  type CallbackEnvelope,
  type JsonValue,
  type OperationKind,
} from "@aiengineer/knowledge-contracts";

const a2aKinds: Readonly<Record<A2ATask["kind"], OperationKind>> = {
  document_preparation: "transformation",
  vector_store_ingestion: "vector_store_ingestion",
  retrieval: "retrieval_run",
  evidence_packet_construction: "evidence_packet",
};

export function operationKindForA2ATask(task: A2ATask): OperationKind {
  return a2aKinds[task.kind];
}

/**
 * Binds orchestration metadata to the real executable input. Object inputs are
 * required because every currently executable A2A operation has an object
 * contract and the reserved `a2a` member must not be caller-controlled.
 */
export function operationInputForA2ATask(task: A2ATask): JsonValue {
  const input = task.operationInput;
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("A2A_OPERATION_INPUT_OBJECT_REQUIRED");
  if ("a2a" in input) throw new Error("A2A_OPERATION_INPUT_RESERVED_FIELD");
  return {
    ...input,
    a2a: {
      taskId: task.taskId,
      kind: task.kind,
      purpose: task.purpose,
      inputArtifactIds: task.inputArtifactIds,
      expectedOutputContract: task.expectedOutputContract,
      callback: task.callback,
    },
  };
}

export function operationEnvelopeForA2ATask(task: A2ATask) {
  return {
    context: task.context,
    input: operationInputForA2ATask(task),
    expectedVersions: {
      contract: task.contractVersion,
      ...task.capabilityVersions,
    },
  };
}

export class A2AKnowledgeAdapter {
  constructor(
    private readonly service: KnowledgeOperationPort,
    private readonly origin: string,
  ) {}

  async dispatch(value: unknown): Promise<A2AStatus> {
    const task = A2ATaskSchema.parse(value);
    const accepted = await this.service.submit(
      operationKindForA2ATask(task),
      operationEnvelopeForA2ATask(task),
      this.origin,
    );
    return {
      taskId: task.taskId,
      operationId: accepted.operationId,
      state: "accepted",
      statusUrl: accepted.statusUrl,
      eventStreamUrl: accepted.eventStreamUrl,
      cancellationUrl: accepted.cancellationUrl,
    };
  }

  callback(
    taskValue: unknown,
    payload: JsonValue,
    secret: string,
    occurredAt = new Date().toISOString(),
  ): CallbackEnvelope {
    const task = A2ATaskSchema.parse(taskValue);
    return callbackEnvelopeForA2ATask(task, payload, secret, occurredAt);
  }
}
