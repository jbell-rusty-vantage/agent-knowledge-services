// Slice Q0 evidence: sha256 digest manifest of the committed bytes of every tracked file that Biome does NOT format.
// Bytes come from the git object database (never the working copy), so CRLF working copies do not matter.
// Usage from the repository root:
//   node docs/operations/package-cleanup/workspace/evidence/q0-digest-manifest.mjs <commit> <formatted-files.txt> [--lines <out.txt>]
// <formatted-files.txt> lists the files Biome checks (one repository-relative path per line).
// Prints the aggregate (file count and one sha256 over the sorted "path sha256" lines) and per-folder aggregates for
// catalog/, fixtures/, vendor/ and this evidence directory.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [commit, formattedPath] = process.argv.slice(2);
const linesOut = process.argv.includes("--lines") ? process.argv[process.argv.indexOf("--lines") + 1] : undefined;
if (!commit || !formattedPath) throw new Error("Usage: q0-digest-manifest.mjs <commit> <formatted-files.txt> [--lines out.txt]");
const formatted = new Set(readFileSync(formattedPath, "utf8").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const tree = execFileSync("git", ["ls-tree", "-r", "-z", commit], { maxBuffer: 1 << 28 }).toString("utf8").split("\0").filter(Boolean)
  .map((entry) => {
    const [meta, path] = [entry.slice(0, entry.indexOf("\t")), entry.slice(entry.indexOf("\t") + 1)];
    return { path, oid: meta.split(" ")[2] };
  })
  .filter(({ path }) => !formatted.has(path));

// One `git cat-file --batch` process streams every blob.
const child = spawn("git", ["cat-file", "--batch"], { stdio: ["pipe", "pipe", "inherit"] });
const chunks = [];
child.stdout.on("data", (chunk) => chunks.push(chunk));
child.stdin.end(tree.map(({ oid }) => `${oid}\n`).join(""));
await new Promise((resolve, reject) => { child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`cat-file exited ${code}`)))); });
const buffer = Buffer.concat(chunks);
let offset = 0;
const digests = new Map();
for (const { path, oid } of tree) {
  const end = buffer.indexOf(0x0a, offset);
  const [name, type, size] = buffer.subarray(offset, end).toString("ascii").split(" ");
  if (name !== oid || type !== "blob") throw new Error(`unexpected cat-file record for ${path}: ${name} ${type}`);
  const start = end + 1;
  digests.set(path, sha256(buffer.subarray(start, start + Number(size))));
  offset = start + Number(size) + 1;
}
const line = (path) => `${path} ${digests.get(path)}`;
const aggregate = (paths) => {
  const sorted = [...paths].sort();
  return { files: sorted.length, sha256: sha256(sorted.map(line).join("\n")) };
};
const all = [...digests.keys()];
const evidenceDirectory = "docs/operations/package-cleanup/workspace/evidence/";
const folders = {};
for (const [label, prefix] of [["catalog", "catalog/"], ["fixtures", "fixtures/"], ["vendor", "vendor/"], ["evidence", evidenceDirectory]]) {
  folders[label] = aggregate(all.filter((path) => path.startsWith(prefix)));
}
const catalogSubfolders = {};
for (const path of all.filter((entry) => entry.startsWith("catalog/"))) {
  const key = path.split("/").slice(0, 2).join("/");
  (catalogSubfolders[key] ??= []).push(path);
}
const result = {
  commit: execFileSync("git", ["rev-parse", commit]).toString().trim(),
  formatterFileCount: formatted.size,
  notFormatted: aggregate(all),
  folders,
  catalogSubfolders: Object.fromEntries(Object.entries(catalogSubfolders).sort().map(([key, paths]) => [key, aggregate(paths)])),
};
if (linesOut) writeFileSync(linesOut, `${[...all].sort().map(line).join("\n")}\n`);
console.log(JSON.stringify(result, null, 2));
