import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locks the SV-09 disposable fixture corpus (`catalog/research/fixtures/**`) by the SHA-256 of each file's exact bytes.
 * `verifyManifest` refuses any added, removed or changed file; the harness never runs on an unlocked corpus.
 *   lock:   corepack pnpm exec tsx scripts/experiments/sprint-v/manifest.ts --lock
 *   verify: corepack pnpm exec tsx scripts/experiments/sprint-v/manifest.ts
 */
export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../catalog/research/fixtures");
export const MANIFEST_PATH = join(FIXTURES_DIR, "manifest.json");

export interface FixtureManifest {
  readonly schemaVersion: "sv09-fixture-manifest.v1";
  readonly id: "sv09-ai-engineer-fixture-corpus";
  readonly note: string;
  readonly lockedAt: string;
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
  /** SHA-256 over the sorted `path:sha256` lines: one digest pins the whole corpus. */
  readonly corpusDigest: string;
}

const sha256 = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function computeFiles(): FixtureManifest["files"] {
  return walk(FIXTURES_DIR)
    .filter((path) => path !== MANIFEST_PATH)
    .map((path) => {
      const bytes = readFileSync(path);
      return { path: relative(FIXTURES_DIR, path).split("\\").join("/"), sha256: sha256(bytes), bytes: bytes.length };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function corpusDigest(files: FixtureManifest["files"]): string {
  return sha256(files.map((file) => `${file.path}:${file.sha256}`).join("\n"));
}

export function lockManifest(): FixtureManifest {
  const files = computeFiles();
  const manifest: FixtureManifest = {
    schemaVersion: "sv09-fixture-manifest.v1",
    id: "sv09-ai-engineer-fixture-corpus",
    note: "Disposable synthetic engineering fixtures (SV-09). Not research corpus; no real product, study or person.",
    lockedAt: new Date().toISOString(),
    files,
    corpusDigest: corpusDigest(files),
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Refuses (throws `FIXTURE_UNLOCKED`) unless every file matches the locked manifest exactly. */
export function verifyManifest(): FixtureManifest {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as FixtureManifest;
  const current = computeFiles();
  const problems: string[] = [];
  const locked = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  for (const file of current) {
    const expected = locked.get(file.path);
    if (expected === undefined) problems.push(`added:${file.path}`);
    else if (expected !== file.sha256) problems.push(`changed:${file.path}`);
    locked.delete(file.path);
  }
  for (const path of locked.keys()) problems.push(`removed:${path}`);
  if (corpusDigest(manifest.files) !== manifest.corpusDigest) problems.push("corpus_digest");
  if (problems.length > 0) throw new Error(`FIXTURE_UNLOCKED: ${problems.join(", ")}`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = process.argv.includes("--lock") ? lockManifest() : verifyManifest();
  process.stdout.write(`${manifest.files.length} files, corpus ${manifest.corpusDigest}\n`);
}
