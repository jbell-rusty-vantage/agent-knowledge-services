import { describe, expect, it } from "vitest";
import type { RetrievalPolicy } from "../types.js";
import { buildRetrievalPlan, inferIntents } from "./build-plan.js";

const policy: RetrievalPolicy = {
  id: "policy-1",
  admittedSpaces: [
    "engineering_claims",
    "tool_capabilities",
    "implementation_examples",
    "paper_case_study_knowledge",
    "entity_profiles",
    "model_capabilities",
    "benchmark_intelligence",
    "source_native_sections",
  ],
  allowedFilterFields: ["language"],
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
};

describe("buildRetrievalPlan", () => {
  it("assigns the first subquery required and the rest supporting", () => {
    const plan = buildRetrievalPlan("first part; second part; third part", policy);
    expect(plan.subqueries.map((q) => q.coverageRole)).toEqual(["required", "supporting", "supporting"]);
    expect(plan.subqueries.map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
  });

  it("splits on versus/vs/then separators as well as ; and ?", () => {
    const plan = buildRetrievalPlan("tool a versus tool b then tool c", policy, {
      spaces: ["tool_capabilities"],
    });
    expect(plan.subqueries.map((q) => q.text)).toEqual(["tool a", "tool b", "tool c"]);
  });

  it("freezes graph.maxDepth at 1 even when the policy allows more (memo §7 item 2, unchanged)", () => {
    const plan = buildRetrievalPlan("agent loop", { ...policy, maxGraphDepth: 2 });
    expect(plan.graph.maxDepth).toBe(1);
  });
});

describe("inferIntents", () => {
  it.each([
    ["which company built this", "entity_discovery"],
    ["how do I implement this api", "implementation_support"],
    ["compare the best tool", "tool_selection"],
    ["what evidence supports this claim", "knowledge_evidence"],
  ])("infers %s -> includes %s", (query, expected) => {
    expect(inferIntents(query)).toContain(expected);
  });

  it("falls back to decision_support when nothing matches", () => {
    expect(inferIntents("xyzzy")).toEqual(["decision_support"]);
  });
});
