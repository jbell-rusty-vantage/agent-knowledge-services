import { resolveEvidenceSelector, sha256Digest } from "@aiengineer/knowledge-verification";
import type { CaptureRecord, FilesystemStore } from "./store.js";
import { encoder } from "./store.js";

/**
 * Producer-side locator helpers. These never decide verification; they help an
 * agent construct a `text_quote` selector that the deterministic engine will
 * later resolve on the exact captured bytes.
 */

export interface LocateResult {
  readonly captureId: string;
  readonly quote: string;
  readonly status: "resolved" | "ambiguous" | "not_found";
  readonly occurrenceCount: number;
  readonly selectedContentDigest?: `sha256:${string}`;
  readonly firstOffset?: number;
  readonly context?: string;
  /** When not found or ambiguous: candidate exact substrings the agent could use instead. */
  readonly suggestions: readonly { readonly quote: string; readonly offset: number; readonly context: string }[];
}

export interface SearchHit {
  readonly offset: number;
  readonly exact: string;
  readonly context: string;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return count;
    count += 1;
    from = index + 1;
  }
  return count;
}

function window(content: string, offset: number, length: number, radius = 160): string {
  const start = Math.max(0, offset - radius);
  const end = Math.min(content.length, offset + length + radius);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

export async function loadCaptureContent(
  store: FilesystemStore,
  captureId: string,
): Promise<{ record: CaptureRecord; content: string }> {
  const record = await store.readCapture(captureId);
  const content = await store.text(record.contentArtifact);
  return { record, content };
}

export function searchContent(content: string, query: string, limit = 10): SearchHit[] {
  const hits: SearchHit[] = [];
  const terms = query.trim();
  if (!terms) return hits;
  // Search the original string: lowercasing can expand Unicode characters and shift offsets.
  const literal = terms.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const match of content.matchAll(new RegExp(literal, "giu"))) {
    if (hits.length >= limit) break;
    const index = match.index;
    hits.push({ offset: index, exact: match[0], context: window(content, index, match[0].length) });
  }
  if (hits.length > 0) return hits;
  const words = normalize(terms)
    .split(" ")
    .filter((word) => word.length > 2);
  if (words.length === 0) return hits;
  const lines = content.split("\n");
  let offset = 0;
  for (const line of lines) {
    const normalized = normalize(line);
    const score = words.filter((word) => normalized.includes(word)).length;
    if (score === words.length || (words.length >= 3 && score >= words.length - 1)) {
      hits.push({ offset, exact: line, context: window(content, offset, line.length, 80) });
      if (hits.length >= limit) break;
    }
    offset += line.length + 1;
  }
  return hits;
}

export function locateQuote(record: CaptureRecord, content: string, quote: string): LocateResult {
  const contentBytes = encoder.encode(content);
  const resolved = resolveEvidenceSelector({
    captureId: record.captureId,
    representationArtifactId: record.contentArtifact.artifactId,
    representationDigest: record.contentArtifact.digest,
    selector: { kind: "text_quote", quote, normalization: "none" },
    content: contentBytes,
  });
  const occurrenceCount = resolved?.resolution.occurrenceCount ?? countOccurrences(content, quote);
  const status: LocateResult["status"] =
    resolved?.resolution.status === "resolved" ? "resolved" : occurrenceCount > 1 ? "ambiguous" : "not_found";
  const firstOffset = content.indexOf(quote);
  const suggestions: { quote: string; offset: number; context: string }[] = [];
  if (status === "ambiguous") {
    // Offer each occurrence with surrounding context so the agent can extend the quote to a unique span.
    let from = 0;
    while (suggestions.length < 5) {
      const index = content.indexOf(quote, from);
      if (index === -1) break;
      const start = Math.max(0, content.lastIndexOf("\n", index) + 1);
      const end = content.indexOf("\n", index + quote.length);
      const line = content.slice(start, end === -1 ? content.length : end);
      suggestions.push({ quote: line.trim(), offset: index, context: window(content, index, quote.length, 100) });
      from = index + 1;
    }
  } else if (status === "not_found") {
    for (const hit of searchContent(content, quote, 5))
      suggestions.push({ quote: hit.exact, offset: hit.offset, context: hit.context });
  }
  return {
    captureId: record.captureId,
    quote,
    status,
    occurrenceCount,
    ...(status === "resolved"
      ? { selectedContentDigest: sha256Digest(quote), firstOffset, context: window(content, firstOffset, quote.length) }
      : {}),
    suggestions,
  };
}
