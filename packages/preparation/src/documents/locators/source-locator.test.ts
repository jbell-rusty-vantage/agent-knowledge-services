import { describe, expect, it } from "vitest";
import { sha256Digest } from "@aiengineer/knowledge-core";
import { convertStructuralDocument } from "../nodes/index.js";
import { createSourceLocator, locatorDigestValue, reconstructNodeSpan, verifyNodeLocators } from "./source-locator.js";

const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
const document = convertStructuralDocument({
  tenantId: id(1),
  representationId: id(2),
  createdAt: "2026-09-03T12:00:00Z",
  blocks: [
    { localKey: "h", ordinal: 0, kind: "heading", text: "Retrieval" },
    {
      localKey: "p",
      parentKey: "h",
      ordinal: 0,
      kind: "paragraph",
      text: "Stable spans.",
      locator: { page: 1, startOffset: 0, endOffset: 13 },
    },
  ],
});
const [heading, paragraph] = document.nodes;

describe("createSourceLocator", () => {
  it("binds the representation, node and quote digest to the supplied coordinates", () => {
    const locator = createSourceLocator(id(2), id(3), "Stable spans.", { page: 1, startOffset: 0, endOffset: 13 });
    expect(locator).toMatchObject({
      representationId: id(2),
      nodeId: id(3),
      page: 1,
      quoteDigest: sha256Digest("Stable spans."),
    });
  });

  it("rejects coordinates the contract does not admit", () => {
    expect(() => createSourceLocator(id(2), id(3), "x", { page: -1 })).toThrow();
  });
});

describe("locatorDigestValue", () => {
  it("hashes an absent locator and one with only undefined fields the same way", () => {
    expect(locatorDigestValue(undefined)).toEqual({});
    expect(locatorDigestValue({ page: undefined })).toEqual({});
    expect(locatorDigestValue({ page: 2, sectionPath: ["a"] })).toEqual({ page: 2, sectionPath: ["a"] });
  });
});

describe("verifyNodeLocators", () => {
  it("accepts nodes whose locators match their sealed text", () => {
    expect(verifyNodeLocators(document.nodes)).toEqual([]);
  });

  it("reports every way a locator can drift from its node", () => {
    const drifted = {
      ...paragraph!,
      locator: {
        ...paragraph!.locator,
        representationId: id(9),
        nodeId: id(8),
        quoteDigest: sha256Digest("other"),
        endOffset: 500,
      },
    };
    expect(verifyNodeLocators([heading!, drifted])).toEqual([
      `${paragraph!.id}: representation mismatch`,
      `${paragraph!.id}: node mismatch`,
      `${paragraph!.id}: quote digest mismatch`,
      `${paragraph!.id}: offset exceeds text`,
    ]);
  });

  it("reports edited text as a quote digest mismatch", () => {
    expect(verifyNodeLocators([{ ...paragraph!, text: "Stable spans!" }])).toEqual([
      `${paragraph!.id}: quote digest mismatch`,
    ]);
  });
});

describe("reconstructNodeSpan", () => {
  it("slices the sealed text by offsets and defaults to the whole node", () => {
    expect(reconstructNodeSpan(paragraph!, 0, 6)).toBe("Stable");
    expect(reconstructNodeSpan(paragraph!)).toBe("Stable spans.");
  });

  it("rejects empty, negative and overlong spans", () => {
    expect(() => reconstructNodeSpan(paragraph!, 3, 3)).toThrow(RangeError);
    expect(() => reconstructNodeSpan(paragraph!, -1, 3)).toThrow(RangeError);
    expect(() => reconstructNodeSpan(paragraph!, 0, 100)).toThrow(RangeError);
  });
});
