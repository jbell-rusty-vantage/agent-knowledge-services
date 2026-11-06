import type { DocumentNode } from "@aiengineer/knowledge-contracts";
import type { ChunkStrategy } from "../types.js";
import { TOKEN_PATTERN } from "./tokenizer.js";

/** A candidate slice of one sealed node, before it is joined into a chunk. */
export interface RawSpan {
  readonly node: DocumentNode;
  readonly startOffset: number;
  readonly endOffset: number;
}

// Falling back to every node when the kinds a strategy filters on are absent is
// a known fail-open (Phase 1 memo, finding 7.2); it is left as-is here so the
// split changes no behavior, and F8 decides whether it throws or returns empty.
export function selectForStrategy(nodes: readonly DocumentNode[], strategy: ChunkStrategy): readonly DocumentNode[] {
  const kinds: Partial<Record<ChunkStrategy, readonly DocumentNode["kind"][]>> = {
    transcripts: ["transcript_segment"],
    code: ["code_block"],
    tables: ["table"],
  };
  const allowed = kinds[strategy];
  if (allowed === undefined) return nodes;
  const selected = nodes.filter(({ kind }) => allowed.includes(kind));
  return selected.length === 0 ? nodes : selected;
}

export function splitClaims(node: DocumentNode): readonly RawSpan[] {
  const spans: RawSpan[] = [];
  const expression = /[^.!?\n]+(?:[.!?]+|\n|$)/g;
  for (const match of node.text.matchAll(expression)) {
    const raw = match[0];
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.length === 0) continue;
    const startOffset = (match.index ?? 0) + leading;
    spans.push({ node, startOffset, endOffset: startOffset + text.length });
  }
  return spans;
}

export function splitNode(node: DocumentNode, maximumTokens: number): readonly RawSpan[] {
  const matches = [...node.text.matchAll(TOKEN_PATTERN)];
  if (matches.length <= maximumTokens) return [{ node, startOffset: 0, endOffset: node.text.length }];
  const spans: RawSpan[] = [];
  for (let cursor = 0; cursor < matches.length; cursor += maximumTokens) {
    const slice = matches.slice(cursor, cursor + maximumTokens);
    const first = slice[0]!;
    const last = slice.at(-1)!;
    spans.push({ node, startOffset: first.index, endOffset: last.index + last[0].length });
  }
  return spans;
}
