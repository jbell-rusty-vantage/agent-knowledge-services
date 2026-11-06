import { describe, expect, it, vi } from "vitest";
import { MemoryEmbeddingCache } from "./cache.js";
import {
  createGatewayEmbeddingAdapterFromEnvironment,
  retryDelay,
  VercelAiGatewayEmbeddingAdapter,
} from "./gateway.js";

const request = {
  vectorSpaceVersionId: "version-1",
  idempotencyKey: "embed-operation-1",
  expectedDimensions: 3,
  inputs: [
    { projectionId: "a", text: "alpha" },
    { projectionId: "b", text: "beta" },
  ],
};

describe("VercelAiGatewayEmbeddingAdapter", () => {
  it("retries with one idempotency key, validates provider order, and caches per version", async () => {
    let calls = 0;
    const seenKeys: string[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls++;
      seenKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (calls === 1) return new Response("busy", { status: 503 });
      return Response.json({
        id: "req",
        model: "openai/text-embedding-3-small",
        data: [
          { index: 0, embedding: [1, 0, 0] },
          { index: 1, embedding: [0, 1, 0] },
        ],
        usage: { total_tokens: 2 },
        providerMetadata: { gateway: { cost: "0.0001", provider: "openai" } },
      });
    });
    const cache = new MemoryEmbeddingCache();
    const adapter = new VercelAiGatewayEmbeddingAdapter({
      apiKey: "not-logged",
      fetch: fetch as typeof globalThis.fetch,
      sleep: async () => {},
      cache,
      now: (() => {
        let n = 0;
        return () => ++n;
      })(),
    });
    const first = await adapter.embedMany(request);
    expect(first.retryHistory).toHaveLength(1);
    expect(seenKeys).toEqual([request.idempotencyKey, request.idempotencyKey]);
    expect(first.items.every((x) => !x.cached)).toBe(true);
    const second = await adapter.embedMany(request);
    expect(calls).toBe(2);
    expect(second.items.every((x) => x.cached)).toBe(true);
    expect(second.observedProviderRoute).toBe("cache");
    const other = await adapter.embedMany({ ...request, vectorSpaceVersionId: "version-2" });
    expect(other.items.every((x) => !x.cached)).toBe(true);
    expect(calls).toBe(3);
  });

  it("rejects reordered, partial and malformed output atomically", async () => {
    for (const data of [
      [
        { index: 1, embedding: [1, 0, 0] },
        { index: 0, embedding: [0, 1, 0] },
      ],
      [{ index: 0, embedding: [1, 0, 0] }],
      [
        { index: 0, embedding: [1, 0] },
        { index: 1, embedding: [0, 1, 0] },
      ],
      [
        { index: 0, embedding: [1, 0, 0] },
        { index: 1, embedding: [0, Number.POSITIVE_INFINITY, 0] },
      ],
    ]) {
      const adapter = new VercelAiGatewayEmbeddingAdapter({
        apiKey: "secret",
        fetch: async () => Response.json({ data }),
      });
      await expect(adapter.embedMany(request)).rejects.toThrow();
    }
  });

  it("discovers the configured model without exposing credentials", async () => {
    const adapter = new VercelAiGatewayEmbeddingAdapter({
      apiKey: "secret-never-returned",
      fetch: async () => Response.json({ data: [{ id: "openai/text-embedding-3-small" }] }),
      now: () => 0,
    });
    const found = await adapter.discoverModel("openai/text-embedding-3-small");
    expect(found.available).toBe(true);
    expect(JSON.stringify(found)).not.toContain("secret-never-returned");
  });

  it("throws without retrying on a non-retryable status", async () => {
    let calls = 0;
    const adapter = new VercelAiGatewayEmbeddingAdapter({
      apiKey: "secret",
      fetch: async () => {
        calls++;
        return new Response("bad request", { status: 400 });
      },
    });
    await expect(adapter.embedMany(request)).rejects.toThrow("AI_GATEWAY_EMBED_400");
    expect(calls).toBe(1);
  });
});

describe("createGatewayEmbeddingAdapterFromEnvironment", () => {
  it("throws AI_GATEWAY_CREDENTIAL_MISSING with neither env var set", () => {
    expect(() => createGatewayEmbeddingAdapterFromEnvironment({})).toThrow("AI_GATEWAY_CREDENTIAL_MISSING");
  });

  it("accepts VERCEL_OIDC_TOKEN when AI_GATEWAY_API_KEY is absent", () => {
    expect(() => createGatewayEmbeddingAdapterFromEnvironment({ VERCEL_OIDC_TOKEN: "token" })).not.toThrow();
  });
});

describe("retryDelay", () => {
  it("honours a numeric retry-after header, capped at 10 seconds", () => {
    expect(retryDelay(0, "3")).toBe(3_000);
    expect(retryDelay(0, "60")).toBe(10_000);
  });

  it("falls back to capped exponential backoff when the header is absent or unparseable", () => {
    expect(retryDelay(0, null)).toBe(100);
    expect(retryDelay(0, undefined)).toBe(100);
    expect(retryDelay(0, "not-a-number")).toBe(100);
    expect(retryDelay(10)).toBe(2_000);
  });
});
