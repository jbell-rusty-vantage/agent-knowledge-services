import type { ChunkProfile, SourceLocator } from "@aiengineer/knowledge-contracts";

export type { ChunkProfile, ChunkProfileTable, ChunkStrategy } from "@aiengineer/knowledge-contracts";

export interface PreparedChunkSpan {
  readonly nodeId: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly locator: SourceLocator;
}

export interface PreparedChunk {
  readonly id: string;
  readonly ordinal: number;
  readonly role: string;
  readonly sourceText: string;
  readonly contextualPrefix: string;
  readonly embeddingText: string;
  readonly sourceTextDigest: `sha256:${string}`;
  readonly embeddingTextDigest: `sha256:${string}`;
  readonly sourceTokenCount: number;
  readonly embeddingTokenCount: number;
  readonly spans: readonly PreparedChunkSpan[];
}

export interface ChunkQaResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly duplicateTokenRatio: number;
  readonly reconstructedChunkCount: number;
}

export interface ChunkingResult {
  readonly profile: ChunkProfile;
  readonly inputDigest: `sha256:${string}`;
  readonly outputDigest: `sha256:${string}`;
  readonly chunks: readonly PreparedChunk[];
  readonly omittedNodeIds: readonly string[];
  readonly qa: ChunkQaResult;
}
