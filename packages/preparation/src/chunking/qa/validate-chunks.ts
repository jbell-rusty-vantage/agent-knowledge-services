import type { DocumentNode } from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import type { ChunkProfile, ChunkQaResult, PreparedChunk } from "../types.js";

export function reconstructChunk(chunk: PreparedChunk, nodes: readonly DocumentNode[]): string {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return chunk.spans
    .map((span) => {
      const node = byId.get(span.nodeId);
      if (node === undefined) throw new Error(`Missing span node ${span.nodeId}`);
      if (span.endOffset > node.text.length || span.endOffset <= span.startOffset)
        throw new Error(`Invalid span for ${span.nodeId}`);
      return node.text.slice(span.startOffset, span.endOffset);
    })
    .join("\n\n");
}

// QA is the gate a preview must pass before anything is proposed: every chunk
// must replay from its spans, sit inside the profile token bounds, and not
// repeat its neighbour. A failure means "next admitted profile", never "accept".
export function validateChunks(
  chunks: readonly PreparedChunk[],
  nodes: readonly DocumentNode[],
  profile: ChunkProfile,
): ChunkQaResult {
  const issues: string[] = [];
  let reconstructedChunkCount = 0;
  for (const chunk of chunks) {
    if (chunk.sourceTokenCount > profile.maximumTokens) issues.push(`${chunk.id}: exceeds maximum source tokens`);
    if (chunk.sourceTokenCount < profile.minimumTokens) issues.push(`${chunk.id}: below minimum source tokens`);
    try {
      if (reconstructChunk(chunk, nodes) !== chunk.sourceText) issues.push(`${chunk.id}: reconstruction mismatch`);
      else reconstructedChunkCount += 1;
    } catch (error) {
      issues.push(`${chunk.id}: ${error instanceof Error ? error.message : "span failure"}`);
    }
  }
  const duplicateTokenRatio = adjacentDuplicateRatio(chunks);
  if (duplicateTokenRatio > profile.maximumDuplicatedTokenRatio)
    issues.push(`duplicated token ratio ${duplicateTokenRatio.toFixed(3)} exceeds limit`);
  return deepFreeze({ valid: issues.length === 0, issues, duplicateTokenRatio, reconstructedChunkCount });
}

function adjacentDuplicateRatio(chunks: readonly PreparedChunk[]): number {
  let duplicated = 0;
  let total = 0;
  for (let index = 1; index < chunks.length; index += 1) {
    const current = chunks[index]!;
    const previous = chunks[index - 1]!;
    total += current.sourceTokenCount;
    for (const span of current.spans) {
      for (const prior of previous.spans) {
        if (span.nodeId !== prior.nodeId) continue;
        const overlapStart = Math.max(span.startOffset, prior.startOffset);
        const overlapEnd = Math.min(span.endOffset, prior.endOffset);
        if (overlapEnd > overlapStart) {
          const spanLength = span.endOffset - span.startOffset;
          duplicated += Math.ceil(((overlapEnd - overlapStart) / spanLength) * current.sourceTokenCount);
        }
      }
    }
  }
  return total === 0 ? 0 : duplicated / total;
}
