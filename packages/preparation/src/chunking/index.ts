// Profiles — admitted chunk profiles and the profile table.
export { CHUNK_PROFILE_TABLE, ChunkProfileRegistry, defaultChunkProfileRegistry } from "./profiles/index.js";

// Chunker — chunkDocument over sealed DocumentNodes.
export { TOKENIZER_VERSION, chunkDocument, tokenize } from "./chunker/index.js";

// QA — reconstructable spans, token bounds, duplicate ratio.
export { reconstructChunk, validateChunks } from "./qa/index.js";

// Result shapes owned by this package.
export type { ChunkQaResult, ChunkingResult, PreparedChunk, PreparedChunkSpan } from "./types.js";

// Contract types some consumers reach through this package. Prefer importing
// them from `@aiengineer/knowledge-contracts` directly.
export type { ChunkProfile, ChunkProfileTable, ChunkStrategy } from "./types.js";
