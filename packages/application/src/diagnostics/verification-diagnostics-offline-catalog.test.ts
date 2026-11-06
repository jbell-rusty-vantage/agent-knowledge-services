import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verificationBenchmarkDigest } from "@aiengineer/knowledge-evaluation";
import {
  DIAGNOSTICS_OFFLINE_CATALOG_SEALS,
  loadDiagnosticsOfflineCatalog,
} from "./verification-diagnostics-offline-catalog.js";
const root = resolve(import.meta.dirname, "../../../..");
const catalog = (name: string) => resolve(root, "catalog/verification-benchmarks", name);
const reseal = (manifest: Record<string, unknown>) => {
  const material = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "manifestDigest"));
  return { ...material, manifestDigest: verificationBenchmarkDigest(material) };
};
describe("diagnostics offline catalog", () => {
  it.each(["diagnostics-companies-v1", "diagnostics-companies-pilot-v3"] as const)(
    "authenticates %s without provider authority",
    async (name) => {
      const loaded = await loadDiagnosticsOfflineCatalog(name, catalog(name));
      expect(loaded.dataset.frozen).toBe(true);
      expect(loaded.dataset.manifestDigest).toBe(DIAGNOSTICS_OFFLINE_CATALOG_SEALS[name].datasetManifestDigest);
      expect(loaded.catalogManifestDigest).toBe(DIAGNOSTICS_OFFLINE_CATALOG_SEALS[name].catalogManifestDigest);
      expect(loaded.files.size).toBe(7);
      expect(loaded).not.toHaveProperty("authority");
    },
  );
  it("does not use network capability", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("NETWORK_FORBIDDEN");
    }) as typeof fetch;
    try {
      await expect(
        loadDiagnosticsOfflineCatalog("diagnostics-companies-v1", catalog("diagnostics-companies-v1")),
      ).resolves.toMatchObject({ name: "diagnostics-companies-v1" });
    } finally {
      globalThis.fetch = original;
    }
  });
  it("rejects a changed manifest-declared file", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "diagnostics-catalog-"));
    try {
      await cp(catalog("diagnostics-companies-v1"), directory, { recursive: true });
      await writeFile(
        resolve(directory, "source-ledger.json"),
        `${await readFile(resolve(directory, "source-ledger.json"), "utf8")} `,
      );
      await expect(loadDiagnosticsOfflineCatalog("diagnostics-companies-v1", directory)).rejects.toThrow(
        "DIAGNOSTICS_OFFLINE_CATALOG_FILE_DIGEST_MISMATCH",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects a resealed manifest path escape", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "diagnostics-catalog-"));
    try {
      await cp(catalog("diagnostics-companies-v1"), directory, { recursive: true });
      const manifestPath = resolve(directory, "manifest.json"),
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.files[0].name = "../dataset.json";
      await writeFile(manifestPath, `${JSON.stringify(reseal(manifest), null, 2)}\n`);
      await expect(loadDiagnosticsOfflineCatalog("diagnostics-companies-v1", directory)).rejects.toThrow(
        "DIAGNOSTICS_OFFLINE_CATALOG_SEAL_MISMATCH",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
