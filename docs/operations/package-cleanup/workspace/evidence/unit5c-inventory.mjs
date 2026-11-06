// Unit 5C evidence (copy of unit5b-inventory.mjs, retargeted at the `ks` CLI): runtime exports of host and
// application; test identities of the host, application, executor, MCP and CLI suites (the catalog test lives in
// MCP); the declared manifest graph and cycles with and without devDependencies, host → app edges, the executor →
// host edge of the 5B seam and the CLI → host/executor edges 5C records; the transport catalog with every
// operation-catalog row and its per-profile state (unit5-catalog-snapshot.ts, which lists `ks` names from 5C),
// comparing row definitions separately from state; and the read-only Eve consumer inventory, by exact file.
// Usage from the repository root, after a build:
//   node docs/operations/package-cleanup/workspace/evidence/unit5c-inventory.mjs collect <output.json>
//   node docs/operations/package-cleanup/workspace/evidence/unit5c-inventory.mjs compare <before.json> <after.json>
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const eveRepository = resolve(repository, "../research_ingestion_systems_agent");
const suites = ["packages/host", "packages/application", "apps/verification-executor", "apps/mcp", "apps/cli"];
const exportedPackages = { host: "packages/host", application: "packages/application" };
// Runtime exports added on purpose to the root entries (5C adds the separate `@aiengineer/knowledge-host/local` entry instead).
const addedExports = {};
// Tests replaced on purpose by the slice's stated surface change: the remote-profile dependency check becomes a check
// over the module graph `--help` and remote commands load.
const replacedTests = {
  "apps/cli/src/tests/remote-profile.test.ts :: remote CLI profile depends on and imports no host, local persistence, executor or database driver":
    "apps/cli/src/tests/remote-profile.test.ts :: remote CLI profile loads no host, executor, persistence or database driver for --help or remote commands",
};
// 5C decision: the CLI depends on host (its ./local entry) and on the executor's transitional ./local-verification seam,
// imported only by the lazily loaded local profile module (and a type-only import in the command table).
const CLI_LOCAL_IMPORTERS = { host: ["apps/cli/src/ks-commands.ts", "apps/cli/src/local/offline.ts"], executor: ["apps/cli/src/local/offline.ts"] };
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
  const temporary = mkdtempSync(join(tmpdir(), "ks-unit5c-inventory-"));
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
      cliExecutorImports: sourceImports("apps/cli/src", "@aiengineer/knowledge-verification-executor"),
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
    // 5C: the CLI depends on host's ./local entry and the executor seam, imported only where recorded (R5 is now the
    // module-graph test over the bundle, which the CLI suite runs).
    cliLocal: {
      dependencies: [...(graph["@aiengineer/knowledge-cli"]?.dependencies ?? []), ...(graph["@aiengineer/knowledge-cli"]?.devDependencies ?? [])]
        .filter((name) => ["@aiengineer/knowledge-host", "@aiengineer/knowledge-verification-executor", PERSISTENCE, KNOWLEDGE_DB].includes(name)),
      hostImports: after.cliHostImports.source,
      executorImports: after.cliExecutorImports?.source ?? [],
      unrecordedImports: [
        ...after.cliHostImports.source.filter((file) => !CLI_LOCAL_IMPORTERS.host.includes(file)),
        ...(after.cliExecutorImports?.source ?? []).filter((file) => !CLI_LOCAL_IMPORTERS.executor.includes(file)),
      ],
      testFilesImportingHost: after.cliHostImports.test,
    },
    catalog: {
      kinds: JSON.stringify(before.catalog.kinds) === JSON.stringify(after.catalog.kinds) ? "unchanged" : { before: before.catalog.kinds, after: after.catalog.kinds },
      apiRoutes: difference("apiRoutes"),
      mcpTools: difference("mcpTools"),
      cli: cliRenames(before.catalog.cliCommands, after.catalog.cliCommands),
      // Row definitions without their derived state and without the CLI binding and executor fields 5C changes on purpose.
      operationsOutsideCli: difference("operations", ({ state, localProfile, cli, executor, ...row }) => JSON.stringify(row)),
      cliBindings: cliBindingChanges(before.catalog.operations, after.catalog.operations, after.catalog.cliCommands),
    },
    catalogStateChanges: stateChanges(before.catalog.operations, after.catalog.operations),
    eve: JSON.stringify(before.eve) === JSON.stringify(after.eve) ? "unchanged" : { before: before.eve, after: after.eve },
  };
}

/** Every pre-5C `resource action` command maps to exactly one remote `ks` name; the rest of the ks table is new. */
function cliRenames(before, after) {
  const renamed = {}, unmapped = [], ambiguous = [];
  for (const { command } of before) {
    const [resource, action] = command.split(" ");
    const names = after.filter((item) => item.profile === "remote" && item.resource === resource && item.action === action).map((item) => item.command);
    if (names.length === 0) unmapped.push(command);
    else if (names.length > 1) ambiguous.push({ command, names });
    else renamed[command] = names[0];
  }
  const mapped = new Set(Object.values(renamed));
  return {
    renamed, unmapped, ambiguous,
    addedRemote: after.filter((item) => item.profile === "remote" && !mapped.has(item.command)).map((item) => item.command),
    addedLocal: after.filter((item) => item.profile === "local").map((item) => `${item.command} → ${item.operation}`),
    addedUtility: after.filter((item) => item.profile === "utility").map((item) => `${item.command} → ${item.utility}`),
  };
}

/** Per row: platform CLI bindings must be exactly the renamed pre-5C names; executor rows may only gain `executor.ks`. */
function cliBindingChanges(before, after, afterCommands) {
  const rename = new Map(afterCommands.filter((item) => item.profile === "remote").map((item) => [`${item.resource} ${item.action}`, item.command]));
  const bound = (binding) => binding.on ?? binding.failsClosed ?? [];
  const mismatches = [], localBindings = {};
  for (const row of after) {
    const previous = before.find((item) => item.id === row.id);
    if (!previous) { mismatches.push({ id: row.id, reason: "new row" }); continue; }
    if (row.admission === "executor") {
      const { ks, ...executor } = row.executor ?? {};
      if (JSON.stringify(executor) !== JSON.stringify(previous.executor)) mismatches.push({ id: row.id, reason: "executor surfaces changed" });
      if (!("excluded" in row.cli)) mismatches.push({ id: row.id, reason: "executor row gained a ks server binding" });
      if (ks) localBindings[row.executor.mcp] = ks;
      continue;
    }
    const kind = "excluded" in row.cli ? "excluded" : "on" in row.cli ? "on" : "failsClosed";
    const previousKind = "excluded" in previous.cli ? "excluded" : "on" in previous.cli ? "on" : "failsClosed";
    const expected = bound(previous.cli).map((name) => rename.get(name) ?? `UNMAPPED:${name}`);
    if (kind !== previousKind || JSON.stringify(bound(row.cli)) !== JSON.stringify(expected)
      || (kind === "excluded" && row.cli.excluded !== previous.cli.excluded)) mismatches.push({ id: row.id, before: previous.cli, after: row.cli });
  }
  return { mismatches, localBindings };
}

const [command, ...arguments_] = process.argv.slice(2);
if (command === "collect" && arguments_[0]) await collect(arguments_[0]);
else if (command === "compare" && arguments_[0] && arguments_[1]) {
  const changes = compare(JSON.parse(readFileSync(resolve(arguments_[0]), "utf8")), JSON.parse(readFileSync(resolve(arguments_[1]), "utf8")));
  console.log(JSON.stringify(changes, null, 2));
  const blocking = ["missingTests", "changedOutcomes", "cycles", "cyclesWithDevDependencies", "knowledgeDbProductionPersistenceImports", "hostImportsApps",
    "applicationOrPersistenceDependOnHost", "applicationHostImports", "persistenceHostImports"];
  // 5C changes CLI names and bindings on purpose; kinds, routes, tools and every other row field must not move.
  const catalogChanged = changes.catalog.kinds !== "unchanged" || ["apiRoutes", "mcpTools", "operationsOutsideCli"]
    .some((key) => changes.catalog[key].removed.length || changes.catalog[key].added.length)
    || changes.catalog.cli.unmapped.length || changes.catalog.cli.ambiguous.length || changes.catalog.cliBindings.mismatches.length;
  if (blocking.some((key) => changes[key].length) || changes.knowledgeDbPersistence.after.production
    || Object.values(changes.exportsRemoved).some((list) => list.length) || Object.values(changes.exportsAdded).some((list) => list.length)
    || Object.values(changes.suiteExitCodes).some(({ before, after }) => before !== after) || catalogChanged
    || changes.executorHost.dependency || changes.cliLocal.unrecordedImports.length
    || changes.cliLocal.dependencies.some((name) => [PERSISTENCE, KNOWLEDGE_DB].includes(name))) process.exitCode = 1;
} else throw new Error("Usage: unit5c-inventory.mjs collect output.json | compare before.json after.json");
