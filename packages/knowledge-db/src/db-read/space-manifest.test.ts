import { describe, expect, it, vi } from "vitest";
import {
  buildSpaceManifest,
  readSpaceManifest,
  type SpaceManifestProfileTable,
  type SpaceManifestReads,
} from "./space-manifest.js";
import type { ReadExecutor } from "./read-executor.js";

// The real chunk-profile-table.v1 values (packages/preparation/src/chunking/profiles/definitions.ts),
// copied here as plain data — not imported — so this test proves the manifest reports what
// the chunker would actually admit, without db-read taking a dependency on chunking or
// contracts. `CHUNK_PROFILE_TABLE` satisfies `SpaceManifestProfileTable<Space>` structurally.
type Space =
  | "engineering_claims"
  | "tool_capabilities"
  | "implementation_examples"
  | "paper_case_study_knowledge"
  | "entity_profiles"
  | "model_capabilities"
  | "benchmark_intelligence"
  | "source_native_sections";

const PROFILE_TABLE: SpaceManifestProfileTable<Space> = {
  schemaVersion: "chunk-profile-table.v1",
  profiles: [
    {
      name: "transcript-topics-v1",
      version: "1.0.0",
      strategy: "transcripts",
      spaces: ["source_native_sections", "engineering_claims"],
      nodeKinds: ["transcript_segment"],
    },
    {
      name: "heading-sections-v1",
      version: "1.0.0",
      strategy: "headings",
      spaces: ["source_native_sections", "paper_case_study_knowledge"],
      nodeKinds: ["heading", "paragraph", "list"],
    },
    {
      name: "atomic-claims-v1",
      version: "1.0.0",
      strategy: "claims",
      spaces: ["engineering_claims"],
      nodeKinds: ["paragraph", "list", "transcript_segment"],
    },
    {
      name: "entity-facets-v1",
      version: "1.0.0",
      strategy: "entities",
      spaces: ["entity_profiles"],
      nodeKinds: ["heading", "paragraph", "list", "table"],
    },
    {
      name: "tool-capabilities-v1",
      version: "1.0.0",
      strategy: "tools",
      spaces: ["tool_capabilities", "model_capabilities"],
      nodeKinds: ["heading", "paragraph", "list", "table"],
    },
    {
      name: "code-symbols-v1",
      version: "1.0.0",
      strategy: "code",
      spaces: ["implementation_examples"],
      nodeKinds: ["code_block"],
    },
    {
      name: "table-row-groups-v1",
      version: "1.0.0",
      strategy: "tables",
      spaces: ["benchmark_intelligence", "paper_case_study_knowledge"],
      nodeKinds: ["table"],
    },
  ],
};

const ALL_SPACES: readonly Space[] = [
  "engineering_claims",
  "tool_capabilities",
  "implementation_examples",
  "paper_case_study_knowledge",
  "entity_profiles",
  "model_capabilities",
  "benchmark_intelligence",
  "source_native_sections",
];

const CONTRACT = { migrationHead: "20260916020200" };

describe("buildSpaceManifest", () => {
  it("includes every supplied space, in order, including one with no profile bindings", () => {
    const manifest = buildSpaceManifest({
      tenantId: "t-1",
      spaces: ALL_SPACES,
      profileTable: PROFILE_TABLE,
      contract: CONTRACT,
    });
    expect(manifest.spaces.map((entry) => entry.space)).toEqual(ALL_SPACES);
    // Every one of the eight real spaces has at least one binding in chunk-profile-table.v1, so
    // the "no bindings" shape is asserted separately below against a space outside that table.
    // Here, assert the shape for a space with exactly one binding.
    const implementationExamples = manifest.spaces.find((entry) => entry.space === "implementation_examples")!;
    expect(implementationExamples.profileBindings).toEqual([
      { name: "code-symbols-v1", version: "1.0.0", strategy: "code", nodeKinds: ["code_block"] },
    ]);
    expect(implementationExamples.admittedNodeKinds).toEqual(["code_block"]);
  });

  it("reports no bindings and no admitted node kinds for a space nothing binds", () => {
    const manifest = buildSpaceManifest({
      tenantId: "t-1",
      spaces: ["figure_only" as unknown as Space],
      profileTable: PROFILE_TABLE,
      contract: CONTRACT,
    });
    expect(manifest.spaces).toEqual([
      {
        space: "figure_only",
        admittedNodeKinds: [],
        profileBindings: [],
        budget: { status: "unavailable", reason: "no per-space reservation exists in contract 0.4.16" },
      },
    ]);
  });

  it("computes profileBindings and admittedNodeKinds correctly, and admits table-row-groups-v1 to exactly the two table spaces", () => {
    const manifest = buildSpaceManifest({
      tenantId: "t-1",
      spaces: ALL_SPACES,
      profileTable: PROFILE_TABLE,
      contract: CONTRACT,
    });
    const bound = manifest.spaces.filter((entry) =>
      entry.profileBindings.some((binding) => binding.name === "table-row-groups-v1"),
    );
    expect(bound.map((entry) => entry.space).sort()).toEqual(["benchmark_intelligence", "paper_case_study_knowledge"]);
    for (const entry of bound) {
      const binding = entry.profileBindings.find((item) => item.name === "table-row-groups-v1")!;
      expect(binding.nodeKinds).toEqual(["table"]);
    }
    const benchmark = manifest.spaces.find((entry) => entry.space === "benchmark_intelligence")!;
    expect(benchmark.admittedNodeKinds).toEqual(["table"]);
  });

  it("deduplicates and sorts admittedNodeKinds across multiple bound profiles", () => {
    const manifest = buildSpaceManifest({
      tenantId: "t-1",
      spaces: ALL_SPACES,
      profileTable: PROFILE_TABLE,
      contract: CONTRACT,
    });
    // paper_case_study_knowledge is bound by heading-sections-v1 (heading, paragraph, list) and
    // table-row-groups-v1 (table): the union, deduplicated and sorted.
    const paper = manifest.spaces.find((entry) => entry.space === "paper_case_study_knowledge")!;
    expect(paper.admittedNodeKinds).toEqual(["heading", "list", "paragraph", "table"]);
    // engineering_claims is bound by transcript-topics-v1 (transcript_segment) and
    // atomic-claims-v1 (paragraph, list, transcript_segment): transcript_segment must not repeat.
    const claims = manifest.spaces.find((entry) => entry.space === "engineering_claims")!;
    expect(claims.admittedNodeKinds).toEqual(["list", "paragraph", "transcript_segment"]);
  });

  it("merges supplied live-row facts into the matching entry only", () => {
    const manifest = buildSpaceManifest({
      tenantId: "t-1",
      spaces: ALL_SPACES,
      profileTable: PROFILE_TABLE,
      contract: CONTRACT,
      liveFacts: { entity_profiles: { storeClass: "official_canonical", authorityClass: "official" } },
    });
    const entities = manifest.spaces.find((entry) => entry.space === "entity_profiles")!;
    expect(entities.storeClass).toBe("official_canonical");
    expect(entities.authorityClass).toBe("official");
    const claims = manifest.spaces.find((entry) => entry.space === "engineering_claims")!;
    expect(claims.storeClass).toBeUndefined();
  });

  it("always reports budget as unavailable, never computed from a store quota", () => {
    const manifest = buildSpaceManifest({
      tenantId: "t-1",
      spaces: ALL_SPACES,
      profileTable: PROFILE_TABLE,
      contract: CONTRACT,
    });
    for (const entry of manifest.spaces)
      expect(entry.budget).toEqual({
        status: "unavailable",
        reason: "no per-space reservation exists in contract 0.4.16",
      });
  });

  it("is deterministic for the same input", () => {
    const input = {
      tenantId: "t-1",
      spaces: ALL_SPACES,
      profileTable: PROFILE_TABLE,
      contract: CONTRACT,
      atKnowledgeSeq: 42,
    };
    expect(buildSpaceManifest(input)).toEqual(buildSpaceManifest(input));
  });
});

function makeReads(
  overrides: Partial<SpaceManifestReads> & { entries?: readonly { name: string }[] },
): SpaceManifestReads {
  const catalogFn = vi.fn(() => ({ entries: overrides.entries ?? [] }));
  const headFn = vi.fn(async (_tenantId: string) => ({ knowledgeSeq: 7 }));
  const runIntentFn = vi.fn(async (_raw: unknown) => ({ operations: [] }));
  return {
    workspace: { migrationHead: "20260916020200", fingerprint: undefined },
    catalog: overrides.catalog ?? catalogFn,
    head: overrides.head ?? headFn,
    runIntent: overrides.runIntent ?? runIntentFn,
  };
}

describe("readSpaceManifest", () => {
  it("with an empty catalog, issues no read intent, touches no head, and returns all five unavailable entries with unavailable budgets", async () => {
    const runIntent = vi.fn(async (_raw: unknown) => ({ operations: [] }));
    const head = vi.fn(async (_tenantId: string) => ({ knowledgeSeq: 99 }));
    const reads = makeReads({ entries: [], runIntent, head });
    const manifest = await readSpaceManifest(reads, {
      tenantId: "t-1",
      spaces: ALL_SPACES,
      profileTable: PROFILE_TABLE,
    });
    expect(runIntent).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    expect(manifest.unavailable.map((item) => item.requires).sort()).toEqual([
      "retrieval.active_space_publication",
      "retrieval.space_version_config",
      "retrieval.spaces_for_tenant",
      "retrieval.store_quota_usage",
      "retrieval.store_spaces_for_tenant",
    ]);
    for (const item of manifest.unavailable) {
      expect(item.field.length).toBeGreaterThan(0);
      expect(item.reason.length).toBeGreaterThan(0);
    }
    for (const entry of manifest.spaces)
      expect(entry.budget).toEqual({
        status: "unavailable",
        reason: "no per-space reservation exists in contract 0.4.16",
      });
    expect(manifest.atKnowledgeSeq).toBeNull();
  });

  it("with a catalog containing some of the five queries, only those appear in the read intent and only the remainder appear in unavailable", async () => {
    const runIntent = vi.fn(async (_raw: unknown) => ({
      operations: [{ opId: "retrieval.store_spaces_for_tenant", status: "empty" }],
    }));
    const reads = makeReads({ entries: [{ name: "retrieval.store_spaces_for_tenant" }], runIntent });
    const manifest = await readSpaceManifest(reads, {
      tenantId: "t-1",
      spaces: ALL_SPACES,
      profileTable: PROFILE_TABLE,
    });
    expect(runIntent).toHaveBeenCalledTimes(1);
    const raw = runIntent.mock.calls[0]![0] as { operations: { query: string }[] };
    expect(raw.operations.map((operation) => operation.query)).toEqual(["retrieval.store_spaces_for_tenant"]);
    expect(manifest.unavailable.map((item) => item.requires).sort()).toEqual([
      "retrieval.active_space_publication",
      "retrieval.space_version_config",
      "retrieval.spaces_for_tenant",
      "retrieval.store_quota_usage",
    ]);
  });

  it("merges live rows from a stubbed runIntent into the right entries (storeClass, authorityClass, activePublication)", async () => {
    const runIntent = vi.fn(async (_raw: unknown) => ({
      operations: [
        {
          opId: "retrieval.store_spaces_for_tenant",
          status: "ok",
          rows: [
            { space: "entity_profiles", storeClass: "official_canonical", authorityClass: "official" },
            { space: "benchmark_intelligence", storeClass: "internal_exploratory", authorityClass: "exploratory" },
          ],
        },
        {
          opId: "retrieval.active_space_publication",
          status: "ok",
          rows: [
            {
              space: "entity_profiles",
              activePublication: {
                vectorStoreSpaceId: "vss-1",
                vectorSpaceVersionId: "vsv-1",
                publicationId: "pub-1",
                status: "active",
                expectedItemCount: 10,
                publishedAt: "2026-09-19T00:00:00.000Z",
              },
            },
          ],
        },
      ],
    }));
    const reads = makeReads({
      entries: [{ name: "retrieval.store_spaces_for_tenant" }, { name: "retrieval.active_space_publication" }],
      runIntent,
    });
    const manifest = await readSpaceManifest(reads, {
      tenantId: "t-1",
      spaces: ALL_SPACES,
      profileTable: PROFILE_TABLE,
    });
    const entities = manifest.spaces.find((entry) => entry.space === "entity_profiles")!;
    expect(entities.storeClass).toBe("official_canonical");
    expect(entities.authorityClass).toBe("official");
    expect(entities.activePublication).toEqual({
      vectorStoreSpaceId: "vss-1",
      vectorSpaceVersionId: "vsv-1",
      publicationId: "pub-1",
      status: "active",
      expectedItemCount: 10,
      publishedAt: "2026-09-19T00:00:00.000Z",
    });
    const benchmark = manifest.spaces.find((entry) => entry.space === "benchmark_intelligence")!;
    expect(benchmark.storeClass).toBe("internal_exploratory");
    expect(benchmark.authorityClass).toBe("exploratory");
    expect(benchmark.activePublication).toBeUndefined();
    const claims = manifest.spaces.find((entry) => entry.space === "engineering_claims")!;
    expect(claims.storeClass).toBeUndefined();
    expect(claims.activePublication).toBeUndefined();
    // Live rows never fill budget, even though a row for the space exists.
    expect(entities.budget).toEqual({
      status: "unavailable",
      reason: "no per-space reservation exists in contract 0.4.16",
    });
  });

  it("takes contract.migrationHead and atKnowledgeSeq from the port, not a literal", async () => {
    const runIntent = vi.fn(async (_raw: unknown) => ({
      operations: [{ opId: "retrieval.store_spaces_for_tenant", status: "empty" }],
    }));
    const head = vi.fn(async (_tenantId: string) => ({ knowledgeSeq: 123 }));
    const reads: SpaceManifestReads = {
      workspace: { migrationHead: "some-other-head", fingerprint: "fp-1" },
      catalog: () => ({ entries: [{ name: "retrieval.store_spaces_for_tenant" }] }),
      head,
      runIntent,
    };
    const manifest = await readSpaceManifest(reads, {
      tenantId: "t-1",
      spaces: ALL_SPACES,
      profileTable: PROFILE_TABLE,
    });
    expect(manifest.contract).toEqual({ migrationHead: "some-other-head", workspaceFingerprint: "fp-1" });
    expect(manifest.atKnowledgeSeq).toBe(123);
    expect(head).toHaveBeenCalledWith("t-1");
  });

  it("is deterministic for the same input", async () => {
    const reads = () =>
      makeReads({
        entries: [{ name: "retrieval.store_spaces_for_tenant" }],
        runIntent: async () => ({
          operations: [
            {
              opId: "retrieval.store_spaces_for_tenant",
              status: "ok",
              rows: [{ space: "entity_profiles", storeClass: "official_canonical" }],
            },
          ],
        }),
        head: async () => ({ knowledgeSeq: 5 }),
      });
    const input = { tenantId: "t-1", spaces: ALL_SPACES, profileTable: PROFILE_TABLE };
    const [first, second] = await Promise.all([readSpaceManifest(reads(), input), readSpaceManifest(reads(), input)]);
    expect(first).toEqual(second);
  });

  it("ReadExecutor satisfies SpaceManifestReads structurally (compile-time proof; never instantiated)", () => {
    const widen: (executor: ReadExecutor) => SpaceManifestReads = (executor) => executor;
    expect(typeof widen).toBe("function");
  });
});
