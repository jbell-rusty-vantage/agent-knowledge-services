// Unit 5B evidence (copy of unit5a-inventory.mjs, retargeted at the local host profile): runtime exports of
// host and application; test identities of the host, application, executor and MCP suites (the catalog test
// lives in MCP); the declared manifest graph and cycles with and without devDependencies, host → app edges
// and the executor → host edge the local-services seam adds; the transport catalog with every operation-catalog
// row and its per-profile state (unit5-catalog-snapshot.ts), comparing row definitions separately from state;
// and the read-only Eve consumer inventory, by exact file.
// Usage from the repository root, after a build:
//   node docs/operations/package-cleanup/workspace/evidence/unit5b-inventory.mjs collect <output.json>
//   node docs/operations/package-cleanup/workspace/evidence/unit5b-inventory.mjs compare <before.json> <after.json>
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const eveRepository = resolve(repository, "../research_ingestion_systems_agent");
const suites = ["packages/host", "packages/application", "apps/verification-executor", "apps/mcp"];
const exportedPackages = { host: "packages/host", application: "packages/application" };
// Runtime exports added on purpose: the local host profile, its capability matrix and admission error.
const addedExports = { host: ["HostCapabilityNotAdmittedError", "createLocalHost", "isLocalOperation", "localVerificationOperations", "profileAvailability"] };
// Tests replaced on purpose by the slice's stated surface change: the local profile is no longer reserved.
const replacedTests = {
  "packages/host/src/tests/composition.test.ts :: host import and profile admission rejects the reserved local profile explicitly without reaching the network or a database":
    "packages/host/src/tests/composition.test.ts :: host import and profile admission composes the local profile lazily without reaching the network or a database",
};
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
  const temporary = mkdtempSync(join(tmpdir(), "ks-unit5b-inventory-"));
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
      executorHostImports: sourceImports("apps/verification-executor/src", "@aiengineer/knowledge-host"),
      cliHostImports: sourceImports("apps/cli/src", "@aiengineer/knowledge-host"),
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

/** Per-row changes of the derived per-profile state (and the local host state once it exists). */
function stateChanges(before, after) {
  const changes = {};
  for (const row of after) {
    const previous = before.find((item) => item.id === row.id);
    const was = JSON.stringify({ state: previous?.state, localProfile: previous?.localProfile });
    const now = JSON.stringify({ state: row.state, localProfile: row.localProfile });
    if (was !== now) {
      const key = `${JSON.stringify(previous?.state)} ${JSON.stringify(previous?.localProfile)} -> ${JSON.stringify(row.state)} ${JSON.stringify(row.localProfile)}`;
      (changes[key] ??= []).push(row.id);
    }
  }
  return changes;
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
    missingTests: [...beforeTests.keys()].filter((identity) => !afterTests.has(identity) && !afterTests.has(replacedTests[identity])),
    replacedTests: Object.fromEntries(Object.entries(replacedTests).filter(([was, now]) => beforeTests.has(was) && afterTests.has(now))),
    changedOutcomes: [...beforeTests].filter(([identity, status]) => afterTests.has(identity) && afterTests.get(identity) !== status)
      .map(([identity, status]) => ({ identity, before: status, after: afterTests.get(identity) })),
    addedTests: [...afterTests.keys()].filter((identity) => !beforeTests.has(identity)),
    // The application suite exits 1 before and after on the retained replay receipt; only a changed exit code blocks.
    suiteExitCodes: Object.fromEntries(after.runs.map((run) => [run.directory, {
      before: before.runs.find((item) => item.directory === run.directory)?.exitCode, after: run.exitCode }])),
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
    executorHost: {
      dependency: (graph["@aiengineer/knowledge-verification-executor"]?.dependencies ?? []).includes("@aiengineer/knowledge-host"),
      devDependency: (graph["@aiengineer/knowledge-verification-executor"]?.devDependencies ?? []).includes("@aiengineer/knowledge-host"),
      imports: after.executorHostImports,
    },
    // The remote CLI must stay client-only (R5): no host dependency or import.
    cliHost: {
      dependency: [...(graph["@aiengineer/knowledge-cli"]?.dependencies ?? []), ...(graph["@aiengineer/knowledge-cli"]?.devDependencies ?? [])]
        .includes("@aiengineer/knowledge-host"),
      // The remote-profile test names the packages it forbids; only production imports count.
      imports: after.cliHostImports.source,
      testFilesNamingThem: after.cliHostImports.test,
    },
    catalog: {
      kinds: JSON.stringify(before.catalog.kinds) === JSON.stringify(after.catalog.kinds) ? "unchanged" : { before: before.catalog.kinds, after: after.catalog.kinds },
      apiRoutes: difference("apiRoutes"),
      mcpTools: difference("mcpTools"),
      cliCommands: difference("cliCommands", JSON.stringify),
        // Row definitions (admission, bindings) are compared without their derived per-profile state.
      operations: difference("operations", ({ state, localProfile, ...row }) => JSON.stringify(row)),
    },
    catalogStateChanges: stateChanges(before.catalog.operations, after.catalog.operations),
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
    || Object.values(changes.suiteExitCodes).some(({ before, after }) => before !== after) || catalogChanged
    || changes.executorHost.dependency || changes.cliHost.dependency || changes.cliHost.imports.length) process.exitCode = 1;
} else throw new Error("Usage: unit5b-inventory.mjs collect output.json | compare before.json after.json");
