import type { SearchEntry, Workspace } from "./workspace.js";

export interface SearchOptions {
  readonly kinds?: readonly string[];
  readonly domain?: string;
  readonly limit?: number;
}

export interface SearchHit {
  readonly id: string;
  readonly kind: string;
  readonly path?: string;
  readonly domain?: string;
  readonly summary?: string;
  readonly score: number;
  readonly matchedOn: "alias" | "name" | "term" | "tokens";
}

export interface SearchResult {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly suggestions: readonly string[];
}

/** Rank tiers: exact alias > exact name/id > terminology > alias containing every query word > summary/token overlap. */
const TIER = { alias: 1000, name: 800, term: 600, aliasPartial: 400, tokens: 1 } as const;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const normalize = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[_\-./:]+/g, " ")
    .replace(/\s+/g, " ");
const words = (text: string): string[] =>
  normalize(text)
    .split(" ")
    .filter((word) => word.length > 1);

function nameOf(entry: SearchEntry): string[] {
  const bare = entry.id.includes(":") ? entry.id.slice(entry.id.indexOf(":") + 1) : entry.id;
  return [entry.id, bare, entry.qualified_name ?? "", bare.split(".").at(-1) ?? ""].filter(Boolean).map(normalize);
}

function tokenScore(entry: SearchEntry, queryWords: readonly string[]): number {
  const haystack = new Set(
    [...entry.tokens, ...entry.aliases, ...words(entry.summary ?? ""), ...nameOf(entry).flatMap(words)].map(normalize),
  );
  let score = 0;
  for (const word of queryWords) {
    if (haystack.has(word)) score += 10;
    else if ([...haystack].some((token) => token.includes(word))) score += 3;
  }
  return score;
}

function scoreEntry(
  entry: SearchEntry,
  query: string,
  queryWords: readonly string[],
  aliasHits: ReadonlySet<string>,
): SearchHit | undefined {
  const aliases = entry.aliases.map(normalize);
  if (aliasHits.has(entry.id) || aliases.includes(query)) return hit(entry, TIER.alias, "alias");
  if (nameOf(entry).includes(query)) return hit(entry, TIER.name, "name");
  const tokens = tokenScore(entry, queryWords);
  if (
    queryWords.length > 0 &&
    aliases.some(
      (alias) => queryWords.every((word) => alias.includes(word)) || (alias.length > 3 && query.includes(alias)),
    )
  )
    return hit(entry, TIER.aliasPartial + tokens, "alias");
  return tokens > 0 ? hit(entry, TIER.tokens * tokens, "tokens") : undefined;
}

function hit(entry: SearchEntry, score: number, matchedOn: SearchHit["matchedOn"]): SearchHit {
  return {
    id: entry.id,
    kind: entry.kind,
    score,
    matchedOn,
    ...(entry.path ? { path: entry.path } : {}),
    ...(entry.domain ? { domain: entry.domain } : {}),
    ...(entry.summary ? { summary: entry.summary } : {}),
  };
}

function terminologyHits(workspace: Workspace, query: string): SearchHit[] {
  return Object.entries(workspace.terminology)
    .filter(([term, entry]) => normalize(term) === query || entry.aliases.some((alias) => normalize(alias) === query))
    .flatMap(([term, entry]) =>
      entry.ids.map((id) => ({
        id,
        kind: "term",
        path: `search/terminology.json#${term}`,
        score: TIER.term,
        matchedOn: "term" as const,
        ...(entry.definition ? { summary: entry.definition } : {}),
      })),
    );
}

function passesFilters(entry: SearchEntry, options: SearchOptions): boolean {
  if (options.kinds && options.kinds.length > 0 && !options.kinds.includes(entry.kind)) return false;
  if (options.domain && entry.domain !== options.domain) return false;
  return true;
}

export function searchWorkspace(workspace: Workspace, rawQuery: string, options: SearchOptions = {}): SearchResult {
  const query = normalize(rawQuery);
  const queryWords = words(rawQuery);
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const aliasHits = new Set(
    Object.entries(workspace.aliases)
      .filter(([alias]) => normalize(alias) === query)
      .flatMap(([, ids]) => ids),
  );
  const scored = workspace.index
    .filter((entry) => passesFilters(entry, options))
    .map((entry) => scoreEntry(entry, query, queryWords, aliasHits))
    .filter((item): item is SearchHit => item !== undefined);
  const merged = [...scored, ...terminologyHits(workspace, query)].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
  const hits = merged.slice(0, limit);
  const suggestions = hits.length > 0 ? [] : suggestAliases(workspace, queryWords);
  return { query: rawQuery, hits, suggestions };
}

function suggestAliases(workspace: Workspace, queryWords: readonly string[]): string[] {
  const pool = [...Object.keys(workspace.aliases), ...workspace.index.flatMap((entry) => entry.aliases)];
  return [
    ...new Set(pool.filter((alias) => queryWords.some((word) => normalize(alias).includes(word.slice(0, 4))))),
  ].slice(0, 8);
}
