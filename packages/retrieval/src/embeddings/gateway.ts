import { randomUUID } from "node:crypto";
import { deepFreeze, sha256Digest } from "@aiengineer/knowledge-core";
import { AI_GATEWAY_BASE_URL, DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from "./types.js";
import type {
  EmbedBatchReceipt,
  EmbeddedItem,
  EmbeddingAdapter,
  EmbeddingCache,
  EmbedManyRequest,
  EmbedOneRequest,
  EmbedReceipt,
  GatewayAdapterOptions,
  ModelDescriptor,
  RetryAttempt,
} from "./types.js";
import { MemoryEmbeddingCache } from "./cache.js";
import { cacheKey, validateRequest, validateVector, vectorDigest } from "./vectors.js";

interface GatewayResponse {
  id?: string;
  model?: string;
  data?: Array<{ index: number; embedding: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
  providerMetadata?: { gateway?: { cost?: string | number; provider?: string } };
  provider_metadata?: { gateway?: { cost?: string | number; provider?: string } };
}

interface GatewayError extends Error {
  status?: number;
}

export function createGatewayEmbeddingAdapterFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: Omit<GatewayAdapterOptions, "apiKey"> = {},
): VercelAiGatewayEmbeddingAdapter {
  const key = environment.AI_GATEWAY_API_KEY ?? environment.VERCEL_OIDC_TOKEN;
  if (!key) {
    throw new Error("AI_GATEWAY_CREDENTIAL_MISSING");
  }
  return new VercelAiGatewayEmbeddingAdapter({ ...options, apiKey: key });
}

export class VercelAiGatewayEmbeddingAdapter implements EmbeddingAdapter {
  readonly #key: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #cache: EmbeddingCache;

  constructor(options: GatewayAdapterOptions) {
    if (!options.apiKey) {
      throw new Error("AI_GATEWAY_CREDENTIAL_MISSING");
    }
    this.#key = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? AI_GATEWAY_BASE_URL).replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
    this.#cache = options.cache ?? new MemoryEmbeddingCache();
  }

  async discoverModel(modelSlug: string): Promise<ModelDescriptor> {
    const response = await this.#fetch(`${this.#baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.#key}` },
    });
    if (!response.ok) {
      throw gatewayError(response.status, `AI_GATEWAY_DISCOVERY_${response.status}`);
    }
    const value: unknown = await response.json();
    const records = Array.isArray(value)
      ? value
      : typeof value === "object" && value !== null && Array.isArray((value as { data?: unknown }).data)
        ? (value as { data: unknown[] }).data
        : [];
    const available = records.some(
      (record) =>
        typeof record === "object" &&
        record !== null &&
        ((record as { id?: unknown }).id === modelSlug || (record as { modelId?: unknown }).modelId === modelSlug),
    );
    return deepFreeze({
      modelSlug,
      available,
      discoveredAt: new Date(this.#now()).toISOString(),
      rawDigest: sha256Digest(JSON.stringify(value)),
    });
  }

  async embedOne(request: EmbedOneRequest): Promise<EmbedReceipt> {
    const result = await this.embedMany({ ...request, inputs: [request.input] });
    const { items, ...receipt } = result;
    return deepFreeze({ ...receipt, item: items[0]! });
  }

  async embedMany(request: EmbedManyRequest): Promise<EmbedBatchReceipt> {
    validateRequest(request);
    const modelSlug = request.modelSlug ?? DEFAULT_EMBEDDING_MODEL;
    const dimensions = request.expectedDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    const route = [...(request.providerRoute ?? ["openai"])];
    const digests = request.inputs.map((input) => {
      const actual = sha256Digest(input.text);
      if (input.textDigest !== undefined && input.textDigest !== actual) {
        throw new Error(`EMBEDDING_TEXT_DIGEST_MISMATCH:${input.projectionId}`);
      }
      return actual;
    });
    const inputManifestDigest = sha256Digest(
      JSON.stringify(
        request.inputs.map((input, index) => ({
          index,
          projectionId: input.projectionId,
          inputDigest: digests[index],
        })),
      ),
    );
    const routeDigest = sha256Digest(JSON.stringify(route));
    const modelDigest = sha256Digest(JSON.stringify({ modelSlug, dimensions }));
    const cached = request.inputs.map((_, index) =>
      this.#cache.get(cacheKey(request.vectorSpaceVersionId, digests[index]!)),
    );
    const missingIndexes = cached.flatMap((value, index) => (value === undefined ? [index] : []));
    const retryHistory: RetryAttempt[] = [];
    let response: GatewayResponse = {};
    const started = this.#now();
    if (missingIndexes.length) {
      const body = {
        model: modelSlug,
        input: missingIndexes.map((index) => request.inputs[index]!.text),
        dimensions,
        provider_options: { gateway: { only: route } },
      };
      response = await this.#postWithRetry(
        body,
        request.idempotencyKey,
        request.timeoutMs ?? 30_000,
        request.maxRetries ?? 2,
        retryHistory,
      );
      const ordered = validateGatewayData(response.data, missingIndexes.length, dimensions);
      for (let outputIndex = 0; outputIndex < ordered.length; outputIndex++) {
        const originalIndex = missingIndexes[outputIndex]!;
        const vector = ordered[outputIndex]!;
        this.#cache.set(cacheKey(request.vectorSpaceVersionId, digests[originalIndex]!), vector);
        cached[originalIndex] = vector;
      }
    }
    const items = request.inputs.map((input, index): EmbeddedItem => {
      const embedding = cached[index]!;
      validateVector(embedding, dimensions);
      return deepFreeze({
        projectionId: input.projectionId,
        index,
        inputDigest: digests[index]!,
        embedding: [...embedding],
        outputDigest: vectorDigest(embedding),
        cacheKey: cacheKey(request.vectorSpaceVersionId, digests[index]!),
        cached: !missingIndexes.includes(index),
      });
    });
    const outputManifestDigest = sha256Digest(
      JSON.stringify(
        items.map(({ projectionId, index, inputDigest, outputDigest }) => ({
          projectionId,
          index,
          inputDigest,
          outputDigest,
        })),
      ),
    );
    const metadata = response.providerMetadata?.gateway ?? response.provider_metadata?.gateway;
    const tokens = response.usage?.total_tokens ?? response.usage?.prompt_tokens ?? 0;
    const cost = Number(metadata?.cost ?? 0);
    return deepFreeze({
      requestId: response.id ?? `local-${randomUUID()}`,
      idempotencyKey: request.idempotencyKey,
      vectorSpaceVersionId: request.vectorSpaceVersionId,
      modelSlug,
      expectedDimensions: dimensions,
      requestedProviderRoute: route,
      observedProviderRoute:
        metadata?.provider ?? response.model ?? (missingIndexes.length ? "gateway:unreported" : "cache"),
      inputManifestDigest,
      outputManifestDigest,
      routeDigest,
      modelDigest,
      items,
      usageTokens: Number.isFinite(tokens) ? tokens : 0,
      costUsd: Number.isFinite(cost) ? cost : 0,
      latencyMs: Math.max(0, this.#now() - started),
      retryHistory,
    });
  }

  async #postWithRetry(
    body: object,
    idempotencyKey: string,
    timeoutMs: number,
    maxRetries: number,
    history: RetryAttempt[],
  ): Promise<GatewayResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.#fetch(`${this.#baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#key}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) {
          return (await response.json()) as GatewayResponse;
        }
        const retryable = [408, 409, 425, 429, 500, 502, 503, 504].includes(response.status);
        if (!retryable || attempt >= maxRetries) {
          throw gatewayError(response.status, `AI_GATEWAY_EMBED_${response.status}`);
        }
        const delay = retryDelay(attempt, response.headers.get("retry-after"));
        history.push({
          attempt: attempt + 1,
          status: response.status,
          retryable: true,
          delayMs: delay,
          errorClass: `HTTP_${response.status}`,
        });
        await this.#sleep(delay);
      } catch (error) {
        const typed = error as GatewayError;
        if (typed.status !== undefined) {
          throw error;
        }
        if (attempt >= maxRetries) {
          throw error;
        }
        const delay = retryDelay(attempt);
        history.push({
          attempt: attempt + 1,
          retryable: true,
          delayMs: delay,
          errorClass: error instanceof Error ? error.name : "UNKNOWN",
        });
        await this.#sleep(delay);
      }
    }
  }
}

export function validateGatewayData(data: GatewayResponse["data"], count: number, dimensions: number): number[][] {
  if (!data || data.length !== count) {
    throw new Error(`EMBEDDING_COUNT_MISMATCH:${data?.length ?? 0}:${count}`);
  }
  data.forEach((item, index) => {
    if (item.index !== index) {
      throw new Error(`EMBEDDING_ORDER_MISMATCH:${item.index}:${index}`);
    }
    validateVector(item.embedding, dimensions);
  });
  return data.map((item) => item.embedding);
}

export function retryDelay(attempt: number, retryAfter?: string | null): number {
  const seconds = retryAfter === undefined || retryAfter === null ? NaN : Number(retryAfter);
  return Number.isFinite(seconds) ? Math.min(10_000, seconds * 1000) : Math.min(2_000, 100 * 2 ** attempt);
}

export function gatewayError(status: number, message: string): GatewayError {
  const error = new Error(message) as GatewayError;
  error.status = status;
  return error;
}
