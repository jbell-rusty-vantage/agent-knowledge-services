import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_DIMENSIONS } from "./types.js";
import { cacheKey, validateVector, vectorDigest } from "./vectors.js";

describe("validateVector", () => {
  it("rejects wrong dimensions and non-finite values", () => {
    expect(() => validateVector([1, 2], 3)).toThrow("DIMENSION");
    expect(() => validateVector([1, Number.NaN, 3], 3)).toThrow("NON_FINITE");
    expect(() =>
      validateVector(Array(DEFAULT_EMBEDDING_DIMENSIONS - 1).fill(0), DEFAULT_EMBEDDING_DIMENSIONS),
    ).toThrow();
  });
});

describe("vectorDigest", () => {
  it("is stable for the same vector and differs for -0 versus 0", () => {
    const vector = [1, 2, 3];
    expect(vectorDigest(vector)).toBe(vectorDigest([...vector]));
    expect(vectorDigest([-0, 1, 2])).not.toBe(vectorDigest([0, 1, 2]));
  });
});

describe("cacheKey", () => {
  it("namespaces the cache key by vectorSpaceVersionId", () => {
    expect(cacheKey("version-1", "sha256:abc")).toBe("version-1:sha256:abc");
    expect(cacheKey("version-1", "sha256:abc")).not.toBe(cacheKey("version-2", "sha256:abc"));
  });
});
