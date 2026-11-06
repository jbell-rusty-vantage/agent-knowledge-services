#!/usr/bin/env node
/**
 * Skill conformance check: every command and MCP tool a skill names must exist in an actual
 * implemented catalog, and the manifest must describe the directories that exist.
 *
 *   node skills/check.mjs            # exit 1 on drift, 2 on a broken catalog source
 *   node skills/check.mjs --json     # also print manifest/skill digests for run-pin freezing
 *
 * Catalogs are read from source, never invented here:
 *   executor operations  apps/verification-executor/src/knowledge/operations.ts (SV-17 retired the recovery and content-link operations)
 *   executor MCP tools   apps/verification-executor/src/mcp.ts  (verify_* tools) + the operations above
 *   platform CLI (ks)    apps/cli/src/ks-commands.ts KS_COMMANDS; remote status from apps/cli/src/commands.ts CLI_COMMANDS
 *   platform MCP tools   apps/mcp/src/catalog.ts and tools/verify.ts
 *   Jev MCP / CLI        apps/jev/src/{mcp,index}.ts
 * When apps/verification-executor/dist/knowledge.js exists, its `ops` output is compared against the
 * parsed executor catalog so a stale parser cannot pass silently.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repoRoot, "skills");
const executorRoot = join(repoRoot, "apps/verification-executor");
const problems = [];
const fail = (message) => problems.push(message);
const die = (message) => { console.error(message); process.exit(2); };
const read = (path) => readFileSync(path, "utf8");

/** Minimum sizes: a silently empty catalog must never let a skill pass. */
const MINIMUM = { executorOperations: 20, executorMcpTools: 30, platformCommands: 50, platformMcpTools: 20, jevMcpTools: 6, jevCommands: 8 };

function executorOperationCatalog() {
  const files = ["operations.ts"].map((name) => read(join(executorRoot, "src/knowledge", name)));
  const operations = new Map();
  for (const source of files) {
    for (const match of source.matchAll(/name:\s*"([a-z][a-z0-9_]*)"[\s\S]{0,2000}?cli:\s*\{\s*command:\s*\[([^\]]*)\]/g)) {
      const command = [...match[2].matchAll(/"([^"]+)"/g)].map((part) => part[1]);
      if (command.length === 2) operations.set(match[1], command.join(" "));
    }
    // `checkpoint_${action}` style templates: keep their literal command pair.
    for (const match of source.matchAll(/name:\s*`([a-z][a-z0-9_]*)_\$\{action\}`[\s\S]{0,600}?command:\s*\[\s*"([^"]+)",\s*action\s*\]/g)) {
      for (const action of ["read", "restore"]) operations.set(`${match[1]}_${action}`, `${match[2]} ${action}`);
    }
  }
  return operations;
}

function verifyMcpTools() {
  const source = read(join(executorRoot, "src/mcp.ts"));
  return new Set([...source.matchAll(/registerTool\(\s*"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]));
}

/** The dispatcher's status per resource/action key: "unsupported" when the command fails closed, else "admitted". */
function remoteStatuses() {
  const source = read(join(repoRoot, "apps/cli/src/commands.ts"));
  const table = source.slice(source.indexOf("export const CLI_COMMANDS"), source.indexOf("export function resolveCommand"));
  if (!table) die("apps/cli/src/commands.ts: CLI_COMMANDS table not found");
  const statuses = new Map();
  let group;
  for (const line of table.split("\n")) {
    const groupMatch = /^\s{2}([a-z_]+):\s*\{\s*$/.exec(line);
    if (groupMatch) { group = groupMatch[1]; continue; }
    const actionMatch = /^\s{4}"?([a-z][a-z-]*)"?:\s*(submit\(|unsupported\(|\{)/.exec(line);
    if (group && actionMatch) statuses.set(`${group} ${actionMatch[1]}`, actionMatch[2] === "unsupported(" ? "unsupported" : "admitted");
  }
  return statuses;
}

/** Every `ks` command name (without the binary): "unsupported" when it fails closed, else "admitted". */
function platformCommands() {
  const statuses = remoteStatuses();
  const commands = new Map();
  const source = read(join(repoRoot, "apps/cli/src/ks-commands.ts"));
  for (const [, name, profile, first, second] of source.matchAll(/^\s{2}"([a-z][a-z -]*)": (remote|local|utility)\("([a-z_-]+)"(?:, "([a-z-]+)")?\)/gm)) {
    if (profile !== "remote") { commands.set(name, "admitted"); continue; }
    const status = statuses.get(`${first} ${second}`);
    if (!status) die(`apps/cli/src/ks-commands.ts: "${name}" binds ${first} ${second}, which CLI_COMMANDS does not define`);
    commands.set(name, status);
  }
  return commands;
}

function platformMcpTools() {
  const catalog = read(join(repoRoot, "apps/mcp/src/catalog.ts"));
  const catalogEnd = catalog.indexOf("export type McpToolName");
  const verificationEnd = catalog.indexOf("export const FORBIDDEN_MCP_CAPABILITIES");
  if (catalogEnd < 0 || verificationEnd < 0) die("platform MCP catalog markers changed");
  const bounded = catalog.slice(catalog.indexOf("export const MCP_TOOL_CATALOG"), catalogEnd);
  const verification = catalog.slice(catalog.indexOf("export const VERIFICATION_MCP_TOOL_NAMES"), verificationEnd);
  const group = read(join(repoRoot, "apps/mcp/src/tools/verify.ts"));
  return new Set([
    ...[...bounded.matchAll(/^\s*"?([a-z][a-z0-9_]*)"?:/gm)].map((match) => match[1]),
    ...[...verification.matchAll(/"([a-z][a-z0-9_]*)"/g)].map((match) => match[1]),
    ...[...group.matchAll(/"(verify_[a-z0-9_]+)"/g)].map((match) => match[1]),
  ]);
}

const executorOperations = executorOperationCatalog();
const executorMcpTools = new Set([...executorOperations.keys(), ...verifyMcpTools()]);
const executorCommands = new Set(executorOperations.values());
/** The longest `ks` command name the leading words spell. */
const ksCommand = (words) => {
  for (let length = Math.min(words.length, 4); length > 0; length -= 1) {
    const name = words.slice(0, length).join(" ");
    if (platform.has(name)) return name;
  }
  return undefined;
};
const platform = platformCommands();
const platformTools = platformMcpTools();
const jevSource = read(join(repoRoot, "apps/jev/src/mcp.ts"));
const jevTools = new Set([...jevSource.matchAll(/registerTool\(\s*"(jev_[a-z0-9_]+)"/g)].map(match => match[1]));
const jevCliSource = read(join(repoRoot, "apps/jev/src/index.ts"));
const jevCommands = new Set([...jevCliSource.matchAll(/command\s*[!=]==\s*"([a-z][a-z-]*)"/g)].map(match => match[1]));
const jevHttpSource = read(join(repoRoot, "apps/jev/src/http.ts"));
const jevHttpRoutes = new Set([...jevHttpSource.matchAll(/request\.method === "(GET|POST)" && path === "([^"]+)"/g)].map(match => `${match[1]} ${match[2]}`));
const jevHttpOperations = new Map([
  ["jev_submit", "POST /v1/jev/jobs"], ["jev_batch", "POST /v1/jev/batches"],
  ["jev_list", "GET /v1/jev/jobs"], ["jev_workers", "GET /v1/jev/health"],
]);
const jobRoutePattern = /const match = \/(.+)\/\.exec\(path\)/.exec(jevHttpSource)?.[1];
if (!jobRoutePattern) die("Jev HTTP job route parser no longer matches source");
const jobRoute = new RegExp(jobRoutePattern);
if (!jobRoute.test("/v1/jev/jobs/example") || !jobRoute.test("/v1/jev/jobs/example/cancel")
  || !jevHttpSource.includes('request.method === "GET" && !match[2]')
  || !jevHttpSource.includes('request.method === "POST" && match[2]')) die("Jev HTTP get/cancel route source changed; update conformance parser");
jevHttpOperations.set("jev_get", "GET /v1/jev/jobs/:id");
jevHttpOperations.set("jev_cancel", "POST /v1/jev/jobs/:id/cancel");
jevHttpRoutes.add("GET /v1/jev/jobs/:id");
jevHttpRoutes.add("POST /v1/jev/jobs/:id/cancel");
for (const [name, minimum] of Object.entries(MINIMUM)) {
  const size = { executorOperations, executorMcpTools, platformCommands: platform, platformMcpTools: platformTools, jevMcpTools: jevTools, jevCommands }[name].size;
  if (size < minimum) die(`catalog ${name} parsed only ${size} entries (expected >= ${minimum}); the parser or the source moved`);
}

const distCli = join(executorRoot, "dist/knowledge.js");
if (existsSync(distCli)) {
  const listed = JSON.parse(execFileSync(process.execPath, [distCli, "ops"], { encoding: "utf8", windowsHide: true }));
  const built = new Set(listed.map((entry) => entry.tool));
  for (const name of built) if (!executorOperations.has(name)) fail(`built executor exposes ${name} but the parsed source catalog does not`);
  for (const name of executorOperations.keys()) if (!built.has(name)) fail(`parsed source catalog has ${name} but the built executor does not (rebuild the executor)`);
}

const manifest = JSON.parse(read(join(skillsRoot, "manifest.json")));
const declared = new Map(manifest.skills.map((skill) => [skill.id, skill]));
const directories = readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
for (const name of directories) if (!declared.has(name)) fail(`skills/${name}/ exists but manifest.json does not declare it`);
for (const skill of manifest.skills) if (!directories.includes(skill.id)) fail(`manifest declares ${skill.id} without a skills/${skill.id}/ directory`);

const SURFACES = new Set(["executor-cli", "executor-mcp", "platform-cli", "platform-mcp", "workspace-files", "jev-cli", "jev-mcp", "jev-http"]);
for (const surface of ["jev-cli", "jev-mcp", "jev-http"]) {
  if (!manifest.distributions?.[surface]) fail(`manifest omits the ${surface} distribution`);
}
const filesOf = (directory) => {
  const files = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(directory, path).split("\\").join("/")] = read(path);
    }
  };
  walk(directory);
  return files;
};
/** Identical to the research run-pin installation digest: sorted relative paths, UTF-8 bytes. */
const contentDigest = (files) => createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))).digest("hex");

const codeSpans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1])
  .concat([...text.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].flatMap((match) => match[1].split(/\r?\n/)));

const report = { skills: [], manifestDigest: contentDigest({ "manifest.json": read(join(skillsRoot, "manifest.json")) }) };

for (const skill of manifest.skills) {
  const directory = join(skillsRoot, skill.id);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
  const files = filesOf(directory);
  if (!files["SKILL.md"]) { fail(`${skill.id}: SKILL.md missing`); continue; }
  if (skill.path !== `${skill.id}/SKILL.md`) fail(`${skill.id}: manifest path must be ${skill.id}/SKILL.md`);
  for (const reference of skill.references ?? []) if (!files[reference]) fail(`${skill.id}: declared reference ${reference} is missing`);
  for (const surface of skill.surfaces ?? []) if (!SURFACES.has(surface)) fail(`${skill.id}: unknown surface ${surface}`);

  const body = Object.entries(files).map(([, text]) => text).join("\n");

  // 1. Declared operations must exist on their declared surfaces.
  for (const operation of skill.operations ?? []) {
    const known = executorOperations.has(operation) || executorMcpTools.has(operation) || platformTools.has(operation) || platform.has(operation) || jevTools.has(operation);
    if (!known) fail(`${skill.id}: declared operation "${operation}" is not in any implemented catalog`);
    if (jevTools.has(operation)) {
      if (!(skill.surfaces ?? []).includes("jev-mcp")) fail(`${skill.id}: declares ${operation} without its jev-mcp surface`);
      if ((skill.surfaces ?? []).includes("jev-cli") && !jevCommands.has(operation.slice("jev_".length))) fail(`${skill.id}: ${operation} has no matching implemented Jev CLI command`);
      if ((skill.surfaces ?? []).includes("jev-http") && !jevHttpRoutes.has(jevHttpOperations.get(operation))) fail(`${skill.id}: ${operation} has no matching implemented Jev HTTP route`);
    }
    if (platform.get(operation) === "unsupported") fail(`${skill.id}: declared operation "${operation}" is an explicitly unsupported platform command`);
  }

  // 2. Every command spelled in the text must resolve, on one of the skill's declared surfaces.
  const surfaces = new Set(skill.surfaces ?? []);
  for (const span of codeSpans(body)) {
    const jevInvocation = /^\s*(?:\$\s+)?(?:jev|node\s+(?:--env-file=\S+\s+)?apps\/jev\/dist\/index\.js)\s+([a-z][a-z-]*)/.exec(span);
    if (jevInvocation) {
      if (!jevCommands.has(jevInvocation[1])) fail(`${skill.id}: Jev command "${jevInvocation[1]}" is not implemented`);
      if (!surfaces.has("jev-cli")) fail(`${skill.id}: uses a Jev command without declaring jev-cli`);
    }
    const ks = /^\s*(?:\$\s+)?ks\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3})/.exec(span);
    if (ks) {
      const words = ks[1].split(/\s+/);
      // `ks help` and a bare group (`ks verify`) name no command.
      if (words[0] === "help" || (words.length === 1 && [...platform.keys()].some((name) => name.startsWith(`${words[0]} `)))) continue;
      const name = ksCommand(words);
      if (!name) fail(`${skill.id}: "ks ${ks[1]}" is not an implemented ks command`);
      else if (platform.get(name) === "unsupported") fail(`${skill.id}: "ks ${name}" is explicitly unsupported`);
      else if (!surfaces.has("platform-cli")) fail(`${skill.id}: uses "ks ${name}" without declaring the platform-cli surface`);
      continue;
    }
    // The executor distribution still ships `knowledge` until 5H; the platform CLI is `ks` from Unit 5C.
    const invocation = /^\s*(?:\$\s+)?knowledge(?:-verify)?\s+([a-z][a-z-]*)\s+([a-z][a-z-]*)/.exec(span);
    if (!invocation) continue;
    const pair = `${invocation[1]} ${invocation[2]}`;
    if (["help", "serve", "health", "ops"].includes(invocation[1])) continue;
    if (!executorCommands.has(pair)) fail(`${skill.id}: "knowledge ${pair}" is not an executor command; the platform CLI is ks (${
      [`knowledge ${pair}`, `verify ${pair}`, `db ${pair}`, pair].find((name) => platform.has(name)) ?? "see ks --help"})`);
    else if (!surfaces.has("executor-cli")) fail(`${skill.id}: uses executor command "knowledge ${pair}" without declaring the executor-cli surface`);
  }

  // 3. Every MCP tool name spelled in the text must exist, unless the skill declares it absent on purpose.
  const absent = new Set([...(skill.absentOperations ?? []), ...(skill.artifactTypes ?? [])]);
  for (const name of absent) {
    if (executorMcpTools.has(name) || platformTools.has(name) || jevTools.has(name) || platform.get(name) === "admitted") fail(`${skill.id}: declares "${name}" unavailable, but it is now an admitted operation — update the skill`);
  }
  for (const span of codeSpans(body)) {
    const toolText = span.replace(/"serviceIdentity"\s*:\s*"[^"]*"/g, "");
    for (const candidate of toolText.matchAll(/\b((?:knowledge|verify|schema|db|ingest|artifact|report|recovery|content|checkpoint|source|jev)_[a-z0-9_]+)(\*?)/g)) {
      const name = candidate[1];
      if (candidate[2] === "*" || name.endsWith("_")) continue;
      if (jevTools.has(name)) {
        if (!surfaces.has("jev-mcp")) fail(`${skill.id}: uses ${name} without declaring jev-mcp`);
        continue;
      }
      if (executorMcpTools.has(name) || platformTools.has(name) || absent.has(name)) continue;
      if (/_(v1|json|md|id|ids|digest|sha256|key|dir|url|tokens|micros|schema|seq|state|kind)$/.test(name)) continue;
      fail(`${skill.id}: "${name}" looks like a tool name but is not in any implemented MCP catalog`);
    }
  }

  // 3b. A skill that owns a catalog prefix must name every operation the catalog exposes under it.
  for (const prefix of skill.requireCatalogPrefix ?? []) {
    const owned = [...executorMcpTools, ...platformTools, ...jevTools].filter((name) => name.startsWith(prefix));
    if (!owned.length) fail(`${skill.id}: no implemented operation starts with "${prefix}"`);
    for (const name of owned) {
      if (!(skill.operations ?? []).includes(name)) fail(`${skill.id}: manifest omits catalog operation "${name}"`);
      if (!body.includes(name)) fail(`${skill.id}: catalog operation "${name}" is not documented in the skill`);
    }
  }

  // 4. A structural seal must never be described as admission.
  const flowing = body.replace(/\s+/g, " ");
  if (/\bseal/i.test(flowing)) {
    const separated = /seal[^.]{0,200}\b(not|never)\b[^.]{0,160}\b(admission|admitted|verified|verification|publication|published)\b/i.test(flowing)
      || /\b(admission|verification|publication)[^.]{0,140}\bseparate[^.]{0,140}\bseal/i.test(flowing)
      || /\bseal[^.]{0,140}\bseparate\b/i.test(flowing);
    if (!separated) fail(`${skill.id}: mentions sealing without stating that a seal is not admission`);
  }

  // 5. Relative markdown links must resolve inside the repository.
  for (const link of body.matchAll(/\]\((\.{1,2}\/[^)\s#]+|[A-Za-z0-9._-]+\.md)(?:#[^)]*)?\)/g)) {
    const target = resolve(directory, link[1]);
    if (!existsSync(target)) fail(`${skill.id}: broken relative link ${link[1]}`);
  }

  report.skills.push({ id: skill.id, version: skill.version, digest: contentDigest(files), files: Object.keys(files).sort() });
}

// The executor-owned skill is shipped separately from the platform catalog.
// Hash every reference/template, and resolve nested links from their own file.
const executorManifest = JSON.parse(read(join(executorRoot, "skills/manifest.json")));
const verificationSkill = executorManifest.skills.find((skill) => skill.id === "knowledge-verify");
if (!verificationSkill) fail("executor manifest omits knowledge-verify");
else {
  const directory = join(executorRoot, "skills/knowledge-verify");
  const files = filesOf(directory);
  const cliSource = read(join(executorRoot, "src/index.ts"));
  const commands = new Set([...cliSource.matchAll(/case "([a-z][a-z-]*)":/g)].map((match) => match[1]));
  for (const reference of verificationSkill.references ?? []) {
    if (!files[reference]) fail(`knowledge-verify: missing shipped reference ${reference}`);
  }
  for (const [name, body] of Object.entries(files)) {
    if (name.endsWith(".mjs")) {
      try { execFileSync(process.execPath, ["--check", join(directory, name)], { stdio: "pipe", windowsHide: true }); }
      catch { fail(`knowledge-verify: template syntax invalid: ${name}`); }
    }
    if (!name.endsWith(".md")) continue;
    for (const span of codeSpans(body)) {
      const command = /^\s*knowledge-verify\s+([a-z][a-z-]*)/.exec(span)?.[1];
      if (command && !commands.has(command) && !["help", "serve", "mcp-stdio"].includes(command)) fail(`knowledge-verify: unknown CLI command ${command}`);
    }
    for (const link of body.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(link[1])) continue;
      const target = resolve(dirname(join(directory, name)), link[1]);
      if (!existsSync(target)) fail(`knowledge-verify/${name}: broken relative link ${link[1]}`);
    }
  }
  report.skills.push({ id: verificationSkill.id, version: verificationSkill.version, digest: contentDigest(files), files: Object.keys(files).sort() });
}

if (problems.length) {
  for (const problem of problems) console.error(`drift: ${problem}`);
  console.error(`${problems.length} skill conformance problem(s)`);
  process.exit(1);
}
const summary = { skills: report.skills.length, executorOperations: executorOperations.size, executorMcpTools: executorMcpTools.size, platformCommands: platform.size, platformMcpTools: platformTools.size, jevMcpTools: jevTools.size, jevCommands: jevCommands.size };
if (process.argv.includes("--json")) console.log(JSON.stringify({ ...summary, ...report }, null, 2));
else console.log(`skills conformant: ${JSON.stringify(summary)}`);
