import { describe, expect, it } from "vitest";
import { convertStructuralDocument } from "../../documents/index.js";
import { chunkDocument } from "../chunker/index.js";
import { defaultChunkProfileRegistry } from "../profiles/index.js";
import { reconstructChunk, validateChunks } from "./validate-chunks.js";

const id = (digit: number) => `00000000-0000-4000-8000-${String(digit).padStart(12, "0")}`;
const document = convertStructuralDocument({
  tenantId: id(1),
  representationId: id(2),
  createdAt: "2026-09-03T12:00:00Z",
  blocks: [
    { localKey: "h", ordinal: 0, kind: "heading", text: "Retries" },
    { localKey: "p", parentKey: "h", ordinal: 0, kind: "paragraph", text: "Workers renew a lease before each retry." },
  ],
});
const profile = defaultChunkProfileRegistry.get("heading-sections-v1");
const { chunks } = chunkDocument(document.nodes, profile);
const chunk = chunks[0]!;

describe("validateChunks", () => {
  it("accepts chunks that replay from their spans inside the bounds", () => {
    const qa = validateChunks(chunks, document.nodes, profile);
    expect(qa).toMatchObject({
      valid: true,
      issues: [],
      duplicateTokenRatio: 0,
      reconstructedChunkCount: chunks.length,
    });
  });

  it("reports a reconstruction mismatch", () => {
    const qa = validateChunks([{ ...chunk, sourceText: `${chunk.sourceText} tampered` }], document.nodes, profile);
    expect(qa.valid).toBe(false);
    expect(qa.issues).toEqual([`${chunk.id}: reconstruction mismatch`]);
    expect(qa.reconstructedChunkCount).toBe(0);
  });

  it("reports token-bound violations in both directions", () => {
    expect(validateChunks(chunks, document.nodes, { ...profile, maximumTokens: 2 }).issues).toContain(
      `${chunk.id}: exceeds maximum source tokens`,
    );
    expect(validateChunks(chunks, document.nodes, { ...profile, minimumTokens: 1000 }).issues).toContain(
      `${chunk.id}: below minimum source tokens`,
    );
  });

  it("reports spans that point outside the sealed nodes", () => {
    expect(validateChunks(chunks, [], profile).issues).toEqual([
      `${chunk.id}: Missing span node ${chunk.spans[0]!.nodeId}`,
    ]);
    const broken = { ...chunk, spans: [{ ...chunk.spans[0]!, endOffset: 10_000 }] };
    expect(validateChunks([broken], document.nodes, profile).issues).toEqual([
      `${chunk.id}: Invalid span for ${chunk.spans[0]!.nodeId}`,
    ]);
  });

  it("reports adjacent chunks that duplicate each other", () => {
    const single = convertStructuralDocument({
      tenantId: id(1),
      representationId: id(3),
      createdAt: "2026-09-03T12:00:00Z",
      blocks: [{ localKey: "p", ordinal: 0, kind: "paragraph", text: "Workers renew a lease before each retry." }],
    });
    const [only] = chunkDocument(single.nodes, profile).chunks;
    const repeated = { ...only!, id: id(7), ordinal: 1 };
    const qa = validateChunks([only!, repeated], single.nodes, profile);
    expect(qa.duplicateTokenRatio).toBe(1);
    expect(qa.issues).toEqual(["duplicated token ratio 1.000 exceeds limit"]);
  });
});

describe("reconstructChunk", () => {
  it("joins spans from the sealed nodes", () => {
    expect(reconstructChunk(chunk, document.nodes)).toBe(chunk.sourceText);
  });

  it("throws for a missing node or an empty span", () => {
    expect(() => reconstructChunk(chunk, [])).toThrow(/Missing span node/);
    const empty = { ...chunk, spans: [{ ...chunk.spans[0]!, endOffset: chunk.spans[0]!.startOffset }] };
    expect(() => reconstructChunk(empty, document.nodes)).toThrow(/Invalid span/);
  });
});
