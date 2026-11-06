import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  enqueue,
  execute,
  git,
  openEngine,
  runJob,
  cursorApiKey,
  childEnvironment,
  CURSOR_MODEL,
  providerCommand,
  maintenanceChild,
} from "./engine.mjs";

const location = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const command = args.shift() ?? "status";
if (process.env.KS_MAINTENANCE_CHILD === "1") {
  process.stdout.write('{"skipped":"maintenance child"}\n');
  process.exit(0);
}
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const policy = JSON.parse(readFileSync(join(location, "policy.json"), "utf8"));
const engine = openEngine(option("--repo") ?? process.cwd(), policy);
if (maintenanceChild(engine.repo)) {
  engine.db.close();
  process.stdout.write('{"skipped":"maintenance child"}\n');
  process.exit(0);
}
const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const hookNames = ["pre-commit", "post-commit", "post-merge", "post-checkout", "post-rewrite", "pre-push"];
const marker = "# ks-maintenance-managed-v1";

function installedHooks() {
  return join(engine.stateDir, "hooks");
}
function hooksPath() {
  try {
    return git(engine.repo, "config", "--get", "core.hooksPath").trim();
  } catch {
    return undefined;
  }
}
function installHooks() {
  const existing = hooksPath();
  const target = installedHooks();
  if (existing && existing !== target)
    throw new Error(`Existing core.hooksPath preserved: ${existing}. Chain maintenance commands manually.`);
  const defaultHooks = resolve(engine.repo, git(engine.repo, "rev-parse", "--git-common-dir").trim(), "hooks");
  if (!existing && hookNames.some((name) => existsSync(join(defaultHooks, name))))
    throw new Error("Existing Git hooks preserved. Chain maintenance commands manually.");
  mkdirSync(target, { recursive: true });
  const commands = {
    "pre-commit": "check-staged",
    "pre-push": "check-push",
    "post-commit": "enqueue",
    "post-merge": "enqueue",
    "post-checkout": "enqueue",
    "post-rewrite": "enqueue",
  };
  for (const name of hookNames) {
    const path = join(target, name);
    if (existsSync(path) && !readFileSync(path, "utf8").includes(marker))
      throw new Error(`Unmanaged hook preserved: ${path}`);
    writeFileSync(
      path,
      `#!/bin/sh\n${marker}\nroot=$(git rev-parse --show-toplevel) || exit 0\n[ -f "$root/tools/maintenance/cli.mjs" ] || exit 0\nnode "$root/tools/maintenance/cli.mjs" ${commands[name]}\n`,
      { mode: 0o755 },
    );
  }
  git(engine.repo, "config", "--local", "core.hooksPath", target);
  return { hooksPath: target };
}
function uninstallHooks() {
  const target = installedHooks();
  if (hooksPath() !== target) return { skipped: "Managed hooks are not active" };
  for (const name of hookNames) {
    const path = join(target, name);
    if (existsSync(path) && !readFileSync(path, "utf8").includes(marker))
      throw new Error(`Modified unmanaged hook preserved: ${path}`);
  }
  git(engine.repo, "config", "--local", "--unset", "core.hooksPath");
  for (const name of hookNames) if (existsSync(join(target, name))) unlinkSync(join(target, name));
  return { removed: true };
}
function checkPush() {
  const input = readFileSync(0, "utf8");
  const refs = input
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/));
  const result = refs
    .filter((row) => !/^0+$/.test(row[1]))
    .map(([, sha]) => {
      git(engine.repo, "cat-file", "-e", `${sha}^{commit}`);
      const receipts = engine.db.prepare("SELECT receipt FROM jobs WHERE head=? AND status='proposed'").all(sha);
      return { sha, receipt: receipts.some((row) => JSON.parse(row.receipt).validatedHead === sha) };
    });
  if (policy.requirePushReceipt && result.some((row) => !row.receipt))
    throw new Error("Outgoing revision lacks a successful maintenance receipt. Run maintenance before pushing.");
  return { refs: result, enforced: policy.requirePushReceipt };
}
async function main() {
  switch (command) {
    case "status":
      return engine.db
        .prepare(
          "SELECT id,head,kind,status,attempts,created,json_extract(receipt,'$.output') AS output,json_extract(receipt,'$.model') AS model FROM jobs WHERE kind!='working' ORDER BY created DESC LIMIT 30",
        )
        .all();
    case "enqueue":
      return enqueue(engine, { commit: option("--commit") });
    case "reconcile":
      return { working: enqueue(engine, { kind: "working" }), commit: enqueue(engine) };
    case "check-staged": {
      git(engine.repo, "diff", "--cached", "--check");
      const staged = git(engine.repo, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
        .split("\0")
        .filter(Boolean);
      for (const path of staged) {
        if (/^\.agent-docs\/(config|modules)\.json$/.test(path)) JSON.parse(git(engine.repo, "show", `:${path}`));
        if (
          /^(apps|packages|services|scripts|tools)\/.*\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(path) &&
          !path.includes("/skills/") &&
          path !== "packages/persistence/src/promotion-selection.ts"
        ) {
          const original = git(engine.repo, "show", `:${path}`);
          const formatted = execute("corepack", ["pnpm", "exec", "biome", "format", `--stdin-file-path=${path}`], {
            cwd: engine.repo,
            input: original,
          });
          if (formatted.replaceAll("\r\n", "\n") !== original.replaceAll("\r\n", "\n"))
            throw new Error(`Staged file needs formatting: ${path}`);
        }
      }
      return { passed: true, scope: "staged whitespace, metadata JSON, source formatting" };
    }
    case "check-push":
      return checkPush();
    case "run":
      return runJob(engine, {
        provider: option("--provider"),
        dryRun: args.includes("--dry-run"),
        jobId: option("--job"),
      });
    case "pause":
    case "resume":
      engine.db
        .prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)")
        .run("paused", String(command === "pause"));
      return { paused: command === "pause" };
    case "doctor": {
      let provider;
      try {
        providerCommand(policy.provider, "validate", policy.model);
        const env = childEnvironment(cursorApiKey(engine.repo));
        const models = execute("agent", ["--list-models"], { env });
        if (!models.split(/\r?\n/).some((line) => line.trim().split(/\s+-\s+/)[0] === CURSOR_MODEL))
          throw new Error(`CURSOR_MODEL_UNAVAILABLE:${CURSOR_MODEL}`);
        provider = {
          available: true,
          model: CURSOR_MODEL,
          version: execute("agent", ["--version"], { env }).trim(),
        };
      } catch (error) {
        provider = { available: false, error: error.message };
      }
      return {
        node: process.version,
        git: execute("git", ["--version"]).trim(),
        stateDir: engine.stateDir,
        observe: policy.observe,
        provider: { name: policy.provider, ...provider },
        hooksPath: hooksPath() ?? null,
        validation: policy.validation,
      };
    }
    case "install-hooks":
      return installHooks();
    case "uninstall-hooks":
      return uninstallHooks();
    case "watch": {
      let stop = false;
      let lastResult;
      process.once("SIGINT", () => {
        stop = true;
      });
      process.once("SIGTERM", () => {
        stop = true;
      });
      do {
        try {
          enqueue(engine, { kind: "working" });
          enqueue(engine);
          lastResult = runJob(engine);
          print(lastResult);
        } catch (error) {
          lastResult = { status: "failed", error: error.message };
          print(lastResult);
        }
        if (args.includes("--once")) break;
        await new Promise((resolve) => setTimeout(resolve, policy.pollMs));
      } while (!stop);
      return args.includes("--once") ? lastResult : { stopped: true };
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
try {
  const result = await main();
  print(result);
  if (result?.status === "failed") process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  engine.db.close();
}
