import type { RetrievalPolicy, RetrievalRecord } from "@aiengineer/knowledge-retrieval";
const tenantId = "00000000-0000-7000-8000-000000000001";
const representationId = "00000000-0000-7000-8000-000000000010";
const cases = [
  ["engineering_claims", "agent loop reliability evidence"],
  ["tool_capabilities", "Firecrawl web extraction capability"],
  ["implementation_examples", "TypeScript retry implementation example"],
  ["paper_case_study_knowledge", "retrieval augmented generation paper finding"],
  ["entity_profiles", "AI engineering organization profile"],
  ["model_capabilities", "embedding model semantic capability"],
  ["benchmark_intelligence", "retrieval benchmark recall metric"],
  ["source_native_sections", "faithful source native section"],
] as const;
export function createSevenDomainRetrievalFixture(): {
  tenantId: string;
  records: readonly RetrievalRecord[];
  policy: RetrievalPolicy;
  queries: readonly { space: (typeof cases)[number][0]; query: string; recordId: string }[];
} {
  const records = cases.map(
    ([space, text], index): RetrievalRecord => ({
      id: `fixture-record-${index}`,
      tenantId,
      projectionId: `fixture-projection-${index}`,
      projectionVersionId: "fixture-v1",
      space,
      targetKind: space,
      targetSchemaVersion: "v1",
      text,
      identifiers: [`${space}-id`],
      vector: Array.from({ length: 1536 }, (_, i) => (i === index ? 1 : 0)),
      fields: { language: "en", visibility: "tenant" },
      locators: [
        {
          representationId,
          nodeId: `00000000-0000-7000-8000-${String(index + 20).padStart(12, "0")}`,
          startOffset: 0,
          endOffset: text.length,
        },
      ],
      authority: "exploratory",
      assurance: "high",
      freshnessAt: "2026-09-01T00:00:00.000Z",
      promoted: true,
      lifecycle: "active",
      sourceId: `source-${index}`,
    }),
  );
  const policy: RetrievalPolicy = {
    id: "00000000-0000-7000-8000-000000000099",
    admittedSpaces: cases.map((x) => x[0]),
    allowedFilterFields: ["language", "visibility"],
    allowedGraphEdges: ["supports", "continues"],
    maxCandidateK: 50,
    maxFinalK: 10,
    maxGraphDepth: 2,
    maxGraphNodes: 50,
    rrfK: 60,
    channelWeights: { exact: 2, trigram: 0.5, fts: 1, semantic: 1, graph: 0.5, rerank: 1 },
    maxPerSource: 2,
    contextRadius: 0,
    minimumCoverage: 1,
  };
  return {
    tenantId,
    records,
    policy,
    queries: cases.map(([space, query], index) => ({ space, query, recordId: records[index]!.id })),
  };
}
