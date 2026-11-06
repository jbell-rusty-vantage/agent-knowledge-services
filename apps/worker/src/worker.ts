import { KnowledgeIntegrationService, type WorkerClaim } from "@aiengineer/knowledge-application";
import type { JsonValue } from "@aiengineer/knowledge-contracts";
import { CanonicalActivityError, retryableActivityFailure } from "./activity-registry.js";

export type ActivityExecutor = (claim: WorkerClaim) => JsonValue | Promise<JsonValue>;

export class DurableKnowledgeWorker {
  constructor(
    readonly owner: string,
    private readonly service: KnowledgeIntegrationService,
    private readonly executeActivity: ActivityExecutor = (claim) => {
      throw new CanonicalActivityError(
        "ACTIVITY_REGISTRY_REQUIRED",
        `No activity registry was configured for ${claim.step.name}`,
        false,
      );
    },
    private readonly leaseMs = 30_000,
  ) {}
  claim() {
    return this.service.claimNext(this.owner, this.leaseMs);
  }
  heartbeat(claim: WorkerClaim) {
    return this.service.heartbeat(claim, this.leaseMs);
  }

  async runOnce() {
    const claim = this.claim();
    if (!claim) return undefined;
    try {
      this.heartbeat(claim);
      const output = await this.executeActivity(claim);
      const receipt = this.service.execute(claim, output);
      const operation = this.service.reconcile(claim.operation.operationId)!;
      return { operation, receipt };
    } catch (error) {
      this.service.ledger.fail(
        claim.operation.operationId,
        claim.step.id,
        claim.step.leaseToken!,
        retryableActivityFailure(error),
      );
      throw error;
    }
  }
}

export { CanonicalDurableKnowledgeWorker } from "./canonical-worker.js";
