// Text — shared normalization every stage agrees on: plan admission, exact/trigram/
// fts scoring and query-term coverage all call this so "the same query" always means
// the same normalized string.
export function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

export function tokenize(value: string): string[] {
  return [
    ...new Set(
      normalize(value)
        .split(/[^a-z0-9_+.#/-]+/)
        .filter((x) => x.length > 1),
    ),
  ];
}
