// Unit 2 evidence: runtime exports of config/host/persistence, composition test identities,
// and the declared workspace manifest graph. Usage from the repository root:
//   node docs/operations/package-cleanup/workspace/evidence/unit2-inventory.mjs collect before|after <output.json>
//   node docs/operations/package-cleanup/workspace/evidence/unit2-inventory.mjs compare <before.json> <after.json>
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const suites = ["apps/api", "apps/mcp", "apps/worker", "packages/persistence"];
const afterSuites = [...suites, "packages/host"];
// Tests that moved with their construction code (before path → after path).
const movedTests = {
  "apps/api/src/verification-benchmark-reads-runtime.test.ts": "packages/host/src/verification/api/verification-benchmark-reads-runtime.test.ts",
  "apps/worker/src/verification-audit-signing-runtime.test.ts": "packages/host/src/verification/worker/verification-audit-signing-runtime.test.ts",
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

async function collect(layout, output) {
  const temporary = mkdtempSync(join(tmpdir(), "ks-unit2-inventory-"));
  try {
    const result = {
      schema: 1,
      layout,
      sourceCommit: git("rev-parse", "HEAD"),
      dirty: Boolean(git("status", "--porcelain")),
      node: process.version,
      exports: {
        config: await runtimeExports("packages/config"),
        host: await runtimeExports("packages/host"),
        persistence: await runtimeExports("packages/persistence"),
      },
      graph: manifestGraph(),
      command: "node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=json (sequential per package)",
      runs: [],
    };
    for (const directory of layout === "before" ? suites : afterSuites) {
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
    const [file, ...rest] = identity.split(" :: ");
    return [movedTests[file] ?? file, ...rest].join(" :: ");
  };
  const beforeTests = new Map(before.runs.flatMap((run) => run.tests.map((test) => [mapIdentity(test.identity), test.status])));
  const afterTests = new Map(after.runs.flatMap((run) => run.tests.map((test) => [test.identity, test.status])));
  const hostExports = new Set(after.exports.host ?? []);
  const hostRuntimeNames = ["createVerificationHostRuntime"];
  return {
    missingTests: [...beforeTests.keys()].filter((identity) => !afterTests.has(identity)),
    changedOutcomes: [...beforeTests].filter(([identity, status]) => afterTests.has(identity) && afterTests.get(identity) !== status)
      .map(([identity, status]) => ({ identity, before: status, after: afterTests.get(identity) })),
    addedTests: [...afterTests.keys()].filter((identity) => !beforeTests.has(identity)),
    configExportsMissingFromHost: (before.exports.config ?? []).filter((name) => !hostExports.has(name)),
    hostRuntimeMissingFromHost: hostRuntimeNames.filter((name) => !hostExports.has(name)),
    hostRuntimeStillInPersistence: hostRuntimeNames.filter((name) => (after.exports.persistence ?? []).includes(name)),
    persistenceExportsRemoved: (before.exports.persistence ?? []).filter((name) => !(after.exports.persistence ?? []).includes(name) && !hostRuntimeNames.includes(name)),
    cycles: after.graph.cycles,
    hostImportsApps: (after.graph.manifests["@aiengineer/knowledge-host"]?.dependencies ?? [])
      .filter((name) => after.graph.manifests[name]?.path.startsWith("apps/")),
    configPackageRemains: Boolean(after.graph.manifests["@aiengineer/knowledge-config"]),
  };
}

const [command, ...arguments_] = process.argv.slice(2);
if (command === "collect" && ["before", "after"].includes(arguments_[0]) && arguments_[1]) await collect(arguments_[0], arguments_[1]);
else if (command === "compare" && arguments_[0] && arguments_[1]) {
  const changes = compare(JSON.parse(readFileSync(resolve(arguments_[0]), "utf8")), JSON.parse(readFileSync(resolve(arguments_[1]), "utf8")));
  console.log(JSON.stringify(changes, null, 2));
  const blocking = ["missingTests", "changedOutcomes", "configExportsMissingFromHost", "hostRuntimeMissingFromHost", "hostRuntimeStillInPersistence", "persistenceExportsRemoved", "cycles", "hostImportsApps"];
  if (blocking.some((key) => changes[key].length) || changes.configPackageRemains) process.exitCode = 1;
} else throw new Error("Usage: unit2-inventory.mjs collect before|after output.json | compare before.json after.json");
