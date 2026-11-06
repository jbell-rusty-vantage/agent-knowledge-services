import { describe, expect, it } from "vitest";
import { ChunkProfileSchema, ChunkProfileTableSchema } from "./index.js";

const profile = {
  name: "heading-sections-v1",
  version: "1.0.0",
  strategy: "headings",
  spaces: ["source_native_sections", "paper_case_study_knowledge"],
  nodeKinds: ["heading", "paragraph", "list"],
  tokenizer: "unicode-word-punctuation-v1",
  targetTokens: 220,
  minimumTokens: 1,
  maximumTokens: 360,
  overlapTokens: 24,
  maximumDuplicatedTokenRatio: 0.2,
  boilerplateOccurrences: 3,
  contextualHeadingPrefix: true,
};
const table = { schemaVersion: "chunk-profile-table.v1", profiles: [profile] };

describe("chunk profile contract", () => {
  it("parses an admitted profile table", () => {
    expect(ChunkProfileTableSchema.parse(table).profiles[0]?.nodeKinds).toEqual(["heading", "paragraph", "list"]);
  });

  it("requires at least one space and one node kind per profile", () => {
    expect(ChunkProfileSchema.safeParse({ ...profile, spaces: [] }).success).toBe(false);
    expect(ChunkProfileSchema.safeParse({ ...profile, nodeKinds: [] }).success).toBe(false);
  });

  it("admits only catalogued spaces, node kinds, strategies and the named tokenizer", () => {
    expect(ChunkProfileSchema.safeParse({ ...profile, spaces: ["everything"] }).success).toBe(false);
    expect(ChunkProfileSchema.safeParse({ ...profile, nodeKinds: ["sentence"] }).success).toBe(false);
    expect(ChunkProfileSchema.safeParse({ ...profile, strategy: "custom-script" }).success).toBe(false);
    expect(ChunkProfileSchema.safeParse({ ...profile, tokenizer: "tiktoken" }).success).toBe(false);
  });

  it("rejects unknown fields, non-integer bounds and other table versions", () => {
    expect(ChunkProfileSchema.safeParse({ ...profile, splitter: "session-local" }).success).toBe(false);
    expect(ChunkProfileSchema.safeParse({ ...profile, targetTokens: 1.5 }).success).toBe(false);
    expect(ChunkProfileTableSchema.safeParse({ ...table, schemaVersion: "chunk-profile-table.v2" }).success).toBe(
      false,
    );
    expect(ChunkProfileTableSchema.safeParse({ ...table, profiles: [] }).success).toBe(false);
  });
});
