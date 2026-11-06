import { assertSealedCaptureDigest } from "./sealed-bytes.js";

export interface SearchSealedCaptureInput {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly query: string;
  readonly limit?: number;
}

export interface SealedCaptureSearchHit {
  readonly offset: number;
  readonly length: number;
  readonly excerpt: string;
  readonly occurrenceCount: number;
}

export interface SealedCaptureSearchResult {
  readonly digest: string;
  readonly query: string;
  readonly hits: readonly SealedCaptureSearchHit[];
}

const DEFAULT_HIT_LIMIT = 8;
const MAXIMUM_HIT_LIMIT = 32;
const EXCERPT_RADIUS = 80;

export function searchSealedCapture(input: SearchSealedCaptureInput): SealedCaptureSearchResult {
  assertSealedCaptureDigest(input.bytes, input.digest);
  const query = input.query;
  if (!query) return { digest: input.digest, query, hits: [] };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_HIT_LIMIT), MAXIMUM_HIT_LIMIT);
  return {
    digest: input.digest,
    query,
    hits: collectHits(text, query, limit),
  };
}

function collectHits(text: string, query: string, limit: number): SealedCaptureSearchHit[] {
  const offsets: number[] = [];
  let occurrenceCount = 0;
  let cursor = 0;
  while (true) {
    const offset = text.indexOf(query, cursor);
    if (offset < 0) break;
    if (offsets.length < limit) offsets.push(offset);
    occurrenceCount += 1;
    cursor = offset + Math.max(1, query.length);
  }
  return offsets.map((offset) => ({
    offset,
    length: query.length,
    excerpt: excerptAround(text, offset, query.length),
    occurrenceCount,
  }));
}

function excerptAround(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - EXCERPT_RADIUS);
  const end = Math.min(text.length, offset + length + EXCERPT_RADIUS);
  return text.slice(start, end);
}
