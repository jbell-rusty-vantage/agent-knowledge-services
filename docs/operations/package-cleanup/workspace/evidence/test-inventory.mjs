import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const groups = {
  core: ["domain", "runtime", "observability"],
  preparation: ["conversion", "documents", "chunking"],
  retrieval: ["retrieval", "projections", "embeddings", "vector-backends"],
  "knowledge-db": ["schema-workspace", "db-read", "ingestion"],
};
const sourceFolder = { retrieval: "search" };

function originalFile(path, group) {
  const normalized = path.replaceAll("\\", "/");
  for (const name of groups[group]) {
    const folder = sourceFolder[name] ?? name;
    for (const area of ["src", "test", "examples"]) {
      const prefix = `packages/${group}/${area}/${folder}/`;
      if (normalized.startsWith(prefix)) return normalized.replace(prefix, `packages/${name}/${area}/`);
    }
  }
  return null;
}

function summarizeTestFile(result, layout, group, packageDirectory) {
  const absoluteFile = isAbsolute(result.name) ? result.name : resolve(packageDirectory, result.name);
  const file = relative(repository, absoluteFile).replaceAll("\\", "/");
  const beforeFile = layout === "before" ? file : originalFile(file, group);
  if (!beforeFile) throw new Error(`Unmapped test file after package merge: ${file}`);
  return {
    file,
    originalFile: beforeFile,
    tests: result.assertionResults.map((test) => ({
      name: test.fullName,
      status: test.status,
    })).sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function runPackage(name, layout, group, tempDirectory) {
  const packageDirectory = join(repository, "packages", name);
  const output = join(tempDirectory, `${name}.json`);
  const arguments_ = [join(repository, "node_modules/vitest/vitest.mjs"), "run", "--maxWorkers=2",
    "--reporter=json", "--outputFile", output];
  const result = spawnSync(process.execPath, arguments_, {
    cwd: packageDirectory,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(readFileSync(output, "utf8"));
  } catch {
    return {
      package: name,
      exitCode: result.status,
      error: result.error?.message ?? (result.stderr || result.stdout || "").slice(-1000),
      files: [],
    };
  }
  return {
    package: name,
    exitCode: result.status,
    counts: {
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      skipped: report.numPendingTests,
      total: report.numTotalTests,
    },
    files: report.testResults.map((file) => summarizeTestFile(file, layout, group, packageDirectory))
      .sort((left, right) => left.file.localeCompare(right.file)),
  };
}

function validateCapture(capture, layout, selectedGroup) {
  const expected = layout === "before" ?
    (selectedGroup ? groups[selectedGroup] : Object.values(groups).flat()) :
    (selectedGroup ? [selectedGroup] : Object.keys(groups));
  if (capture.schema !== 1 || capture.layout !== layout || !Array.isArray(capture.runs)) {
    throw new Error(`Invalid ${layout} test inventory`);
  }
  const actual = capture.runs.map((run) => run.package);
  if (actual.length !== expected.length || new Set(actual).size !== expected.length ||
    expected.some((name) => !actual.includes(name))) {
    throw new Error(`Missing or duplicate ${layout} package test runs`);
  }
  for (const run of capture.runs) {
    const reportedTests = Array.isArray(run.files) ? run.files.reduce((sum, file) =>
      sum + (Array.isArray(file.tests) ? file.tests.length : 0), 0) : -1;
    if (run.exitCode !== 0 || run.error || !Array.isArray(run.files) || !run.files.length ||
      !run.counts || !Number.isInteger(run.counts.total) || run.counts.total < 1 ||
      reportedTests !== run.counts.total ||
      run.counts.passed + run.counts.failed + run.counts.skipped !== run.counts.total ||
      [run.counts.passed, run.counts.failed, run.counts.skipped].some((count) =>
        !Number.isInteger(count) || count < 0)) {
      throw new Error(`Failed or incomplete ${layout} test run: ${run.package}`);
    }
    for (const file of run.files) {
      const expectedPrefixes = layout === "before" ? [`packages/${run.package}/`] :
        groups[run.package].map((name) => `packages/${name}/`);
      if (!file.originalFile || !Array.isArray(file.tests) || !file.tests.length ||
        !expectedPrefixes.some((prefix) => file.originalFile.startsWith(prefix)) ||
        file.tests.some((test) => !test.name || !test.status)) {
        throw new Error(`Unmapped or incomplete ${layout} test file: ${file.file}`);
      }
    }
  }
}

function testOutcomes(capture) {
  const outcomes = new Map();
  for (const run of capture.runs) {
    for (const file of run.files) {
      for (const test of file.tests) {
        const identity = `${file.originalFile} :: ${test.name}`;
        const statuses = outcomes.get(identity) ?? [];
        statuses.push(test.status);
        outcomes.set(identity, statuses);
      }
    }
  }
  for (const statuses of outcomes.values()) statuses.sort();
  return outcomes;
}

function compare(before, after, selectedGroup) {
  if (selectedGroup) {
    const members = groups[selectedGroup];
    before = { ...before, runs: before.runs.filter((run) => members.includes(run.package)) };
  }
  validateCapture(before, "before", selectedGroup);
  validateCapture(after, "after", selectedGroup);
  const beforeByIdentity = testOutcomes(before);
  const afterByIdentity = testOutcomes(after);
  return {
    missing: [...beforeByIdentity].filter(([identity]) => !afterByIdentity.has(identity)),
    added: [...afterByIdentity].filter(([identity]) => !beforeByIdentity.has(identity)),
    changedOutcomes: [...beforeByIdentity].filter(([identity, statuses]) =>
      afterByIdentity.has(identity) && JSON.stringify(statuses) !== JSON.stringify(afterByIdentity.get(identity)))
      .map(([identity, statuses]) => ({ identity, before: statuses, after: afterByIdentity.get(identity) })),
  };
}

const [command, ...arguments_] = process.argv.slice(2);
if (command === "collect" || command === "collect-group") {
  const [selectedGroup, layout, output] = command === "collect-group" ? arguments_ : [undefined, ...arguments_];
  if (selectedGroup && !groups[selectedGroup]) throw new Error(`Unknown package group: ${selectedGroup}`);
  if (!["before", "after"].includes(layout) || !output) {
    throw new Error("Usage: node test-inventory.mjs collect before|after output.json");
  }
  const tempDirectory = mkdtempSync(join(tmpdir(), "ks-test-inventory-"));
  try {
    const runs = [];
    for (const [group, members] of Object.entries(groups).filter(([group]) =>
      !selectedGroup || group === selectedGroup)) {
      for (const name of layout === "before" ? members : [group]) {
        console.log(`Running ${name} with at most two Vitest workers`);
        runs.push(runPackage(name, layout, group, tempDirectory));
      }
    }
    const result = {
      schema: 1,
      layout,
      ...(selectedGroup ? { group: selectedGroup } : {}),
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
      dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim()),
      command: "node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=json",
      runs,
    };
    writeFileSync(resolve(output), `${JSON.stringify(result, null, 2)}\n`);
    if (runs.some((run) => run.exitCode !== 0 || run.error)) process.exitCode = 1;
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
} else if (command === "compare" || command === "compare-group") {
  const [selectedGroup, beforePath, afterPath] = command === "compare-group" ? arguments_ : [undefined, ...arguments_];
  if (selectedGroup && !groups[selectedGroup]) throw new Error(`Unknown package group: ${selectedGroup}`);
  if (!beforePath || !afterPath) throw new Error("Usage: node test-inventory.mjs compare before.json after.json");
  const changes = compare(JSON.parse(readFileSync(resolve(beforePath), "utf8")),
    JSON.parse(readFileSync(resolve(afterPath), "utf8")), selectedGroup);
  console.log(JSON.stringify(changes, null, 2));
  if (Object.values(changes).some((items) => items.length)) process.exitCode = 1;
} else {
  throw new Error("Usage: node test-inventory.mjs collect before|after output.json | compare before.json after.json");
}
