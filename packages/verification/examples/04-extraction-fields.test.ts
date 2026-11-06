import { describe, expect, it } from "vitest";
import { acceptedLeaves, extractionFieldsExample } from "./04-extraction-fields.js";

describe("example 04: extraction fields", () => {
  it("accepts both fields when evidence resolves to the same scalars", () => {
    const result = extractionFieldsExample();
    expect(result.valid).toBe(true);
    expect(acceptedLeaves(result).map((leaf) => leaf.path)).toEqual(["/total", "/vendor"]);
  });

  it("compares decimal fields numerically", () => {
    const total = acceptedLeaves(extractionFieldsExample()).find((leaf) => leaf.path === "/total");
    expect(total).toMatchObject({ value: "12.5", rawValue: "12.50" });
  });

  it("rejects an exact field whose candidate text differs", () => {
    const result = extractionFieldsExample({
      vendor: "Northwind  Labs",
      total: "12.5",
    });
    expect(result.valid).toBe(false);
    expect(result.acceptedLeaves).toEqual([]);
  });
});
