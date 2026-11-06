import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const evidence = dirname(fileURLToPath(import.meta.url));
const [group, layout] = process.argv.slice(2);
const groups = {
  "knowledge-db": ["schema-workspace", "db-read", "ingestion"],
  retrieval: ["retrieval", "projections", "embeddings", "vector-backends"],
  preparation: ["conversion", "documents", "chunking"],
  core: ["domain", "runtime", "observability"],
};
if (!groups[group] || !["before", "after"].includes(layout)) {
  throw new Error("Usage: node type-consumer-probe.mjs <group> before|after");
}

const baseline = JSON.parse(readFileSync(join(evidence, "unit1-before.json"), "utf8"));
const lines = ["// Compiler consumer probe generated from the merged baseline's public export symbols."];
let index = 0;
for (const member of groups[group]) {
  const packageName = layout === "before" ? baseline.packages[member].packageName : `@aiengineer/knowledge-${group}`;
  for (const symbol of baseline.packages[member].sourceExports) {
    if (symbol.type) lines.push(`import type { ${symbol.name} as PublicType${index} } from "${packageName}";`);
    if (symbol.value) lines.push(`type PublicValue${index} = typeof import("${packageName}").${symbol.name};`);
    index++;
  }
}
lines.push("export {};", "");
const source = lines.join("\n");
const savedSource = join(evidence, `unit1-${group}-consumer-probe-${layout}.ts`);
const temporarySource = join(repository, "apps/verification-executor/src/unit1-public-export-probe.ts");
const temporaryConfig = join(repository, "apps/verification-executor/tsconfig.unit1-probe.json");
const paths = Object.fromEntries(Object.values(groups).flat().map((name) => [
  baseline.packages[name].packageName,
  [`../../packages/${name}/dist/index.d.ts`],
]));
if (layout === "after") paths[`@aiengineer/knowledge-${group}`] = [`../../packages/${group}/dist/index.d.ts`];
writeFileSync(savedSource, source);
writeFileSync(temporarySource, source);
writeFileSync(temporaryConfig, JSON.stringify({
  extends: "./tsconfig.json",
  compilerOptions: { paths },
}, null, 2));
let result;
try {
  result = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "-p", temporaryConfig], {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
} finally {
  unlinkSync(temporarySource);
  unlinkSync(temporaryConfig);
}
const capture = {
  group,
  layout,
  baselineCommit: baseline.sourceCommit,
  currentCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim()),
  probeFile: savedSource.slice(repository.length + 1).replaceAll("\\", "/"),
  symbolCount: index,
  exitCode: result.status,
  stdout: result.stdout,
  stderr: result.stderr,
  error: result.error?.message,
};
writeFileSync(join(evidence, `unit1-${group}-consumer-probe-${layout}.json`), `${JSON.stringify(capture, null, 2)}\n`);
console.log(`Public ${group} ${layout} probe: ${index} symbols, typecheck exit ${result.status}`);
if (result.status !== 0 || result.error) {
  process.stderr.write((result.stderr || result.stdout || result.error?.message || "Unknown probe failure").slice(-5000));
  process.exitCode = 1;
}
