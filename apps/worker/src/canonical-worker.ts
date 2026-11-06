import { randomUUID } from "node:crypto";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import type { LeasedStep, PostgresCanonicalRepository } from "@aiengineer/knowledge-persistence";
import {
  VerificationStructuredExtractionFailureResultSchema,
  type OperationKind,
} from "@aiengineer/knowledge-contracts";
import { activityFailureClass, CanonicalActivityError, retryableActivityFailure } from "./activity-registry.js";

export type CanonicalActivityExecutor = (claim: LeasedStep) => unknown | Promise<unknown>;

/** A tenant-scoped worker whose lease, receipt, and reconciliation state all live in PostgreSQL. */
export class CanonicalDurableKnowledgeWorker {
  constructor(
    readonly owner: string,
    readonly tenantId: string,
    private readonly repository: PostgresCanonicalRepository,
    private readonly executeActivity: CanonicalActivityExecutor = (claim) => {
      throw new CanonicalActivityError(
        "ACTIVITY_REGISTRY_REQUIRED",
        `No activity registry was configured for ${claim.stepKind}`,
        false,
      );
    },
    private readonly leaseMs = 30_000,
    private readonly eligibleOperationKinds?: readonly OperationKind[],
  ) {}

  reconcile() {
    return this.repository.reconcileOperations(this.tenantId);
  }
  reconcileOperation(operationId: string) {
    return this.repository.reconcileOperation(this.tenantId, operationId);
  }
  claim() {
    return this.repository.claimNext(this.tenantId, this.owner, this.leaseMs, this.eligibleOperationKinds);
  }
  claimOperation(operationId: string) {
    return this.repository.claimOperation(this.tenantId, operationId, this.owner, this.leaseMs);
  }
  heartbeat(claim: LeasedStep) {
    return this.repository.heartbeat(this.tenantId, claim, this.leaseMs);
  }

  async runOnce() {
    const claimed = await this.claim();
    if (!claimed) return undefined;
    return this.#execute(claimed);
  }

  async runOperationOnce(operationId: string) {
    const claimed = await this.claimOperation(operationId);
    if (!claimed) return undefined;
    return this.#execute(claimed);
  }

  async #execute(claimed: LeasedStep) {
    let heartbeatChain = Promise.resolve();
    let heartbeatError: unknown;
    const heartbeatTimer = setInterval(
      () => {
        heartbeatChain = heartbeatChain.then(async () => {
          if (heartbeatError === undefined) {
            try {
              await this.heartbeat(claimed);
            } catch (error) {
              heartbeatError = error;
            }
          }
        });
      },
      Math.max(250, Math.floor(this.leaseMs / 3)),
    );
    try {
      const current = await this.heartbeat(claimed);
      const output = await this.executeActivity(current);
      clearInterval(heartbeatTimer);
      await heartbeatChain;
      if (heartbeatError !== undefined) throw heartbeatError;
      const receiptInput = {
        id: deterministicUuid(
          "knowledge-worker-receipt",
          `${current.operationId}:${current.id}:${current.inputSha256}`,
        ),
        idempotencyKey: `worker:${current.operationId}:${current.id}:${current.inputSha256}`,
        executorIdentity: this.owner,
        output,
      };
      const failure =
        current.stepKey === "extract_and_register"
          ? VerificationStructuredExtractionFailureResultSchema.safeParse(output)
          : undefined;
      // SQL independently requires the exact committed failure publication.
      // A captured failure result is terminal work, not an activity exception.
      const receipt = failure?.success
        ? await this.repository.failStructuredExtractionStep(this.tenantId, current, {
            ...receiptInput,
            output: failure.data,
          })
        : await this.repository.completeStep(this.tenantId, current, {
            ...receiptInput,
            receiptKind: `${current.stepKind}.succeeded`,
          });
      return { operation: await this.repository.getOperation(this.tenantId, current.operationId), receipt };
    } catch (error) {
      clearInterval(heartbeatTimer);
      await heartbeatChain;
      await this.repository
        .failStep(this.tenantId, claimed, {
          id: randomUUID(),
          idempotencyKey: `worker-failure:${claimed.id}:${claimed.attemptCount}`,
          executorIdentity: this.owner,
          errorClass: activityFailureClass(error),
          retryable: retryableActivityFailure(error),
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
