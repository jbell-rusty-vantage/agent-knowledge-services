import { describe, expect, it } from "vitest";
import {
  prototypeSha256,
  replayPrototypeArithmetic,
  resolvePrototypeJsonPointer,
  resolvePrototypeTextLocator,
} from "./index.js";

describe("prototype compatibility boundary", () => {
  it("keeps frozen legacy digest and text-locator outputs", () => {
    expect(prototypeSha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(
      resolvePrototypeTextLocator("Intro. RAG was basically just a hack.", {
        kind: "text_quote",
        quote: "RAG was basically just a hack",
        offsetBasis: "raw_utf16",
      }),
    ).toEqual({
      matchMode: "exact",
      start: 7,
      end: 36,
      selectedContentSha256: "ceeff18e421941a228b863d1d0464c596dc0e0c936a22d8a79d790a1f38a7530",
      occurrenceCount: 1,
    });
    expect(
      resolvePrototypeTextLocator("some sort of uh default agent that does search", {
        kind: "text_quote",
        quote: "some sort of default agent that does search",
        offsetBasis: "raw_utf16",
      }),
    ).toEqual({
      matchMode: "normalized",
      start: 0,
      end: 46,
      selectedContentSha256: "e06a2515f4ae8f29ca2db0acf122784df012537da3cdfdab6f2f99a324094962",
      occurrenceCount: 1,
    });
  });

  it("retains the three historical coordinate transforms", () => {
    const content = "A\r\n  B\nC";
    expect(
      resolvePrototypeTextLocator(content, {
        kind: "text_quote",
        quote: "B",
        offsetBasis: "raw_utf16",
      }),
    ).toMatchObject({ matchMode: "exact", start: 5, end: 6 });
    expect(
      resolvePrototypeTextLocator(content, {
        kind: "text_quote",
        quote: "B",
        offsetBasis: "lf_normalized",
      }),
    ).toMatchObject({ matchMode: "exact", start: 4, end: 5 });
    expect(
      resolvePrototypeTextLocator(content, {
        kind: "text_quote",
        quote: "A B C",
        offsetBasis: "lf_normalized_newlines_collapsed",
      }),
    ).toMatchObject({ matchMode: "exact", start: 0, end: 5 });
  });

  it("keeps JSON pointer serialization and escapes", () => {
    expect(resolvePrototypeJsonPointer('{"a":{"b/c":{"~key":7}}}', "/a/b~1c/~0key")).toEqual({
      matchMode: "json_pointer",
      start: null,
      end: null,
      selectedContentSha256: "7902699be42c8a8e46fbbb4501726517e86b22c56a189f7625a6da49081b2451",
      occurrenceCount: 1,
      value: 7,
    });
  });

  it("retains legacy IEEE arithmetic without granting authenticated KS status", () => {
    expect(replayPrototypeArithmetic("sum", [10, 15])).toBe(25);
    expect(replayPrototypeArithmetic("percent_change", [10, 15])).toBe(50);
    expect(Number.isNaN(replayPrototypeArithmetic("ratio", [1, 0]))).toBe(true);
  });
});
