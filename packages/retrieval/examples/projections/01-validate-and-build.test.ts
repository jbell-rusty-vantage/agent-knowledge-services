import { describe, expect, it } from "vitest";
import { validateAndBuildExample } from "./01-validate-and-build.js";

describe("example 01: validate and build", () => {
  it("validates the evidence support set before building", () => {
    expect(validateAndBuildExample().valid).toBe(true);
  });

  it("derives the same projectionId from the same evidence and text", () => {
    expect(validateAndBuildExample().deterministic).toBe(true);
  });
});
