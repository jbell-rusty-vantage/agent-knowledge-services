import { describe, expect, it } from "vitest";
import { VerificationSelectorSchema } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "../canonical/index.js";
import { resolveEvidenceSelector } from "./resolve-evidence-selector.js";
import { parseCanonicalProjection } from "./projections/index.js";
import { projectionSelectorResolver } from "./projection-resolver.js";

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalizeJson(value));
const request = (content: Uint8Array, selector: any) => ({
  captureId: "capture-01",
  representationArtifactId: "11111111-1111-4111-8111-111111111111",
  representationDigest: sha256Digest(content),
  selector,
  content,
});
const status = (content: Uint8Array, selector: any) =>
  projectionSelectorResolver.resolve(request(content, selector)).resolution.status;

describe("synthetic canonical selector projections", () => {
  it("selects exact HTML field ranges without weakening DOM uniqueness, fallback, or Unicode boundaries", () => {
    const text = "A😀 75+ biomarkers";
    const html = bytes({
      kind: "html_dom",
      canonicalText: text,
      document: {
        tag: "main",
        children: [
          { tag: "p", id: "metrics", text },
          { tag: "p", text: "75+" },
        ],
      },
    });
    const selector = {
      kind: "html",
      css: "#metrics",
      textRange: { start: 4, end: 7 },
    };
    expect(VerificationSelectorSchema.safeParse(selector).success).toBe(true);
    const result = projectionSelectorResolver.resolve(request(html, selector));
    expect(result.resolution.status).toBe("resolved");
    expect(new TextDecoder().decode(result.selectedContent)).toBe("75+");
    expect(result.resolution.resolvedRanges).toEqual([{ start: 4, end: 7, coordinateSpace: "html_dom_text_utf16" }]);
    expect(status(html, { ...selector, css: "p" })).toBe("ambiguous");
    for (const textRange of [
      { start: -1, end: 2 },
      { start: 4, end: 4 },
      { start: 0, end: 999 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
      { start: 1.5, end: 3 },
    ])
      expect(status(html, { ...selector, textRange })).toBe("invalid");
    expect(
      VerificationSelectorSchema.safeParse({
        ...selector,
        textRange: { start: 7, end: 4 },
      }).success,
    ).toBe(false);
    expect(
      status(html, {
        ...selector,
        canonicalTextFallback: {
          kind: "text_quote",
          quote: text,
          normalization: "none",
        },
      }),
    ).toBe("resolved");
    expect(
      status(html, {
        ...selector,
        canonicalTextFallback: {
          kind: "text_quote",
          quote: "75+",
          normalization: "none",
        },
      }),
    ).toBe("invalid");
    expect(
      new TextDecoder().decode(
        projectionSelectorResolver.resolve(request(html, { kind: "html", css: "#metrics" })).selectedContent,
      ),
    ).toBe(text);
  });
  it("requires one agreeing, unique DOM target and never treats the fallback as a selector", () => {
    const html = bytes({
      kind: "html_dom",
      canonicalText: "Native summary",
      document: {
        tag: "main",
        children: [
          {
            tag: "p",
            id: "summary",
            attributes: { "data-evidence": "yes" },
            text: "Native summary",
          },
          { tag: "p", text: "Native summary" },
          { tag: "script", id: "ignored", text: "poison" },
        ],
      },
    });
    const result = projectionSelectorResolver.resolve(
      request(html, {
        kind: "html",
        css: "#summary",
        xpath: "//p[@id='summary']",
        domPath: "0",
        canonicalTextFallback: {
          kind: "text_quote",
          quote: "Native summary",
          normalization: "none",
        },
      }),
    );
    expect(result.resolution.status).toBe("resolved");
    expect(new TextDecoder().decode(result.selectedContent)).toBe("Native summary");
    expect(status(html, { kind: "html", css: "p" })).toBe("ambiguous");
    expect(
      status(html, {
        kind: "html",
        css: "#summary",
        canonicalTextFallback: {
          kind: "text_quote",
          quote: "other",
          normalization: "none",
        },
      }),
    ).toBe("invalid");
    expect(status(html, { kind: "html", css: "article" })).toBe("invalid");
    expect(status(html, { kind: "html", css: "#ignored" })).toBe("invalid");
    const hiddenAncestor = bytes({
      kind: "html_dom",
      document: {
        tag: "main",
        children: [
          {
            tag: "section",
            hidden: true,
            children: [{ tag: "p", id: "descendant", text: "not selectable" }],
          },
        ],
      },
    });
    expect(status(hiddenAncestor, { kind: "html", domPath: "0/0" })).toBe("invalid");
    const duplicateId = bytes({
      kind: "html_dom",
      document: {
        tag: "p",
        id: "visible",
        attributes: { id: "shadow" },
        text: "bad",
      },
    });
    expect(status(duplicateId, { kind: "html", css: "#visible" })).toBe("parse_error");
    expect(
      status(html, {
        kind: "html",
        css: "#summary",
        canonicalTextFallback: {
          kind: "text_quote",
          quote: " \n\t ",
          normalization: "lf_whitespace_collapsed",
        },
      }),
    ).toBe("invalid");
    const mixed = bytes({
      kind: "html_dom",
      document: { tag: "p", text: "A", children: [{ tag: "b", text: "B" }] },
    });
    expect(status(mixed, { kind: "html", css: "p" })).toBe("parse_error");
    const inline = bytes({
      kind: "html_dom",
      document: {
        tag: "p",
        children: [
          { tag: "#text", text: "A" },
          { tag: "b", text: "B" },
          { tag: "#text", text: "C" },
        ],
      },
    });
    expect(
      new TextDecoder().decode(
        projectionSelectorResolver.resolve(request(inline, { kind: "html", css: "p" })).selectedContent,
      ),
    ).toBe("ABC");
    const spacedInline = bytes({
      kind: "html_dom",
      document: {
        tag: "p",
        children: [
          { tag: "#text", text: "A " },
          { tag: "b", text: "B" },
          { tag: "#text", text: " C" },
        ],
      },
    });
    expect(
      new TextDecoder().decode(
        projectionSelectorResolver.resolve(request(spacedInline, { kind: "html", xpath: "//p" })).selectedContent,
      ),
    ).toBe("A B C");
  });

  it("uses physical PDF pages and exact text-layer hashes while preserving graph residuals", () => {
    const text = "Panel value 42";
    const pdf = bytes({
      kind: "pdf_text",
      pageCount: 2,
      pages: [
        {
          physicalPageNumber: 1,
          text: "cover",
          textLayerDigest: sha256Digest("cover"),
          widthPoints: 842,
          heightPoints: 1191,
        },
        {
          physicalPageNumber: 2,
          text,
          textLayerDigest: sha256Digest(text),
          widthPoints: 842,
          heightPoints: 1191,
        },
      ],
      residuals: [
        {
          kind: "unresolved_visual_content",
          physicalPageNumber: 2,
          detail: "chart numerals absent from native text",
        },
      ],
    });
    const selector = {
      kind: "pdf_text",
      page: 2,
      start: 12,
      end: 14,
      offsetBasis: "utf16_code_units",
      textLayerDigest: sha256Digest(text),
    };
    const result = projectionSelectorResolver.resolve(request(pdf, selector));
    expect(result.resolution.status).toBe("resolved");
    expect(result.resolution.resolvedRanges[0]?.coordinateSpace).toContain("pdf_physical_page_2");
    expect(status(pdf, { ...selector, page: 1 })).toBe("invalid");
    expect(status(pdf, { ...selector, textLayerDigest: sha256Digest("wrong") })).toBe("invalid");
    expect(status(pdf, { ...selector, start: 0, end: 99 })).toBe("invalid");
    const astral = "A😀B";
    const astralPdf = bytes({
      kind: "pdf_text",
      pageCount: 1,
      pages: [
        {
          physicalPageNumber: 1,
          text: astral,
          textLayerDigest: sha256Digest(astral),
          widthPoints: 1,
          heightPoints: 1,
        },
      ],
    });
    expect(
      status(astralPdf, {
        kind: "pdf_text",
        page: 1,
        start: 1,
        end: 2,
        offsetBasis: "utf16_code_units",
        textLayerDigest: sha256Digest(astral),
      }),
    ).toBe("invalid");
  });

  it("converts PDF points to normalized geometry and uses contained-token selection", () => {
    const geometry = bytes({
      kind: "geometry",
      pages: [
        {
          physicalPageNumber: 2,
          widthPoints: 200,
          heightPoints: 100,
          tokens: [
            {
              text: "42",
              x: 20,
              y: 10,
              width: 10,
              height: 10,
              coordinateSpace: "pdf_points",
              order: 0,
            },
            {
              text: "outside",
              x: 150,
              y: 10,
              width: 20,
              height: 10,
              coordinateSpace: "pdf_points",
              order: 1,
            },
          ],
        },
      ],
    });
    const selected = projectionSelectorResolver.resolve(
      request(geometry, {
        kind: "bounding_box",
        page: 2,
        coordinateSpace: "normalized",
        x: 0.05,
        y: 0.05,
        width: 0.2,
        height: 0.2,
      }),
    );
    expect(selected.resolution.status).toBe("resolved");
    expect(new TextDecoder().decode(selected.selectedContent)).toContain('"text":"42"');
    expect(
      status(geometry, {
        kind: "bounding_box",
        page: 2,
        coordinateSpace: "pixels",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        imageWidth: 1,
        imageHeight: 1,
      }),
    ).toBe("invalid");
    const image = bytes({
      kind: "geometry",
      pages: [
        {
          imageWidth: 200,
          imageHeight: 100,
          tokens: [
            {
              text: "pixel-bound",
              x: 20,
              y: 10,
              width: 20,
              height: 10,
              coordinateSpace: "pixels",
              order: 0,
            },
          ],
        },
      ],
    });
    const imageSelection = projectionSelectorResolver.resolve(
      request(image, {
        kind: "bounding_box",
        coordinateSpace: "pixels",
        x: 20,
        y: 10,
        width: 20,
        height: 10,
        imageWidth: 200,
        imageHeight: 100,
      }),
    );
    expect(imageSelection.resolution.status).toBe("resolved");
    expect(new TextDecoder().decode(imageSelection.selectedContent)).toContain('"text":"pixel-bound"');
    expect(
      status(image, {
        kind: "bounding_box",
        coordinateSpace: "pixels",
        x: 20,
        y: 10,
        width: 20,
        height: 10,
        imageWidth: 201,
        imageHeight: 100,
      }),
    ).toBe("invalid");
  });

  it("binds table coordinates, headers, and empty-cell values without selecting adjacent cells", () => {
    const table = bytes({
      kind: "table",
      tables: [
        {
          tableId: "table-01",
          cells: [
            { row: 0, column: 0, value: "", headerPath: ["Metric"] },
            { row: 0, column: 1, value: "21", headerPath: ["Systems"] },
          ],
        },
      ],
    });
    expect(
      status(table, {
        kind: "table",
        tableId: "table-01",
        row: 0,
        column: 0,
        headerPath: ["Metric"],
        expectedCellValue: "",
      }),
    ).toBe("resolved");
    expect(
      status(table, {
        kind: "table",
        tableId: "table-01",
        row: 0,
        column: 0,
        headerPath: ["Systems"],
      }),
    ).toBe("invalid");
    expect(
      status(table, {
        kind: "table",
        tableId: "table-01",
        row: 1,
        column: 0,
        headerPath: ["Metric"],
      }),
    ).toBe("not_found");
    const overlapping = bytes({
      kind: "table",
      tables: [
        {
          tableId: "table-01",
          cells: [
            {
              row: 0,
              column: 0,
              value: "merged",
              headerPath: ["Metric"],
              columnSpan: 2,
            },
            { row: 0, column: 1, value: "overlap", headerPath: ["Metric"] },
          ],
        },
      ],
    });
    expect(
      status(overlapping, {
        kind: "table",
        tableId: "table-01",
        row: 0,
        column: 0,
        headerPath: ["Metric"],
      }),
    ).toBe("parse_error");
  });

  it("uses half-open transcript windows and abstains on unscopeable speaker ambiguity", () => {
    const transcript = bytes({
      kind: "transcript",
      durationMs: 3000,
      segments: [
        {
          segmentId: "a",
          startMs: 0,
          endMs: 1000,
          text: "first",
          speaker: "A",
          channel: "left",
        },
        {
          segmentId: "b",
          startMs: 1000,
          endMs: 2000,
          text: "second",
          speaker: "B",
          channel: "right",
        },
      ],
    });
    expect(
      status(transcript, {
        kind: "media_timecode",
        startMs: 0,
        endMs: 1000,
        speaker: "A",
        channel: "left",
      }),
    ).toBe("resolved");
    expect(status(transcript, { kind: "media_timecode", startMs: 0, endMs: 2000 })).toBe("ambiguous");
    expect(
      status(transcript, {
        kind: "media_timecode",
        startMs: 1000,
        endMs: 2000,
        speaker: "A",
      }),
    ).toBe("not_found");
    const reversed = bytes({
      kind: "transcript",
      durationMs: 3000,
      segments: [
        { segmentId: "b", startMs: 1000, endMs: 2000, text: "second" },
        { segmentId: "a", startMs: 0, endMs: 1500, text: "first" },
      ],
    });
    expect(status(reversed, { kind: "media_timecode", startMs: 0, endMs: 2000 })).toBe("parse_error");
  });

  it("reads repository projection bytes only after full commit and safe-path binding", () => {
    const commit = "a".repeat(40);
    const repository = bytes({
      kind: "repository",
      commit,
      lineRangeConvention: "zero_based_half_open",
      files: [{ path: "src/emoji.ts", content: "const x = '😀';\nexport { x };" }],
    });
    expect(
      status(repository, {
        kind: "repository",
        commit,
        path: "src/emoji.ts",
        rangeKind: "lines",
        start: 1,
        end: 2,
      }),
    ).toBe("resolved");
    expect(
      status(repository, {
        kind: "repository",
        commit,
        path: "../secret",
        rangeKind: "lines",
        start: 0,
        end: 1,
      }),
    ).toBe("invalid");
    expect(
      status(repository, {
        kind: "repository",
        commit,
        path: "src/emoji.ts",
        rangeKind: "bytes",
        start: 11,
        end: 12,
      }),
    ).toBe("invalid");
  });

  it("enforces dataset version/key uniqueness and API pagination lineage", () => {
    const dataset = bytes({
      kind: "dataset",
      datasetVersionId: "dataset-v1",
      rows: [{ key: "r1", value: { value: 21, nullable: null } }],
    });
    expect(
      status(dataset, {
        kind: "dataset",
        datasetVersionId: "dataset-v1",
        rowKey: "r1",
        column: "value",
      }),
    ).toBe("resolved");
    expect(
      status(dataset, {
        kind: "dataset",
        datasetVersionId: "dataset-v2",
        rowKey: "r1",
      }),
    ).toBe("invalid");
    expect(
      status(dataset, {
        kind: "dataset",
        datasetVersionId: "dataset-v1",
        rowKey: "r1",
        column: "absent",
      }),
    ).toBe("not_found");
    const duplicateDataset = bytes({
      kind: "dataset",
      datasetVersionId: "dataset-v1",
      rows: [
        { key: "r1", value: 1 },
        { key: "r1", value: 2 },
      ],
    });
    expect(
      status(duplicateDataset, {
        kind: "dataset",
        datasetVersionId: "dataset-v1",
        rowKey: "r1",
      }),
    ).toBe("parse_error");

    const api = bytes({
      kind: "paginated_api",
      apiVersion: "2026-09",
      queryDigest: sha256Digest("query"),
      pages: [
        { pageKey: "p1", records: [{ recordKey: "same", value: { id: 1 } }] },
        { pageKey: "p2", records: [{ recordKey: "same", value: { id: 2 } }] },
      ],
    });
    expect(status(api, { kind: "api_record", recordKey: "same" })).toBe("ambiguous");
    expect(
      status(api, {
        kind: "api_record",
        pageKey: "p2",
        recordKey: "same",
        fieldPointer: "/id",
      }),
    ).toBe("resolved");
    expect(
      status(api, {
        kind: "api_record",
        pageKey: "missing",
        recordKey: "same",
      }),
    ).toBe("not_found");
  });

  it("fails closed when projection bytes are changed or are not canonical JSON", () => {
    const projection = bytes({
      kind: "dataset",
      datasetVersionId: "dataset-v1",
      rows: [{ key: "r1", value: 1 }],
    });
    const selector = {
      kind: "dataset",
      datasetVersionId: "dataset-v1",
      rowKey: "r1",
    };
    expect(
      projectionSelectorResolver.resolve({
        ...request(projection, selector),
        representationDigest: sha256Digest("different"),
      }).resolution.status,
    ).toBe("invalid");
    const nonCanonical = new TextEncoder().encode('{"rows":[],"datasetVersionId":"dataset-v1","kind":"dataset"}');
    expect(status(nonCanonical, selector)).toBe("parse_error");
    const bomb = bytes({
      kind: "table",
      tables: [
        {
          tableId: "table-01",
          cells: [{ row: 0, column: 0, value: "x", headerPath: ["x"], rowSpan: 1001 }],
        },
      ],
    });
    expect(
      status(bomb, {
        kind: "table",
        tableId: "table-01",
        row: 0,
        column: 0,
        headerPath: ["x"],
      }),
    ).toBe("parse_error");
    const manyMediumSpans = bytes({
      kind: "table",
      tables: [
        {
          tableId: "table-01",
          cells: Array.from({ length: 101 }, (_, row) => ({
            row,
            column: 0,
            value: "x",
            headerPath: ["x"],
            rowSpan: 1000,
          })),
        },
      ],
    });
    expect(
      status(manyMediumSpans, {
        kind: "table",
        tableId: "table-01",
        row: 0,
        column: 0,
        headerPath: ["x"],
      }),
    ).toBe("parse_error");
    const crossTableBudgetBomb = bytes({
      kind: "table",
      tables: ["table-01", "table-02"].map((tableId) => ({
        tableId,
        cells: Array.from({ length: 51 }, () => ({
          row: 0,
          column: 0,
          value: "x",
          headerPath: ["x"],
          rowSpan: 1000,
        })),
      })),
    });
    expect(() => parseCanonicalProjection(crossTableBudgetBomb)).toThrow(/TABLE_EXPANDED_CELL_BUDGET/);
    const coordinateOverflow = bytes({
      kind: "table",
      tables: [
        {
          tableId: "table-01",
          cells: [
            {
              row: Number.MAX_SAFE_INTEGER,
              column: 0,
              value: "x",
              headerPath: ["x"],
            },
          ],
        },
      ],
    });
    expect(() => parseCanonicalProjection(coordinateOverflow)).toThrow(/TABLE_COORDINATE_OVERFLOW/);
  });

  it("accepts a bounded geometry projection up to the native parser output cap only", () => {
    const geometry = (tokenCount: number) =>
      bytes({
        kind: "geometry",
        pages: [
          {
            physicalPageNumber: 1,
            widthPoints: 1,
            heightPoints: 1,
            tokens: Array.from({ length: tokenCount }, (_, order) => ({
              text: "x".repeat(60_000),
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              coordinateSpace: "pdf_points",
              order,
            })),
          },
        ],
      });
    const admitted = geometry(20);
    expect(admitted.byteLength).toBeGreaterThan(1_000_000);
    expect(admitted.byteLength).toBeLessThanOrEqual(4_000_000);
    expect(parseCanonicalProjection(admitted).kind).toBe("geometry");
    expect(() => parseCanonicalProjection(geometry(70))).toThrow(/PROJECTION_INVALID:BYTES/);
  });

  it("accepts native DOM output within 4MB while retaining string and other projection bounds", () => {
    const dom = (count: number, textLength = 60_000) =>
      bytes({
        kind: "html_dom",
        document: {
          tag: "body",
          children: Array.from({ length: count }, () => ({
            tag: "p",
            text: "x".repeat(textLength),
          })),
        },
      });
    expect(dom(20).byteLength).toBeGreaterThan(1_000_000);
    expect(parseCanonicalProjection(dom(20)).kind).toBe("html_dom");
    expect(() => parseCanonicalProjection(dom(70))).toThrow(/PROJECTION_INVALID:BYTES/);
    expect(() => parseCanonicalProjection(dom(11, 100_001))).toThrow(/PROJECTION_INVALID:DOM_TEXT/);
    const dataset = bytes({
      kind: "dataset",
      datasetVersionId: "v1",
      rows: Array.from({ length: 20 }, (_, index) => ({
        key: String(index),
        value: "x".repeat(60_000),
      })),
    });
    expect(() => parseCanonicalProjection(dataset)).toThrow(/PROJECTION_INVALID:BYTES/);
  });

  it("is admitted by the core port only when its canonical selected bytes replay", () => {
    const projection = bytes({
      kind: "dataset",
      datasetVersionId: "dataset-v1",
      rows: [{ key: "r1", value: { answer: 42 } }],
    });
    const selection = resolveEvidenceSelector(
      request(projection, {
        kind: "dataset",
        datasetVersionId: "dataset-v1",
        rowKey: "r1",
        column: "answer",
      }),
      [projectionSelectorResolver],
    );
    expect(selection?.resolution.status).toBe("resolved");
    expect(sha256Digest(selection!.selectedContent)).toBe(selection!.resolution.selectedContentDigest);
  });
});
