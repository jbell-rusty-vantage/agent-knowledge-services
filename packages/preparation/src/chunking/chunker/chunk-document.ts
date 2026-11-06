import type { DocumentNode } from "@aiengineer/knowledge-contracts";
import { deepFreeze, sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "../../documents/index.js";
import { validateProfile } from "../profiles/index.js";
import { validateChunks } from "../qa/index.js";
import type { ChunkProfile, ChunkingResult, PreparedChunk } from "../types.js";
import { selectForStrategy, splitClaims, splitNode, type RawSpan } from "./strategies.js";
import { tokenize } from "./tokenizer.js";

// Chunking only slices a sealed tree: identity, digests and spans all derive
// from the nodes handed in, so the same nodes and profile always replay to the
// same outputDigest.
export function chunkDocument(nodes: readonly DocumentNode[], profile: ChunkProfile): ChunkingResult {
  validateProfile(profile);
  const ordered = orderDocumentNodes(nodes);
  const boilerplate = findBoilerplate(ordered, profile.boilerplateOccurrences);
  const seenContent = new Set<string>();
  const omittedNodeIds = ordered
    .filter((node) => {
      const key = normalizedDuplicateKey(node.text);
      const omit = boilerplate.has(key) || node.role === "boilerplate" || seenContent.has(key);
      seenContent.add(key);
      return omit;
    })
    .map(({ id }) => id);
  const admitted = ordered.filter((node) => !omittedNodeIds.includes(node.id) && node.text.trim().length > 0);
  const selected = selectForStrategy(admitted, profile.strategy);
  const rawGroups = buildGroups(selected, profile);
  const chunks = rawGroups.map((spans, ordinal) => materializeChunk(spans, ordinal, profile, ordered));
  const qa = validateChunks(chunks, nodes, profile);
  const inputDigest = sha256Digest(nodes.map(({ id, digest }) => ({ id, digest })));
  const outputDigest = sha256Digest(
    JSON.stringify(
      chunks.map(({ id, sourceTextDigest, embeddingTextDigest, spans }) => ({
        id,
        sourceTextDigest,
        embeddingTextDigest,
        spans,
      })),
    ),
  );
  return deepFreeze({ profile, inputDigest, outputDigest, chunks, omittedNodeIds, qa });
}

function orderDocumentNodes(nodes: readonly DocumentNode[]): DocumentNode[] {
  const children = new Map<string | undefined, DocumentNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const ordered: DocumentNode[] = [];
  const visit = (node: DocumentNode): void => {
    ordered.push(node);
    for (const child of children.get(node.id) ?? []) visit(child);
  };
  for (const root of children.get(undefined) ?? []) visit(root);
  if (ordered.length !== nodes.length) throw new Error("Document nodes contain an orphan or structural cycle");
  return ordered;
}

function buildGroups(nodes: readonly DocumentNode[], profile: ChunkProfile): readonly (readonly RawSpan[])[] {
  if (profile.strategy === "claims") return nodes.flatMap(splitClaims).map((span) => [span]);
  const groups: RawSpan[][] = [];
  let current: RawSpan[] = [];
  let tokens = 0;
  for (const node of nodes) {
    const parts = splitNode(node, profile.maximumTokens);
    for (const part of parts) {
      const partTokens = tokenize(part.node.text.slice(part.startOffset, part.endOffset)).length;
      const structuralBoundary = node.kind === "heading" && current.length > 0;
      if (current.length > 0 && (structuralBoundary || tokens + partTokens > profile.targetTokens)) {
        groups.push(current);
        current = [];
        tokens = 0;
      }
      current.push(part);
      tokens += partTokens;
      if (tokens >= profile.targetTokens) {
        groups.push(current);
        current = [];
        tokens = 0;
      }
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function materializeChunk(
  spans: readonly RawSpan[],
  ordinal: number,
  profile: ChunkProfile,
  allNodes: readonly DocumentNode[],
): PreparedChunk {
  const sourceText = spans
    .map(({ node, startOffset, endOffset }) => node.text.slice(startOffset, endOffset))
    .join("\n\n");
  const heading = profile.contextualHeadingPrefix ? nearestHeading(spans[0]!.node, allNodes) : undefined;
  const contextualPrefix = heading === undefined ? "" : `${heading.text}\n\n`;
  const embeddingText = `${contextualPrefix}${sourceText}`;
  const preparedSpans = spans.map(({ node, startOffset, endOffset }) => ({
    nodeId: node.id,
    startOffset,
    endOffset,
    locator: { ...node.locator, startOffset, endOffset },
  }));
  const identity = sha256Digest(
    JSON.stringify({
      profile: `${profile.name}@${profile.version}`,
      spans: preparedSpans,
      sourceText: sha256Digest(sourceText),
      projection: sha256Digest(embeddingText),
    }),
  );
  return deepFreeze({
    id: deterministicUuid(identity),
    ordinal,
    role: spans[0]!.node.role ?? profile.strategy,
    sourceText,
    contextualPrefix,
    embeddingText,
    sourceTextDigest: sha256Digest(sourceText),
    embeddingTextDigest: sha256Digest(embeddingText),
    sourceTokenCount: tokenize(sourceText).length,
    embeddingTokenCount: tokenize(embeddingText).length,
    spans: preparedSpans,
  });
}

function nearestHeading(node: DocumentNode, allNodes: readonly DocumentNode[]): DocumentNode | undefined {
  let cursor: DocumentNode | undefined = node;
  const byId = new Map(allNodes.map((candidate) => [candidate.id, candidate]));
  while (cursor !== undefined) {
    if (cursor.kind === "heading") return cursor;
    cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
  }
  return undefined;
}

function normalizedDuplicateKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function findBoilerplate(nodes: readonly DocumentNode[], threshold: number): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const { text } of nodes) {
    const key = normalizedDuplicateKey(text);
    if (key.length > 0) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([key, count]) => key.length < 240 && count >= threshold).map(([key]) => key));
}
