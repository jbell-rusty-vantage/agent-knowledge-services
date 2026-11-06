export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;
export const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export interface ModelDescriptor {
  readonly modelSlug: string;
  readonly available: boolean;
  readonly discoveredAt: string;
  readonly rawDigest: `sha256:${string}`;
}

export interface EmbedInput {
  readonly projectionId: string;
  readonly text: string;
  readonly textDigest?: `sha256:${string}`;
}

export interface EmbedRequestBase {
  readonly vectorSpaceVersionId: string;
  readonly modelSlug?: string;
  readonly expectedDimensions?: number;
  readonly providerRoute?: readonly string[];
  readonly idempotencyKey: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export interface EmbedOneRequest extends EmbedRequestBase {
  readonly input: EmbedInput;
}

export interface EmbedManyRequest extends EmbedRequestBase {
  readonly inputs: readonly EmbedInput[];
}

export interface RetryAttempt {
  readonly attempt: number;
  readonly status?: number;
  readonly retryable: boolean;
  readonly delayMs: number;
  readonly errorClass: string;
}

export interface EmbeddedItem {
  readonly projectionId: string;
  readonly index: number;
  readonly inputDigest: `sha256:${string}`;
  readonly embedding: readonly number[];
  readonly outputDigest: `sha256:${string}`;
  readonly cacheKey: string;
  readonly cached: boolean;
}

export interface EmbedBatchReceipt {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly vectorSpaceVersionId: string;
  readonly modelSlug: string;
  readonly expectedDimensions: number;
  readonly requestedProviderRoute: readonly string[];
  readonly observedProviderRoute: string;
  readonly inputManifestDigest: `sha256:${string}`;
  readonly outputManifestDigest: `sha256:${string}`;
  readonly routeDigest: `sha256:${string}`;
  readonly modelDigest: `sha256:${string}`;
  readonly items: readonly EmbeddedItem[];
  readonly usageTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly retryHistory: readonly RetryAttempt[];
}

export type EmbedReceipt = Omit<EmbedBatchReceipt, "items"> & { readonly item: EmbeddedItem };

export interface EmbeddingAdapter {
  discoverModel(modelSlug: string): Promise<ModelDescriptor>;
  embedOne(request: EmbedOneRequest): Promise<EmbedReceipt>;
  embedMany(request: EmbedManyRequest): Promise<EmbedBatchReceipt>;
}

export interface EmbeddingCache {
  get(key: string): readonly number[] | undefined;
  set(key: string, value: readonly number[]): void;
}

export interface GatewayAdapterOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly cache?: EmbeddingCache;
}
