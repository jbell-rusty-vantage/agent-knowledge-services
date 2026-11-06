import { describe, expect, it } from "vitest";
import { MemoryEmbeddingCache } from "./cache.js";

describe("MemoryEmbeddingCache", () => {
  it("returns undefined for a key it has not seen", () => {
    expect(new MemoryEmbeddingCache().get("missing")).toBeUndefined();
  });

  it("stores a frozen copy of the vector it was given, not the original array", () => {
    const cache = new MemoryEmbeddingCache();
    const vector = [1, 2, 3];
    cache.set("key", vector);
    vector.push(4);
    const stored = cache.get("key");
    expect(stored).toEqual([1, 2, 3]);
    expect(Object.isFrozen(stored)).toBe(true);
  });
});
