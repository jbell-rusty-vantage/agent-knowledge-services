// Unit 5C installed-`ks` smoke: installs the packed ks tarball into a fresh directory outside the workspace with a
// secret-free environment, then runs `ks --help`, a remote command against a local API built from this workspace (and
// its authorization and network failures), and the offline capture → locate → claims → policy → extraction chain on the
// local profile with the global fetch disabled. Prints one JSON summary; exits 1 on any failed check.
// Usage from the repository root, after `pnpm --filter @aiengineer/knowledge-cli... build`, the API build and
// `pnpm --filter @aiengineer/knowledge-cli pack:sandbox`:
//   node docs/operations/package-cleanup/workspace/evidence/unit5c-ks-smoke.mjs [tarball]
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const tarball = resolve(process.argv[2] ?? readFileSync(join(repository, "apps/cli/dist/sandbox/TARBALL"), "utf8").trim());
const api = join(repository, "apps/api/dist/index.js");
// An allowlist: no credential, database, KNOWLEDGE_* or VERIFY_* variable reaches npm or ks.
const baseEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "HOME"]
    .includes(name.toUpperCase())));
const outside = (path) => relative(repository, path).startsWith("..");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const summary = { tarball: relative(repository, tarball).replaceAll("\\", "/"), checks: {} };

const directory = await realpath(await mkdtemp(join(tmpdir(), "ks-installed-")));
let server;
try {
  assert.ok(outside(directory), "the install directory must be outside the workspace");
  const npm = (args) => {
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args,
      { cwd: directory, env: baseEnvironment, encoding: "utf8", shell: process.platform === "win32", windowsHide: true, timeout: 300_000 });
    assert.equal(result.status, 0, `npm ${args[0]}: ${result.stderr}`);
  };
  npm(["init", "-y"]);
  npm(["install", tarball, "--no-audit", "--no-fund"]);
  const installed = join(directory, "node_modules/ks");
  const binary = join(installed, "dist/index.js");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.deepEqual(manifest.bin, { ks: "./dist/index.js" });
  assert.ok(existsSync(join(directory, "node_modules/.bin", process.platform === "win32" ? "ks.cmd" : "ks")));
  // No workspace resolution: nothing from @aiengineer is installed or required.
  assert.ok(!existsSync(join(directory, "node_modules/@aiengineer")));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@aiengineer/")), []);
  summary.install = { directoryOutsideWorkspace: true, dependencies: manifest.dependencies, skills: readdirSync(join(installed, "skills")).sort() };

  const guard = join(directory, "no-network.mjs");
  await writeFile(guard, [
    'import http from "node:http"; import https from "node:https"; import { syncBuiltinESMExports } from "node:module";',
    'const forbidden = () => { throw new Error("NETWORK_FORBIDDEN"); };',
    "globalThis.fetch = forbidden; for (const client of [http, https]) { client.request = forbidden; client.get = forbidden; }",
    "syncBuiltinESMExports();", "",
  ].join("\n"));
  const ks = (argv, env = {}, { offline = false } = {}) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [...(offline ? ["--import", pathToFileURL(guard).href] : []), binary, ...argv],
      { cwd: directory, env: { ...baseEnvironment, ...env }, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => void (stdout += chunk));
    child.stderr.on("data", (chunk) => void (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });

  // 1. Help constructs nothing and needs no configuration.
  const help = await ks(["--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /^ks — Knowledge Services command line/u);
  const verifyHelp = await ks(["verify", "--help"]);
  assert.equal(verifyHelp.code, 0, verifyHelp.stderr);
  summary.checks.help = { exit: help.code, groupHelpExit: verifyHelp.code };

  // 2. A remote command against a local API (no database) through KnowledgeClient; failures exit 2 without fallback.
  const port = await new Promise((resolvePort) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port: free } = probe.address(); probe.close(() => resolvePort(free)); }); });
  const token = "ks-smoke-reader-token-0001", tenantId = id(1);
  server = spawn(process.execPath, [api], {
    cwd: repository, windowsHide: true,
    env: { ...baseEnvironment, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "development",
      KNOWLEDGE_API_IDENTITIES: JSON.stringify([{ token, actor: { kind: "human", id: id(2) }, grants: [{ tenantId, roles: ["knowledge_reader"] }] }]) },
  });
  let apiLog = "";
  server.stderr.on("data", (chunk) => void (apiLog += chunk));
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt += 1) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* starting */ }
    assert.ok(attempt < 100, `local API did not start: ${apiLog}`);
    await new Promise((wait) => setTimeout(wait, 200));
  }
  const plan = {
    policyVersion: id(6), query: "Synthetic preview organizations", intents: ["knowledge_evidence"],
    subqueries: [{ id: "q", text: "preview", coverageRole: "required" }], spaces: ["engineering_claims"],
    anchors: { entities: [], concepts: [], useCases: [] }, hardFilters: [{ field: "visibility", op: "eq", value: "internal" }],
    softBoosts: [], temporalScope: {}, candidateK: 20, finalK: 5, graph: { maxDepth: 0, allowedEdges: [] }, abstention: { minimumCoverage: 0 },
  };
  const context = JSON.stringify({ tenantId, operationId: id(3), attemptId: id(4), correlationId: id(5), actor: { kind: "human", id: id(2) },
    capabilityVersion: "v1", idempotencyKey: "ks-smoke-key", reason: "installed ks smoke", contractVersion: "v1" });
  const remote = ["knowledge", "retrieve", "plan", "--base-url", url, "--context", context, "--input", JSON.stringify(plan)];
  const validated = await ks(remote, { KNOWLEDGE_API_TOKEN: token });
  assert.equal(validated.code, 0, validated.stderr);
  assert.deepEqual(JSON.parse(validated.stdout), plan);
  const unauthorized = await ks(remote, { KNOWLEDGE_API_TOKEN: "ks-smoke-unknown-token-0001" });
  assert.equal(unauthorized.code, 2);
  assert.equal(unauthorized.stdout, "");
  assert.equal(JSON.parse(unauthorized.stderr).code, "CLI_ERROR");
  server.kill();
  await new Promise((stopped) => server.once("exit", stopped));
  server = undefined;
  const unreachable = await ks(remote, { KNOWLEDGE_API_TOKEN: token });
  assert.equal(unreachable.code, 2);
  assert.equal(unreachable.stdout, "");
  assert.equal(JSON.parse(unreachable.stderr).code, "CLI_ERROR");
  summary.checks.remote = { command: "ks knowledge retrieve plan", exit: validated.code, unauthorizedExit: unauthorized.code, unreachableExit: unreachable.code };

  // 3. The offline chain on the local profile: no network (fetch throws), no database, no credentials, no providers.
  const store = join(directory, "store"), run = "ks-offline";
  const local = (argv, expected) => ks([...argv, "--store", store, "--git-sha", "ks-smoke"], {}, { offline: true }).then((result) => {
    assert.equal(result.code, expected, `${argv.slice(0, 3).join(" ")}: ${result.stderr}`);
    return result.code === 2 ? result : JSON.parse(result.stdout);
  });
  const source = join(directory, "source.txt");
  await writeFile(source, "Panel A has 42 samples.\nPanel B has 42 samples.\nCurrency: USD 12.00\n");
  await local(["verify", "capture", "file", source, "--capture-id", "panel", "--run", run], 0);
  assert.equal((await local(["verify", "capture", "locate", "panel", "42 samples", "--run", run], 1)).status, "ambiguous");
  const quote = "Panel A has 42 samples.";
  assert.equal((await local(["verify", "capture", "locate", "panel", quote, "--run", run], 0)).status, "resolved");
  const claims = join(directory, "claims.json");
  await writeFile(claims, JSON.stringify({ schemaVersion: "verification-claims-intent.v1", intentId: "panel-count",
    claims: [{ claimId: "panel-count", proposition: quote, evidence: [{ captureId: "panel", quote }] }] }));
  assert.equal((await local(["verify", "chain", "claims", claims, "--run", run], 0)).status, "passed");
  const policy = await local(["verify", "chain", "policy", "--run", run], 1);
  assert.ok(["review", "abstain"].includes(policy.outcome));
  assert.equal(policy.semanticCoverage.judged, 0);
  const candidate = { currency: "USD 12.00" };
  const extraction = (value) => ({ schemaVersion: "verification-extraction-intent.v1", intentId: "panel-fields",
    schema: { schemaId: "panel", schemaVersion: "1", jsonSchema: { type: "object", description: "Synthetic panel fields", additionalProperties: false,
      required: ["currency"], properties: { currency: { type: "string", description: "currency", maxLength: 100 } } } },
    candidate: value, normalizations: [],
    fields: [{ path: "/currency", comparison: "currency", quote: candidate.currency, allowedValues: ["USD"], captureId: "panel" }] });
  const passing = join(directory, "extraction.json"), altered = join(directory, "altered.json");
  await writeFile(passing, JSON.stringify(extraction(candidate)));
  await writeFile(altered, JSON.stringify(extraction({ currency: "USD 99.00" })));
  assert.equal((await local(["verify", "chain", "extraction", passing, "--run", run], 0)).valid, true);
  assert.ok((await local(["verify", "chain", "extraction", altered, "--run", run], 1)).failedPaths.includes("/currency"));
  const image = join(directory, "image.png");
  await writeFile(image, new Uint8Array([137, 80, 78, 71]));
  assert.match((await local(["verify", "capture", "file", image, "--run", run], 2)).stderr, /UNSUPPORTED/u);
  const refused = await local(["verify", "capture", "source", "https://example.com", "--run", run], 2);
  assert.equal(JSON.parse(refused.stderr).code, "CAPABILITY_NOT_ADMITTED");
  const status = await local(["verify", "chain", "status", "--run", run], 0);
  assert.ok(status.steps.some((step) => step.operation === "verify_claims"));
  summary.checks.offline = {
    chain: "capture → locate (ambiguous, resolved) → claims → policy (held) → extraction (pass, changed value rejected) → status",
    mechanical: "passed", policy: policy.outcome, semanticJudged: 0, providersCalled: 0, networkGuard: "fetch, http and https throw",
    receipts: status.steps.length, captureSourceWithoutProvider: "CAPABILITY_NOT_ADMITTED",
  };
  summary.result = "passed";
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.result = "failed";
  summary.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  server?.kill();
  await rm(directory, { recursive: true, force: true });
}
