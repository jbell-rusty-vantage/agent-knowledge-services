import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { VerificationBenchmarkDatasetSchema, type VerificationBenchmarkDataset } from "@aiengineer/knowledge-contracts";
import {
  assertFrozenVerificationBenchmarkDataset,
  verificationBenchmarkDigest,
} from "@aiengineer/knowledge-evaluation";
type Digest = `sha256:${string}`;
const digest = (bytes: Uint8Array): Digest => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const without = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const object = (value: unknown, code: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};
export const DIAGNOSTICS_OFFLINE_CATALOG_SEALS = Object.freeze({
  "diagnostics-companies-v1": Object.freeze({
    datasetManifestDigest: "sha256:e3529d2d27e3f473d4f6eb9da633b404c14c48f20b9db8c1d7a428220d538d9e" as Digest,
    catalogManifestDigest: "sha256:fc927c53f8bc308227fe3e9f1f5d321e3075986140a25ce07755208c86ac09e1" as Digest,
  }),
  "diagnostics-companies-pilot-v3": Object.freeze({
    datasetManifestDigest: "sha256:b625b311493f8c366ef43bf4047bf61f38d510fe7f3c340f50bca42de737dfe6" as Digest,
    catalogManifestDigest: "sha256:b90e96a2dc341f7d7c71f18d04f99fe4e9566b79c3b294effccf7dac585fa6ed" as Digest,
  }),
});
export type DiagnosticsOfflineCatalogName = keyof typeof DIAGNOSTICS_OFFLINE_CATALOG_SEALS;
export interface DiagnosticsOfflineCatalog {
  readonly name: DiagnosticsOfflineCatalogName;
  readonly directory: string;
  readonly dataset: VerificationBenchmarkDataset;
  readonly datasetManifestDigest: Digest;
  readonly catalogManifestDigest: Digest;
  readonly files: ReadonlyMap<string, Uint8Array>;
}
const requiredFiles = new Set([
  "dataset.json",
  "derived-input-grant.json",
  "annotation-guidelines.json",
  "annotation-queue.json",
  "source-ledger.json",
  "experiment.json",
  "benchmark-v1-candidate-pool.json",
]);
const safeLeaf = (name: unknown): name is string =>
  typeof name === "string" &&
  name.length > 0 &&
  name === basename(name) &&
  !name.includes("/") &&
  !name.includes("\\") &&
  name !== "." &&
  name !== "..";
/** Reads a sealed offline catalog without creating provider-input authority or network capability. */
export async function loadDiagnosticsOfflineCatalog(
  name: DiagnosticsOfflineCatalogName,
  directory: string,
): Promise<DiagnosticsOfflineCatalog> {
  const seal = DIAGNOSTICS_OFFLINE_CATALOG_SEALS[name];
  if (!seal) throw new Error("DIAGNOSTICS_OFFLINE_CATALOG_NAME_INVALID");
  const root = await realpath(directory),
    manifestPath = resolve(root, "manifest.json"),
    manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink())
    throw new Error("DIAGNOSTICS_OFFLINE_CATALOG_MANIFEST_PATH_INVALID");
  const manifestBytes = await readFile(manifestPath),
    manifest = object(JSON.parse(manifestBytes.toString("utf8")), "DIAGNOSTICS_OFFLINE_CATALOG_MANIFEST_INVALID");
  if (
    manifest.schemaVersion !== "verification-benchmark-catalog-manifest.v1" ||
    manifest.manifestDigest !== verificationBenchmarkDigest(without(manifest, "manifestDigest")) ||
    manifest.manifestDigest !== seal.catalogManifestDigest
  )
    throw new Error("DIAGNOSTICS_OFFLINE_CATALOG_SEAL_MISMATCH");
  if (!Array.isArray(manifest.files)) throw new Error("DIAGNOSTICS_OFFLINE_CATALOG_FILES_INVALID");
  const entries = manifest.files.map((entry) => object(entry, "DIAGNOSTICS_OFFLINE_CATALOG_FILE_INVALID")),
    names = entries.map((entry) => entry.name);
  if (
    entries.length !== requiredFiles.size ||
    new Set(names).size !== names.length ||
    names.some((entry) => !safeLeaf(entry)) ||
    requiredFiles.size !== new Set(names).size ||
    [...requiredFiles].some((entry) => !names.includes(entry))
  )
    throw new Error("DIAGNOSTICS_OFFLINE_CATALOG_FILE_SET_INVALID");
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (
      typeof entry.name !== "string" ||
      typeof entry.digest !== "string" ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1
    )
      throw new Error("DIAGNOSTICS_OFFLINE_CATALOG_FILE_INVALID");
    const expectedBytes = entry.bytes;
    const path = resolve(root, entry.name),
      pathRelative = relative(root, path);
    if (pathRelative.startsWith(`..${sep}`) || pathRelative === "..")
      throw new Error("DIAGNOSTICS_OFFLINE_CATALOG_PATH_ESCAPE");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("DIAGNOSTICS_OFFLINE_CATALOG_FILE_PATH_INVALID");
    const bytes = await readFile(path);
    if (bytes.byteLength !== expectedBytes || digest(bytes) !== entry.digest)
      throw new Error(`DIAGNOSTICS_OFFLINE_CATALOG_FILE_DIGEST_MISMATCH:${entry.name}`);
    files.set(entry.name, bytes);
  }
  const datasetBytes = files.get("dataset.json");
  if (!datasetBytes) throw new Error("DIAGNOSTICS_OFFLINE_CATALOG_DATASET_MISSING");
  const datasetRaw = object(
    JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(datasetBytes)),
    "DIAGNOSTICS_OFFLINE_CATALOG_DATASET_INVALID",
  );
  const dataset = VerificationBenchmarkDatasetSchema.strict().parse(datasetRaw) as VerificationBenchmarkDataset;
  assertFrozenVerificationBenchmarkDataset(dataset);
  if (
    dataset.frozen !== true ||
    dataset.schemaVersion !== "verification-benchmark.v1" ||
    dataset.verificationContractVersion !== "verification.v1" ||
    dataset.datasetId !== "diagnostics-companies" ||
    dataset.cases.length === 0 ||
    new Set(dataset.cases.map((item) => item.caseId)).size !== dataset.cases.length
  )
    throw new Error("DIAGNOSTICS_OFFLINE_CATALOG_DATASET_INVALID");
  if (
    dataset.manifestDigest !== seal.datasetManifestDigest ||
    manifest.datasetManifestDigest !== dataset.manifestDigest
  )
    throw new Error("DIAGNOSTICS_OFFLINE_CATALOG_DATASET_SEAL_MISMATCH");
  return Object.freeze({
    name,
    directory: root,
    dataset,
    datasetManifestDigest: dataset.manifestDigest as Digest,
    catalogManifestDigest: manifest.manifestDigest as Digest,
    files,
  });
}
