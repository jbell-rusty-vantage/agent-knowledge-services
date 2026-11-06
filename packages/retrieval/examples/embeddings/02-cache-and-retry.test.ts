import { describe, expect, it } from "vitest";
import { cacheAndRetryExample } from "./02-cache-and-retry.js";

describe("example 02: cache and retry", () => {
  it("retries the 503 once under the same idempotency key", async () => {
    const result = await cacheAndRetryExample();
    expect(result.retryCount).toBe(1);
    expect(result.sameIdempotencyKeyAcrossRetry).toBe(true);
    expect(result.firstCached).toBe(false);
  });

  it("serves the second call from the cache without another network call", async () => {
    const result = await cacheAndRetryExample();
    expect(result.secondCached).toBe(true);
    expect(result.totalCalls).toBe(2);
  });
});
