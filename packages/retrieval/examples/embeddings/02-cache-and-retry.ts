import { MemoryEmbeddingCache, VercelAiGatewayEmbeddingAdapter } from "../../src/index.js";

/**
 * The gateway adapter retries a transient 503 under the same idempotency key,
 * then serves a repeat request for the same vector-space version from the
 * cache without another network call. Nothing here reaches a real provider:
 * `fetch` is a stub that counts calls and returns canned responses.
 */
export async function cacheAndRetryExample() {
  let calls = 0;
  const seenIdempotencyKeys: string[] = [];
  const fetchStub = async (_url: unknown, init?: RequestInit) => {
    calls++;
    seenIdempotencyKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    if (calls === 1) return new Response("busy", { status: 503 });
    return Response.json({
      id: "req-1",
      data: [{ index: 0, embedding: [1, 0, 0] }],
      usage: { total_tokens: 4 },
      providerMetadata: { gateway: { cost: "0.00001", provider: "openai" } },
    });
  };
  const adapter = new VercelAiGatewayEmbeddingAdapter({
    apiKey: "example-key",
    fetch: fetchStub as typeof globalThis.fetch,
    sleep: async () => {},
    cache: new MemoryEmbeddingCache(),
  });
  const request = {
    vectorSpaceVersionId: "space-v1",
    idempotencyKey: "batch-2",
    expectedDimensions: 3,
    inputs: [{ projectionId: "alpha", text: "A worker renews its lease before every retry." }],
  };
  const first = await adapter.embedMany(request);
  const second = await adapter.embedMany(request);
  return {
    retryCount: first.retryHistory.length,
    sameIdempotencyKeyAcrossRetry: new Set(seenIdempotencyKeys).size === 1,
    firstCached: first.items[0]!.cached,
    secondCached: second.items[0]!.cached,
    totalCalls: calls,
  };
}

if (process.argv[1]?.includes("02-cache-and-retry")) {
  cacheAndRetryExample().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`));
}
