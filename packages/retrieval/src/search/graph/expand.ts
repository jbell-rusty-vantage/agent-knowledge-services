import type { AdvancedRetrievalPlan, GraphEdge, RetrievalChannel, RetrievalPolicy, RetrievalRecord } from "../types.js";

// Graph — verified-edge frontier walk. A pure function over the seeds retrieve()
// already ranked: the load-bearing seed order (highest fused score first) is
// computed in retrieve.ts from its channelRanks Map, and only the resulting id list
// crosses this boundary, so the walk itself is testable without a Map of its own.
export function expandVerifiedGraph(
  plan: AdvancedRetrievalPlan,
  eligible: readonly RetrievalRecord[],
  graphEdges: readonly GraphEdge[],
  policy: RetrievalPolicy,
  seeds: readonly string[],
  rankChannel: (
    channel: RetrievalChannel,
    scored: readonly {
      record: RetrievalRecord;
      score: number;
      explanation: string;
      graphPath?: readonly string[];
    }[],
  ) => void,
): void {
  const byId = new Map(eligible.map((x) => [x.id, x]));
  const seen = new Set(seeds);
  let frontier = seeds.map((id) => ({ id, path: [id] }));
  for (let depth = 1; depth <= plan.graph.maxDepth; depth++) {
    const next: typeof frontier = [];
    for (const node of frontier)
      for (const edge of graphEdges) {
        const sourceRecord = byId.get(edge.fromId),
          targetRecord = byId.get(edge.toId);
        const locatorBoundToEndpoint = [sourceRecord, targetRecord].some((endpoint) =>
          endpoint?.locators.some((locator) => locator.quoteDigest === edge.locatorDigest),
        );
        if (
          !edge.verified ||
          !edge.rationale?.trim() ||
          !edge.provenance?.length ||
          !edge.locatorDigest ||
          !locatorBoundToEndpoint ||
          edge.fromId !== node.id ||
          !plan.graph.allowedEdges.includes(edge.kind) ||
          // Position matters here, inside the edge loop: this cap bounds newly seen
          // nodes, not total expansion work, so a dense edge set still walks every
          // edge at each depth (Phase 2 memo §7 item 1). Kept exactly where it was
          // found, not "fixed" by this split.
          seen.size >= policy.maxGraphNodes
        )
          continue;
        const record = targetRecord;
        if (!record) continue;
        const path = [...node.path, edge.kind, edge.toId];
        rankChannel("graph", [
          {
            record,
            score: 1 / depth,
            explanation: `verified ${edge.kind} expansion: ${edge.rationale}`,
            graphPath: path,
          },
        ]);
        if (!seen.has(edge.toId)) {
          seen.add(edge.toId);
          next.push({ id: edge.toId, path });
        }
      }
    frontier = next;
  }
}
