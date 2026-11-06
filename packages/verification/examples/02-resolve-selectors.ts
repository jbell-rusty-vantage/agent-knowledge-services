import {
  canonicalizeJson,
  projectionSelectorResolver,
  resolveEvidenceSelector,
  sha256Digest,
  type VerificationSelector,
  type EvidenceSelection,
} from "../src/index.js";

/** Synthetic parser outputs, not evidence that a parser can acquire these media. */
export interface SelectorExample {
  readonly name: string;
  readonly content: string;
  readonly selector: VerificationSelector;
  readonly expectedText: string;
}

const projection = (value: unknown): string => canonicalizeJson(value);
const pdfText = "Panel value 42";
const commit = "a".repeat(40);

export const selectorExamples: readonly SelectorExample[] = [
  {
    name: "exact quote",
    content: "The count is 42.",
    selector: { kind: "text_quote", quote: "42", normalization: "none" },
    expectedText: "42",
  },
  {
    name: "Unicode character position",
    content: "A😀42",
    selector: {
      kind: "character_position",
      start: 2,
      end: 4,
      offsetBasis: "unicode_code_points",
      normalization: "none",
    },
    expectedText: "42",
  },
  {
    name: "JSON pointer",
    content: '{"count":42}',
    selector: { kind: "json_pointer", pointer: "/count" },
    expectedText: "42",
  },
  {
    name: "multiple text fragments",
    content: "Count: 42; provisional.",
    selector: {
      kind: "multi_fragment_text",
      fragments: [
        { kind: "text_quote", quote: "42", normalization: "none" },
        { kind: "text_quote", quote: "provisional", normalization: "none" },
      ],
      joiner: " … ",
    },
    expectedText: "42 … provisional",
  },
  {
    name: "HTML DOM",
    content: projection({
      kind: "html_dom",
      document: { tag: "p", id: "count", text: "42" },
    }),
    selector: { kind: "html", css: "#count" },
    expectedText: "42",
  },
  {
    name: "PDF physical page",
    content: projection({
      kind: "pdf_text",
      pageCount: 1,
      pages: [
        {
          physicalPageNumber: 1,
          text: pdfText,
          textLayerDigest: sha256Digest(pdfText),
          widthPoints: 612,
          heightPoints: 792,
        },
      ],
    }),
    selector: {
      kind: "pdf_text",
      page: 1,
      start: 12,
      end: 14,
      offsetBasis: "utf16_code_units",
      textLayerDigest: sha256Digest(pdfText),
    },
    expectedText: "42",
  },
  {
    name: "image or PDF geometry",
    content: projection({
      kind: "geometry",
      pages: [
        {
          imageWidth: 100,
          imageHeight: 100,
          tokens: [
            {
              text: "42",
              x: 10,
              y: 10,
              width: 20,
              height: 10,
              coordinateSpace: "pixels",
              order: 0,
            },
          ],
        },
      ],
    }),
    selector: {
      kind: "bounding_box",
      coordinateSpace: "pixels",
      imageWidth: 100,
      imageHeight: 100,
      x: 10,
      y: 10,
      width: 20,
      height: 10,
    },
    expectedText: '"text":"42"',
  },
  {
    name: "table cell with header",
    content: projection({
      kind: "table",
      tables: [
        {
          tableId: "counts",
          cells: [{ row: 0, column: 0, value: "42", headerPath: ["Count"] }],
        },
      ],
    }),
    selector: {
      kind: "table",
      tableId: "counts",
      row: 0,
      column: 0,
      headerPath: ["Count"],
      expectedCellValue: "42",
    },
    expectedText: '"value":"42"',
  },
  {
    name: "audio/video transcript interval",
    content: projection({
      kind: "transcript",
      durationMs: 2000,
      segments: [
        {
          segmentId: "s1",
          startMs: 0,
          endMs: 1000,
          speaker: "A",
          channel: "left",
          text: "42",
        },
      ],
    }),
    selector: {
      kind: "media_timecode",
      startMs: 0,
      endMs: 1000,
      speaker: "A",
      channel: "left",
    },
    expectedText: '"text":"42"',
  },
  {
    name: "repository at a commit",
    content: projection({
      kind: "repository",
      commit,
      lineRangeConvention: "zero_based_half_open",
      files: [{ path: "src/count.ts", content: "export const count = 42;" }],
    }),
    selector: {
      kind: "repository",
      commit,
      path: "src/count.ts",
      rangeKind: "lines",
      start: 0,
      end: 1,
    },
    expectedText: "export const count = 42;",
  },
  {
    name: "versioned dataset cell",
    content: projection({
      kind: "dataset",
      datasetVersionId: "counts-v1",
      rows: [{ key: "sample", value: { count: 42 } }],
    }),
    selector: {
      kind: "dataset",
      datasetVersionId: "counts-v1",
      rowKey: "sample",
      column: "count",
    },
    expectedText: "42",
  },
  {
    name: "paginated API field",
    content: projection({
      kind: "paginated_api",
      apiVersion: "v1",
      queryDigest: sha256Digest("counts"),
      pages: [
        {
          pageKey: "page-1",
          records: [{ recordKey: "sample", value: { count: 42 } }],
        },
      ],
    }),
    selector: {
      kind: "api_record",
      pageKey: "page-1",
      recordKey: "sample",
      fieldPointer: "/count",
    },
    expectedText: "42",
  },
];

export function resolveExample(example: SelectorExample): EvidenceSelection | undefined {
  const content = new TextEncoder().encode(example.content);
  return resolveEvidenceSelector(
    {
      captureId: "synthetic-capture",
      representationArtifactId: "11111111-1111-4111-8111-111111111111",
      representationDigest: sha256Digest(content),
      content,
      selector: example.selector,
    },
    [projectionSelectorResolver],
  );
}
