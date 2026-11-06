import { deepFreeze, sha256Digest } from "@aiengineer/knowledge-core";
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from "./types.js";
import type { EmbedBatchReceipt, EmbeddingAdapter, EmbedManyRequest, EmbedOneRequest, EmbedReceipt } from "./types.js";
import { cacheKey, fakeVector, validateRequest, vectorDigest } from "./vectors.js";

export class DeterministicFakeEmbeddingAdapter implements EmbeddingAdapter {
  constructor(readonly dimensions = DEFAULT_EMBEDDING_DIMENSIONS) {}

  async discoverModel(modelSlug: string) {
    return deepFreeze({
      modelSlug,
      available: true,
      discoveredAt: "2000-01-01T00:00:00.000Z",
      rawDigest: sha256Digest(`fake:${modelSlug}`),
    });
  }

  async embedOne(request: EmbedOneRequest): Promise<EmbedReceipt> {
    const batch = await this.embedMany({ ...request, inputs: [request.input] });
    const { items, ...receipt } = batch;
    return deepFreeze({ ...receipt, item: items[0]! });
  }

  async embedMany(request: EmbedManyRequest): Promise<EmbedBatchReceipt> {
    validateRequest(request);
    const dimensions = request.expectedDimensions ?? this.dimensions;
    const modelSlug = request.modelSlug ?? DEFAULT_EMBEDDING_MODEL;
    const route = [...(request.providerRoute ?? ["deterministic-fake"])];
    const inputs = request.inputs.map((input, index) => ({
      projectionId: input.projectionId,
      index,
      inputDigest: sha256Digest(input.text),
      embedding: fakeVector(input.text, dimensions),
    }));
    const items = inputs.map((x) =>
      deepFreeze({
        ...x,
        outputDigest: vectorDigest(x.embedding),
        cacheKey: cacheKey(request.vectorSpaceVersionId, x.inputDigest),
        cached: false,
      }),
    );
    const inputManifestDigest = sha256Digest(
      JSON.stringify(items.map(({ projectionId, index, inputDigest }) => ({ projectionId, index, inputDigest }))),
    );
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
    return deepFreeze({
      requestId: `fake-${request.idempotencyKey}`,
      idempotencyKey: request.idempotencyKey,
      vectorSpaceVersionId: request.vectorSpaceVersionId,
      modelSlug,
      expectedDimensions: dimensions,
      requestedProviderRoute: route,
      observedProviderRoute: "deterministic-fake",
      inputManifestDigest,
      outputManifestDigest,
      routeDigest: sha256Digest(JSON.stringify(route)),
      modelDigest: sha256Digest(JSON.stringify({ modelSlug, dimensions })),
      items,
      usageTokens: request.inputs.reduce((n, i) => n + Math.ceil(i.text.length / 4), 0),
      costUsd: 0,
      latencyMs: 0,
      retryHistory: [],
    });
  }
}
