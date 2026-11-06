import { canonicalizeJson, digestCanonicalJson, isSha256Digest, sha256Digest } from "../src/index.js";

/**
 * Stage 0 — primitives. Every digest in the package is SHA-256 over RFC 8785
 * canonical JSON, so two objects that differ only in key order or whitespace
 * hash identically, and a digest string has one recognizable shape.
 */
export const shuffled = { z: 1, a: { d: [true, null], b: "two" } };
export const ordered = { a: { b: "two", d: [true, null] }, z: 1 };

export function canonicalDigestExample() {
  return {
    canonicalForm: canonicalizeJson(shuffled),
    sameCanonicalForm: canonicalizeJson(shuffled) === canonicalizeJson(ordered),
    digest: digestCanonicalJson(shuffled),
    sameDigest: digestCanonicalJson(shuffled) === digestCanonicalJson(ordered),
    rawBytesDigest: sha256Digest(new TextEncoder().encode("42")),
    rawTextDigest: sha256Digest("42"),
    recognizesDigest: isSha256Digest(digestCanonicalJson(shuffled)),
    rejectsBareHex: isSha256Digest("a".repeat(64)),
  };
}
