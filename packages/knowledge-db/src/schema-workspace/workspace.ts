import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { infrastructureError } from "./errors.js";

const ManifestSchema = z.looseObject({
  format: z.string(),
  build: z.looseObject({
    contract_version: z.string().optional(),
    migration_head: z.string(),
    renderer_version: z.string().optional(),
    fingerprint: z.string().optional(),
    workspace_fingerprint: z.string().optional(),
  }),
  scope: z.unknown().nullable().optional(),
  layers: z.record(z.string(), z.number()).optional(),
  entry_points: z.array(z.string()).optional(),
});
export type WorkspaceManifest = z.infer<typeof ManifestSchema>;

const optionalText = z
  .string()
  .nullable()
  .optional()
  .transform((value) => value ?? undefined);

/** Renderer output uses `null` for absent optional fields; the loader normalizes them to `undefined`. */
export const SearchEntrySchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  path: optionalText,
  qualified_name: optionalText,
  domain: optionalText,
  aliases: z
    .array(z.string())
    .nullable()
    .default([])
    .transform((value) => value ?? []),
  tokens: z
    .array(z.string())
    .nullable()
    .default([])
    .transform((value) => value ?? []),
  summary: optionalText,
  stub: z
    .boolean()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
});
export type SearchEntry = z.infer<typeof SearchEntrySchema>;

const AliasIndexSchema = z.record(z.string(), z.array(z.string()));
/** Terminology entries point at ids as `ids` (layout doc) or `refs` (renderer); both are read. */
const TerminologySchema = z.record(
  z.string(),
  z
    .looseObject({
      definition: z.string().optional(),
      aliases: z.array(z.string()).default([]),
      ids: z.array(z.string()).optional(),
      refs: z.array(z.string()).optional(),
    })
    .transform((entry) => ({ ...entry, ids: entry.ids ?? entry.refs ?? [] })),
);
export type TerminologyEntry = z.infer<typeof TerminologySchema>[string];

const JsonSchemaSchema = z.record(z.string(), z.unknown());
export const CatalogEntrySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  title: z.string().optional(),
  role: z.enum(["app_reader", "pipeline_agent"]).default("app_reader"),
  sql: z.string().min(1),
  params: JsonSchemaSchema.default({ type: "object", properties: {}, additionalProperties: false }),
  paramOrder: z.array(z.string()).default([]),
  result: z
    .looseObject({
      shape: z.enum(["rows", "single_row", "single_json"]).default("rows"),
      columns: z.array(z.string()).optional(),
    })
    .default({ shape: "rows" }),
  cost_class: z.enum(["cheap", "medium", "heavy"]).default("cheap"),
  volatile: z.boolean().default(false),
  kind: z.enum(["named_query", "retrieval"]).default("named_query"),
  domain: z.string().optional(),
  tasks: z.array(z.string()).default([]),
  example: z.record(z.string(), z.unknown()).optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const QueryCatalogSchema = z.looseObject({
  schemaVersion: z.literal("knowledge-query-catalog.v1"),
  catalogVersion: z.string().optional(),
  migrationHead: z.string().optional(),
  defaults: z
    .looseObject({
      role: z.enum(["app_reader", "pipeline_agent"]).default("app_reader"),
      limit: z.number().int().positive().default(200),
      maxLimit: z.number().int().positive().default(2000),
      statementTimeoutMs: z
        .record(z.string(), z.number().int().positive())
        .default({ cheap: 15_000, medium: 15_000, heavy: 60_000 }),
    })
    .default({
      role: "app_reader",
      limit: 200,
      maxLimit: 2000,
      statementTimeoutMs: { cheap: 15_000, medium: 15_000, heavy: 60_000 },
    }),
  entries: z.array(CatalogEntrySchema),
});
export type QueryCatalog = z.infer<typeof QueryCatalogSchema>;

export interface Workspace {
  readonly dir: string;
  readonly manifest: WorkspaceManifest;
  readonly migrationHead: string;
  readonly fingerprint: string | undefined;
  readonly index: readonly SearchEntry[];
  readonly aliases: Readonly<Record<string, readonly string[]>>;
  readonly terminology: Readonly<Record<string, TerminologyEntry>>;
  readonly catalog: QueryCatalog | undefined;
}

export const WORKSPACE_FILES = {
  manifest: "manifest.json",
  searchIndex: "search/index.json",
  aliases: "search/aliases.json",
  terminology: "search/terminology.json",
  catalog: "queries/catalog.json",
  rules: "rules/ingestion-rules.v1.json",
} as const;

function readJsonIfPresent(dir: string, relative: string): unknown {
  const path = join(dir, relative);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw infrastructureError("WORKSPACE_CORRUPT", `cannot parse ${relative}`, {
      path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseOrCorrupt<T>(schema: z.ZodType<T>, value: unknown, relative: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw infrastructureError("WORKSPACE_CORRUPT", `${relative} does not match its contract`, {
      issueCount: parsed.error.issues.length,
      issues: parsed.error.issues.slice(0, 8),
    });
  return parsed.data;
}

/** Reads the machine layer of a workspace tree; pages are read lazily by `getPage`. */
export function loadWorkspace(dir: string): Workspace {
  const root = resolve(dir);
  const manifestRaw = readJsonIfPresent(root, WORKSPACE_FILES.manifest);
  if (manifestRaw === undefined)
    throw infrastructureError("WORKSPACE_MISSING", "manifest.json not found", { dir: root });
  const manifest = parseOrCorrupt(ManifestSchema, manifestRaw, WORKSPACE_FILES.manifest);
  const indexRaw = readJsonIfPresent(root, WORKSPACE_FILES.searchIndex);
  const aliasesRaw = readJsonIfPresent(root, WORKSPACE_FILES.aliases);
  const terminologyRaw = readJsonIfPresent(root, WORKSPACE_FILES.terminology);
  const catalogRaw = readJsonIfPresent(root, WORKSPACE_FILES.catalog);
  return {
    dir: root,
    manifest,
    migrationHead: manifest.build.migration_head,
    fingerprint: manifest.build.workspace_fingerprint ?? manifest.build.fingerprint,
    index:
      indexRaw === undefined ? [] : parseOrCorrupt(z.array(SearchEntrySchema), indexRaw, WORKSPACE_FILES.searchIndex),
    aliases: aliasesRaw === undefined ? {} : parseOrCorrupt(AliasIndexSchema, aliasesRaw, WORKSPACE_FILES.aliases),
    terminology:
      terminologyRaw === undefined
        ? {}
        : parseOrCorrupt(TerminologySchema, terminologyRaw, WORKSPACE_FILES.terminology),
    catalog:
      catalogRaw === undefined ? undefined : parseOrCorrupt(QueryCatalogSchema, catalogRaw, WORKSPACE_FILES.catalog),
  };
}

export function requireCatalog(workspace: Workspace): QueryCatalog {
  if (!workspace.catalog)
    throw infrastructureError("CATALOG_MISSING", `${WORKSPACE_FILES.catalog} is absent from the workspace`, {
      dir: workspace.dir,
    });
  return workspace.catalog;
}
