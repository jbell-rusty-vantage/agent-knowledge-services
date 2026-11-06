// Unit 4 evidence: runtime exports of the packages this unit moves or renames, test identities
// of the affected suites (with folder moves and renames mapped), the declared manifest graph,
// runtime-dependency rules and the transport catalog (unit4-catalog-snapshot.ts).
// Usage from the repository root, after a build:
//   node docs/operations/package-cleanup/workspace/evidence/unit4-inventory.mjs collect <output.json>
//   node docs/operations/package-cleanup/workspace/evidence/unit4-inventory.mjs compare <before.json> <after.json>
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
// Each suite is found at its Unit 4 path, or at its pre-rename path before the naming pass.
const suites = [
  ["apps/api"], ["apps/mcp"], ["apps/cli"], ["apps/worker"], ["packages/host"], ["packages/application"],
  ["packages/persistence"], ["packages/sources", "packages/acquisition"], ["packages/client", "packages/client-typescript"],
];
const exportedPackages = {
  application: ["packages/application"],
  host: ["packages/host"],
  persistence: ["packages/persistence"],
  sources: ["packages/sources", "packages/acquisition"],
  client: ["packages/client", "packages/client-typescript"],
};
// Path prefixes moved by this unit (before → after); longest prefix wins.
const movedPrefixes = {
  "packages/acquisition/": "packages/sources/",
  "packages/client-typescript/": "packages/client/",
  "packages/application/src/preparation/": "packages/application/src/knowledge/preparation/",
  "packages/application/src/source-discovery/": "packages/application/src/knowledge/source-discovery/",
  "packages/application/src/promotion-selection/": "packages/application/src/knowledge/promotion-selection/",
  "packages/application/src/checkpoints/": "packages/application/src/knowledge/checkpoints/",
  "packages/application/src/retrieval/": "packages/application/src/knowledge/retrieval/",
  "packages/application/src/operations/a2a-adapter.test.ts": "apps/api/src/tests/a2a-adapter.test.ts",
};
// The A2A test file split: the callback-sender tests stay in application beside the sender.
const movedTests = Object.fromEntries([
  "A2A adapter sends an authenticated result only to its admitted exact callback target",
  "A2A adapter rejects target substitution and result correlation mismatch before network I/O",
].map((title) => [`packages/application/src/operations/a2a-adapter.test.ts :: ${title}`, `packages/application/src/operations/a2a-callbacks.test.ts :: ${title}`]));
// Exports removed from application on purpose: the A2A task mapping and the task binding that
// calls it (A2AKnowledgeAdapter) moved to apps/api. callbackEnvelopeForA2ATask is the formerly
// private callback builder, now exported for that binding.
const movedApplicationExports = ["A2AKnowledgeAdapter", "operationEnvelopeForA2ATask", "operationInputForA2ATask", "operationKindForA2ATask"];
const addedApplicationExports = ["callbackEnvelopeForA2ATask"];

const git = (...arguments_) => execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" }).trim();
const firstExisting = (paths) => paths.find((path) => existsSync(join(repository, path, "package.json")));

async function runtimeExports(paths) {
  const directory = firstExisting(paths);
  const entry = directory && join(repository, directory, "dist/index.js");
  if (!entry || !existsSync(entry)) return undefined;
  return Object.keys(await import(pathToFileURL(entry).href)).sort();
}

function manifestGraph() {
  const manifests = {};
  for (const root of ["apps", "packages", "services"]) {
    const base = join(repository, root);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const path = join(base, name, "package.json");
      if (!existsSync(path)) continue;
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      const internal = (section) => Object.keys(manifest[section] ?? {}).filter((dependency) => dependency.startsWith("@aiengineer/knowledge-")).sort();
      manifests[manifest.name] = { path: `${root}/${name}`, dependencies: internal("dependencies"), devDependencies: internal("devDependencies") };
    }
  }
  const cycles = [];
  const visit = (name, stack) => {
    if (stack.includes(name)) { cycles.push([...stack.slice(stack.indexOf(name)), name]); return; }
    for (const dependency of manifests[name]?.dependencies ?? []) if (manifests[dependency]) visit(dependency, [...stack, name]);
  };
  for (const name of Object.keys(manifests)) visit(name, []);
  return { manifests, cycles };
}

/** Non-test source files under a directory whose text contains the given module specifier. */
function sourceImports(directory, specifier) {
  const found = [];
  const walk = (path) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "tests") walk(child); continue; }
      if (!/\.(ts|mts)$/u.test(entry.name) || /\.test\.ts$/u.test(entry.name)) continue;
      if (readFileSync(child, "utf8").includes(`"${specifier}`)) found.push(relative(repository, child).replaceAll("\\", "/"));
    }
  };
  walk(join(repository, directory));
  return found.sort();
}

function catalog() {
  const run = spawnSync(process.execPath, [join(repository, "node_modules/tsx/dist/cli.mjs"), "docs/operations/package-cleanup/workspace/evidence/unit4-catalog-snapshot.ts"], {
    cwd: repository, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`catalog snapshot failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

function runSuite(directory, temporary) {
  const output = join(temporary, `${directory.replaceAll("/", "-")}.json`);
  const run = spawnSync(process.execPath, [join(repository, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=2", "--reporter=json", `--outputFile=${output}`], {
    cwd: join(repository, directory), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const report = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : { testResults: [] };
  const tests = report.testResults.flatMap((file) => file.assertionResults.map((test) => ({
    identity: `${relative(repository, file.name).replaceAll("\\", "/")} :: ${test.fullName}`,
    status: test.status,
  }))).sort((left, right) => left.identity.localeCompare(right.identity));
  return { directory, exitCode: run.status, files: report.testResults.length, tests };
}

async function collect(output) {
  const temporary = mkdtempSync(join(tmpdir(), "ks-unit4-inventory-"));
  try {
    const graph = manifestGraph();
    const result = {
      schema: 1,
      sourceCommit: git("rev-parse", "HEAD"),
      dirty: Boolean(git("status", "--porcelain")),
      node: process.version,
      exports: Object.fromEntries(await Promise.all(Object.entries(exportedPackages).map(async ([name, paths]) => [name, await runtimeExports(paths)]))),
      graph,
      apiRuntimeDependsOnTestkit: graph.manifests["@aiengineer/knowledge-api"]?.dependencies.includes("@aiengineer/knowledge-testkit") ?? false,
      apiTestkitImports: sourceImports("apps/api/src", "@aiengineer/knowledge-testkit"),
      mcpClientImports: sourceImports("apps/mcp/src", "@aiengineer/knowledge-client"),
      applicationHostImports: sourceImports("packages/application/src", "@aiengineer/knowledge-host"),
      persistenceHostImports: sourceImports("packages/persistence/src", "@aiengineer/knowledge-host"),
      catalog: catalog(),
      command: "node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=json (sequential per package)",
      runs: [],
    };
    for (const paths of suites) {
      const directory = firstExisting(paths);
      console.log(`Running ${directory}`);
      result.runs.push(runSuite(directory, temporary));
    }
    writeFileSync(resolve(output), `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function mapPath(file) {
  const prefix = Object.keys(movedPrefixes).filter((candidate) => file.startsWith(candidate)).sort((a, b) => b.length - a.length)[0];
  return prefix ? movedPrefixes[prefix] + file.slice(prefix.length) : file;
}

function compare(before, after) {
  const mapIdentity = (identity) => {
    if (movedTests[identity]) return movedTests[identity];
    const [file, ...rest] = identity.split(" :: ");
    return [mapPath(file), ...rest].join(" :: ");
  };
  const beforeTests = new Map(before.runs.flatMap((run) => run.tests.map((test) => [mapIdentity(test.identity), test.status])));
  const afterTests = new Map(after.runs.flatMap((run) => run.tests.map((test) => [test.identity, test.status])));
  const removed = (name) => (before.exports[name] ?? []).filter((symbol) => !(after.exports[name] ?? []).includes(symbol));
  const added = (name) => (after.exports[name] ?? []).filter((symbol) => !(before.exports[name] ?? []).includes(symbol));
  const graph = after.graph.manifests;
  const difference = (key) => ({
    removed: before.catalog[key].filter((item) => !after.catalog[key].includes(item)),
    added: after.catalog[key].filter((item) => !before.catalog[key].includes(item)),
  });
  const cliKey = (command) => JSON.stringify(command);
  return {
    missingTests: [...beforeTests.keys()].filter((identity) => !afterTests.has(identity)),
    changedOutcomes: [...beforeTests].filter(([identity, status]) => afterTests.has(identity) && afterTests.get(identity) !== status)
      .map(([identity, status]) => ({ identity, before: status, after: afterTests.get(identity) })),
    addedTests: [...afterTests.keys()].filter((identity) => !beforeTests.has(identity)),
    applicationExportsRemoved: removed("application").filter((symbol) => !movedApplicationExports.includes(symbol)),
    applicationExportsMoved: removed("application").filter((symbol) => movedApplicationExports.includes(symbol)),
    applicationExportsAdded: added("application").filter((symbol) => !addedApplicationExports.includes(symbol)),
    applicationExportsAddedAsRecorded: added("application").filter((symbol) => addedApplicationExports.includes(symbol)),
    exportsAdded: Object.fromEntries(Object.keys(exportedPackages).filter((name) => name !== "application").map((name) => [name, added(name)])),
    otherExportsRemoved: Object.fromEntries(Object.keys(exportedPackages).filter((name) => name !== "application").map((name) => [name, removed(name)])),
    cycles: after.graph.cycles,
    hostImportsApps: (graph["@aiengineer/knowledge-host"]?.dependencies ?? []).filter((name) => graph[name]?.path.startsWith("apps/")),
    applicationOrPersistenceDependOnHost: ["@aiengineer/knowledge-application", "@aiengineer/knowledge-persistence"]
      .filter((name) => (graph[name]?.dependencies ?? []).includes("@aiengineer/knowledge-host")),
    applicationHostImports: after.applicationHostImports,
    persistenceHostImports: after.persistenceHostImports,
    mcpClientImports: after.mcpClientImports,
    apiRuntimeDependsOnTestkit: after.apiRuntimeDependsOnTestkit,
    apiTestkitImports: after.apiTestkitImports,
    catalog: {
      kinds: JSON.stringify(before.catalog.kinds) === JSON.stringify(after.catalog.kinds) ? "unchanged" : { before: before.catalog.kinds, after: after.catalog.kinds },
      apiRoutes: difference("apiRoutes"),
      mcpTools: difference("mcpTools"),
      cliCommands: {
        removed: before.catalog.cliCommands.map(cliKey).filter((item) => !after.catalog.cliCommands.map(cliKey).includes(item)),
        added: after.catalog.cliCommands.map(cliKey).filter((item) => !before.catalog.cliCommands.map(cliKey).includes(item)),
      },
    },
  };
}

const [command, ...arguments_] = process.argv.slice(2);
if (command === "collect" && arguments_[0]) await collect(arguments_[0]);
else if (command === "compare" && arguments_[0] && arguments_[1]) {
  const changes = compare(JSON.parse(readFileSync(resolve(arguments_[0]), "utf8")), JSON.parse(readFileSync(resolve(arguments_[1]), "utf8")));
  console.log(JSON.stringify(changes, null, 2));
  const blocking = ["missingTests", "changedOutcomes", "applicationExportsRemoved", "applicationExportsAdded", "cycles", "hostImportsApps",
    "applicationOrPersistenceDependOnHost", "applicationHostImports", "persistenceHostImports", "mcpClientImports", "apiTestkitImports"];
  const catalogChanged = changes.catalog.kinds !== "unchanged" || ["apiRoutes", "mcpTools", "cliCommands"]
    .some((key) => changes.catalog[key].removed.length || changes.catalog[key].added.length);
  if (blocking.some((key) => changes[key].length) || Object.values(changes.otherExportsRemoved).some((list) => list.length)
    || changes.apiRuntimeDependsOnTestkit || catalogChanged) process.exitCode = 1;
} else throw new Error("Usage: unit4-inventory.mjs collect output.json | compare before.json after.json");
