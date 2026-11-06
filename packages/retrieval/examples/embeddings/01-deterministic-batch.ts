import { DeterministicFakeEmbeddingAdapter } from "../../src/index.js";

/**
 * The deterministic fake adapter never calls a network. Given the same
 * inputs it returns the same ordering and the same output manifest digest
 * on every run, which is what a caller replays to prove an embedding batch
 * is reproducible without re-calling a provider.
 */
export async function deterministicBatchExample() {
  const adapter = new DeterministicFakeEmbeddingAdapter(8);
  const request = {
    vectorSpaceVersionId: "space-v1",
    idempotencyKey: "batch-1",
    inputs: [
      { projectionId: "alpha", text: "A worker renews its lease before every retry." },
      { projectionId: "beta", text: "Retries never exceed the shared budget." },
    ],
  };
  const first = await adapter.embedMany(request);
  const second = await adapter.embedMany(request);
  return {
    order: first.items.map((item) => item.projectionId),
    outputManifestDigest: first.outputManifestDigest,
    identicalAcrossRuns: first.outputManifestDigest === second.outputManifestDigest,
  };
}

if (process.argv[1]?.includes("01-deterministic-batch")) {
  deterministicBatchExample().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`));
}
