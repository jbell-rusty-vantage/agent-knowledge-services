#!/usr/bin/env node
/**
 * Pack `knowledge-verify` + `knowledge` as a standalone npm tarball that can be installed inside a
 * sandbox (Docker / Vercel Sandbox) with `npm i <tarball>`. The bundles already inline every
 * workspace package; the tarball's `dependencies` are derived from the external imports recorded
 * in esbuild's metafile for the two packed bins (currently @modelcontextprotocol/sdk, zod, pg).
 *
 *   node scripts/pack-sandbox.mjs            → dist/sandbox/knowledge-verify-<version>.tgz
 *   node scripts/pack-sandbox.mjs --print    → print the tarball path only
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const BINS = { "knowledge-verify": "index.js", knowledge: "knowledge.js" };
const BUILD_HINT = "run `pnpm --filter @aiengineer/knowledge-verification-executor build` first";

const fail = (message) => {
  console.error(message);
  process.exit(2);
};

for (const file of Object.values(BINS)) {
  if (!existsSync(join(appDir, "dist", file))) fail(`dist/${file} missing — ${BUILD_HINT}`);
}

const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
const versionOf = (name) =>
  JSON.parse(readFileSync(join(appDir, "node_modules", name, "package.json"), "utf8")).version;

const metafilePath = join(appDir, "dist", "metafile-esm.json");
if (!existsSync(metafilePath)) fail(`dist/metafile-esm.json missing — ${BUILD_HINT}`);
const metafile = JSON.parse(readFileSync(metafilePath, "utf8"));
if (!metafile.outputs || typeof metafile.outputs !== "object") fail("esbuild metafile has no outputs");
const runtimeImportKinds = new Set(["import-statement", "dynamic-import", "require-call", "require-resolve"]);
const runtimePackages = new Set();
for (const file of Object.values(BINS)) {
  const binPath = join(appDir, "dist", file);
  const matches = Object.entries(metafile.outputs).filter(([path]) => resolve(appDir, path) === binPath);
  if (matches.length !== 1 || !Array.isArray(matches[0][1].imports))
    fail(`esbuild metafile does not describe dist/${file}`);
  // tsup appends a source-map comment after esbuild records output.bytes.
  const source = readFileSync(binPath);
  const sourceMapComment = Buffer.from(`//# sourceMappingURL=${file}.map`);
  if (
    !source.subarray(-sourceMapComment.length).equals(sourceMapComment) ||
    source.byteLength - sourceMapComment.length !== matches[0][1].bytes
  )
    fail(`dist/${file} does not match its esbuild metafile size — ${BUILD_HINT}`);
  for (const item of matches[0][1].imports) {
    if (!item.external) fail(`dist/${file} imports unpacked output ${item.path}`);
    if (!runtimeImportKinds.has(item.kind)) fail(`unsupported external import kind in dist/${file}: ${item.kind}`);
    const specifier = item.path;
    if (typeof specifier !== "string" || specifier.length === 0) fail(`invalid external import in dist/${file}`);
    if (specifier.startsWith("node:")) continue;
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:"))
      fail(`dist/${file} imports unpacked local module ${specifier}`);
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (!builtinModules.includes(name)) runtimePackages.add(name);
  }
}
const undeclared = [...runtimePackages].filter((name) => !pkg.dependencies?.[name]);
if (undeclared.length > 0)
  fail(`bundles import ${undeclared.join(", ")} but package.json does not declare them as runtime dependencies`);
const dependencies = Object.fromEntries([...runtimePackages].sort().map((name) => [name, versionOf(name)]));

const stage = join(appDir, "dist", "sandbox");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });
for (const file of Object.values(BINS)) copyFileSync(join(appDir, "dist", file), join(stage, "dist", file));
copyFileSync(join(appDir, "README.md"), join(stage, "README.md"));

const copyTree = (from, to) => {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyTree(join(from, entry.name), join(to, entry.name));
    else copyFileSync(join(from, entry.name), join(to, entry.name));
  }
};
// knowledge-verify is canonical here; the knowledge skills are canonical in ../../skills.
const REQUIRED_SKILLS = ["schema-explore", "knowledge-db", "knowledge-ingest"];
const skillSources = [
  [join(appDir, "skills", "knowledge-verify"), "knowledge-verify"],
  ...REQUIRED_SKILLS.map((name) => [resolve(appDir, "..", "..", "skills", name), name]),
];
const missingSkills = skillSources
  .filter(([from]) => !existsSync(join(from, "SKILL.md")))
  .map(([from, name]) => `${name} → ${from}`);
if (missingSkills.length > 0)
  fail(
    `required sandbox skills are missing (a silently thinner tarball is not acceptable):\n  ${missingSkills.join("\n  ")}`,
  );
const manifestPath = resolve(appDir, "..", "..", "skills", "manifest.json");
const manifestSkills = new Set(JSON.parse(readFileSync(manifestPath, "utf8")).skills.map((skill) => skill.id));
const unregistered = REQUIRED_SKILLS.filter((name) => !manifestSkills.has(name));
if (unregistered.length > 0) fail(`skills/manifest.json does not register ${unregistered.join(", ")}`);
for (const [from, name] of skillSources) copyTree(from, join(stage, "skills", name));

writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "knowledge-verify",
      version: pkg.version,
      description: pkg.description,
      license: "UNLICENSED",
      private: false,
      type: "module",
      bin: Object.fromEntries(Object.entries(BINS).map(([bin, file]) => [bin, `./dist/${file}`])),
      files: ["dist", "skills", "README.md"],
      engines: { node: ">=22" },
      dependencies,
    },
    null,
    2,
  ) + "\n",
);

const packOutput = execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--json", "--pack-destination", stage],
  { cwd: stage, encoding: "utf8", shell: process.platform === "win32" },
);
const packed = JSON.parse(packOutput)[0];
const tarball = join(stage, packed.filename);
const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
writeFileSync(join(stage, "TARBALL"), `${tarball}\n`);
writeFileSync(join(stage, "TARBALL.sha256"), `${digest}\n`);
if (process.argv.includes("--print")) console.log(tarball);
else
  console.log(
    JSON.stringify({ tarball, bytes: packed.size, sha256: digest, dependencies: Object.keys(dependencies) }, null, 2),
  );
