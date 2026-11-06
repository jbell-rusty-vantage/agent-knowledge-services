import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertHeadMatches, compareHeads } from "./head.js";
import { getPage } from "./pages.js";
import { resolveWorkspaceDir } from "./locate.js";
import { materializeScope } from "./materialize.js";
import { searchWorkspace } from "./search.js";
import { loadWorkspace } from "./workspace.js";

export const FIXTURE_WORKSPACE = resolve(import.meta.dirname, "../../test/schema-workspace/fixtures/workspace");
const workspace = loadWorkspace(FIXTURE_WORKSPACE);

describe("loadWorkspace", () => {
  it("reads the machine layer and exposes the migration head", () => {
    expect(workspace.migrationHead).toBe("20260912020000");
    expect(workspace.catalog?.entries.map((entry) => entry.name)).toContain("entity.resolve");
    expect(workspace.index.length).toBeGreaterThan(3);
  });

  it("fails with WORKSPACE_MISSING for an empty directory", () => {
    expect(() => loadWorkspace(join(FIXTURE_WORKSPACE, "domains"))).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_MISSING", exit: 2 }),
    );
  });
});

describe("resolveWorkspaceDir", () => {
  it("prefers SCHEMA_WORKSPACE_DIR", () => {
    expect(resolveWorkspaceDir({ env: { SCHEMA_WORKSPACE_DIR: FIXTURE_WORKSPACE } })).toBe(FIXTURE_WORKSPACE);
  });

  it("finds the pinned contract workspace or the explicit fallback, whichever exists first", () => {
    const resolved = resolveWorkspaceDir({ env: {}, fallbackDir: FIXTURE_WORKSPACE });
    expect(existsSync(join(resolved, "manifest.json"))).toBe(true);
    expect(() =>
      resolveWorkspaceDir({ env: { SCHEMA_WORKSPACE_DIR: join(FIXTURE_WORKSPACE, "domains") } }),
    ).not.toThrow();
  });
});

describe("searchWorkspace", () => {
  it("ranks an exact alias above a name match above token overlap", () => {
    const hits = searchWorkspace(workspace, "fact").hits;
    expect(hits[0]?.id).toBe("rel:temporal.segment");
    expect(hits[0]?.matchedOn).toBe("alias");
  });

  it("matches a qualified name exactly", () => {
    expect(searchWorkspace(workspace, "corpus.entity").hits[0]).toMatchObject({
      id: "rel:corpus.entity",
      matchedOn: "name",
    });
  });

  it("finds terminology and token overlap", () => {
    const hits = searchWorkspace(workspace, "knowledge-head").hits;
    expect(hits.some((hit) => hit.matchedOn === "term")).toBe(true);
    expect(searchWorkspace(workspace, "valid_during belief").hits[0]?.id).toBe("rel:temporal.segment");
  });

  it("filters by kind and domain and offers suggestions when nothing matches", () => {
    expect(searchWorkspace(workspace, "entity", { kinds: ["domain"] }).hits.every((hit) => hit.kind === "domain")).toBe(
      true,
    );
    expect(searchWorkspace(workspace, "segment", { domain: "identity" }).hits).toHaveLength(0);
    expect(searchWorkspace(workspace, "zzzz-nothing").suggestions).toEqual([]);
  });
});

describe("getPage", () => {
  it("returns a page by id and by path, honouring the size cap", () => {
    expect(getPage(workspace, "rel:temporal.segment").text).toContain("# temporal.segment");
    expect(getPage(workspace, "domains/identity.md").path).toBe("domains/identity.md");
    const capped = getPage(workspace, "dom:temporal-facts", { maxBytes: 40 });
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBeLessThanOrEqual(40);
  });

  it("rejects unknown pages and path escapes", () => {
    expect(() => getPage(workspace, "rel:nope.missing")).toThrowError(
      expect.objectContaining({ code: "PAGE_NOT_FOUND", exit: 1 }),
    );
    expect(() => getPage(workspace, "../../package.json")).toThrowError(
      expect.objectContaining({ code: "PAGE_PATH_INVALID" }),
    );
  });
});

describe("head check", () => {
  it("reports HEAD_MISMATCH unless stale is allowed", () => {
    expect(compareHeads(workspace, "20260912020000").matches).toBe(true);
    expect(() => assertHeadMatches(workspace, "20260912019999")).toThrowError(
      expect.objectContaining({ code: "HEAD_MISMATCH", exit: 2 }),
    );
    expect(assertHeadMatches(workspace, undefined, true).matches).toBe(false);
  });

  it("loads the pinned contract head 20261031010000 and fails closed on a stale database head", () => {
    const pinned = loadWorkspace(resolveWorkspaceDir({ env: {} }));
    expect(pinned.migrationHead).toBe("20261031010000");
    expect(assertHeadMatches(pinned, "20261031010000").matches).toBe(true);
    expect(() => assertHeadMatches(pinned, "20260914011100")).toThrowError(
      expect.objectContaining({ code: "HEAD_MISMATCH", exit: 2 }),
    );
  });
});

describe("materializeScope", () => {
  const outDirs: string[] = [];
  afterEach(() => {
    for (const dir of outDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("filters the full workspace by scope when no db-contract CLI is present", () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "ks-scope-")), "bundle");
    outDirs.push(resolve(outDir, ".."));
    const result = materializeScope(workspace, { scope: "db-aware-research", outDir });
    expect(result.strategy).toBe("in-process-filter");
    const scoped = loadWorkspace(outDir);
    expect(scoped.index.map((entry) => entry.id)).not.toContain("rel:temporal.knowledge_head");
    expect(scoped.index.map((entry) => entry.id)).toContain("rel:temporal.segment");
    expect(scoped.catalog?.entries.map((entry) => entry.name)).toEqual([
      "entity.resolve",
      "entity.card",
      "entity.at",
      "entity.what_changed",
      "knowledge.head",
    ]);
    expect(scoped.manifest.scope).toMatchObject({ id: "db-aware-research" });
  });

  it("refuses unknown scopes", () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "ks-scope-")), "bundle");
    outDirs.push(resolve(outDir, ".."));
    expect(() => materializeScope(workspace, { scope: "no-such-scope", outDir })).toThrowError(
      expect.objectContaining({ code: "SCOPE_UNKNOWN" }),
    );
  });
});
