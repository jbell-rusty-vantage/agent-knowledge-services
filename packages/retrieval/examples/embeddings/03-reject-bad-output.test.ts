import { describe, expect, it } from "vitest";
import { rejectBadOutputExample } from "./03-reject-bad-output.js";

describe("example 03: reject bad output", () => {
  it("rejects reordered, partial, wrong-dimension and non-finite responses", async () => {
    const results = await rejectBadOutputExample();
    expect(results.reordered).toMatch(/ORDER_MISMATCH/);
    expect(results.partial).toMatch(/COUNT_MISMATCH/);
    expect(results.wrongDimension).toMatch(/DIMENSION_MISMATCH/);
    expect(results.nonFinite).toMatch(/NON_FINITE/);
  });
});
