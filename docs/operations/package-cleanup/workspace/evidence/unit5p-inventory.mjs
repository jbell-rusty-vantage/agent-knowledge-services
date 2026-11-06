// Slice 5P evidence (copy of q0-inventory.mjs; 5P moves API and MCP tests and the catalog module and renames MCP tools in T4, so `apps/api` joins the test-identity suites: every moved test must still be found by identity; the T4 name table and recorded test additions are the only expected differences, and the comparison stays strict so anything else is a blocking finding): runtime exports of host and
// application; test identities of the host, application, executor, MCP and CLI suites (the catalog test lives in
// MCP); the declared manifest graph and cycles with and without devDependencies, host → app edges, the executor →
// host edge of the 5B seam and the CLI → host/executor edges 5C records; the transport catalog with every
// operation-catalog row and its per-profile state (unit5-catalog-snapshot.ts, which lists `ks` names from 5C),
// comparing row definitions separately from state; and the read-only Eve consumer inventory, by exact file.
// Usage from the repository root, after a build:
//   node docs/operations/package-cleanup/workspace/evidence/unit5p-inventory.mjs collect <output.json>
//   node docs/operations/package-cleanup/workspace/evidence/unit5p-inventory.mjs compare <before.json> <after.json>
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const eveRepository = resolve(repository, "../research_ingestion_systems_agent");
const suites = ["packages/host", "packages/application", "apps/verification-executor", "apps/api", "apps/mcp", "apps/cli"];
const exportedPackages = { host: "packages/host", application: "packages/application" };
// Runtime exports added on purpose to the root entries (5C adds the separate `@aiengineer/knowledge-host/local` entry instead).
const addedExports = {
  host: ["localProfileState", "AgenticKnowledgeService", "createIntegrationService", "createKnowledgeApplication", "OperationCapabilityUnavailableError", "retrievalExecutionProblem", "DeterministicFakeEmbeddingAdapter", "VerificationOperationApplicationService", "assertOperationKindAdmitted", "bindResolvedVerificationContext", "createKnowledgeResourceReads", "createVerificationResourceReads", "isAdjudicationDecisionReviewerActor", "operationCatalog", "productionWorkerOperationKinds", "submitCanonicalRetrievalRun", "transportProblem"],
  application: ["declaredApiRequests", "operationCatalog", "transportState"],
};
// Tests replaced on purpose by the slice's stated surface change: the remote-profile dependency check becomes a check
// over the module graph `--help` and remote commands load.
const replacedTests = {};
const nameTable = readFileSync(join(repository, "docs/operations/package-cleanup/UNIT-5P-TRANSPORT-STRUCTURE.md"), "utf8");
const mcpRenames = new Map([...nameTable.matchAll(/^\| `([^`]+)`(?: \(declared\))? \| `([^`]+)` \|$/gm)]
  .map(([, oldName, newName]) => [oldName, newName]));
if (mcpRenames.size !== 70) throw new Error(`Expected 70 MCP name mappings, found ${mcpRenames.size}`);
const orderedRenames = [...mcpRenames].sort(([left], [right]) => right.length - left.length);
const renameMcpText = (value) => orderedRenames.reduce((text, [oldName, newName]) => text.replaceAll(oldName, newName), value);
const mapMcpNames = (value) => Array.isArray(value) ? value.map(mapMcpNames)
  : typeof value === "string" ? renameMcpText(value)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapMcpNames(child)]))
  : value;
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
  const temporary = mkdtempSync(join(tmpdir(), "ks-unit5p-inventory-"));
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
const stableIdentity = (identity) => renameMcpText(identity
  .replace("apps/api/src/verification-benchmark-reads.test.ts", "apps/api/src/tests/verification-benchmark-reads.test.ts")
  .replace(/'([^']+)(?:\u00e2\u20ac\u00a6|\u2026)' API\/MCP parity/gu, (match, prefix) => {
    const matches = orderedRenames.filter(([oldName, newName]) => oldName.startsWith(prefix) || newName.startsWith(prefix));
    return matches.length === 1 ? `'${matches[0][1]}' API/MCP parity` : match;
  }))
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "<uuid>");

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
    recordedMcpRenames: mcpRenames.size,
    movedTestFiles: [{
      from: "apps/api/src/verification-benchmark-reads.test.ts",
      to: "apps/api/src/tests/verification-benchmark-reads.test.ts",
      identities: before.runs.flatMap((run) => run.tests).filter((test) =>
        test.identity.startsWith("apps/api/src/verification-benchmark-reads.test.ts :: ")).length,
    }],
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
      mcpTools: {
        removed: before.catalog.mcpTools.map((name) => mcpRenames.get(name) ?? name).filter((name) => !after.catalog.mcpTools.includes(name)),
        added: after.catalog.mcpTools.filter((name) => !before.catalog.mcpTools.map((old) => mcpRenames.get(old) ?? old).includes(name)),
      },
      // Row definitions without their derived state.
      operationsOutsideCli: {
        removed: before.catalog.operations.map(({ state, localProfile, ...row }) => JSON.stringify({ ...row, mcp: mapMcpNames(row.mcp) }))
          .filter((row) => !after.catalog.operations.map(({ state, localProfile, ...item }) => JSON.stringify(item)).includes(row)),
        added: after.catalog.operations.map(({ state, localProfile, ...row }) => JSON.stringify(row))
          .filter((row) => !before.catalog.operations.map(({ state, localProfile, ...item }) => JSON.stringify({ ...item, mcp: mapMcpNames(item.mcp) })).includes(row)),
      },
      // Q0 changes no CLI name or binding: the whole CLI table and every operation row (with state) must be identical.
      cliCommandsIdentical: JSON.stringify(before.catalog.cliCommands) === JSON.stringify(after.catalog.cliCommands),
      operationsIdentical: JSON.stringify(before.catalog.operations.map((row) => ({ ...row, mcp: mapMcpNames(row.mcp) }))) === JSON.stringify(after.catalog.operations),
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
  const blocking = ["missingTests", "changedOutcomes", "cycles", "cyclesWithDevDependencies", "knowledgeDbProductionPersistenceImports", "hostImportsApps",
    "applicationOrPersistenceDependOnHost", "applicationHostImports", "persistenceHostImports"];
  // Only the recorded MCP names and test path move; kinds, routes, row meaning and CLI bindings stay fixed.
  const catalogChanged = changes.catalog.kinds !== "unchanged" || ["apiRoutes", "mcpTools", "operationsOutsideCli"]
    .some((key) => changes.catalog[key].removed.length || changes.catalog[key].added.length)
    || !changes.catalog.cliCommandsIdentical || !changes.catalog.operationsIdentical;
  if (blocking.some((key) => changes[key].length) || changes.knowledgeDbPersistence.after.production
    || Object.values(changes.exportsRemoved).some((list) => list.length) || Object.values(changes.exportsAdded).some((list) => list.length)
    || Object.values(changes.suiteExitCodes).some(({ before, after }) => before !== after) || catalogChanged
    || changes.executorHost.dependency || changes.cliLocal.unrecordedImports.length
    || changes.cliLocal.dependencies.some((name) => [PERSISTENCE, KNOWLEDGE_DB].includes(name))) process.exitCode = 1;
} else throw new Error("Usage: unit5p-inventory.mjs collect output.json | compare before.json after.json");
