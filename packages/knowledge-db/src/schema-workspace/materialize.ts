import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { domainError, infrastructureError } from "./errors.js";
import { loadWorkspace, WORKSPACE_FILES, type Workspace } from "./workspace.js";

const ScopeSchema = z.looseObject({
  format: z.string().optional(),
  id: z.string(),
  description: z.string().optional(),
  include: z
    .looseObject({
      domains: z.array(z.string()).default([]),
      relations: z.array(z.string()).default([]),
      functions: z.array(z.string()).default([]),
    })
    .default({ domains: [], relations: [], functions: [] }),
  exclude: z
    .looseObject({ relations: z.array(z.string()).default([]), functions: z.array(z.string()).default([]) })
    .default({ relations: [], functions: [] }),
  tasks: z.array(z.string()).default([]),
  queries: z.array(z.string()).default([]),
});
export type SchemaScope = z.infer<typeof ScopeSchema>;

export interface MaterializeInput {
  readonly scope: string;
  readonly outDir: string;
}

export interface MaterializeResult {
  readonly scopeId: string;
  readonly outDir: string;
  readonly strategy: "db-contract-cli" | "prebuilt-bundle" | "in-process-filter";
  readonly files: number;
  readonly omitted: { readonly relations: number; readonly functions: number };
}

const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
const matchesAny = (value: string, globs: readonly string[]): boolean =>
  globs.some((glob) => globToRegExp(glob).test(value));

function contractRootOf(workspace: Workspace): string {
  return dirname(workspace.dir);
}

function countFiles(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce(
    (total, entry) => total + (entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1),
    0,
  );
}

function readScope(contractRoot: string, scopeId: string): SchemaScope | undefined {
  const file =
    scopeId.endsWith(".json") && existsSync(scopeId)
      ? scopeId
      : join(contractRoot, "workspace-scopes", `${scopeId}.json`);
  if (!existsSync(file)) return undefined;
  const parsed = ScopeSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success)
    throw infrastructureError("SCOPE_INVALID", `scope file ${file} is malformed`, { issues: parsed.error.issues });
  return parsed.data;
}

function viaContractCli(contractRoot: string, scopeId: string, outDir: string): MaterializeResult | undefined {
  const cli = join(contractRoot, "scripts", "schema-workspace", "cli.mjs");
  const scopeFile = join(contractRoot, "workspace-scopes", `${scopeId}.json`);
  if (!existsSync(cli) || !existsSync(scopeFile)) return undefined;
  const run = spawnSync(process.execPath, [cli, "materialize", "--scope", scopeFile, "--out", outDir], {
    cwd: contractRoot,
    encoding: "utf8",
  });
  if (run.status !== 0)
    throw infrastructureError("MATERIALIZE_FAILED", "db-contract materialize exited non-zero", {
      status: run.status,
      stderr: run.stderr.slice(0, 4000),
    });
  return { scopeId, outDir, strategy: "db-contract-cli", files: countFiles(outDir), omitted: readOmitted(outDir) };
}

function viaPrebuiltBundle(contractRoot: string, scopeId: string, outDir: string): MaterializeResult | undefined {
  const bundle = join(contractRoot, "workspace-scopes", scopeId);
  if (!existsSync(join(bundle, WORKSPACE_FILES.manifest))) return undefined;
  cpSync(bundle, outDir, { recursive: true });
  return { scopeId, outDir, strategy: "prebuilt-bundle", files: countFiles(outDir), omitted: readOmitted(outDir) };
}

function readOmitted(outDir: string): MaterializeResult["omitted"] {
  try {
    const manifest = JSON.parse(readFileSync(join(outDir, WORKSPACE_FILES.manifest), "utf8")) as {
      scope?: { omitted?: { relations?: number; functions?: number } };
    };
    return { relations: manifest.scope?.omitted?.relations ?? 0, functions: manifest.scope?.omitted?.functions ?? 0 };
  } catch {
    return { relations: 0, functions: 0 };
  }
}

const ALWAYS_COPIED = [
  "START_HERE.md",
  "INDEX.md",
  "relations.txt",
  "fingerprint.json",
  "queries/README.md",
  "rules",
  "vocabularies",
  "types",
  "search/aliases.json",
  "search/terminology.json",
];

function relationInScope(
  entry: Pick<Workspace["index"][number], "id" | "kind" | "domain" | "qualified_name">,
  scope: SchemaScope,
): boolean {
  const name = entry.qualified_name ?? entry.id.slice(entry.id.indexOf(":") + 1);
  const isFunction = entry.id.startsWith("fn:") || entry.kind === "function";
  if (isFunction) return matchesAny(name, scope.include.functions) && !matchesAny(name, scope.exclude.functions);
  if (matchesAny(name, scope.exclude.relations)) return false;
  return (
    matchesAny(name, scope.include.relations) ||
    (entry.domain !== undefined && scope.include.domains.includes(entry.domain))
  );
}

function entryInScope(entry: Workspace["index"][number], scope: SchemaScope): boolean {
  switch (entry.kind) {
    case "domain":
      return scope.include.domains.includes(entry.id.replace(/^dom:/, ""));
    case "task":
      return scope.tasks.includes(entry.id.replace(/^task:/, ""));
    case "query":
      return matchesAny(entry.id.replace(/^q:/, ""), scope.queries);
    case "term":
    case "vocabulary":
      return true;
    default:
      return relationInScope(entry, scope);
  }
}

function copyRelative(workspace: Workspace, outDir: string, relativePath: string): void {
  const source = join(workspace.dir, relativePath);
  if (!existsSync(source)) return;
  const target = join(outDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: statSync(source).isDirectory() });
}

/** Same filter rules as the db-contract CLI, applied in-process to the loaded full workspace. */
function viaInProcessFilter(workspace: Workspace, scope: SchemaScope, outDir: string): MaterializeResult {
  mkdirSync(outDir, { recursive: true });
  const kept = workspace.index.filter((entry) => entryInScope(entry, scope));
  const keptIds = new Set(kept.map((entry) => entry.id));
  for (const item of ALWAYS_COPIED) copyRelative(workspace, outDir, item);
  for (const entry of kept) if (entry.path) copyRelative(workspace, outDir, entry.path.split("#")[0]!);
  const catalog = workspace.catalog
    ? {
        ...workspace.catalog,
        entries: workspace.catalog.entries.filter((entry) => matchesAny(entry.name, scope.queries)),
      }
    : undefined;
  if (catalog) writeJson(join(outDir, WORKSPACE_FILES.catalog), catalog);
  writeJson(join(outDir, WORKSPACE_FILES.searchIndex), kept);
  const omittedRelations = workspace.index.filter(
    (entry) =>
      !keptIds.has(entry.id) && ["table", "view", "partitioned_table", "materialized_view"].includes(entry.kind),
  ).length;
  const omittedFunctions = workspace.index.filter(
    (entry) => !keptIds.has(entry.id) && entry.kind === "function",
  ).length;
  writeJson(join(outDir, WORKSPACE_FILES.manifest), {
    ...workspace.manifest,
    scope: {
      id: scope.id,
      included: { entries: kept.length },
      omitted: { relations: omittedRelations, functions: omittedFunctions },
      strategy: "in-process-filter",
    },
  });
  writeJson(join(outDir, "scope.json"), scope);
  return {
    scopeId: scope.id,
    outDir,
    strategy: "in-process-filter",
    files: countFiles(outDir),
    omitted: { relations: omittedRelations, functions: omittedFunctions },
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Copies a scoped bundle to `outDir`. Prefers the db-contract CLI (authoritative), then a
 * prebuilt bundle directory, then an in-process filter of the loaded full workspace.
 */
export function materializeScope(workspace: Workspace, input: MaterializeInput): MaterializeResult {
  const outDir = resolve(input.outDir);
  const contractRoot = contractRootOf(workspace);
  const scopeId = basename(input.scope).replace(/\.json$/, "");
  if (existsSync(outDir) && readdirSync(outDir).length > 0)
    throw domainError("OUT_DIR_NOT_EMPTY", "refusing to materialize into a non-empty directory", { outDir });
  const result = viaContractCli(contractRoot, scopeId, outDir) ?? viaPrebuiltBundle(contractRoot, scopeId, outDir);
  if (result) return result;
  const scope = readScope(contractRoot, input.scope);
  if (!scope)
    throw domainError(
      "SCOPE_UNKNOWN",
      `no scope ${scopeId} under ${relative(process.cwd(), join(contractRoot, "workspace-scopes"))}`,
      { scopeId },
    );
  return viaInProcessFilter(workspace, scope, outDir);
}

/** Convenience for callers that already hold a directory and only want the loaded bundle back. */
export function loadMaterialized(outDir: string): Workspace {
  return loadWorkspace(outDir);
}
