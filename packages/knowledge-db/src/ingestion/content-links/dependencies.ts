import type { ContentLinkOperation } from "@aiengineer/knowledge-contracts";
import { domainError } from "../../schema-workspace/index.js";

export interface OrderedContentOperation {
  readonly operation: ContentLinkOperation;
  readonly dependsOn: readonly string[];
}

/** Includes canonical summary references so omitted ordering cannot bypass a held producer. */
export function orderContentOperations(operations: readonly ContentLinkOperation[]): OrderedContentOperation[] {
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  if (byId.size !== operations.length)
    throw domainError("CONTENT_LINK_DEPENDENCY_INVALID", "Operation IDs must be unique");
  const summaryProducers = new Map<string, string>();
  for (const operation of operations) {
    if (operation.kind !== "summary.materialize") continue;
    if (summaryProducers.has(operation.summaryId))
      throw domainError("CONTENT_LINK_DEPENDENCY_INVALID", "One summary cannot have multiple producers");
    summaryProducers.set(operation.summaryId, operation.operationId);
  }
  const ordered: OrderedContentOperation[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (operationId: string): void => {
    if (visited.has(operationId)) return;
    const operation = byId.get(operationId);
    if (!operation || visiting.has(operationId))
      throw domainError("CONTENT_LINK_DEPENDENCY_INVALID", "Operation dependencies are missing or cyclic");
    visiting.add(operationId);
    const producer = summaryProducers.get(referencedSummary(operation) ?? "");
    const dependencies = [...new Set([...operation.dependsOn, ...(producer ? [producer] : [])])];
    for (const dependency of dependencies) visit(dependency);
    visiting.delete(operationId);
    visited.add(operationId);
    ordered.push({ operation, dependsOn: dependencies });
  };
  for (const operation of operations) visit(operation.operationId);
  return ordered;
}

function referencedSummary(operation: ContentLinkOperation): string | undefined {
  switch (operation.kind) {
    case "summary.source.link":
      return operation.summaryId;
    case "summary.materialize":
      return operation.supersedesId;
    case "projection.target.link":
      return operation.target.kind === "summary" ? operation.target.canonicalId : undefined;
    default:
      return undefined;
  }
}
