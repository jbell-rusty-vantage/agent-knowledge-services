import type { AuthScope } from "@aiengineer/knowledge-research-core";
import type { RevisionFrontier, RevisionStatus } from "../ports.js";

/**
 * On-demand Crossref revision frontier (SV-07): one HTTP GET of `/works/{doi}` when invoked; no polling, no live feed,
 * no background work. The update relations Crossref records on a work (`updated-by`, including Retraction Watch
 * sourced notices) and on a notice (`update-to`) are mapped to a revision status. Any transport failure, non-200
 * response or unparseable body is `unknown` (authority unavailable holds; it never reads as `current`).
 * Tests use a recorded fake `fetch`; the adapter is never called against the network in tests.
 */
export type FetchLike = (
  url: string,
  init: { readonly method: "GET"; readonly headers: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

export interface CrossrefOptions {
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  /** Crossref "polite pool" contact; sent as the User-Agent mailto when configured. */
  readonly mailto?: string;
  readonly timeoutMs?: number;
}

const RETRACTED = new Set(["retraction", "retracted", "removal"]);
const WITHDRAWN = new Set(["withdrawal", "withdrawn"]);
const CORRECTED = new Set([
  "correction",
  "corrigendum",
  "erratum",
  "addendum",
  "clarification",
  "expression_of_concern",
  "expression-of-concern",
  "partial_retraction",
  "new_version",
]);

type Update = { type?: unknown; DOI?: unknown };

function statusOf(types: readonly string[]): RevisionStatus {
  if (types.some((type) => RETRACTED.has(type))) return "retracted";
  if (types.some((type) => WITHDRAWN.has(type))) return "withdrawn";
  if (types.some((type) => CORRECTED.has(type))) return "corrected";
  return "current";
}

export class CrossrefRevisionFrontier implements RevisionFrontier {
  private readonly baseUrl: string;

  constructor(private readonly options: CrossrefOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.crossref.org").replace(/\/$/, "");
  }

  async check(_scope: AuthScope, doi: string): Promise<{ status: RevisionStatus; notices: string[] }> {
    if (!/^10\.\d{4,9}\/\S{1,300}$/.test(doi)) return { status: "unknown", notices: [] };
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.options.mailto)
      headers["user-agent"] = `knowledge-services-revision-frontier (mailto:${this.options.mailto})`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const response = await this.options.fetch(`${this.baseUrl}/works/${encodeURIComponent(doi)}`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (response.status !== 200) return { status: "unknown", notices: [] };
      const body = (await response.json()) as { message?: Record<string, unknown> };
      const message = body?.message;
      if (message === undefined || message === null || typeof message !== "object")
        return { status: "unknown", notices: [] };
      const updates = [
        ...(Array.isArray(message["updated-by"]) ? (message["updated-by"] as Update[]) : []),
        // A DOI that is itself a retraction/withdrawal notice reports what it updates; the notice is not current.
        ...(Array.isArray(message["update-to"]) ? (message["update-to"] as Update[]) : []),
      ];
      const types = updates.flatMap((update) =>
        typeof update?.type === "string" ? [update.type.toLowerCase().replace(/\s+/g, "_")] : [],
      );
      const notices = updates.flatMap((update) => (typeof update?.DOI === "string" ? [update.DOI.toLowerCase()] : []));
      return { status: statusOf(types), notices: [...new Set(notices)].sort() };
    } catch {
      return { status: "unknown", notices: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}
