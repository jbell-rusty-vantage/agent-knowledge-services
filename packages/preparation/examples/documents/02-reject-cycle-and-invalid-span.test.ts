import { describe, expect, it } from "vitest";
import { rejectCycleAndInvalidSpanExample } from "./02-reject-cycle-and-invalid-span.js";

describe("example 02: reject a cycle and an invalid span", () => {
  it("fails the whole document on a structural cycle or unknown parent", () => {
    const result = rejectCycleAndInvalidSpanExample();
    expect(result.cycle).toMatch(/Structural parent cycle/);
    expect(result.unknownParent).toMatch(/Unknown parentKey: missing/);
  });

  it("refuses spans outside the sealed text", () => {
    const result = rejectCycleAndInvalidSpanExample();
    expect(result.invalidSpan).toMatch(/^RangeError: Invalid node span 0:10000/);
    expect(result.emptySpan).toMatch(/^RangeError: Invalid node span 4:4/);
  });

  it("reports a node whose text was edited after sealing", () => {
    expect(rejectCycleAndInvalidSpanExample().editedNodeIssues).toEqual([
      expect.stringMatching(/quote digest mismatch$/),
    ]);
  });
});
