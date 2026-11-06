import { PostgresCanonicalRepository } from "@aiengineer/knowledge-persistence";
import { CanonicalDurableKnowledgeWorker } from "./canonical-worker.js";

const connectionString = process.env.POSTGRES_URL;
const tenantId = process.env.WORKER_TENANT_ID;
const operationId = process.env.WORKER_OPERATION_ID;
const mode = process.env.WORKER_RESTART_FIXTURE_MODE;
if (!connectionString || !tenantId || !operationId || (mode !== "abandon" && mode !== "complete"))
  throw new Error("INVALID_RESTART_FIXTURE_ENVIRONMENT");
const repository = new PostgresCanonicalRepository({ connectionString, localOnly: true });
const worker = new CanonicalDurableKnowledgeWorker(
  `restart-fixture-${mode}-${process.pid}`,
  tenantId,
  repository,
  (claim) => ({ operationId: claim.operationId, step: claim.stepKey, fixture: "process-restart" }),
  1_000,
);
try {
  if (mode === "abandon") {
    const claim = await worker.claimOperation(operationId);
    if (!claim) throw new Error("RESTART_FIXTURE_CLAIM_REQUIRED");
    process.stdout.write(
      `${JSON.stringify({ mode, pid: process.pid, stepId: claim.id, attemptCount: claim.attemptCount })}\n`,
    );
  } else {
    const result = await worker.runOperationOnce(operationId);
    if (!result) throw new Error("RESTART_FIXTURE_RECLAIM_REQUIRED");
    process.stdout.write(
      `${JSON.stringify({ mode, pid: process.pid, operationId, status: result.operation?.status })}\n`,
    );
  }
} finally {
  await repository.close();
}
