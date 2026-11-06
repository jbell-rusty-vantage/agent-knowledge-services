import { z } from "zod";
import {
  CheckpointPendingOperationSchema,
  CheckpointScopeSchema,
  type CheckpointOperationOutcome,
} from "@aiengineer/knowledge-contracts";
import { checkpointScopeId, type CheckpointOperationReconciler } from "@aiengineer/knowledge-application";
import type { PostgresCanonicalRepository } from "@aiengineer/knowledge-persistence";
import { canonicalizeJson } from "@aiengineer/knowledge-verification";
import { validateStoredArtifact, type ArtifactCustody } from "../store-custody.js";
import { checkpointTerminalOutcome } from "./checkpoints-events.js";

const Observation = z.object({
  schemaVersion: z.literal("checkpoint-observation.v1"),
  scope: CheckpointScopeSchema,
  operation: CheckpointPendingOperationSchema,
  event: z
    .object({
      eventType: z.literal("action.result"),
      data: z
        .object({
          status: z.string(),
          result: z.object({ callId: z.string() }).passthrough(),
        })
        .passthrough(),
    })
    .passthrough(),
});

/** Reconcile captured tool outcomes without repeating the external action. */
export function createCheckpointReconciler(
  database: PostgresCanonicalRepository,
  custody: ArtifactCustody,
  owners: CheckpointOperationReconciler,
): CheckpointOperationReconciler {
  return {
    async reconcile({ tenantId, scope, operation }): Promise<CheckpointOperationOutcome> {
      const unresolved = {
        ...operation,
        state: "unresolved" as const,
        artifacts: [],
        detail: "No matching durable terminal owner receipt",
      };
      if (operation.owner !== "external_tool") return owners.reconcile({ tenantId, scope, operation });
      const producer = `knowledge:checkpoint-observation:${checkpointScopeId(scope)}`;
      const rows = await database.transaction(
        tenantId,
        async (client) =>
          (
            await client.query<{ artifact_id: string }>(
              `select artifact_id from orchestration.verification_artifact_metadata
       where tenant_id=$1 and producer_activity_id=$2 order by artifact_id limit 10001`,
              [tenantId, producer],
            )
          ).rows,
      );
      if (rows.length > 10000) throw new Error("CHECKPOINT_OBSERVATION_LIMIT");
      const outcomes: CheckpointOperationOutcome[] = [];
      for (const row of rows) {
        const remote = await custody.resolve(row.artifact_id);
        if (!remote) continue;
        validateStoredArtifact(tenantId, remote.handle, remote.bytes);
        if (
          remote.handle.producerActivityId !== producer ||
          remote.handle.mediaType !== "application/vnd.aiengineer.checkpoint-observation+json"
        )
          continue;
        const parsed = Observation.safeParse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(remote.bytes)),
        );
        if (!parsed.success) continue;
        const value = parsed.data;
        if (
          canonicalizeJson(value.scope) !== canonicalizeJson(scope) ||
          canonicalizeJson(value.operation) !== canonicalizeJson(operation) ||
          value.event.data.result.callId !== operation.operationId
        )
          continue;
        const outcome = checkpointTerminalOutcome(value.event.data);
        if (outcome) outcomes.push({ ...operation, state: "settled", outcome, artifacts: [remote.handle] });
      }
      if (new Set(outcomes.map((value) => value.outcome)).size > 1)
        return { ...unresolved, detail: "Conflicting durable tool outcomes require owner reconciliation" };
      return outcomes[0] ?? unresolved;
    },
  };
}
