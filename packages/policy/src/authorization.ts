import type { Actor, ServiceIdentity } from "@aiengineer/knowledge-contracts";

const allowedActions: Record<ServiceIdentity, readonly string[]> = {
  knowledge_api: [
    "operation.manage",
    "store.manage",
    "retrieve",
    "proposal.submit",
    "decision.record",
    "publication.execute",
  ],
  knowledge_worker: ["operation.lease", "transformation.record", "retrieve.execute", "receipt.record"],
  control_plane: ["store.manage", "publication.execute"],
  acquisition_executor: ["capture.write"],
  conversion_executor: ["capture.read", "representation.write"],
  inspection_agent: ["artifact.read", "proposal.submit", "finding.write"],
  content_curator_agent: ["artifact.read", "proposal.submit", "evaluation.propose"],
  embedding_executor: ["projection.read", "embedding.execute"],
  retrieval_executor: ["retrieve.execute", "packet.write"],
  evaluation_executor: ["evaluation.execute"],
  human_reviewer: ["review.read", "decision.record"],
  mission_control_client: ["operation.dispatch", "operation.read", "result.read"],
  retention_worker: ["retention.execute"],
};

export function isAuthorized(actor: Actor, action: string): boolean {
  if (actor.kind === "human") return action === "review.read" || action === "decision.record";
  return allowedActions[actor.serviceIdentity].includes(action);
}
