import { describe, expect, it } from "vitest";
import type { AdvancedRetrievalPlan, GraphEdge, RetrievalChannel, RetrievalPolicy, RetrievalRecord } from "../types.js";
import { expandVerifiedGraph } from "./expand.js";

const plan = (overrides: Partial<AdvancedRetrievalPlan["graph"]> = {}): AdvancedRetrievalPlan => ({
  policyVersionId: "policy-1",
  normalizedQuery: "agent loop",
  intents: ["decision_support"],
  subqueries: [{ id: "q1", text: "agent loop", coverageRole: "required" }],
  spaces: ["engineering_claims"],
  hardFilters: [],
  softBoosts: [],
  candidateK: 50,
  finalK: 10,
  graph: { maxDepth: 2, allowedEdges: ["supports"], ...overrides },
  minimumCoverage: 1,
  minimumEvidenceScore: 0,
  minimumEvidenceTerms: 0,
});

const policy = (overrides: Partial<RetrievalPolicy> = {}): RetrievalPolicy => ({
  id: "policy-1",
  admittedSpaces: ["engineering_claims"],
  allowedFilterFields: [],
  allowedGraphEdges: ["supports"],
  maxCandidateK: 50,
  maxFinalK: 10,
  maxGraphDepth: 2,
  maxGraphNodes: 20,
  rrfK: 60,
  channelWeights: {},
  maxPerSource: 2,
  contextRadius: 0,
  minimumCoverage: 1,
  ...overrides,
});

const record = (id: string, quoteDigest: string): RetrievalRecord => ({
  id,
  tenantId: "t1",
  projectionId: `p-${id}`,
  projectionVersionId: "v1",
  space: "engineering_claims",
  targetKind: "engineering_claims",
  targetSchemaVersion: "v1",
  text: `record ${id}`,
  fields: {},
  locators: [
    {
      representationId: "00000000-0000-7000-8000-000000000010",
      nodeId: "00000000-0000-7000-8000-000000000011",
      startOffset: 0,
      endOffset: 5,
      quoteDigest: quoteDigest as `sha256:${string}`,
    },
  ],
  authority: "exploratory",
  assurance: "high",
  freshnessAt: "2026-08-01T00:00:00.000Z",
  promoted: true,
  sourceId: "source-a",
});

const boundDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const unboundDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const edge = (overrides: Partial<GraphEdge> = {}): GraphEdge => ({
  fromId: "r0",
  toId: "r1",
  kind: "supports",
  verified: true,
  rationale: "recorded support relationship",
  provenance: ["fixture:v1"],
  locatorDigest: boundDigest,
  ...overrides,
});

type Ranked = { channel: RetrievalChannel; recordId: string; graphPath?: readonly string[] };

function collect() {
  const calls: Ranked[] = [];
  const rankChannel = (
    channel: RetrievalChannel,
    scored: readonly { record: RetrievalRecord; graphPath?: readonly string[] }[],
  ) => {
    for (const item of scored)
      calls.push({
        channel,
        recordId: item.record.id,
        ...(item.graphPath ? { graphPath: item.graphPath } : {}),
      });
  };
  return { calls, rankChannel };
}

describe("expandVerifiedGraph", () => {
  it("expands a verified edge whose locator binds to an endpoint", () => {
    const r0 = record("r0", boundDigest);
    const r1 = record("r1", "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
    const { calls, rankChannel } = collect();
    expandVerifiedGraph(plan(), [r0, r1], [edge()], policy(), ["r0"], rankChannel);
    expect(calls).toEqual([{ channel: "graph", recordId: "r1", graphPath: ["r0", "supports", "r1"] }]);
  });

  it("rejects an edge whose locatorDigest binds to neither endpoint", () => {
    const r0 = record("r0", boundDigest);
    const r1 = record("r1", boundDigest);
    const { calls, rankChannel } = collect();
    expandVerifiedGraph(plan(), [r0, r1], [edge({ locatorDigest: unboundDigest })], policy(), ["r0"], rankChannel);
    expect(calls).toEqual([]);
  });

  it("stops expansion once seen reaches policy.maxGraphNodes", () => {
    const r0 = record("r0", boundDigest);
    const r1 = record("r1", boundDigest);
    const r2 = record("r2", boundDigest);
    const edges: GraphEdge[] = [edge({ fromId: "r0", toId: "r1" }), edge({ fromId: "r0", toId: "r2" })];
    const { calls, rankChannel } = collect();
    // seeds already fill the cap, so no new node may be counted as seen; the walk
    // still visits r0's edges (the cap bounds newly seen nodes, not the edge loop
    // itself — see expand.ts's comment on this exact check).
    expandVerifiedGraph(plan(), [r0, r1, r2], edges, policy({ maxGraphNodes: 1 }), ["r0"], rankChannel);
    expect(calls).toEqual([]);
  });
});
