import { describe, expect, it } from "vitest";
import type { VectorSpace } from "@aiengineer/knowledge-contracts";
import { buildRetrievalPlan, retrieve, type RetrievalPolicy, type RetrievalRecord } from "./index.js";

const tenant = "00000000-0000-7000-8000-000000000001";

const spaces: VectorSpace[] = [
  "engineering_claims",
  "tool_capabilities",
  "implementation_examples",
  "paper_case_study_knowledge",
  "entity_profiles",
  "model_capabilities",
  "benchmark_intelligence",
  "source_native_sections",
];

const policy: RetrievalPolicy = {
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

const locator = {
  representationId: "00000000-0000-7000-8000-000000000010",
  nodeId: "00000000-0000-7000-8000-000000000011",
  startOffset: 0,
  endOffset: 5,
  quoteDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
};

const records = spaces.map(
  (space, index): RetrievalRecord => ({
    id: `r${index}`,
    tenantId: tenant,
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
  }),
);

describe("advanced retrieval", () => {
  it("validates policy, decomposes intent, spaces, filters and limits", () => {
    const plan = buildRetrievalPlan("How to implement an API; compare tools?", policy, {
      hardFilters: [{ field: "language", op: "eq", value: "en" }],
    });
    expect(plan.subqueries.length).toBeGreaterThan(1);
    expect(plan.intents).toContain("implementation_support");
    expect(() =>
      buildRetrievalPlan("x", policy, {
        hardFilters: [{ field: "secret", op: "eq", value: true }],
      }),
    ).toThrow("FILTER_NOT_ALLOWED");
    expect(() => buildRetrievalPlan("x", policy, { candidateK: 0, finalK: 0 })).toThrow("RETRIEVAL_LIMIT_EXCEEDED");
    expect(() => buildRetrievalPlan("x", { ...policy, rrfK: 0 })).toThrow("INVALID_RRF_POLICY");
  });

  it("fuses independent channels deterministically, verifies filters, expands graph and attaches context", async () => {
    const args = {
      tenantId: tenant,
      policy,
      records,
      spaces,
      finalK: 2,
      queryVector: [1, 0],
      hardFilters: [{ field: "language", op: "eq" as const, value: "en" }],
      graphEdges: [
        {
          fromId: "r0",
          toId: "r1",
          kind: "supports",
          verified: true,
          rationale: "recorded support relationship",
          provenance: ["fixture:v1"],
          locatorDigest: locator.quoteDigest,
        },
      ],
      now: "2026-09-01T00:00:00.000Z",
    };
    const first = await retrieve("agent-loop", args);
    const second = await retrieve("agent-loop", args);
    expect(first.digest).toBe(second.digest);
    expect(first.members[0]!.recordId).toBe("r0");
    expect(first.members[0]!.contributions.map((x) => x.channel)).toEqual(
      expect.arrayContaining(["exact", "trigram", "semantic"]),
    );
    expect(first.members.find((x) => x.recordId === "r1")?.contributions.some((x) => x.channel === "graph")).toBe(true);
    const withContext = await retrieve("agent-loop", {
      ...args,
      finalK: 1,
      graphEdges: [],
    });
    expect(withContext.members.some((x) => x.contextOnly)).toBe(true);
    expect(
      withContext.members.filter((x) => x.contextOnly).every((x) => x.finalScore === 0 && x.contributions.length === 0),
    ).toBe(true);
  });

  it("falls back to fused results when reranking fails", async () => {
    const packet = await retrieve("agent evidence", {
      tenantId: tenant,
      policy,
      records,
      reranker: {
        version: "bad",
        async rerank() {
          throw new Error("offline");
        },
      },
    });
    expect(packet.degradedMode).toBe(true);
    expect(packet.members.length).toBeGreaterThan(0);
    expect(packet.omittedResults.some((x) => x.reason.includes("reranker_failed"))).toBe(true);
  });

  it("abstains with reasoned coverage and rejects cross-tenant/unpromoted content", async () => {
    const packet = await retrieve("nonexistent required topic", {
      tenantId: tenant,
      policy,
      records: records.map((r, i) => ({
        ...r,
        tenantId: i === 0 ? "00000000-0000-7000-8000-999999999999" : r.tenantId,
        promoted: i !== 1,
      })),
    });
    expect(packet.abstention.recommended).toBe(true);
    expect(packet.abstention.reason).toContain("coverage");
    expect(packet.omittedResults.map((x) => x.reason)).toEqual(
      expect.arrayContaining(["tenant_mismatch", "not_eligible"]),
    );
  });

  it("supports every public domain plus faithful native sections", async () => {
    for (const [index, space] of spaces.entries()) {
      const packet = await retrieve(records[index]!.text, {
        tenantId: tenant,
        policy,
        records,
        spaces: [space],
      });
      expect(packet.members.some((x) => x.space === space)).toBe(true);
    }
  });

  it("denies unauthorized visibility and rejects graph edges with unbound locators", async () => {
    const privateRecord = {
      ...records[1]!,
      fields: { ...records[1]!.fields, visibility: "private" },
    };
    const packet = await retrieve("agent-loop", {
      tenantId: tenant,
      policy,
      records: [records[0]!, privateRecord],
      spaces,
      finalK: 2,
      graphEdges: [
        {
          fromId: "r0",
          toId: "r1",
          kind: "supports",
          verified: true,
          rationale: "claims support",
          provenance: ["fixture:v1"],
          locatorDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ],
    });
    expect(packet.omittedResults).toContainEqual({
      recordId: "r1",
      reason: "visibility_not_authorized",
    });
    expect(packet.members.flatMap((x) => x.contributions).some((x) => x.channel === "graph")).toBe(false);
  });
});
