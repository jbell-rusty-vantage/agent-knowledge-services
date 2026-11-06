import { describe, expect, it } from "vitest";
import { exactSearchExample } from "./01-exact-search.js";

describe("example 01: exact search", () => {
  it("isolates by tenant, vector-space version and lifecycle, and orders deterministically", async () => {
    const result = await exactSearchExample();
    expect(result.visibleItemIds).toEqual(["match-a", "match-b", "orthogonal"]);
    expect(result.deterministic).toBe(true);
  });
});
