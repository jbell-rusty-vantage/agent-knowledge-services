import { scopedCustodyOperations, type ScopedOperation } from "./access.js";
import { scopedKnowledgeOperations } from "./knowledge/scoped-knowledge-operations.js";
import { loadExecutorConfig, VerificationExecutor } from "./executor.js";
import { createKnowledgeServices, loadKnowledgeConfig } from "./knowledge/context.js";
import {
  KnowledgeCheckpointHarnessRequestSchema,
  type KnowledgeCheckpointHarnessRequest,
} from "./knowledge/checkpoints-harness.js";
import { CHECKPOINT_PROFILE_PINS } from "./knowledge/checkpoints-policy.js";

export { ScopedExecutorAccess, ScopedAccessError } from "./access.js";
export type { ScopedAssignment, ScopedOperation, GrantInstallation } from "./access.js";
export { scopedOperationCatalog } from "./knowledge/scoped-knowledge-operations.js";

export interface ScopedCustodyHost {
  readonly operations: readonly ScopedOperation[];
  readonly checkpointProfilePins: typeof CHECKPOINT_PROFILE_PINS;
  checkpoint(request: KnowledgeCheckpointHarnessRequest): Promise<unknown>;
  close(): Promise<void>;
}

/** Parent-process custody composition. Never install this module in a child tool surface. */
export async function createScopedCustodyHost(input: {
  env: Readonly<Record<string, string | undefined>>;
}): Promise<ScopedCustodyHost> {
  const executorConfig = loadExecutorConfig(input.env);
  const knowledgeConfig = loadKnowledgeConfig(input.env);
  if (!knowledgeConfig?.storage) throw new Error("SCOPED_HOST_REMOTE_CUSTODY_REQUIRED");
  if (
    knowledgeConfig.defaultTenantId !== executorConfig.tenantId ||
    !knowledgeConfig.producerAttemptId ||
    knowledgeConfig.producerAttemptId !== executorConfig.producerAttemptId
  ) {
    throw new Error("SCOPED_HOST_PRODUCER_BINDING");
  }
  const executor = await VerificationExecutor.create(executorConfig);
  const knowledge = createKnowledgeServices(knowledgeConfig, { verification: executor });
  try {
    const attempts = await knowledge.db.transaction(
      { tenantId: executorConfig.tenantId, readOnly: true },
      async (client) =>
        (
          await client.query<{ id: string; agent_deployment_id: string }>(
            `select a.id,a.agent_deployment_id from orchestration.attempt a
         join orchestration.work_item w on w.tenant_id=a.tenant_id and w.id=a.work_item_id
         where a.tenant_id=$1 and a.id=any($2::uuid[]) and ($3::uuid is null or w.mission_id=$3)`,
            [
              executorConfig.tenantId,
              [executorConfig.producerAttemptId, executorConfig.verifierAttemptId],
              knowledgeConfig.missionId ?? null,
            ],
          )
        ).rows,
    );
    if (
      !attempts.some(
        (row) =>
          row.id === executorConfig.producerAttemptId &&
          row.agent_deployment_id === executorConfig.producerDeploymentId,
      ) ||
      !attempts.some(
        (row) =>
          row.id === executorConfig.verifierAttemptId &&
          row.agent_deployment_id === executorConfig.verifierDeploymentId,
      )
    ) {
      throw new Error("SCOPED_HOST_CANONICAL_ATTEMPTS_REQUIRED");
    }
  } catch (error) {
    await knowledge.close();
    throw error;
  }
  const harness = knowledge.checkpointHarness;
  if (!harness) {
    await knowledge.close();
    throw new Error("SCOPED_HOST_CHECKPOINT_REQUIRED");
  }
  return {
    operations: [...scopedCustodyOperations(executor), ...scopedKnowledgeOperations(knowledge)],
    checkpointProfilePins: structuredClone(CHECKPOINT_PROFILE_PINS),
    checkpoint: async (proposed) => {
      const request = KnowledgeCheckpointHarnessRequestSchema.parse(proposed);
      if (
        request.scopeContext.tenantId !== executorConfig.tenantId ||
        request.scopeContext.producerAttemptId !== executorConfig.producerAttemptId
      ) {
        throw new Error("SCOPED_HOST_CHECKPOINT_BINDING");
      }
      return harness.run(request);
    },
    close: () => knowledge.close(),
  };
}
