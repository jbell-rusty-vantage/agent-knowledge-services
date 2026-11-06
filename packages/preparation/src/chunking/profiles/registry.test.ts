import { describe, expect, it } from "vitest";
import { ChunkProfileTableSchema, VectorSpaceSchema } from "@aiengineer/knowledge-contracts";
import { CHUNK_PROFILE_TABLE } from "./definitions.js";
import { ChunkProfileRegistry, defaultChunkProfileRegistry } from "./registry.js";

const names = (profiles: readonly { name: string }[]) => profiles.map(({ name }) => name);

describe("chunk profile table", () => {
  it("is the chunk-profile-table.v1 contract instance", () => {
    expect(CHUNK_PROFILE_TABLE.schemaVersion).toBe("chunk-profile-table.v1");
    expect(ChunkProfileTableSchema.safeParse(CHUNK_PROFILE_TABLE).success).toBe(true);
  });

  it("binds every profile to the node kinds its strategy filters on", () => {
    const byName = new Map(CHUNK_PROFILE_TABLE.profiles.map((profile) => [profile.name, profile.nodeKinds]));
    expect(byName.get("transcript-topics-v1")).toEqual(["transcript_segment"]);
    expect(byName.get("code-symbols-v1")).toEqual(["code_block"]);
    expect(byName.get("table-row-groups-v1")).toEqual(["table"]);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(CHUNK_PROFILE_TABLE)).toBe(true);
    expect(Object.isFrozen(CHUNK_PROFILE_TABLE.profiles[0]?.spaces)).toBe(true);
  });
});

describe("ChunkProfileRegistry", () => {
  it("registers all admitted strategies in table order", () => {
    expect(defaultChunkProfileRegistry.list().map(({ strategy }) => strategy)).toEqual([
      "transcripts",
      "headings",
      "claims",
      "entities",
      "tools",
      "code",
      "tables",
    ]);
  });

  it.each([
    ["engineering_claims", ["transcript-topics-v1", "atomic-claims-v1"]],
    ["tool_capabilities", ["tool-capabilities-v1"]],
    ["implementation_examples", ["code-symbols-v1"]],
    ["paper_case_study_knowledge", ["heading-sections-v1", "table-row-groups-v1"]],
    ["entity_profiles", ["entity-facets-v1"]],
    ["model_capabilities", ["tool-capabilities-v1"]],
    ["benchmark_intelligence", ["table-row-groups-v1"]],
    ["source_native_sections", ["transcript-topics-v1", "heading-sections-v1"]],
  ] as const)("selects the admitted profiles for %s", (space, expected) => {
    expect(names(defaultChunkProfileRegistry.forSpace(space))).toEqual(expected);
  });

  it("covers every vector space in the contract", () => {
    for (const space of VectorSpaceSchema.options)
      expect(defaultChunkProfileRegistry.forSpace(space).length).toBeGreaterThan(0);
  });

  it("skips the table profile when no table node was observed", () => {
    expect(
      names(defaultChunkProfileRegistry.forSpaceAndNodeKinds("paper_case_study_knowledge", ["heading", "paragraph"])),
    ).toEqual(["heading-sections-v1"]);
    expect(names(defaultChunkProfileRegistry.forSpaceAndNodeKinds("paper_case_study_knowledge", ["table"]))).toEqual([
      "table-row-groups-v1",
    ]);
    expect(names(defaultChunkProfileRegistry.forSpaceAndNodeKinds("engineering_claims", ["figure"]))).toEqual([]);
  });

  it("gets a profile by name and version and rejects unknown ones", () => {
    expect(defaultChunkProfileRegistry.get("atomic-claims-v1").maximumTokens).toBe(160);
    expect(() => defaultChunkProfileRegistry.get("atomic-claims-v1", "9.0.0")).toThrow(/Unknown chunk profile/);
    expect(() => defaultChunkProfileRegistry.get("session-local-splitter")).toThrow(/Unknown chunk profile/);
  });

  it("rejects duplicate registration", () => {
    const claims = defaultChunkProfileRegistry.get("atomic-claims-v1");
    expect(() => new ChunkProfileRegistry([claims, claims])).toThrow(/already registered/);
    expect(() => defaultChunkProfileRegistry.register(claims)).toThrow(/already registered/);
  });

  it("rejects profiles whose bounds cannot hold", () => {
    const claims = defaultChunkProfileRegistry.get("atomic-claims-v1");
    expect(() => new ChunkProfileRegistry([{ ...claims, targetTokens: 500 }])).toThrow(/Invalid token bounds/);
    expect(() => new ChunkProfileRegistry([{ ...claims, minimumTokens: 0 }])).toThrow(/Invalid token bounds/);
    expect(() => new ChunkProfileRegistry([{ ...claims, overlapTokens: 160 }])).toThrow(/Overlap must be below/);
    expect(() => new ChunkProfileRegistry([{ ...claims, maximumDuplicatedTokenRatio: 1.5 }])).toThrow(
      /duplicated-token ratio/,
    );
  });

  it("hands out frozen copies, not the arrays it was given", () => {
    const spaces = ["entity_profiles" as const];
    const registry = new ChunkProfileRegistry([{ ...defaultChunkProfileRegistry.get("entity-facets-v1"), spaces }]);
    spaces.push("engineering_claims" as never);
    expect(registry.get("entity-facets-v1").spaces).toEqual(["entity_profiles"]);
    expect(Object.isFrozen(registry.get("entity-facets-v1"))).toBe(true);
  });
});
