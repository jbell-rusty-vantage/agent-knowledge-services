import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("../dist/demo-assets/", import.meta.url));
const catalog = resolve(root, "catalog/verification-benchmarks/diagnostics-companies-v1");
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const manifestBytes = await readFile(resolve(catalog, "manifest.json"));
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.manifestDigest, "sha256:fc927c53f8bc308227fe3e9f1f5d321e3075986140a25ce07755208c86ac09e1");
const files = [{ name: "manifest.json", bytes: manifestBytes }];
for (const entry of manifest.files) {
  assert.match(entry.name, /^[a-z0-9-]+\.json$/u);
  const source = resolve(catalog, entry.name);
  assert.equal(await realpath(source), source);
  const bytes = await readFile(source);
  assert.equal(hash(bytes), entry.digest);
  assert.equal(bytes.byteLength, entry.bytes);
  files.push({ name: entry.name, bytes });
}
const preparationDigest = manifest.sourcePreparationDigest;
assert.match(preparationDigest, /^sha256:[a-f0-9]{64}$/u);
const preparation = resolve(root, "catalog/verification-assets", preparationDigest.slice(7));
const preparationBytes = await readFile(resolve(preparation, "manifest.json"));
assert.equal(hash(preparationBytes), preparationDigest);
const artifacts = [{ name: "manifest.json", bytes: preparationBytes }];
for (const item of JSON.parse(preparationBytes).artifacts) {
  assert.match(item.file, /^artifacts\/[a-f0-9-]{36}\.bin$/u);
  const source = resolve(preparation, item.file);
  assert.equal(await realpath(source), source);
  const bytes = await readFile(source);
  assert.equal(hash(bytes), item.handle.digest);
  assert.equal(bytes.byteLength, item.handle.byteLength);
  artifacts.push({ name: item.file, bytes });
}
// Verify the complete source closure before copying into the generated CLI assets.
for (const [directory, entries] of [
  [resolve(output, "catalog/diagnostics-companies-v1"), files],
  [resolve(output, "preparations", preparationDigest.slice(7)), artifacts],
]) {
  for (const item of entries) {
    const target = resolve(directory, item.name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, item.bytes);
  }
}
// SV-17: the claim/report semantic replay fixtures served only the retired claims-based offline demo.
console.log(`Benchmark assets: ${files.length} catalog files, ${artifacts.length - 1} preparation artifacts`);
