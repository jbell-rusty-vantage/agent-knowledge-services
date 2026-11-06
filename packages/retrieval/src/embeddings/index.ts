// Contract — request/response shapes, the adapter port, and pinned defaults.
export { AI_GATEWAY_BASE_URL, DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from "./types.js";
export type {
  EmbedBatchReceipt,
  EmbeddedItem,
  EmbeddingAdapter,
  EmbeddingCache,
  EmbedInput,
  EmbedManyRequest,
  EmbedOneRequest,
  EmbedReceipt,
  EmbedRequestBase,
  GatewayAdapterOptions,
  ModelDescriptor,
  RetryAttempt,
} from "./types.js";

// Vectors — validation and digesting shared by both adapters.
export { validateVector, vectorDigest } from "./vectors.js";

// Cache — per-process embedding cache keyed by vector-space version.
export { MemoryEmbeddingCache } from "./cache.js";

// Gateway adapter (wired) — Vercel AI Gateway embedding adapter with retry and caching.
export { createGatewayEmbeddingAdapterFromEnvironment, VercelAiGatewayEmbeddingAdapter } from "./gateway.js";

// Deterministic fake — no network, stable output for tests and examples.
export { DeterministicFakeEmbeddingAdapter } from "./fake.js";
