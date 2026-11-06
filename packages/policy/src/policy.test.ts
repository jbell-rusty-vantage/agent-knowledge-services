import { describe, expect, it } from "vitest";
import { isAuthorized, validateRetrievalPlan } from "./index.js";

const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
describe("policy", () => {
  it("does not grant decision or publication authority to curator models", () => {
    const actor = {
      kind: "model" as const,
      id: id(1),
      serviceIdentity: "content_curator_agent" as const,
      model: "m",
      providerRunId: "r",
    };
    expect(isAuthorized(actor, "proposal.submit")).toBe(true);
    expect(isAuthorized(actor, "decision.record")).toBe(false);
    expect(isAuthorized(actor, "publication.execute")).toBe(false);
  });
  it("rejects unauthorized spaces, filters, and excessive depth before execution", () => {
    const plan = {
      policyVersion: id(1),
      query: "q",
      intents: ["knowledge_evidence" as const],
      subqueries: [{ id: "q1", text: "q", coverageRole: "required" as const }],
      spaces: ["engineering_claims" as const],
      anchors: { entities: [], concepts: [], useCases: [] },
      hardFilters: [{ field: "language", op: "eq" as const, value: "typescript" }],
      softBoosts: [],
      temporalScope: {},
      candidateK: 50,
      finalK: 10,
      graph: { maxDepth: 1, allowedEdges: [] },
      abstention: { minimumCoverage: 1 },
    };
    expect(
      validateRetrievalPlan(plan, {
        allowedSpaces: ["engineering_claims"],
        allowedFilterFields: ["language"],
        maximumCandidateK: 100,
        maximumFinalK: 20,
        maximumGraphDepth: 2,
      }),
    ).toBe(plan);
    expect(() =>
      validateRetrievalPlan(plan, {
        allowedSpaces: ["entity_profiles"],
        allowedFilterFields: ["language"],
        maximumCandidateK: 100,
        maximumFinalK: 20,
        maximumGraphDepth: 2,
      }),
    ).toThrowError(/not authorized/);
  });
});
