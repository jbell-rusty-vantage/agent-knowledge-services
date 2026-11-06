import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalJson, digestBytes, digestCanonical } from "./canonical.js";

describe("kop-canonical-json.v1", () => {
  it("sorts keys, drops whitespace and omits undefined properties", () => {
    expect(canonicalJson({ b: 1, a: { d: null, c: [true, "x"] }, e: undefined })).toBe(
      '{"a":{"c":[true,"x"],"d":null},"b":1}',
    );
  });

  it("never normalizes Unicode and writes strings as JSON.stringify does", () => {
    const composed = "Café";
    const decomposed = "Café";
    expect(canonicalJson({ s: composed })).not.toBe(canonicalJson({ s: decomposed }));
    expect(canonicalJson({ s: "a\r\nb\t🧪" })).toBe('{"s":"a\\r\\nb\\t🧪"}');
    expect(canonicalJson({ s: " " })).toBe('{"s":" "}');
  });

  it("refuses non-integer numbers and undefined array members", () => {
    expect(() => canonicalJson({ n: 1.5 })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ n: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/safe integers/);
    expect(() => canonicalJson([1, undefined as unknown as number])).toThrow(/undefined/);
    expect(canonicalJson({ z: -0 })).toBe('{"z":0}');
  });

  it("sorts keys by UTF-16 code units, not code points", () => {
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FF61 although its code point is larger.
    expect(canonicalJson({ "｡": 1, "\u{1F600}": 2 })).toBe('{"\u{1F600}":2,"｡":1}');
  });

  it("refuses lone surrogates in values and keys; a paired surrogate is fine", () => {
    expect(() => canonicalJson({ s: "a\uD800b" })).toThrow(/lone surrogate/);
    expect(() => canonicalJson({ s: "\uDC00" })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ "\uD83D": 1 })).toThrow(/lone surrogate/);
    expect(canonicalJson({ s: "😀" })).toBe('{"s":"\u{1F600}"}');
  });

  it("digests bytes and canonical values deterministically", () => {
    expect(digestBytes("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(digestCanonical({ a: 1, b: [2, 3] })).toBe(digestCanonical({ b: [2, 3], a: 1 }));
    expect(digestCanonical({ a: 1 })).not.toBe(digestCanonical({ a: "1" }));
  });
});
