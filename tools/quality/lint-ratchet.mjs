// Lint ratchet: runs Biome lint over the configured scope and compares the number of diagnostics per rule with
// tools/quality/lint-baseline.json. Counts may only fall.
//
//   node tools/quality/lint-ratchet.mjs            check (exit 1 on any increase, new rule or Biome error)
//   node tools/quality/lint-ratchet.mjs --update   rewrite the baseline when nothing increased (lowers counts); creates
//                                                  the baseline when the file does not exist yet
//
// Exit codes: 0 within baseline, 1 ratchet violated or Biome reported an error, 2 the tool itself failed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baselinePath = join(repository, "tools/quality/lint-baseline.json");
const update = process.argv.includes("--update");

const require = createRequire(import.meta.url);
const biomePackage = require.resolve("@biomejs/biome/package.json");
const biomeBinary = join(dirname(biomePackage), "bin/biome");
const biomeVersion = JSON.parse(readFileSync(biomePackage, "utf8")).version;

const run = spawnSync(
  process.execPath,
  [biomeBinary, "lint", "--reporter=json", "--max-diagnostics=none", "--colors=off", "."],
  { cwd: repository, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] },
);
if (run.error || !run.stdout) {
  console.error(`lint-ratchet: Biome did not produce a report\n${run.error ?? run.stderr}`);
  process.exit(2);
}
let report;
try {
  report = JSON.parse(run.stdout.replace(/^\uFEFF/u, ""));
} catch (error) {
  console.error(`lint-ratchet: Biome output is not JSON (${error.message})\n${run.stderr}`);
  process.exit(2);
}
if (report.summary.diagnosticsNotPrinted > 0) {
  console.error(`lint-ratchet: Biome withheld ${report.summary.diagnosticsNotPrinted} diagnostics`);
  process.exit(2);
}

const counts = {};
const errors = [];
for (const diagnostic of report.diagnostics) {
  const category = diagnostic.category ?? "unknown";
  if (category.startsWith("lint/")) counts[category] = (counts[category] ?? 0) + 1;
  // Parse failures, internal errors and any error-level diagnostic (including rules the baseline holds at zero).
  if (diagnostic.severity === "error" || diagnostic.severity === "fatal") {
    errors.push(`${category} ${diagnostic.location?.path ?? ""}:${diagnostic.location?.start?.line ?? ""}`.trim());
  }
}
const sorted = Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
const total = Object.values(sorted).reduce((sum, count) => sum + count, 0);

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : undefined;
if (!baseline && !update) {
  console.error("lint-ratchet: tools/quality/lint-baseline.json is missing; run with --update to create it");
  process.exit(1);
}
const known = baseline?.rules ?? {};
const increased = [];
const added = [];
const lowered = [];
for (const [rule, count] of Object.entries(sorted)) {
  if (!(rule in known)) added.push(`${rule}: ${count}`);
  else if (count > known[rule]) increased.push(`${rule}: ${known[rule]} -> ${count}`);
}
for (const [rule, count] of Object.entries(known)) {
  const now = sorted[rule] ?? 0;
  if (now < count) lowered.push(`${rule}: ${count} -> ${now}`);
}

if (update && (!baseline || (!increased.length && !added.length && !errors.length))) {
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ tool: "@biomejs/biome", version: biomeVersion, total, rules: sorted }, null, 2)}\n`,
  );
  console.log(`lint-ratchet: baseline written (${total} diagnostics, ${Object.keys(sorted).length} rules)`);
  process.exit(0);
}

console.log(`lint-ratchet: ${total} diagnostics over ${Object.keys(sorted).length} rules (baseline ${baseline.total})`);
if (biomeVersion !== baseline.version) {
  console.log(`lint-ratchet: note - baseline was recorded with Biome ${baseline.version}, running ${biomeVersion}`);
}
if (lowered.length) {
  console.log("Counts fell; lower the baseline with `pnpm lint --update` (or edit tools/quality/lint-baseline.json):");
  for (const line of lowered) console.log(`  ${line}`);
}
let failed = false;
for (const [label, list] of [
  ["Rule counts increased", increased],
  ["Rules not in the baseline appeared", added],
  ["Biome reported errors", errors.slice(0, 20)],
]) {
  if (!list.length) continue;
  failed = true;
  console.error(`${label}:`);
  for (const line of list) console.error(`  ${line}`);
}
if (errors.length > 20) console.error(`  ... and ${errors.length - 20} more`);
process.exit(failed ? 1 : 0);
