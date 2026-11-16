import { describe, expect, it } from "vitest";
import { documentNodeKindOf, documentNodeUnit } from "./document-node-units.js";

const locator = { representationId: "0192d000-0000-7000-8000-000000000001" };

describe("document nodes as typed units of the current schema", () => {
  it("writes each node kind as one unit kind and reads it back as the same node kind", () => {
    for (const kind of ["heading", "paragraph", "list", "table", "figure", "code_block"] as const) {
      const unit = documentNodeUnit({ kind, locator });
      expect(documentNodeKindOf(unit.unitKind)).toBe(kind);
    }
    expect(documentNodeUnit({ kind: "heading", locator: { ...locator, sectionPath: ["A", "B"] } })).toEqual({
      unitKind: "section",
      attributes: { path: "A > B" },
      startMs: null,
      endMs: null,
    });
  });

  it("gives a transcript segment the time code its unit kind requires, and refuses one without it", () => {
    expect(
      documentNodeUnit({ kind: "transcript_segment", locator: { ...locator, startTimeMs: 1200, endTimeMs: 4800 } }),
    ).toEqual({
      unitKind: "transcript_segment",
      attributes: { t0_ms: 1200, t1_ms: 4800 },
      startMs: 1200,
      endMs: 4800,
    });
    expect(() => documentNodeUnit({ kind: "transcript_segment", locator })).toThrow(
      "DOCUMENT_NODE_TIMECODE_REQUIRED:transcript_segment",
    );
  });

  it("refuses a node kind with no faithful unit kind instead of writing it as another", () => {
    expect(() => documentNodeUnit({ kind: "formula", locator })).toThrow("DOCUMENT_NODE_KIND_UNSUPPORTED:formula");
    expect(() => documentNodeUnit({ kind: "citation", locator })).toThrow("DOCUMENT_NODE_KIND_UNSUPPORTED:citation");
    expect(() => documentNodeKindOf("price_row")).toThrow("DOCUMENT_NODE_UNIT_KIND_UNREADABLE:price_row");
  });
});
