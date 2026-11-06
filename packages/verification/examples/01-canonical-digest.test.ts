import { describe, expect, it } from "vitest";
import { canonicalDigestExample } from "./01-canonical-digest.js";

describe("example 01: canonical digest", () => {
  it("orders keys canonically", () => {
    expect(canonicalDigestExample().canonicalForm).toBe('{"a":{"b":"two","d":[true,null]},"z":1}');
  });

  it("hashes key-reordered objects identically", () => {
    expect(canonicalDigestExample().sameDigest).toBe(true);
  });

  it("hashes text and its UTF-8 bytes identically", () => {
    const result = canonicalDigestExample();
    expect(result.rawTextDigest).toBe(result.rawBytesDigest);
  });

  it("recognizes only prefixed lowercase digests", () => {
    const result = canonicalDigestExample();
    expect(result.recognizesDigest).toBe(true);
    expect(result.rejectsBareHex).toBe(false);
  });
});
