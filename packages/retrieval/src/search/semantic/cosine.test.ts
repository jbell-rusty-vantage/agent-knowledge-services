import { describe, expect, it } from "vitest";
import { cosine } from "./cosine.js";

describe("cosine", () => {
  it("throws QUERY_VECTOR_DIMENSION_MISMATCH for mismatched lengths", () => {
    expect(() => cosine([1, 0], [1, 0, 0])).toThrow("QUERY_VECTOR_DIMENSION_MISMATCH:2:3");
  });

  it("throws NON_FINITE_VECTOR when either vector holds a non-finite component", () => {
    expect(() => cosine([1, Number.NaN], [1, 0])).toThrow("NON_FINITE_VECTOR");
    expect(() => cosine([1, 0], [1, Number.POSITIVE_INFINITY])).toThrow("NON_FINITE_VECTOR");
  });

  it("is 1 for identical direction and 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it("is 0 when either vector has zero magnitude", () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});
