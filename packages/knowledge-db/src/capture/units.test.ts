import { describe, expect, it } from "vitest";
import { isKnowledgeError } from "../schema-workspace/index.js";
import { captureFormatCode, normalizeCaptureMediaType, planCaptureUnits } from "./units.js";

const REPRESENTATION = "0192d000-0000-7000-8000-000000000001";
const plan = (text: string, sourceMediaType: "text/plain" | "text/markdown" | "text/html" | "application/json") =>
  planCaptureUnits({ representationId: REPRESENTATION, text, sourceMediaType });
const refusal = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (isKnowledgeError(error)) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("capture units", () => {
  it("splits Markdown into typed units through the repository's deterministic conversion, each a slice of the text", () => {
    const text = "# Persistence\n\nCheckpointers save state.\n\n## Threads\n\n- one\n- two\n\n```python\nprint(1)\n```";
    const units = plan(text, "text/markdown");
    expect(units.map((unit) => unit.unitKind)).toEqual(["section", "paragraph", "section", "list", "code_block"]);
    for (const unit of units) expect(text.slice(unit.startOffset ?? -1, unit.endOffset ?? -1)).toBe(unit.text);
    expect(units[0]?.attributes).toEqual({ path: "Persistence", heading: "Persistence", level: 1 });
    expect(units[1]?.attributes).toEqual({ path: "Persistence" });
    expect(units[3]?.attributes).toMatchObject({ items: 2, ordered: false, path: "Persistence > Threads" });
    expect(units[4]?.attributes).toMatchObject({ lines: 3, language: "python" });
    expect(units.map((unit) => unit.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(units.map((unit) => unit.stableLocalKey)).size).toBe(units.length);
    expect(
      units.every((unit) => unit.selector.kind === "text_quote" && /^[0-9a-f]{64}$/.test(unit.contentSha256)),
    ).toBe(true);
  });

  it("is deterministic: the same text and representation give the same unit ids", () => {
    const text = "One paragraph.\n\nAnother paragraph.";
    expect(plan(text, "text/plain").map((unit) => unit.id)).toEqual(plan(text, "text/plain").map((unit) => unit.id));
    expect(
      planCaptureUnits({
        representationId: "0192d000-0000-7000-8000-000000000002",
        text,
        sourceMediaType: "text/plain",
      })[0]?.id,
    ).not.toBe(plan(text, "text/plain")[0]?.id);
  });

  it("reads the executor's HTML rendering one line at a time", () => {
    const text = "Title\nFirst paragraph of the page.\nSecond paragraph.";
    const units = plan(text, "text/html");
    expect(units.map((unit) => unit.text)).toEqual(["Title", "First paragraph of the page.", "Second paragraph."]);
    expect(units[1]).toMatchObject({ startOffset: 6, endOffset: 34 });
  });

  it("splits JSON into members with exact spans and json_pointer selectors, and large members into theirs", () => {
    const text = JSON.stringify({ probe: "P-1", checks: { holds: true, "a/b": 2 }, runs: [1, 2] }, null, 2);
    const units = plan(text, "application/json");
    expect(units.map((unit) => unit.selector)).toEqual([
      { kind: "json_pointer", pointer: "/probe" },
      { kind: "json_pointer", pointer: "/checks" },
      { kind: "json_pointer", pointer: "/runs" },
    ]);
    for (const unit of units) expect(text.slice(unit.startOffset ?? -1, unit.endOffset ?? -1)).toBe(unit.text);
    expect(units[0]).toMatchObject({
      unitKind: "metadata_field",
      text: '"probe": "P-1"',
      attributes: { key: "/probe", value: "P-1" },
    });
    expect(units[1]?.attributes).toEqual({ key: "/checks" });
    expect(units[1]?.text).toContain('"holds": true');

    const big = JSON.stringify({ items: Array.from({ length: 60 }, (_, index) => ({ index, note: "x".repeat(40) })) });
    const split = plan(big, "application/json");
    expect(split).toHaveLength(60);
    expect(split[7]?.selector).toEqual({ kind: "json_pointer", pointer: "/items/7" });
    expect(JSON.parse(split[7]?.text ?? "null")).toEqual({ index: 7, note: "x".repeat(40) });

    const escaped = plan(JSON.stringify({ "a/b~c": 1 }), "application/json");
    expect(escaped[0]?.selector).toEqual({ kind: "json_pointer", pointer: "/a~1b~0c" });
    expect(plan(" 42 ", "application/json")).toMatchObject([{ unitKind: "document_root", text: "42", startOffset: 1 }]);
  });

  it("refuses JSON that does not parse, text with nothing to quote and oversized text, with stable codes", () => {
    expect(refusal(() => plan("{ not json", "application/json")).code).toBe("CAPTURE_JSON_INVALID");
    expect(refusal(() => plan("  \n\n ", "text/plain")).code).toBe("CAPTURE_HAS_NO_TEXT");
    expect(refusal(() => plan("x".repeat(8_000_001), "text/plain")).code).toBe("CAPTURE_TOO_LARGE");
  });

  it("names the media types and formats it registers", () => {
    expect(normalizeCaptureMediaType("text/markdown; charset=utf-8")).toBe("text/markdown");
    expect(normalizeCaptureMediaType("application/xhtml+xml")).toBe("text/html");
    expect(captureFormatCode("application/json")).toBe("json");
    expect(captureFormatCode("text/plain")).toBe("text");
  });
});
