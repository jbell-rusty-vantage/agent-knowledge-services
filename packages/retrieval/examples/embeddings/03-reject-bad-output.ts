import { VercelAiGatewayEmbeddingAdapter } from "../../src/index.js";

/**
 * The gateway adapter accepts a provider response only when it is complete,
 * ordered, dimensioned correctly and finite. Each malformed shape below is
 * rejected before it ever reaches the caller. `fetch` is a stub; nothing
 * here calls a real provider.
 */
export async function rejectBadOutputExample() {
  const request = {
    vectorSpaceVersionId: "space-v1",
    idempotencyKey: "batch-3",
    expectedDimensions: 3,
    inputs: [
      { projectionId: "alpha", text: "first" },
      { projectionId: "beta", text: "second" },
    ],
  };
  const cases: Record<string, unknown> = {
    reordered: [
      { index: 1, embedding: [1, 0, 0] },
      { index: 0, embedding: [0, 1, 0] },
    ],
    partial: [{ index: 0, embedding: [1, 0, 0] }],
    wrongDimension: [
      { index: 0, embedding: [1, 0] },
      { index: 1, embedding: [0, 1, 0] },
    ],
    nonFinite: [
      { index: 0, embedding: [1, 0, 0] },
      { index: 1, embedding: [0, Number.POSITIVE_INFINITY, 0] },
    ],
  };
  const results: Record<string, string> = {};
  for (const [name, data] of Object.entries(cases)) {
    const adapter = new VercelAiGatewayEmbeddingAdapter({
      apiKey: "example-key",
      fetch: async () => Response.json({ data }),
    });
    try {
      await adapter.embedMany(request);
      results[name] = "accepted";
    } catch (error) {
      results[name] = error instanceof Error ? error.message : String(error);
    }
  }
  return results;
}

if (process.argv[1]?.includes("03-reject-bad-output")) {
  rejectBadOutputExample().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`));
}
