import type { RetrievalRecord } from "../types.js";
import { normalize, tokenize } from "./text.js";

// Generic channel scorer, shared by every lexical channel and by the semantic
// channel in retrieve.ts: rank eligible records by an arbitrary scorer, keep only
// positive scores, and break ties by id so the same input always sorts the same way.
export function score(
  records: readonly RetrievalRecord[],
  scorer: (r: RetrievalRecord) => number,
  explanation: string,
) {
  return records
    .map((record) => ({ record, score: scorer(record), explanation }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
}

export function exactScore(record: RetrievalRecord, query: string): number {
  const q = normalize(query);
  return (record.identifiers ?? []).some((x) => {
    const identifier = normalize(x);
    return identifier === q || q.includes(identifier);
  })
    ? 1
    : normalize(record.text).includes(q)
      ? 0.95
      : 0;
}

export function ftsScore(text: string, tokens: readonly string[]): number {
  if (!tokens.length) return 0;
  const words = tokenize(text);
  const set = new Set(words);
  return tokens.filter((x) => set.has(x)).length / tokens.length;
}

export function trigramScore(a: string, b: string): number {
  const grams = (x: string) => {
    const n = `  ${normalize(x)} `;
    const result: string[] = [];
    for (let i = 0; i < n.length - 2; i++) result.push(n.slice(i, i + 3));
    return result;
  };
  const aa = grams(a),
    bb = grams(b),
    counts = new Map<string, number>();
  aa.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
  let overlap = 0;
  for (const x of bb) {
    const count = counts.get(x) ?? 0;
    if (count) {
      overlap++;
      counts.set(x, count - 1);
    }
  }
  return aa.length + bb.length ? (2 * overlap) / (aa.length + bb.length) : 0;
}
