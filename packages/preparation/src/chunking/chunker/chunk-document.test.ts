import { describe, expect, it } from "vitest";
import { convertStructuralDocument } from "../../documents/index.js";
import { defaultChunkProfileRegistry } from "../profiles/index.js";
import { reconstructChunk } from "../qa/index.js";
import { chunkDocument } from "./chunk-document.js";
import { tokenize } from "./tokenizer.js";

const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
const createdAt = "2026-09-03T12:00:00Z";
const document = convertStructuralDocument({
  tenantId: id(1),
  representationId: id(2),
  createdAt,
  blocks: [
    { localKey: "h", ordinal: 0, kind: "heading", text: "Chunking" },
    {
      localKey: "p",
      parentKey: "h",
      ordinal: 0,
      kind: "paragraph",
      text: "Chunks preserve evidence. Claims remain atomic.",
    },
    { localKey: "footer-1", ordinal: 1, kind: "paragraph", role: "boilerplate", text: "Terms" },
    { localKey: "duplicate", ordinal: 2, kind: "paragraph", text: "Chunks preserve evidence. Claims remain atomic." },
  ],
});
const sections = convertStructuralDocument({
  tenantId: id(1),
  representationId: id(3),
  createdAt,
  blocks: [
    { localKey: "h1", ordinal: 0, kind: "heading", text: "Section one" },
    { localKey: "p1", parentKey: "h1", ordinal: 0, kind: "paragraph", text: "First body." },
    { localKey: "h2", ordinal: 1, kind: "heading", text: "Section two" },
    { localKey: "p2", parentKey: "h2", ordinal: 0, kind: "paragraph", text: "Second body." },
  ],
});

describe("chunkDocument", () => {
  it("creates deterministic atomic, reconstructable chunks and removes boilerplate", () => {
    const profile = defaultChunkProfileRegistry.get("atomic-claims-v1");
    const result = chunkDocument(document.nodes, profile);
    expect(result.chunks.map(({ sourceText }) => sourceText)).toEqual([
      "Chunking",
      "Chunks preserve evidence.",
      "Claims remain atomic.",
    ]);
    expect(result.omittedNodeIds).toHaveLength(2);
    expect(result.qa.valid).toBe(true);
    expect(result.chunks.every((chunk) => reconstructChunk(chunk, document.nodes) === chunk.sourceText)).toBe(true);
    expect(chunkDocument(document.nodes, profile).outputDigest).toBe(result.outputDigest);
  });

  it("breaks section chunks on heading boundaries and prefixes the nearest heading", () => {
    const result = chunkDocument(sections.nodes, defaultChunkProfileRegistry.get("heading-sections-v1"));
    expect(result.chunks.map(({ sourceText }) => sourceText)).toEqual([
      "Section one\n\nFirst body.",
      "Section two\n\nSecond body.",
    ]);
    expect(result.chunks[1]?.contextualPrefix).toBe("Section two\n\n");
    expect(result.chunks[1]?.embeddingText.startsWith("Section two")).toBe(true);
  });

  it("splits an oversized node so every chunk stays inside the profile maximum", () => {
    const profile = defaultChunkProfileRegistry.get("heading-sections-v1");
    const long = convertStructuralDocument({
      tenantId: id(1),
      representationId: id(4),
      createdAt,
      blocks: [
        {
          localKey: "p",
          ordinal: 0,
          kind: "paragraph",
          text: Array.from({ length: 500 }, (_, index) => `word${index}`).join(" "),
        },
      ],
    });
    const result = chunkDocument(long.nodes, profile);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.every((chunk) => chunk.sourceTokenCount <= profile.maximumTokens)).toBe(true);
    expect(result.qa.valid).toBe(true);
  });

  it("rejects an orphaned node", () => {
    const [heading, paragraph] = document.nodes;
    const orphan = { ...paragraph!, parentId: id(9) };
    expect(() => chunkDocument([heading!, orphan], defaultChunkProfileRegistry.get("heading-sections-v1"))).toThrow(
      /orphan or structural cycle/,
    );
  });

  it("rejects a structural cycle", () => {
    const [heading, paragraph] = document.nodes;
    const cycle = [
      { ...heading!, parentId: paragraph!.id },
      { ...paragraph!, parentId: heading!.id },
    ];
    expect(() => chunkDocument(cycle, defaultChunkProfileRegistry.get("heading-sections-v1"))).toThrow(
      /orphan or structural cycle/,
    );
  });

  it("rejects a profile whose bounds cannot hold", () => {
    const profile = { ...defaultChunkProfileRegistry.get("heading-sections-v1"), maximumTokens: 10 };
    expect(() => chunkDocument(document.nodes, profile)).toThrow(/Invalid token bounds/);
  });
});

describe("tokenize", () => {
  it("splits words, numbers and punctuation under unicode-word-punctuation-v1", () => {
    expect(tokenize("TypeScript: v5.6")).toEqual(["TypeScript", ":", "v5", ".", "6"]);
    expect(tokenize("")).toEqual([]);
  });
});
