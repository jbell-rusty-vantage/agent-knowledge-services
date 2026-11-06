import type { VectorSpace } from "@aiengineer/knowledge-contracts";
import type { RetrievalPolicy, RetrievalRecord } from "../../src/index.js";

export const tenantId = "00000000-0000-7000-8000-000000000001";

export const spaces: VectorSpace[] = [
  "engineering_claims",
  "tool_capabilities",
  "implementation_examples",
  "paper_case_study_knowledge",
  "entity_profiles",
  "model_capabilities",
  "benchmark_intelligence",
  "source_native_sections",
];

/** The one locator every fixture record carries, so graph edges can bind to it. */
export const locator = {
  representationId: "00000000-0000-7000-8000-000000000010",
  nodeId: "00000000-0000-7000-8000-000000000011",
  startOffset: 0,
  endOffset: 5,
  quoteDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
};

export const policy: RetrievalPolicy = {
  id: "00000000-0000-7000-8000-000000000002",
  admittedSpaces: spaces,
  allowedFilterFields: ["language", "visibility"],
  allowedGraphEdges: ["supports", "continues"],
  allowedVisibilities: ["tenant", "public"],
  maxCandidateK: 50,
  maxFinalK: 10,
  maxGraphDepth: 2,
  maxGraphNodes: 20,
  rrfK: 60,
  channelWeights: { exact: 2, fts: 1, semantic: 1, graph: 0.5, rerank: 1 },
  maxPerSource: 2,
  contextRadius: 1,
  minimumCoverage: 1,
};

/** One record per space; index 0 is the record every example query targets. */
export const records: RetrievalRecord[] = spaces.map((space, index) => ({
  id: `r${index}`,
  tenantId,
  projectionId: `p${index}`,
  projectionVersionId: "v1",
  space,
  targetKind: space,
  targetSchemaVersion: "v1",
  text:
    index === 0
      ? "Agent loops use tools and evidence for reliable engineering"
      : "Context about model tools benchmark code paper organizations",
  identifiers: index === 0 ? ["agent-loop"] : [],
  vector: index === 0 ? [1, 0] : [0, 1],
  fields: { language: "en", visibility: "tenant" },
  locators: [locator],
  authority: "exploratory",
  assurance: "high",
  freshnessAt: "2026-08-01T00:00:00.000Z",
  promoted: true,
  lifecycle: "active",
  sourceId: index < 2 ? "source-a" : `source-${index}`,
  ordinal: index,
}));

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
