// Unit 3 evidence: runtime exports of application/host/persistence, test identities of the
// suites this unit touches, the declared manifest graph and MCP runtime imports.
// Usage from the repository root:
//   node docs/operations/package-cleanup/workspace/evidence/unit3-inventory.mjs collect <output.json>
//   node docs/operations/package-cleanup/workspace/evidence/unit3-inventory.mjs compare <before.json> <after.json>
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const suites = ["apps/api", "apps/mcp", "apps/cli", "packages/host", "packages/application", "packages/persistence"];
// Tests that moved with their implementation (before path → after path).
const movedTests = {
  "apps/api/src/tests/retrieval-executor.test.ts": "packages/application/src/retrieval/canonical-retrieval-executor.test.ts",
  "apps/api/src/tests/verification-drift-revalidation-runtime.test.ts": "packages/host/src/verification/api/verification-drift-revalidation-runtime.test.ts",
  "apps/api/src/tests/verification-benchmark-capture-profile.test.ts": "packages/host/src/verification/api/verification-benchmark-capture-profile.test.ts",
  "apps/api/src/tests/verification-ownership.test.ts": "packages/host/src/verification/api/verification-ownership.test.ts",
  "apps/api/src/tests/verification-adjudication-decision-runtime.test.ts": "packages/host/src/verification/api/verification-adjudication-decision-runtime.test.ts",
  "apps/api/src/tests/verification-adjudication-reads-runtime.test.ts": "packages/host/src/verification/api/verification-adjudication-reads-runtime.test.ts",
  "apps/api/src/tests/verification-capture-reads-runtime.test.ts": "packages/host/src/verification/api/verification-capture-reads-runtime.test.ts",
  "apps/api/src/tests/verification-claims-report-reads-runtime.test.ts": "packages/host/src/verification/api/verification-claims-report-reads-runtime.test.ts",
  "apps/api/src/tests/verification-semantic-reconciliation-runtime.test.ts": "packages/host/src/verification/api/verification-semantic-reconciliation-runtime.test.ts",
};
// Test titles that were renamed because they described the retired HTTP shim (before → after).
const renamedTests = {
  "apps/mcp/src/tests/adjudication.test.ts :: adjudication MCP adapter forwards a strict request through tenant-granted API authority only":
    "apps/mcp/src/tests/adjudication.test.ts :: adjudication MCP adapter forwards a strict request through tenant-granted in-process authority only",
  "apps/mcp/src/tests/adjudication.test.ts :: adjudication MCP adapter keeps record-decision on the HTTP shim until decision admission is present":
    "apps/mcp/src/tests/adjudication.test.ts :: adjudication MCP adapter returns CAPABILITY_NOT_ADMITTED for record-decision until decision admission is present",
  "apps/mcp/src/tests/benchmark-reads.test.ts :: benchmark MCP reads rejects foreign tenants and caller signing keys before the HTTP client":
    "apps/mcp/src/tests/benchmark-reads.test.ts :: benchmark MCP reads rejects foreign tenants and caller signing keys before the read",
  "apps/mcp/src/tests/index.test.ts :: durable MCP operation facade routes status and explanation tools to canonical API reads without admitting writes":
    "apps/mcp/src/tests/index.test.ts :: durable MCP operation facade routes status and explanation tools to canonical in-process reads without admitting writes",
  "apps/mcp/src/tests/retrieval-reads.test.ts :: public retrieval citation adapters fails closed when the public replay client is absent":
    "apps/mcp/src/tests/retrieval-reads.test.ts :: public retrieval citation adapters fails closed when in-process citation replay is not composed",
  "apps/mcp/src/tests/verification-tools.test.ts :: audit inspection MCP adapter routes only the strict audit reference through the authenticated client":
    "apps/mcp/src/tests/verification-tools.test.ts :: audit inspection MCP adapter routes only the strict audit reference through in-process admission",
  "apps/mcp/src/tests/verification-tools.test.ts :: claims/report read MCP adapter denies an ungranted tenant before the client call":
    "apps/mcp/src/tests/verification-tools.test.ts :: claims/report read MCP adapter denies an ungranted tenant before the read",
  "apps/mcp/src/tests/verification-tools.test.ts :: metric MCP adapter forwards metric routing hints through the API and rejects synthesized findings":
    "apps/mcp/src/tests/verification-tools.test.ts :: metric MCP adapter forwards metric routing hints to trusted ownership and rejects synthesized findings",
  "apps/mcp/src/tests/verification-tools.test.ts :: metric MCP adapter submits comparison references through the API and rejects caller inference":
    "apps/mcp/src/tests/verification-tools.test.ts :: metric MCP adapter submits comparison references in process and rejects caller inference",
  "apps/mcp/src/tests/verification-tools.test.ts :: parse MCP adapter forwards only a strict artifact handle to the API client":
    "apps/mcp/src/tests/verification-tools.test.ts :: parse MCP adapter forwards only a strict artifact handle to in-process submission",
  "apps/mcp/src/tests/verification-tools.test.ts :: verification MCP adapter denies a tenant outside the authenticated grant before calling the client":
    "apps/mcp/src/tests/verification-tools.test.ts :: verification MCP adapter denies a tenant outside the authenticated grant before submission",
  "apps/mcp/src/tests/verification-tools.test.ts :: verification MCP adapter uses bearer-bound identity and the strict API client without accepting actor context":
    "apps/mcp/src/tests/verification-tools.test.ts :: verification MCP adapter uses bearer-bound identity and strict in-process admission without accepting actor context",
};

const git = (...arguments_) => execFileSync("git", arguments_, { cwd: repository, encoding: "utf8" }).trim();

async function runtimeExports(packageDirectory) {
  const entry = join(repository, packageDirectory, "dist/index.js");
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
      manifests[manifest.name] = {
        path: `${root}/${name}`,
        dependencies: Object.keys(manifest.dependencies ?? {}).filter((dependency) => dependency.startsWith("@aiengineer/knowledge-")).sort(),
      };
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

/** Non-test source files under a directory that import the given module specifier. */
function sourceImports(directory, specifier) {
  const found = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (statSync(child).isDirectory()) { if (name !== "tests") walk(child); continue; }
      if (!/\.(ts|mts)$/u.test(name) || /\.test\.ts$/u.test(name)) continue;
      if (readFileSync(child, "utf8").includes(`"${specifier}`)) found.push(relative(repository, child).replaceAll("\\", "/"));
    }
  };
  walk(join(repository, directory));
  return found.sort();
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
  const temporary = mkdtempSync(join(tmpdir(), "ks-unit3-inventory-"));
  try {
    const result = {
      schema: 1,
      sourceCommit: git("rev-parse", "HEAD"),
      dirty: Boolean(git("status", "--porcelain")),
      node: process.version,
      exports: {
        application: await runtimeExports("packages/application"),
        host: await runtimeExports("packages/host"),
        persistence: await runtimeExports("packages/persistence"),
      },
      graph: manifestGraph(),
      mcpClientImports: sourceImports("apps/mcp/src", "@aiengineer/knowledge-client"),
      applicationHostImports: sourceImports("packages/application/src", "@aiengineer/knowledge-host"),
      persistenceHostImports: sourceImports("packages/persistence/src", "@aiengineer/knowledge-host"),
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

function compare(before, after) {
  const mapIdentity = (identity) => {
    const renamed = renamedTests[identity] ?? identity;
    const [file, ...rest] = renamed.split(" :: ");
    return [movedTests[file] ?? file, ...rest].join(" :: ");
  };
  const beforeTests = new Map(before.runs.flatMap((run) => run.tests.map((test) => [mapIdentity(test.identity), test.status])));
  const afterTests = new Map(after.runs.flatMap((run) => run.tests.map((test) => [test.identity, test.status])));
  const removed = (name) => (before.exports[name] ?? []).filter((symbol) => !(after.exports[name] ?? []).includes(symbol));
  const graph = after.graph.manifests;
  return {
    missingTests: [...beforeTests.keys()].filter((identity) => !afterTests.has(identity)),
    changedOutcomes: [...beforeTests].filter(([identity, status]) => afterTests.has(identity) && afterTests.get(identity) !== status)
      .map(([identity, status]) => ({ identity, before: status, after: afterTests.get(identity) })),
    addedTests: [...afterTests.keys()].filter((identity) => !beforeTests.has(identity)),
    applicationExportsRemoved: removed("application"),
    hostExportsRemoved: removed("host"),
    persistenceExportsRemoved: removed("persistence"),
    cycles: after.graph.cycles,
    hostImportsApps: (graph["@aiengineer/knowledge-host"]?.dependencies ?? []).filter((name) => graph[name]?.path.startsWith("apps/")),
    applicationOrPersistenceDependOnHost: ["@aiengineer/knowledge-application", "@aiengineer/knowledge-persistence"]
      .filter((name) => (graph[name]?.dependencies ?? []).includes("@aiengineer/knowledge-host")),
    applicationHostImports: after.applicationHostImports,
    persistenceHostImports: after.persistenceHostImports,
    mcpClientImports: after.mcpClientImports,
    mcpDependsOnClient: (graph["@aiengineer/knowledge-mcp"]?.dependencies ?? []).includes("@aiengineer/knowledge-client"),
  };
}

const [command, ...arguments_] = process.argv.slice(2);
if (command === "collect" && arguments_[0]) await collect(arguments_[0]);
else if (command === "compare" && arguments_[0] && arguments_[1]) {
  const changes = compare(JSON.parse(readFileSync(resolve(arguments_[0]), "utf8")), JSON.parse(readFileSync(resolve(arguments_[1]), "utf8")));
  console.log(JSON.stringify(changes, null, 2));
  const blocking = ["missingTests", "changedOutcomes", "applicationExportsRemoved", "hostExportsRemoved", "persistenceExportsRemoved", "cycles",
    "hostImportsApps", "applicationOrPersistenceDependOnHost", "applicationHostImports", "persistenceHostImports", "mcpClientImports"];
  if (blocking.some((key) => changes[key].length) || changes.mcpDependsOnClient) process.exitCode = 1;
} else throw new Error("Usage: unit3-inventory.mjs collect output.json | compare before.json after.json");
