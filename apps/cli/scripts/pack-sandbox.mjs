#!/usr/bin/env node
/**
 * Packs `ks` as a standalone npm tarball that installs outside the workspace (a sandbox, a laptop) with `npm i <tarball>`.
 * The build inlines every workspace package and splits lazily loaded modules into chunks (tsup.config.ts); the tarball's
 * `dependencies` are the third-party packages the bundle imports, read from esbuild's metafile. It ships the skills whose
 * procedures use this distribution (every skills/manifest.json skill with the `platform-cli` surface). The private demo
 * assets (dist/demo-assets) are not redistributed: `ks verify demo …` and `ks verify benchmark capture diagnostics-companies`
 * run from a workspace build.
 *
 *   node scripts/pack-sandbox.mjs            → dist/sandbox/ks-<version>.tgz
 *   node scripts/pack-sandbox.mjs --print    → print the tarball path only
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const repository = resolve(appDir, "../..");
const BIN = { ks: "index.js" };
const BUILD_HINT = "run `pnpm --filter @aiengineer/knowledge-cli... build` first";
const DISTRIBUTION = "platform-cli";

const fail = (message) => {
  console.error(message);
  process.exit(2);
};

const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
const versionOf = (name) =>
  JSON.parse(readFileSync(join(appDir, "node_modules", name, "package.json"), "utf8")).version;
const metafilePath = join(appDir, "dist", "metafile-esm.json");
if (!existsSync(join(appDir, "dist", BIN.ks)) || !existsSync(metafilePath))
  fail(`dist/${BIN.ks} or its metafile is missing — ${BUILD_HINT}`);
const metafile = JSON.parse(readFileSync(metafilePath, "utf8"));
if (!metafile.outputs || typeof metafile.outputs !== "object") fail("esbuild metafile has no outputs");

// Every JavaScript output ships: the entry and the chunks it imports statically or lazily.
const outputs = Object.entries(metafile.outputs).filter(([path]) => path.endsWith(".js"));
if (!outputs.some(([path]) => resolve(appDir, path) === join(appDir, "dist", BIN.ks)))
  fail(`esbuild metafile does not describe dist/${BIN.ks}`);
const runtimeImportKinds = new Set(["import-statement", "dynamic-import", "require-call", "require-resolve"]);
const runtimePackages = new Set();
for (const [path, output] of outputs) {
  const file = resolve(appDir, path);
  if (dirname(file) !== join(appDir, "dist")) fail(`unexpected output location ${path}`);
  if (!existsSync(file) || !Array.isArray(output.imports)) fail(`${path} is missing — ${BUILD_HINT}`);
  // tsup appends a source-map comment after esbuild records output.bytes.
  const source = readFileSync(file);
  const comment = Buffer.from(`//# sourceMappingURL=${file.slice(dirname(file).length + 1)}.map`);
  if (!source.subarray(-comment.length).equals(comment) || source.byteLength - comment.length !== output.bytes)
    fail(`${path} does not match its esbuild metafile size — ${BUILD_HINT}`);
  for (const item of output.imports) {
    if (!runtimeImportKinds.has(item.kind)) fail(`unsupported import kind in ${path}: ${item.kind}`);
    if (!item.external) {
      if (!outputs.some(([candidate]) => candidate === item.path)) fail(`${path} imports unpacked output ${item.path}`);
      continue;
    }
    const specifier = item.path;
    if (typeof specifier !== "string" || specifier.length === 0) fail(`invalid external import in ${path}`);
    if (specifier.startsWith("node:")) continue;
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:"))
      fail(`${path} imports unpacked local module ${specifier}`);
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (name.startsWith("@aiengineer/"))
      fail(`${path} imports workspace package ${name}; workspace packages must be inlined`);
    if (!builtinModules.includes(name)) runtimePackages.add(name);
  }
}
const undeclared = [...runtimePackages].filter((name) => !pkg.dependencies?.[name]);
if (undeclared.length > 0)
  fail(`the bundle imports ${undeclared.join(", ")} but package.json does not declare them as runtime dependencies`);
const dependencies = Object.fromEntries([...runtimePackages].sort().map((name) => [name, versionOf(name)]));

// The skills this distribution serves; a silently thinner tarball is not acceptable.
const manifest = JSON.parse(readFileSync(join(repository, "skills", "manifest.json"), "utf8"));
const skills = manifest.skills
  .filter((skill) => (skill.surfaces ?? []).includes(DISTRIBUTION))
  .map((skill) => skill.id)
  .sort();
if (skills.length === 0) fail(`skills/manifest.json declares no ${DISTRIBUTION} skill`);
const missing = skills.filter((name) => !existsSync(join(repository, "skills", name, "SKILL.md")));
if (missing.length > 0) fail(`required ks skills are missing: ${missing.join(", ")}`);

const stage = join(appDir, "dist", "sandbox");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });
for (const [path] of outputs) copyFileSync(resolve(appDir, path), join(stage, "dist", path.slice("dist/".length)));
for (const name of skills) cpSync(join(repository, "skills", name), join(stage, "skills", name), { recursive: true });
copyFileSync(join(appDir, "README.md"), join(stage, "README.md"));

writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    {
      name: "ks",
      version: pkg.version,
      description:
        "Knowledge Services command line: remote commands through KnowledgeClient and the local file-store profile",
      license: "UNLICENSED",
      private: false,
      type: "module",
      bin: Object.fromEntries(Object.entries(BIN).map(([bin, file]) => [bin, `./dist/${file}`])),
      files: ["dist", "skills", "README.md"],
      engines: { node: ">=22" },
      dependencies,
    },
    null,
    2,
  )}\n`,
);

const packOutput = execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--json", "--pack-destination", process.platform === "win32" ? `"${stage}"` : stage],
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
    JSON.stringify(
      {
        tarball,
        bytes: packed.size,
        files: packed.entryCount,
        sha256: digest,
        dependencies: Object.keys(dependencies),
        skills,
      },
      null,
      2,
    ),
  );
