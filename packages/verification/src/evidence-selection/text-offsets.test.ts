import { describe, expect, it } from "vitest";
import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "../canonical/index.js";
import { resolveEvidenceSelector } from "./resolve-evidence-selector.js";
import { projectionSelectorResolver } from "./projection-resolver.js";

type PositionSelector = Extract<VerificationSelector, { kind: "character_position" }>;
type OffsetRange = Pick<PositionSelector, "start" | "end" | "offsetBasis">;

const source = "A😀é42";

function resolveText(text: string, selector: VerificationSelector) {
  const content = new TextEncoder().encode(text);
  return resolveEvidenceSelector(
    {
      captureId: "capture-unicode",
      representationArtifactId: "11111111-1111-4111-8111-111111111111",
      representationDigest: sha256Digest(content),
      content,
      selector,
    },
    [projectionSelectorResolver],
  );
}

const adapters = [
  {
    name: "character positions",
    coordinateSpace: (basis: OffsetRange["offsetBasis"]) => basis,
    resolve: (range: OffsetRange, text = source) =>
      resolveText(text, {
        kind: "character_position",
        normalization: "none",
        ...range,
      }),
  },
  {
    name: "PDF text positions",
    coordinateSpace: (basis: OffsetRange["offsetBasis"]) => `pdf_physical_page_1:${basis}`,
    resolve: (range: OffsetRange, text = source) =>
      resolveText(
        canonicalizeJson({
          kind: "pdf_text",
          pageCount: 1,
          pages: [
            {
              physicalPageNumber: 1,
              text,
              textLayerDigest: sha256Digest(text),
              widthPoints: 612,
              heightPoints: 792,
            },
          ],
        }),
        {
          kind: "pdf_text",
          page: 1,
          textLayerDigest: sha256Digest(text),
          ...range,
        },
      ),
  },
];

const validRanges: readonly (OffsetRange & { expectedText: string })[] = [
  { offsetBasis: "utf16_code_units", start: 1, end: 3, expectedText: "😀" },
  { offsetBasis: "unicode_code_points", start: 1, end: 2, expectedText: "😀" },
  { offsetBasis: "utf8_bytes", start: 1, end: 5, expectedText: "😀" },
  { offsetBasis: "utf16_code_units", start: 4, end: 6, expectedText: "42" },
  { offsetBasis: "unicode_code_points", start: 3, end: 5, expectedText: "42" },
  { offsetBasis: "utf8_bytes", start: 7, end: 9, expectedText: "42" },
];

const invalidRanges: readonly OffsetRange[] = [
  { offsetBasis: "utf16_code_units", start: 1, end: 2 },
  { offsetBasis: "utf16_code_units", start: 2, end: 3 },
  { offsetBasis: "utf8_bytes", start: 1, end: 4 },
  { offsetBasis: "utf8_bytes", start: 2, end: 5 },
  { offsetBasis: "utf8_bytes", start: 5, end: 6 },
  { offsetBasis: "utf16_code_units", start: 0, end: 7 },
  { offsetBasis: "unicode_code_points", start: 0, end: 6 },
  { offsetBasis: "utf8_bytes", start: 0, end: 10 },
  { offsetBasis: "utf16_code_units", start: -1, end: 1 },
  { offsetBasis: "unicode_code_points", start: 1.5, end: 3 },
  { offsetBasis: "utf8_bytes", start: 1, end: 1 },
  { offsetBasis: "utf16_code_units", start: 3, end: 1 },
];

describe.each(adapters)("$name", (adapter) => {
  it.each(validRanges)("retains $offsetBasis coordinates [$start, $end)", (range) => {
    const result = adapter.resolve(range);
    expect(result?.resolution.status).toBe("resolved");
    expect(new TextDecoder().decode(result?.selectedContent)).toBe(range.expectedText);
    expect(result?.resolution.resolvedRanges).toEqual([
      {
        start: range.start,
        end: range.end,
        coordinateSpace: adapter.coordinateSpace(range.offsetBasis),
      },
    ]);
  });

  it.each(invalidRanges)("rejects incomplete or invalid $offsetBasis coordinates [$start, $end)", (range) => {
    const result = adapter.resolve(range);
    expect(result?.resolution.status).toBe("invalid");
    expect(result?.selectedContent).toHaveLength(0);
    expect(result?.resolution.resolvedRanges).toEqual([]);
  });

  it.each([
    { start: 0, end: 1, expectedText: "A" },
    { start: 1, end: 4, expectedText: "\uFEFF" },
    { start: 1, end: 5, expectedText: "\uFEFFB" },
    { start: 4, end: 5, expectedText: "B" },
  ])("preserves UTF-8 positions [$start, $end) around an interior U+FEFF", ({ start, end, expectedText }) => {
    const result = adapter.resolve({ start, end, offsetBasis: "utf8_bytes" }, "A\uFEFFB");
    expect(result?.resolution.status).toBe("resolved");
    expect(result?.selectedContent).toEqual(new TextEncoder().encode(expectedText));
    expect(result?.resolution.resolvedRanges).toEqual([
      {
        start,
        end,
        coordinateSpace: adapter.coordinateSpace("utf8_bytes"),
      },
    ]);
  });
});

it("counts an initial U+FEFF preserved inside a PDF text layer", () => {
  const result = adapters[1]!.resolve({ start: 3, end: 4, offsetBasis: "utf8_bytes" }, "\uFEFFA");
  expect(result?.resolution.status).toBe("resolved");
  expect(result?.selectedContent).toEqual(new TextEncoder().encode("A"));
  expect(result?.resolution.resolvedRanges).toEqual([
    { start: 3, end: 4, coordinateSpace: "pdf_physical_page_1:utf8_bytes" },
  ]);
});

it("counts an initial U+FEFF preserved inside repository content", () => {
  const commit = "a".repeat(40);
  const result = resolveText(
    canonicalizeJson({
      kind: "repository",
      commit,
      lineRangeConvention: "zero_based_half_open",
      files: [{ path: "source.txt", content: "\uFEFFA" }],
    }),
    {
      kind: "repository",
      commit,
      path: "source.txt",
      rangeKind: "bytes",
      start: 3,
      end: 4,
    },
  );
  expect(result?.resolution.status).toBe("resolved");
  expect(result?.selectedContent).toEqual(new TextEncoder().encode("A"));
  expect(result?.resolution.resolvedRanges).toEqual([{ start: 3, end: 4, coordinateSpace: "repository_utf8_bytes" }]);
});

it("keeps character positions in the declared normalized text coordinate space", () => {
  const result = resolveText("A\r\n😀42", {
    kind: "character_position",
    normalization: "lf",
    offsetBasis: "unicode_code_points",
    start: 3,
    end: 5,
  });
  expect(new TextDecoder().decode(result?.selectedContent)).toBe("42");
  expect(result?.resolution.resolvedRanges).toEqual([{ start: 3, end: 5, coordinateSpace: "unicode_code_points" }]);
  expect(result?.resolution.normalization).toBe("lf");
});
