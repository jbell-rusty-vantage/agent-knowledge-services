import { describe, expect, it } from "vitest";
import { verifyNodeLocators } from "../locators/index.js";
import { assertAcyclic, convertStructuralDocument, normalizeDocumentText } from "./structural-document.js";

const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
const input = {
  tenantId: id(1),
  representationId: id(2),
  createdAt: "2026-09-03T12:00:00Z",
  blocks: [
    { localKey: "h", ordinal: 0, kind: "heading" as const, text: "  Retrieval  " },
    {
      localKey: "p",
      parentKey: "h",
      ordinal: 0,
      kind: "paragraph" as const,
      text: "Stable   spans.",
      locator: { page: 1, startOffset: 0, endOffset: 13 },
    },
  ],
};

describe("convertStructuralDocument", () => {
  it("produces stable immutable nodes and verified locators", () => {
    const first = convertStructuralDocument(input);
    const second = convertStructuralDocument(input);
    expect(first).toEqual(second);
    expect(first.nodes[1]?.text).toBe("Stable spans.");
    expect(first.nodes[1]?.parentId).toBe(first.nodes[0]?.id);
    expect(verifyNodeLocators(first.nodes)).toEqual([]);
    expect(Object.isFrozen(first.nodes[0])).toBe(true);
  });

  it("derives node ids from the representation and local key only", () => {
    const moved = convertStructuralDocument({ ...input, createdAt: "2026-09-04T00:00:00Z", tenantId: id(5) });
    expect(moved.nodes.map(({ id }) => id)).toEqual(convertStructuralDocument(input).nodes.map(({ id }) => id));
    expect(convertStructuralDocument({ ...input, representationId: id(3) }).nodes[0]?.id).not.toBe(moved.nodes[0]?.id);
  });

  it("changes the document digest when any block changes", () => {
    const base = convertStructuralDocument(input).digest;
    expect(
      convertStructuralDocument({
        ...input,
        blocks: [input.blocks[0]!, { ...input.blocks[1]!, text: "Stable spans!" }],
      }).digest,
    ).not.toBe(base);
    expect(
      convertStructuralDocument({ ...input, blocks: [input.blocks[0]!, { ...input.blocks[1]!, role: "note" }] }).digest,
    ).not.toBe(base);
  });

  it("rejects an unknown parent, a self parent, a cycle, a duplicate key and a duplicate sibling ordinal", () => {
    const [heading, paragraph] = input.blocks;
    expect(() => convertStructuralDocument({ ...input, blocks: [{ ...heading!, parentKey: "missing" }] })).toThrow(
      /Unknown parent/,
    );
    expect(() => convertStructuralDocument({ ...input, blocks: [{ ...heading!, parentKey: "h" }] })).toThrow(
      /cannot parent itself/,
    );
    expect(() =>
      convertStructuralDocument({ ...input, blocks: [{ ...heading!, parentKey: "p" }, paragraph!] }),
    ).toThrow(/parent cycle/);
    expect(() => convertStructuralDocument({ ...input, blocks: [heading!, { ...paragraph!, localKey: "h" }] })).toThrow(
      /must be unique/,
    );
    const { parentKey: _parentKey, ...rootParagraph } = paragraph!;
    expect(() => convertStructuralDocument({ ...input, blocks: [heading!, { ...rootParagraph, ordinal: 0 }] })).toThrow(
      /Duplicate sibling ordinal/,
    );
  });
});

describe("normalizeDocumentText", () => {
  it("collapses prose whitespace but keeps code and table layout", () => {
    expect(normalizeDocumentText("  a \t b \r\n  c  ", "paragraph")).toBe("a b\nc");
    expect(normalizeDocumentText("  a \t b \r\n  c  ", "code_block")).toBe("  a \t b \n  c");
    expect(normalizeDocumentText("| a |  b |\r\n", "table")).toBe("| a |  b |");
  });
});

describe("assertAcyclic", () => {
  it("passes a tree and rejects a two-block cycle", () => {
    expect(() => assertAcyclic(input.blocks)).not.toThrow();
    expect(() =>
      assertAcyclic([
        { localKey: "a", parentKey: "b", ordinal: 0, kind: "paragraph", text: "a" },
        { localKey: "b", parentKey: "a", ordinal: 0, kind: "paragraph", text: "b" },
      ]),
    ).toThrow(/Structural parent cycle at a/);
  });
});
