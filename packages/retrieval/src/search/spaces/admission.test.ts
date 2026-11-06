import { describe, expect, it } from "vitest";
import { VectorSpaceSchema } from "@aiengineer/knowledge-contracts";
import { ALL_SPACES, assertAdmittedSpaces, inferSpaces } from "./admission.js";

describe("ALL_SPACES", () => {
  it("is derived from VectorSpaceSchema.options, not a hand-written copy (P2-9)", () => {
    expect(ALL_SPACES).toEqual(VectorSpaceSchema.options);
  });
});

describe("inferSpaces", () => {
  it.each([
    ["benchmark scores", ["benchmark_intelligence"]],
    ["which model is best", ["model_capabilities", "engineering_claims"]],
    ["implement the api", ["implementation_examples", "tool_capabilities", "source_native_sections"]],
    ["read the paper", ["paper_case_study_knowledge", "source_native_sections"]],
    ["which company built this", ["entity_profiles", "engineering_claims"]],
  ])("infers spaces for %j", (query, expected) => {
    expect(inferSpaces(query)).toEqual(expected);
  });

  it("falls back to every admitted space when nothing matches", () => {
    // Covers the remaining branch and, together with the cases above, exercises
    // all eight VectorSpace values across the inference function.
    expect(inferSpaces("xyzzy")).toEqual(ALL_SPACES);
  });
});

describe("assertAdmittedSpaces", () => {
  it("throws SPACE_NOT_ADMITTED with the denied spaces listed, in order", () => {
    expect(() =>
      assertAdmittedSpaces(["benchmark_intelligence", "model_capabilities"], ["engineering_claims"]),
    ).toThrow("SPACE_NOT_ADMITTED:benchmark_intelligence,model_capabilities");
  });

  it("passes silently when every requested space is admitted", () => {
    expect(() =>
      assertAdmittedSpaces(["engineering_claims"], ["engineering_claims", "model_capabilities"]),
    ).not.toThrow();
  });
});
