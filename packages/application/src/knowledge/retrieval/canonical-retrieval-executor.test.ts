import { describe, expect, it } from "vitest";
import {
  validateRerankerOutput,
  unavailableRetrievalCapabilities,
  isRetrievalUnsupportedError,
  RetrievalUnsupportedError,
} from "./canonical-retrieval-executor.js";
import { RetrievalPlanSchema, RetrievalUnsupportedResponseSchema } from "@aiengineer/knowledge-contracts";

describe("canonical retrieval reranker boundary", () => {
  it("admits a unique finite subset of the bounded fused candidates", () => {
    expect(() =>
      validateRerankerOutput(
        ["a", "b", "c"],
        [
          { vectorItemId: "b", score: 0.9 },
          { vectorItemId: "a", score: 0.2 },
        ],
      ),
    ).not.toThrow();
  });
  it("rejects malformed output", () => {
    for (const scores of [
      [
        { vectorItemId: "a", score: 0.2 },
        { vectorItemId: "a", score: 0.1 },
      ],
      [{ vectorItemId: "outside", score: 0.2 }],
      [{ vectorItemId: "a", score: Number.NaN }],
      [{ vectorItemId: "a", score: 2 }],
      [],
    ])
      expect(() => validateRerankerOutput(["a", "b"], scores)).toThrow("INVALID_RERANKER_OUTPUT");
  });
});

describe("retrieval capability preflight", () => {
  const plan = RetrievalPlanSchema.parse({
    policyVersion: "00000000-0000-4000-8000-000000000001",
    query: "preview",
    intents: ["knowledge_evidence"],
    subqueries: [{ id: "preview", text: "preview", coverageRole: "required" }],
    spaces: ["engineering_claims"],
    anchors: {
      entities: ["00000000-0000-4000-8000-000000000002"],
      concepts: [],
      useCases: [],
    },
    hardFilters: [],
    softBoosts: [],
    temporalScope: {},
    worldScope: { kind: "at", at: "2026-01-01T00:00:00.000001Z" },
    knowledgeScope: { atKnowledgeSeq: 1 },
    candidateK: 10,
    finalK: 5,
    graph: { maxDepth: 0, allowedEdges: [] },
    abstention: { minimumCoverage: 1 },
  });
  it("admits implemented world/K/entity scope", () => {
    expect(unavailableRetrievalCapabilities(plan, 0)).toEqual([]);
  });
  it("returns typed omissions only for explicitly optional requested capabilities", () => {
    expect(
      unavailableRetrievalCapabilities(
        {
          ...plan,
          graph: { maxDepth: 1, allowedEdges: ["supports"] },
          optionalCapabilities: ["graph"],
        },
        0,
      ),
    ).toEqual([{ capability: "graph", reason: "not_implemented" }]);
  });
  it("rejects required graph and unsupported freshness bounds", () => {
    try {
      unavailableRetrievalCapabilities(
        {
          ...plan,
          graph: { maxDepth: 1, allowedEdges: [] },
          temporalScope: { observedBefore: "2026-01-01T00:00:00Z" },
        },
        0,
      );
      throw new Error("expected unsupported capabilities");
    } catch (error) {
      expect(error).toBeInstanceOf(RetrievalUnsupportedError);
      expect(error).toMatchObject({
        code: "RETRIEVAL_CAPABILITY_UNSUPPORTED",
        unsupported: [
          { capability: "graph", reason: "not_implemented" },
          { capability: "observed_upper_bound", reason: "not_implemented" },
        ],
      });
    }
  });
  it("does not infer optionality from optional subquery text", () => {
    expect(() =>
      unavailableRetrievalCapabilities(
        {
          ...plan,
          subqueries: [{ id: "optional", text: "maybe graph", coverageRole: "optional" }],
          anchors: {
            ...plan.anchors,
            concepts: ["00000000-0000-4000-8000-000000000003"],
          },
        },
        0,
      ),
    ).toThrow(RetrievalUnsupportedError);
  });
});

describe("typed unsupported-capability answer", () => {
  const plan = RetrievalPlanSchema.parse({
    policyVersion: "00000000-0000-4000-8000-000000000001",
    query: "preview",
    intents: ["knowledge_evidence"],
    subqueries: [{ id: "preview", text: "preview", coverageRole: "required" }],
    spaces: ["engineering_claims"],
    anchors: { entities: [], concepts: [], useCases: [] },
    hardFilters: [],
    softBoosts: [],
    temporalScope: {},
    candidateK: 10,
    finalK: 5,
    graph: { maxDepth: 0, allowedEdges: [] },
    abstention: { minimumCoverage: 1 },
  });
  it("carries a validated 422 body instead of a generic message", () => {
    try {
      unavailableRetrievalCapabilities({ ...plan, temporalScope: { effectiveBefore: "2026-01-01T00:00:00Z" } }, 0);
      throw new Error("expected unsupported capabilities");
    } catch (error) {
      expect(isRetrievalUnsupportedError(error)).toBe(true);
      const response = (error as RetrievalUnsupportedError).response;
      expect(RetrievalUnsupportedResponseSchema.parse(response)).toEqual({
        schemaVersion: "knowledge.retrieval-unsupported/v1",
        code: "RETRIEVAL_CAPABILITY_UNSUPPORTED",
        unsupported: [{ capability: "freshness_upper_bound", reason: "not_implemented" }],
      });
    }
  });
  it("declares a requested-but-optional freshness bound as a recorded omission", () => {
    expect(
      unavailableRetrievalCapabilities(
        {
          ...plan,
          temporalScope: { effectiveBefore: "2026-01-01T00:00:00Z" },
          optionalCapabilities: ["freshness_upper_bound"],
        },
        0,
      ),
    ).toEqual([{ capability: "freshness_upper_bound", reason: "not_implemented" }]);
  });
  it("reports every required unimplemented capability at once, before any provider call", () => {
    try {
      unavailableRetrievalCapabilities(
        {
          ...plan,
          softBoosts: [{ field: "language", op: "eq", value: "en" }],
          anchors: { entities: [], concepts: [], useCases: ["compare"] },
        },
        2,
      );
      throw new Error("expected unsupported capabilities");
    } catch (error) {
      expect((error as RetrievalUnsupportedError).response.unsupported.map((item) => item.capability)).toEqual([
        "use_case_anchors",
        "soft_boosts",
        "context",
      ]);
    }
  });
});
