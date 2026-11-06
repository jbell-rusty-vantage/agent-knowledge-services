import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import typescript from "typescript";
import { API, SymbolFlags } from "typescript/unstable/sync";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const groups = {
  core: ["domain", "runtime", "observability"],
  preparation: ["conversion", "documents", "chunking"],
  retrieval: ["retrieval", "projections", "embeddings", "vector-backends"],
  "knowledge-db": ["schema-workspace", "db-read", "ingestion"],
};
const groupByPackage = Object.fromEntries(
  Object.entries(groups).flatMap(([group, packages]) => packages.map((name) => [name, group])),
);
const sourceFolders = { retrieval: "search" };
const testFilePattern = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

function git(...arguments_) {
  return execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" }).trim();
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function packageLocation(name, layout) {
  return `packages/${layout === "before" ? name : groupByPackage[name]}`;
}

function sourceEntry(name, layout) {
  const location = packageLocation(name, layout);
  return `${location}/src/${layout === "before" ? "" : `${sourceFolders[name] ?? name}/`}index.ts`;
}

function readManifest(path) {
  return JSON.parse(readFileSync(isAbsolute(path) ? path : join(repository, path), "utf8"));
}

function compilerExports(entry, project) {
  const program = project.program;
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`Compiler did not include ${entry}`);
  const checker = project.checker;
  const module = checker.getSymbolAtLocation(source);
  if (!module) throw new Error(`Compiler could not resolve module ${entry}`);
  return checker.getExportsOfModule(module).map((symbol) => {
    const target = symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const declarations = target.declarations ?? [];
    const explicitTypeOnly = symbol.declarations.some((declaration) => {
      const node = declaration.resolve();
      return node?.isTypeOnly === true || node?.parent?.isTypeOnly === true;
    });
    return {
      name: symbol.name,
      value: !explicitTypeOnly && Boolean(target.flags & SymbolFlags.Value),
      type: explicitTypeOnly || Boolean(target.flags & SymbolFlags.Type),
      declaredAt: sorted(declarations.map((declaration) =>
        relative(repository, declaration.resolve()?.getSourceFile()?.fileName ?? declaration.path).replaceAll("\\", "/"))),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

async function runtimeExports(path) {
  if (!existsSync(path)) return { status: "missing-build", names: [] };
  const content = readFileSync(path);
  try {
    const module = await import(pathToFileURL(path).href);
    return { status: "present-unverified-build", sha256: sha256(content), names: sorted(Object.keys(module)) };
  } catch (error) {
    return { status: "import-failed", sha256: sha256(content), names: [], error: String(error) };
  }
}

function testFiles(name, layout, tracked) {
  const oldPrefix = `packages/${name}/`;
  const currentPrefix = `${packageLocation(name, layout)}/`;
  const folder = sourceFolders[name] ?? name;
  return tracked.filter((path) => {
    if (!path.startsWith(currentPrefix) || !testFilePattern.test(path)) return false;
    if (layout === "before") return true;
    return path.startsWith(`${currentPrefix}src/${folder}/`) ||
      path.startsWith(`${currentPrefix}test/${folder}/`) ||
      path.startsWith(`${currentPrefix}examples/${folder}/`);
  }).map((path) => ({
    path,
    originalPath: layout === "before" ? path : path
      .replace(`${currentPrefix}src/${folder}/`, `${oldPrefix}src/`)
      .replace(`${currentPrefix}test/${folder}/`, `${oldPrefix}test/`)
      .replace(`${currentPrefix}examples/${folder}/`, `${oldPrefix}examples/`),
  })).sort((left, right) => left.path.localeCompare(right.path));
}

function manifestGraph(tracked) {
  const paths = tracked.filter((path) => /^(?:packages|apps|services)\/[^/]+\/package\.json$/.test(path));
  const manifests = paths.map((path) => ({ path, data: readManifest(path) }));
  const byName = new Map(manifests.map(({ data, path }) => [data.name, path]));
  const edges = manifests.map(({ data }) => ({
    from: data.name,
    to: sorted(Object.keys({ ...data.dependencies, ...data.devDependencies, ...data.optionalDependencies })
      .filter((dependency) => byName.has(dependency))),
  })).sort((left, right) => left.from.localeCompare(right.from));
  const connections = new Map(edges.map(({ from, to }) => [from, to]));
  const visited = new Set();
  const active = new Set();
  const cycles = [];
  function visit(name, trail) {
    if (active.has(name)) {
      cycles.push([...trail.slice(trail.indexOf(name)), name]);
      return;
    }
    if (visited.has(name)) return;
    active.add(name);
    for (const dependency of connections.get(name) ?? []) visit(dependency, [...trail, name]);
    active.delete(name);
    visited.add(name);
  }
  for (const name of connections.keys()) visit(name, []);
  return { packageCount: manifests.length, edges, cycles };
}

function collisions(packages, selectedGroup) {
  return Object.fromEntries(Object.entries(groups).filter(([group]) => !selectedGroup || group === selectedGroup).map(([group, members]) => {
    const owners = new Map();
    for (const name of members) {
      for (const item of packages[name].sourceExports) {
        const names = owners.get(item.name) ?? [];
        names.push(name);
        owners.set(item.name, names);
      }
    }
    return [group, [...owners].filter(([, names]) => names.length > 1)
      .map(([name, names]) => ({ name, packages: names }))
      .sort((left, right) => left.name.localeCompare(right.name))];
  }));
}

async function collect(layout, selectedGroup) {
  const tracked = git("ls-files", "--", "packages", "apps", "services").split(/\r?\n/).filter(Boolean);
  const packages = {};
  const api = new API();
  const members = selectedGroup ? groups[selectedGroup] : Object.keys(groupByPackage);
  const configPaths = [...new Set(members.map((name) =>
    join(repository, packageLocation(name, layout), "tsconfig.json")))];
  const snapshot = api.updateSnapshot({ openProjects: configPaths });
  let groupExports;
  try {
    for (const name of members) {
      const entry = sourceEntry(name, layout);
      const absoluteEntry = join(repository, entry);
      if (!existsSync(absoluteEntry)) throw new Error(`Missing source entry ${entry}`);
      const location = packageLocation(name, layout);
      const manifest = readManifest(`${location}/package.json`);
      const project = snapshot.getProject(join(repository, location, "tsconfig.json"));
      if (!project) throw new Error(`Compiler did not open ${location}/tsconfig.json`);
      packages[name] = {
        group: groupByPackage[name],
        packageName: manifest.name,
        sourceEntry: entry,
        sourceExports: compilerExports(absoluteEntry, project),
        testFiles: testFiles(name, layout, tracked),
      };
    }
    groupExports = layout === "after" ? Object.fromEntries(Object.keys(groups).filter((group) =>
      !selectedGroup || group === selectedGroup).map((group) => [
      group,
      { source: compilerExports(join(repository, `packages/${group}/src/index.ts`),
        snapshot.getProject(join(repository, `packages/${group}/tsconfig.json`))) },
    ])) : undefined;
  } finally {
    snapshot.dispose();
    api.close();
  }
  for (const name of Object.keys(packages)) {
    packages[name].runtimeExports = await runtimeExports(join(repository, packageLocation(name, layout), "dist/index.js"));
  }
  if (groupExports) {
    for (const group of Object.keys(groupExports)) {
      groupExports[group].runtime = await runtimeExports(join(repository, `packages/${group}/dist/index.js`));
    }
  }
  return {
    schema: 1,
    layout,
    ...(selectedGroup ? { group: selectedGroup } : {}),
    sourceCommit: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
    compilerVersion: typescript.version,
    runtimeProvenance: "Built dist/index.js is untracked output; digest proves byte identity only, not source commit or successful build.",
    packages,
    groupExports,
    collisions: collisions(packages, selectedGroup),
    manifestGraph: manifestGraph(tracked),
  };
}

function compare(before, after, selectedGroup) {
  const changes = {};
  for (const [group, members] of Object.entries(groups).filter(([group]) =>
    !selectedGroup || group === selectedGroup)) {
    const oldSymbols = members.flatMap((name) => before.packages[name].sourceExports);
    const newSymbols = after.groupExports[group].source;
    const expectedTypes = sorted(new Set(oldSymbols.map((item) => item.name)));
    const actualTypes = sorted(newSymbols.map((item) => item.name));
    const oldByName = new Map(oldSymbols.map((item) => [item.name, item]));
    const newByName = new Map(newSymbols.map((item) => [item.name, item]));
    const expectedRuntime = sorted(new Set(members.flatMap((name) => before.packages[name].runtimeExports.names)));
    const actualRuntime = after.groupExports[group].runtime.names;
    const oldTests = sorted(members.flatMap((name) => before.packages[name].testFiles.map((file) => file.path)));
    const newTests = sorted(members.flatMap((name) => after.packages[name].testFiles.map((file) => file.originalPath)));
    changes[group] = {
      missingTypes: expectedTypes.filter((name) => !actualTypes.includes(name)),
      addedTypes: actualTypes.filter((name) => !expectedTypes.includes(name)),
      changedKinds: expectedTypes.filter((name) => newByName.has(name) && (
        oldByName.get(name).type !== newByName.get(name).type ||
        oldByName.get(name).value !== newByName.get(name).value
      )).map((name) => ({
        name,
        before: { type: oldByName.get(name).type, value: oldByName.get(name).value },
        after: { type: newByName.get(name).type, value: newByName.get(name).value },
      })),
      missingRuntime: expectedRuntime.filter((name) => !actualRuntime.includes(name)),
      addedRuntime: actualRuntime.filter((name) => !expectedRuntime.includes(name)),
      runtimeUnavailable: members.some((name) => before.packages[name].runtimeExports.status !== "present-unverified-build") ||
        after.groupExports[group].runtime.status !== "present-unverified-build",
      missingTestFiles: oldTests.filter((path) => !newTests.includes(path)),
      extraTestFiles: newTests.filter((path) => !oldTests.includes(path)),
    };
  }
  return changes;
}

const [command, ...arguments_] = process.argv.slice(2);
if (command === "collect" || command === "collect-group") {
  const [selectedGroup, layout, output] = command === "collect-group" ? arguments_ : [undefined, ...arguments_];
  if (selectedGroup && !groups[selectedGroup]) throw new Error(`Unknown package group: ${selectedGroup}`);
  if (!["before", "after"].includes(layout) || !output) throw new Error("Usage: node inventory.mjs collect before|after output.json");
  const inventory = await collect(layout, selectedGroup);
  writeFileSync(resolve(output), `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(`Wrote ${output}: ${Object.keys(inventory.packages).length} source packages, ${inventory.manifestGraph.cycles.length} manifest cycles`);
  if (inventory.manifestGraph.cycles.length || Object.values(inventory.packages).some((item) =>
    item.runtimeExports.status !== "present-unverified-build")) process.exitCode = 1;
} else if (command === "compare" || command === "compare-group") {
  const [selectedGroup, beforePath, afterPath] = command === "compare-group" ? arguments_ : [undefined, ...arguments_];
  if (selectedGroup && !groups[selectedGroup]) throw new Error(`Unknown package group: ${selectedGroup}`);
  if (!beforePath || !afterPath) throw new Error("Usage: node inventory.mjs compare before.json after.json");
  const changes = compare(readManifest(resolve(beforePath)), readManifest(resolve(afterPath)), selectedGroup);
  console.log(JSON.stringify(changes, null, 2));
  if (Object.values(changes).some((group) => Object.values(group).some((value) =>
    Array.isArray(value) ? value.length > 0 : value))) process.exitCode = 1;
} else {
  throw new Error("Usage: node inventory.mjs collect before|after output.json | compare before.json after.json");
}
