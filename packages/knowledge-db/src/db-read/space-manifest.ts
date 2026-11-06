/**
 * `space_manifest` (Phase 2 memo §6, decision P2-7): reports what is knowable about a vector
 * space today and declares, honestly, what it cannot yet report because the pinned database
 * contract 0.4.16 query catalog has no space/store/version/publication query at all (35
 * entries, none of them touch `retrieval.vector_space`, `vector_space_version`,
 * `vector_store_space`, `space_publication` or `vector_store`). It never reaches for
 * `sqlReadonly` to fill that gap — ad-hoc SQL is exactly what the catalog discipline exists to
 * prevent. Instead the manifest assembles the static half (profile↔space bindings) and, for
 * the live half, either reads it through named catalog queries when they exist or records the
 * gap in `unavailable[]` naming the query that would fill it.
 */
export const SPACE_MANIFEST_SCHEMA_VERSION = "space-manifest.v1";

/**
 * Structural profile input. This is deliberately **not** an import of `ChunkProfile` /
 * `ChunkProfileTable` from `@aiengineer/knowledge-contracts` — `db-read` takes no new
 * dependency on `contracts` or `chunking`. `chunk-profile-table.v1`
 * (`packages/preparation/src/chunking/profiles/definitions.ts`) is the only source of profile↔space
 * bindings; its `CHUNK_PROFILE_TABLE` value satisfies this interface structurally, and the
 * caller (the executor operation) passes it straight in. This file must never grow its own
 * copy of that table.
 */
export interface SpaceManifestProfile<Space extends string> {
  readonly name: string;
  readonly version: string;
  readonly strategy: string;
  readonly spaces: readonly Space[];
  readonly nodeKinds: readonly string[];
}

export interface SpaceManifestProfileTable<Space extends string> {
  readonly schemaVersion: string;
  readonly profiles: readonly SpaceManifestProfile<Space>[];
}

export type SpaceManifestAuthorityClass = "official" | "exploratory" | "user_managed";

export interface SpaceManifestActivePublication {
  readonly vectorStoreSpaceId: string;
  readonly vectorSpaceVersionId: string;
  readonly publicationId: string;
  readonly status: string;
  readonly expectedItemCount: number;
  readonly publishedAt: string;
}

/** Live-row facts a caller already has, or that `readSpaceManifest` fills once the catalog
 * carries the queries in {@link CATALOG_REQUIREMENTS}. */
export interface SpaceManifestLiveFacts {
  readonly storeClass?: string;
  readonly authorityClass?: SpaceManifestAuthorityClass;
  readonly activePublication?: SpaceManifestActivePublication;
}

/**
 * Per-space budgets do not exist anywhere in contract 0.4.16 (memo §6.5b): the only budgets
 * are per-*store* (`vector_store.quota_profile`: `maximumDocuments`/`maximumBytes`/
 * `maximumSpaces`) and per-*selection* (`PromotionSelection.budget`). Presenting the store's
 * quota as though it belonged to one space would be a false number, so every entry's `budget`
 * is unconditionally this shape until the contract carries a real per-space reservation —
 * never computed from `quota_profile`, whether or not a future `retrieval.store_quota_usage`
 * query exists in the catalog.
 */
export type SpaceManifestBudget =
  | { readonly reserved: number; readonly remaining: number; readonly basis: string }
  | { readonly status: "unavailable"; readonly reason: string };

const BUDGET_UNAVAILABLE: SpaceManifestBudget = {
  status: "unavailable",
  reason: "no per-space reservation exists in contract 0.4.16",
};

export interface SpaceManifestEntry<Space extends string> {
  readonly space: Space;
  readonly storeClass?: string;
  readonly authorityClass?: SpaceManifestAuthorityClass;
  readonly admittedNodeKinds: readonly string[];
  readonly profileBindings: readonly {
    readonly name: string;
    readonly version: string;
    readonly strategy: string;
    readonly nodeKinds: readonly string[];
  }[];
  readonly activePublication?: SpaceManifestActivePublication;
  readonly budget: SpaceManifestBudget;
}

export interface SpaceManifestUnavailable {
  readonly field: string;
  readonly reason: string;
  readonly requires: string;
}

export interface SpaceManifest<Space extends string> {
  readonly schemaVersion: typeof SPACE_MANIFEST_SCHEMA_VERSION;
  readonly tenantId: string;
  readonly atKnowledgeSeq: number | null;
  readonly contract: { readonly migrationHead: string; readonly workspaceFingerprint?: string };
  readonly profileTable: { readonly schemaVersion: string };
  readonly spaces: readonly SpaceManifestEntry<Space>[];
  readonly unavailable: readonly SpaceManifestUnavailable[];
}

export interface BuildSpaceManifestInput<Space extends string> {
  readonly tenantId: string;
  readonly spaces: readonly Space[];
  readonly profileTable: SpaceManifestProfileTable<Space>;
  readonly contract: { readonly migrationHead: string; readonly workspaceFingerprint?: string };
  readonly atKnowledgeSeq?: number | null;
  readonly liveFacts?: Readonly<Partial<Record<Space, SpaceManifestLiveFacts>>>;
  readonly unavailable?: readonly SpaceManifestUnavailable[];
}

/**
 * Pure, no I/O. One entry per space in `input.spaces`, in the supplied order, even when no
 * profile binds it and no live row exists for it. `profileBindings` is every supplied profile
 * whose `spaces` includes the entry's space; `admittedNodeKinds` is the sorted, deduplicated
 * union of those profiles' `nodeKinds`. Live-row facts supplied per space are merged in when
 * present; `budget` is always the unavailable form (see {@link SpaceManifestBudget}).
 */
export function buildSpaceManifest<Space extends string>(input: BuildSpaceManifestInput<Space>): SpaceManifest<Space> {
  const spaces = input.spaces.map((space): SpaceManifestEntry<Space> => {
    const bindings = input.profileTable.profiles.filter((profile) => profile.spaces.includes(space));
    const admittedNodeKinds = [...new Set(bindings.flatMap((profile) => profile.nodeKinds))].sort();
    const facts = input.liveFacts?.[space];
    return {
      space,
      ...(facts?.storeClass !== undefined ? { storeClass: facts.storeClass } : {}),
      ...(facts?.authorityClass !== undefined ? { authorityClass: facts.authorityClass } : {}),
      admittedNodeKinds,
      profileBindings: bindings.map((profile) => ({
        name: profile.name,
        version: profile.version,
        strategy: profile.strategy,
        nodeKinds: profile.nodeKinds,
      })),
      ...(facts?.activePublication !== undefined ? { activePublication: facts.activePublication } : {}),
      budget: BUDGET_UNAVAILABLE,
    };
  });
  return {
    schemaVersion: SPACE_MANIFEST_SCHEMA_VERSION,
    tenantId: input.tenantId,
    atKnowledgeSeq: input.atKnowledgeSeq ?? null,
    contract: input.contract,
    profileTable: { schemaVersion: input.profileTable.schemaVersion },
    spaces,
    unavailable: sortUnavailable(input.unavailable ?? []),
  };
}

function sortUnavailable(list: readonly SpaceManifestUnavailable[]): readonly SpaceManifestUnavailable[] {
  return [...list].sort((a, b) => a.requires.localeCompare(b.requires) || a.field.localeCompare(b.field));
}

/**
 * The narrow read port `readSpaceManifest` needs. `ReadExecutor` (`read-executor.ts`)
 * satisfies this structurally — `space-manifest.test.ts` carries the compile-time proof — so
 * this file depends on a shape, not a class, and `ReadExecutor` never has to change for it.
 */
export interface SpaceManifestReads {
  // `fingerprint` is `string | undefined` (a required key that may hold undefined), matching
  // `Workspace.fingerprint` in ../schema-workspace/index.js exactly — not `fingerprint?:
  // string` — so `ReadExecutor.workspace` satisfies this under `exactOptionalPropertyTypes`.
  readonly workspace: { readonly migrationHead: string; readonly fingerprint: string | undefined };
  catalog(): { readonly entries: readonly { readonly name: string }[] };
  head(tenantId: string): Promise<{ readonly knowledgeSeq: number }>;
  runIntent(raw: unknown): Promise<{
    readonly operations: readonly {
      readonly opId: string;
      readonly status: string;
      readonly rows?: readonly Record<string, unknown>[];
    }[];
  }>;
}

export interface ReadSpaceManifestInput<Space extends string> {
  readonly tenantId: string;
  readonly spaces: readonly Space[];
  readonly profileTable: SpaceManifestProfileTable<Space>;
}

interface CatalogRequirement {
  readonly query: string;
  readonly field: string;
}

/**
 * The five catalog queries `space_manifest` would need to read its live half (memo §6.5a).
 * None exists in the pinned contract 0.4.16 catalog today (memo §6.3) — this is what
 * `readSpaceManifest` checks `catalog()` against, not a claim that they exist. Flagged to
 * `ai-engineer-db-contract` as a cross-repository proposal, not designed here.
 */
const CATALOG_REQUIREMENTS: readonly CatalogRequirement[] = [
  { query: "retrieval.spaces_for_tenant", field: "space.purpose, space.class" },
  { query: "retrieval.store_spaces_for_tenant", field: "storeClass, authorityClass, activeSpaceVersionId" },
  { query: "retrieval.active_space_publication", field: "activePublication" },
  { query: "retrieval.space_version_config", field: "dims, precision, publicationLifecycle" },
  { query: "retrieval.store_quota_usage", field: "budget.reserved, budget.remaining" },
];

type OperationLike = {
  readonly opId: string;
  readonly status: string;
  readonly rows?: readonly Record<string, unknown>[];
};

/**
 * Catalog-aware. Inspects `reads.catalog().entries` for the five names above; with today's
 * empty catalog it calls neither `reads.head` nor `reads.runIntent` — no read intent is
 * issued and no database is touched — and returns the static half (profile bindings) plus all
 * five `unavailable` rows. When some of the five exist, it builds a `knowledge-read-intent.v1`
 * containing only those, runs it once, and merges the returned rows into the matching spaces;
 * the rest are recorded in `unavailable[]`.
 */
export async function readSpaceManifest<Space extends string>(
  reads: SpaceManifestReads,
  input: ReadSpaceManifestInput<Space>,
): Promise<SpaceManifest<Space>> {
  const known = new Set(reads.catalog().entries.map((entry) => entry.name));
  const present = CATALOG_REQUIREMENTS.filter((requirement) => known.has(requirement.query));
  const missing = CATALOG_REQUIREMENTS.filter((requirement) => !known.has(requirement.query));
  const unavailable = missing.map((requirement) => ({
    field: requirement.field,
    reason: `catalog does not include ${requirement.query}`,
    requires: requirement.query,
  }));

  let atKnowledgeSeq: number | null = null;
  let liveFacts: Partial<Record<Space, SpaceManifestLiveFacts>> = {};
  if (present.length > 0) {
    atKnowledgeSeq = (await reads.head(input.tenantId)).knowledgeSeq;
    const snapshot = await reads.runIntent(
      buildReadIntent(input.tenantId, reads.workspace.migrationHead, atKnowledgeSeq, present),
    );
    liveFacts = mergeLiveFacts(snapshot.operations, input.spaces);
  }

  return buildSpaceManifest({
    tenantId: input.tenantId,
    spaces: input.spaces,
    profileTable: input.profileTable,
    contract: {
      migrationHead: reads.workspace.migrationHead,
      ...(reads.workspace.fingerprint !== undefined ? { workspaceFingerprint: reads.workspace.fingerprint } : {}),
    },
    atKnowledgeSeq,
    liveFacts,
    unavailable,
  });
}

function buildReadIntent(
  tenantId: string,
  migrationHead: string,
  atKnowledgeSeq: number,
  present: readonly CatalogRequirement[],
): unknown {
  return {
    schemaVersion: "knowledge-read-intent.v1",
    intentId: "space-manifest",
    context: { tenantId },
    contract: { migrationHead },
    atKnowledgeSeq,
    operations: present.map((requirement) => ({
      opId: requirement.query,
      kind: "named_query",
      query: requirement.query,
    })),
  };
}

/**
 * Row shape assumed for the two proposed queries this unit can actually merge
 * (`retrieval.store_spaces_for_tenant`, `retrieval.active_space_publication`): one row per
 * space, keyed by a `space` column. Neither query exists yet, so this shape is this file's own
 * proposal for what they would return, not a read of any real schema. `retrieval.
 * spaces_for_tenant`, `retrieval.space_version_config` and `retrieval.store_quota_usage` fill
 * fields this manifest does not model (or, for the budget query, must never use — see
 * {@link SpaceManifestBudget}), so their rows are not merged even when the query is present.
 */
function mergeLiveFacts<Space extends string>(
  operations: readonly OperationLike[],
  spaces: readonly Space[],
): Partial<Record<Space, SpaceManifestLiveFacts>> {
  const known = new Set<string>(spaces);
  const byOpId = new Map(operations.map((operation) => [operation.opId, operation]));
  const facts: Partial<Record<Space, SpaceManifestLiveFacts>> = {};
  const set = (space: string, patch: SpaceManifestLiveFacts): void => {
    if (!known.has(space)) return;
    facts[space as Space] = { ...facts[space as Space], ...patch };
  };

  const storeSpaces = byOpId.get("retrieval.store_spaces_for_tenant");
  if (storeSpaces?.status === "ok") {
    for (const row of storeSpaces.rows ?? []) {
      if (typeof row.space !== "string") continue;
      set(row.space, {
        ...(typeof row.storeClass === "string" ? { storeClass: row.storeClass } : {}),
        ...(typeof row.authorityClass === "string"
          ? { authorityClass: row.authorityClass as SpaceManifestAuthorityClass }
          : {}),
      });
    }
  }

  const activePublication = byOpId.get("retrieval.active_space_publication");
  if (activePublication?.status === "ok") {
    for (const row of activePublication.rows ?? []) {
      if (typeof row.space !== "string" || row.activePublication === null || typeof row.activePublication !== "object")
        continue;
      set(row.space, { activePublication: row.activePublication as SpaceManifestActivePublication });
    }
  }

  return facts;
}
