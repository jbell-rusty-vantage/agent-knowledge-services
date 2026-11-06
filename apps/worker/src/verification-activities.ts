import {
  VerificationOperationExecutor,
  type VerificationOperationRepositoryPort,
} from "@aiengineer/knowledge-application";
import { VerificationArtifactHandleSchema, type JsonValue } from "@aiengineer/knowledge-contracts";
import type {
  CanonicalOperationRecord,
  CanonicalReceipt,
  OperationsRepository,
  ReceiptRepository,
} from "@aiengineer/knowledge-persistence";
import type { CanonicalActivityHandler } from "./activity-registry.js";
import { CanonicalActivityError } from "./activity-registry.js";

type VerificationOperations = Pick<OperationsRepository, "getOperationRecord"> & ReceiptRepository;

function resultHandle(receipts: readonly CanonicalReceipt[]) {
  const receipt = [...receipts]
    .reverse()
    .find((item) => item.outcome === "succeeded" && item.receiptKind === "verify_and_register.succeeded");
  if (!receipt || !record(receipt.body)) throw new Error("VERIFICATION_COMPLETED_RESULT_NOT_FOUND");
  const parsed = VerificationArtifactHandleSchema.safeParse(receipt.body.resultArtifact);
  if (!parsed.success) throw new Error("VERIFICATION_COMPLETED_RESULT_INVALID");
  return parsed.data;
}

/** Adapters bind the trusted executor to canonical PostgreSQL operation state. */
export function createVerificationOperationExecutor(input: {
  readonly operations: VerificationOperations;
  readonly repository: VerificationOperationRepositoryPort;
  readonly admission: ConstructorParameters<typeof VerificationOperationExecutor>[1];
  readonly catalog: ConstructorParameters<typeof VerificationOperationExecutor>[4];
  readonly config: ConstructorParameters<typeof VerificationOperationExecutor>[5];
  readonly sourceAcquirer?: ConstructorParameters<typeof VerificationOperationExecutor>[6];
}): VerificationOperationExecutor {
  return new VerificationOperationExecutor(
    input.repository,
    input.admission,
    {
      async loadResultArtifact({ tenantId, operationId }) {
        const operation = await input.operations.getOperationRecord(tenantId, operationId);
        if (!operation || operation.operationKind !== "verification_extraction" || operation.status !== "succeeded")
          throw new Error("VERIFICATION_REPLAY_SOURCE_NOT_SUCCEEDED");
        return resultHandle(await input.operations.listReceipts(tenantId, operationId));
      },
    },
    {
      async assertActive({ tenantId, operationId }) {
        const operation = await input.operations.getOperationRecord(tenantId, operationId);
        if (!operation || operation.status !== "running")
          throw new Error(
            operation?.status === "cancelled"
              ? "VERIFICATION_OPERATION_CANCELLED"
              : "VERIFICATION_OPERATION_NOT_ACTIVE",
          );
      },
    },
    input.catalog,
    input.config,
    input.sourceAcquirer,
  );
}

/** Complete handlers are returned together and may then be admitted by a worker registry. */
export function verificationActivityHandlers(
  executor: VerificationOperationExecutor,
): readonly CanonicalActivityHandler[] {
  return [
    handler("verification_capture", "register_and_admit"),
    handler("verification_extraction", "verify_and_register"),
    handler("verification_replay", "hydrate_and_recompute"),
  ];
  function handler(
    operationKind: "verification_capture" | "verification_extraction" | "verification_replay",
    stepName: string,
  ): CanonicalActivityHandler {
    return {
      operationKind,
      stepName,
      async execute({ activity }): Promise<JsonValue> {
        try {
          return (await executor.execute(
            operationKind,
            activity.operationInput,
            activity.context,
          )) as unknown as JsonValue;
        } catch (error) {
          if (error instanceof CanonicalActivityError) throw error;
          const message = error instanceof Error ? error.message : "";
          const code = /^[A-Z][A-Z0-9_]{2,127}$/u.test(message) ? message : "VERIFICATION_INFRASTRUCTURE_FAILURE";
          const retryable =
            code === "VERIFICATION_INFRASTRUCTURE_FAILURE" ||
            code.startsWith("OBJECT_STORE_") ||
            code === "REGISTERED_ARTIFACT_BYTES_UNAVAILABLE" ||
            code === "ARTIFACT_REGISTRATION_LOST";
          throw new CanonicalActivityError(code, code, retryable, { cause: error });
        }
      },
    };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
