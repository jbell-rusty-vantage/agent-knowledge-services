import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDING_BUNDLE_VIDEO_IDS,
  findEmbeddingBundleSeed,
  importEmbeddingBundleFixtures,
  loadEmbeddingBundles,
  validateEmbeddingBundle,
} from "./embedding-bundles.js";
describe("embedding bundle fixtures", () => {
  it("loads and validates all three actual versioned bundles deterministically", async () => {
    const first = await loadEmbeddingBundles();
    const second = await loadEmbeddingBundles();
    expect(first.map((item) => item.bundle.video_id)).toEqual(EMBEDDING_BUNDLE_VIDEO_IDS);
    expect(first.map((item) => item.digest)).toEqual(second.map((item) => item.digest));
    expect(first.reduce((sum, item) => sum + item.bundle.engineering_claims.length, 0)).toBe(41);
    expect(first.every((item) => item.bundle.store_class === "internal_exploratory")).toBe(true);
  });
  it("rejects promotion-class and schema drift", () => {
    expect(() => validateEmbeddingBundle({ schema_version: "bad" })).toThrow("Unsupported");
  });
  it("imports exact files with a deterministic provenance manifest", async () => {
    const first = await mkdtemp(join(tmpdir(), "knowledge-bundles-a-"));
    const second = await mkdtemp(join(tmpdir(), "knowledge-bundles-b-"));
    try {
      const a = await importEmbeddingBundleFixtures(first);
      const b = await importEmbeddingBundleFixtures(second);
      expect(a).toEqual(b);
      expect((await loadEmbeddingBundles(first)).map((item) => item.digest)).toEqual(
        a.bundles.map((item) => item.digest),
      );
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  });
  it("rejects an incomplete or changed fixture set", async () => {
    const destination = await mkdtemp(join(tmpdir(), "knowledge-bundles-invalid-"));
    try {
      await importEmbeddingBundleFixtures(destination);
      const bundlePath = join(destination, "videos", EMBEDDING_BUNDLE_VIDEO_IDS[0], "embedding-bundle.json");
      const original = await readFile(bundlePath, "utf8");
      await writeFile(bundlePath, `${original} `, "utf8");
      await expect(loadEmbeddingBundles(destination)).rejects.toThrow("digest mismatch");
      await unlink(bundlePath);
      await expect(loadEmbeddingBundles(destination)).rejects.toThrow();
      await unlink(join(destination, "outputs", "catalog.json"));
      await expect(loadEmbeddingBundles(destination)).rejects.toThrow();
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });
  it("resolves only the repository fixture", async () => {
    const fixtureRoot = await findEmbeddingBundleSeed();
    expect((await loadEmbeddingBundles()).every(({ sourcePath }) => sourcePath.startsWith(fixtureRoot))).toBe(true);
  });
});
