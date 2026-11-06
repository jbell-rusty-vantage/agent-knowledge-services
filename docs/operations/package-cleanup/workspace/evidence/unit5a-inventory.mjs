// Unit 5A evidence (copy of unit4-inventory.mjs, retargeted at the R1 inversion): runtime exports of
// knowledge-db, persistence and host; test identities of the suites the inversion touches; the declared
// manifest graph with the knowledge-db → persistence edges (production and test-only) and cycles with and
// without devDependencies; non-test knowledge-db source that still imports persistence; the transport
// catalog with every operation-catalog row (unit5-catalog-snapshot.ts); and a read-only inventory of the
// Eve consumer files Unit 5 must adapt, by exact file.
// Usage from the repository root, after a build:
//   node docs/operations/package-cleanup/workspace/evidence/unit5a-inventory.mjs collect <output.json>
//   node docs/operations/package-cleanup/workspace/evidence/unit5a-inventory.mjs compare <before.json> <after.json>
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const eveRepository = resolve(repository, "../research_ingestion_systems_agent");
const suites = ["packages/knowledge-db", "packages/persistence", "packages/host", "apps/verification-executor", "apps/mcp"];
const exportedPackages = { knowledgeDb: "packages/knowledge-db", persistence: "packages/persistence", host: "packages/host" };
// Runtime exports added on purpose: the persistence adapter for knowledge-db's content-admission port.
const addedExports = { persistence: ["postgresContentAdmission"] };
const KNOWLEDGE_DB = "@aiengineer/knowledge-db";
const PERSISTENCE = "@aiengineer/knowledge-persistence";
// Eve files named by the Unit 5 specification and FINAL-REVIEW R4, and the terms that tie them to
// packages, binaries, entrypoints, environment names or paths Unit 5 removes or renames.
const eveFiles = [
  "package.json",
  "tools/team/t14-platform-host.mjs", "tools/team/t14-launcher.mjs", "tools/team/t14-ks-host.mjs",
  "tools/team/host-bootstrap.mjs", "tools/team/catalog-sync.mjs", "tools/team/public-host.integration.test.mjs",
  "tools/experiment-runner/run.mjs", "tools/experiment-runner/lib/tarball.mjs",
  "tools/skill-pack-sync/sync.mjs", "agents/verified-research/agent/lib/skill-packs.generated.ts",
  "agents/verified-research/agent/lib/profiles.ts", "agents/verified-research/agent/instructions/surface.ts",
  "agents/verified-research/agent/connections/verification.ts", "agents/verified-research/agent/sandbox/sandbox.ts",
];
const eveTerms = [
  "verification-executor", "knowledge-verify", "VERIFY_EXECUTOR_URL", "VERIFY_EXECUTOR_TOKEN", "VERIFY_STORE_DIR",
  "root-host/v1", "scoped-host/v1", "evidence-reader/v1", "dist/sandbox", "TARBALL", "createApiClient",
  "client-typescript", "packages/runtime", "packages/db-read", "packages/schema-workspace", "packages/ingestion", "packages/domain",
  "knowledge-embeddings", "knowledge-runtime", "knowledge-client", "knowledge-persistence", "knowledge-db", "knowledge-host",
  "apps/cli", "apps/jev",
];

const git = (cwd, ...arguments_) => execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();

async function runtimeExports(directory) {
  const entry = join(repository, directory, "dist/index.js");
  if (!existsSync(entry)) return undefined;
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
  const cyclesOver = (edges) => {
    const cycles = [];
    const visit = (name, stack) => {
      if (stack.includes(name)) { cycles.push([...stack.slice(stack.indexOf(name)), name]); return; }
      for (const dependency of edges(name)) if (manifests[dependency]) visit(dependency, [...stack, name]);
    };
    for (const name of Object.keys(manifests)) visit(name, []);
    return cycles;
  };
  const knowledgeDb = manifests[KNOWLEDGE_DB];
  return {
    manifests,
    cycles: cyclesOver((name) => manifests[name]?.dependencies ?? []),
    // Turbo and pnpm order builds over devDependencies too; a cycle here blocks the workspace build graph.
    cyclesWithDevDependencies: cyclesOver((name) => [...(manifests[name]?.dependencies ?? []), ...(manifests[name]?.devDependencies ?? [])]),
    knowledgeDbPersistence: {
      production: knowledgeDb?.dependencies.includes(PERSISTENCE) ?? false,
      testOnly: knowledgeDb?.devDependencies.includes(PERSISTENCE) ?? false,
    },
  };
}

/** Source files under a directory whose text contains the given module specifier, split by test and non-test. */
function sourceImports(directory, specifier) {
  const found = { source: [], test: [] };
  const walk = (path) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) { if (!["node_modules", "dist"].includes(entry.name)) walk(child); continue; }
      if (!/\.(ts|mts|mjs)$/u.test(entry.name)) continue;
      if (!readFileSync(child, "utf8").includes(`"${specifier}`)) continue;
      const file = relative(repository, child).replaceAll("\\", "/");
      const test = /\.test\.ts$/u.test(entry.name) || /\/(tests?|fixtures)\//u.test(file) || /(^|\/)test\//u.test(file.slice(directory.length));
      found[test ? "test" : "source"].push(file);
    }
  };
  walk(join(repository, directory));
  return { source: found.source.sort(), test: found.test.sort() };
}

function eveInventory() {
  if (!existsSync(eveRepository)) return { available: false };
  const files = {};
  for (const file of eveFiles) {
    const path = join(eveRepository, file);
    if (!existsSync(path)) { files[file] = { present: false }; continue; }
    const matches = readFileSync(path, "utf8").split(/\r?\n/u).flatMap((line, index) =>
      eveTerms.filter((term) => line.includes(term)).map((term) => ({ line: index + 1, term })));
    const terms = {};
    for (const match of matches) (terms[match.term] ??= []).push(match.line);
    files[file] = { present: true, terms };
  }
  return { available: true, commit: git(eveRepository, "rev-parse", "HEAD"), dirty: Boolean(git(eveRepository, "status", "--porcelain")), files };
}

function catalog() {
  const run = spawnSync(process.execPath, [join(repository, "node_modules/tsx/dist/cli.mjs"), "docs/operations/package-cleanup/workspace/evidence/unit5-catalog-snapshot.ts"], {
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
  const temporary = mkdtempSync(join(tmpdir(), "ks-unit5a-inventory-"));
  try {
    const graph = manifestGraph();
    const result = {
      schema: 1,
      sourceCommit: git(repository, "rev-parse", "HEAD"),
      dirty: Boolean(git(repository, "status", "--porcelain")),
      node: process.version,
      exports: Object.fromEntries(await Promise.all(Object.entries(exportedPackages).map(async ([name, path]) => [name, await runtimeExports(path)]))),
      graph,
      knowledgeDbPersistenceImports: sourceImports("packages/knowledge-db", PERSISTENCE),
      applicationKnowledgeDbImports: sourceImports("packages/application/src", KNOWLEDGE_DB),
      hostKnowledgeDbImports: sourceImports("packages/host/src", KNOWLEDGE_DB),
      applicationHostImports: sourceImports("packages/application/src", "@aiengineer/knowledge-host"),
      persistenceHostImports: sourceImports("packages/persistence/src", "@aiengineer/knowledge-host"),
      catalog: catalog(),
      eve: eveInventory(),
      command: "node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=json (sequential per package)",
      runs: [],
    };
    for (const directory of suites) {
      console.log(`Running ${directory}`);
      result.runs.push(runSuite(directory, temporary));
    }
    writeFileSync(resolve(output), `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// Some parameterized titles embed a fresh randomUUID per run (executor evidence-reader boundary); compare them without it.
const stableIdentity = (identity) => identity.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "<uuid>");

function compare(before, after) {
  const beforeTests = new Map(before.runs.flatMap((run) => run.tests.map((test) => [stableIdentity(test.identity), test.status])));
  const afterTests = new Map(after.runs.flatMap((run) => run.tests.map((test) => [stableIdentity(test.identity), test.status])));
  const removed = (name) => (before.exports[name] ?? []).filter((symbol) => !(after.exports[name] ?? []).includes(symbol));
  const added = (name) => (after.exports[name] ?? []).filter((symbol) => !(before.exports[name] ?? []).includes(symbol));
  const graph = after.graph.manifests;
  const difference = (key, keyOf = (item) => item) => ({
    removed: before.catalog[key].map(keyOf).filter((item) => !after.catalog[key].map(keyOf).includes(item)),
    added: after.catalog[key].map(keyOf).filter((item) => !before.catalog[key].map(keyOf).includes(item)),
  });
  return {
    missingTests: [...beforeTests.keys()].filter((identity) => !afterTests.has(identity)),
    changedOutcomes: [...beforeTests].filter(([identity, status]) => afterTests.has(identity) && afterTests.get(identity) !== status)
      .map(([identity, status]) => ({ identity, before: status, after: afterTests.get(identity) })),
    addedTests: [...afterTests.keys()].filter((identity) => !beforeTests.has(identity)),
    suiteExitCodes: Object.fromEntries(after.runs.map((run) => [run.directory, run.exitCode])),
    exportsRemoved: Object.fromEntries(Object.keys(exportedPackages).map((name) => [name, removed(name)])),
    exportsAdded: Object.fromEntries(Object.keys(exportedPackages).map((name) => [name, added(name).filter((symbol) => !(addedExports[name] ?? []).includes(symbol))])),
    exportsAddedAsRecorded: Object.fromEntries(Object.keys(exportedPackages).map((name) => [name, added(name).filter((symbol) => (addedExports[name] ?? []).includes(symbol))])),
    cycles: after.graph.cycles,
    cyclesWithDevDependencies: after.graph.cyclesWithDevDependencies,
    knowledgeDbPersistence: { before: before.graph.knowledgeDbPersistence, after: after.graph.knowledgeDbPersistence },
    knowledgeDbProductionPersistenceImports: after.knowledgeDbPersistenceImports.source,
    knowledgeDbTestPersistenceImports: after.knowledgeDbPersistenceImports.test,
    hostImportsApps: (graph["@aiengineer/knowledge-host"]?.dependencies ?? []).filter((name) => graph[name]?.path.startsWith("apps/")),
    applicationOrPersistenceDependOnHost: ["@aiengineer/knowledge-application", PERSISTENCE]
      .filter((name) => (graph[name]?.dependencies ?? []).includes("@aiengineer/knowledge-host")),
    applicationHostImports: after.applicationHostImports.source,
    persistenceHostImports: after.persistenceHostImports.source,
    catalog: {
      kinds: JSON.stringify(before.catalog.kinds) === JSON.stringify(after.catalog.kinds) ? "unchanged" : { before: before.catalog.kinds, after: after.catalog.kinds },
      apiRoutes: difference("apiRoutes"),
      mcpTools: difference("mcpTools"),
      cliCommands: difference("cliCommands", JSON.stringify),
      operations: difference("operations", JSON.stringify),
    },
    eve: JSON.stringify(before.eve) === JSON.stringify(after.eve) ? "unchanged" : { before: before.eve, after: after.eve },
  };
}

const [command, ...arguments_] = process.argv.slice(2);
if (command === "collect" && arguments_[0]) await collect(arguments_[0]);
else if (command === "compare" && arguments_[0] && arguments_[1]) {
  const changes = compare(JSON.parse(readFileSync(resolve(arguments_[0]), "utf8")), JSON.parse(readFileSync(resolve(arguments_[1]), "utf8")));
  console.log(JSON.stringify(changes, null, 2));
  const blocking = ["missingTests", "changedOutcomes", "cycles", "knowledgeDbProductionPersistenceImports", "hostImportsApps",
    "applicationOrPersistenceDependOnHost", "applicationHostImports", "persistenceHostImports"];
  const catalogChanged = changes.catalog.kinds !== "unchanged" || ["apiRoutes", "mcpTools", "cliCommands", "operations"]
    .some((key) => changes.catalog[key].removed.length || changes.catalog[key].added.length);
  if (blocking.some((key) => changes[key].length) || changes.knowledgeDbPersistence.after.production
    || Object.values(changes.exportsRemoved).some((list) => list.length) || Object.values(changes.exportsAdded).some((list) => list.length)
    || Object.values(changes.suiteExitCodes).some((code) => code !== 0) || catalogChanged) process.exitCode = 1;
} else throw new Error("Usage: unit5a-inventory.mjs collect output.json | compare before.json after.json");
