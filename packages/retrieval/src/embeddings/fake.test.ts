import { describe, expect, it } from "vitest";
import { DeterministicFakeEmbeddingAdapter } from "./fake.js";

const request = {
  vectorSpaceVersionId: "version-1",
  idempotencyKey: "embed-operation-1",
  expectedDimensions: 3,
  inputs: [
    { projectionId: "a", text: "alpha" },
    { projectionId: "b", text: "beta" },
  ],
};

describe("DeterministicFakeEmbeddingAdapter", () => {
  it("returns stable ordered deterministic embeddings and manifests", async () => {
    const adapter = new DeterministicFakeEmbeddingAdapter(8);
    const first = await adapter.embedMany({ ...request, expectedDimensions: 8 });
    const second = await adapter.embedMany({ ...request, expectedDimensions: 8 });
    expect(first.items.map((x) => x.projectionId)).toEqual(["a", "b"]);
    expect(first.outputManifestDigest).toBe(second.outputManifestDigest);
    expect(first.items[0]!.embedding).toHaveLength(8);
  });

  it("rejects caller-supplied digest mismatches and duplicate projection identities", async () => {
    const adapter = new DeterministicFakeEmbeddingAdapter(3);
    await expect(
      adapter.embedMany({
        ...request,
        inputs: [
          {
            projectionId: "a",
            text: "alpha",
            textDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
      }),
    ).rejects.toThrow("TEXT_DIGEST_MISMATCH");
    await expect(
      adapter.embedMany({
        ...request,
        inputs: [
          { projectionId: "a", text: "alpha" },
          { projectionId: "a", text: "beta" },
        ],
      }),
    ).rejects.toThrow("DUPLICATE_EMBEDDING_PROJECTION");
  });
});
