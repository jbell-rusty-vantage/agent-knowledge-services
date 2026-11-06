// Semantic — cosine similarity between the query vector and a record's vector.
// Pure and dimension-strict: a length mismatch or a non-finite component fails
// loudly rather than silently producing a meaningless score.
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`QUERY_VECTOR_DIMENSION_MISMATCH:${a.length}:${b.length}`);
  let dot = 0,
    an = 0,
    bn = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!,
      bv = b[i]!;
    if (!Number.isFinite(av) || !Number.isFinite(bv)) throw new Error("NON_FINITE_VECTOR");
    dot += av * bv;
    an += av * av;
    bn += bv * bv;
  }
  return an && bn ? dot / (Math.sqrt(an) * Math.sqrt(bn)) : 0;
}
