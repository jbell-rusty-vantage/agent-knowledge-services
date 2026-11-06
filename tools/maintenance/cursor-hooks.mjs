import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { allowedProposalPath, digest, enqueue, execute, git, openEngine, snapshot } from "./engine.mjs";

const roots = [
  "apps",
  "packages",
  "services",
  "tools",
  "docs",
  "knowledge",
  "skills",
  ".agent-docs",
  "AGENTS.md",
  "README.md",
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "biome.json",
];
const excluded = [
  "artifacts",
  "outputs",
  "runs",
  "fixtures",
  "catalog",
  "vendor",
  "node_modules",
  "dist",
  "receipts",
  "private",
  "vault",
].flatMap((name) => [`:(exclude,glob)**/${name}/**`, `:(exclude,glob)${name}/**`]);
const markerEvents = new Set(["afterFileEdit", "afterShellExecution"]);

function inspectFile(repo, path) {
  let current = repo;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("HOOK_SNAPSHOT_SYMLINK");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  const stat = lstatSync(current);
  if (!stat.isFile()) throw new Error("HOOK_SNAPSHOT_NOT_REGULAR");
  return stat;
}

function eligiblePaths(engine) {
  rejectExternalFilters(engine);
  return [
    ...new Set([
      ...git(engine.repo, "diff", "HEAD", "--name-only", "--no-renames", "-z", "--", ...roots, ...excluded).split("\0"),
      ...git(engine.repo, "ls-files", "--others", "--exclude-standard", "-z", "--", ...roots, ...excluded).split("\0"),
    ]),
  ]
    .filter((path) => path && allowedProposalPath(path))
    .sort();
}

function rejectExternalFilters(engine) {
  const paths = git(
    engine.repo,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...roots,
    ...excluded,
  )
    .split("\0")
    .filter((path) => path && allowedProposalPath(path));
  if (!paths.length) return;
  const attributes = execute("git", ["-C", engine.repo, "check-attr", "-z", "--stdin", "filter"], {
    input: `${paths.join("\0")}\0`,
  }).split("\0");
  for (let index = 2; index < attributes.length; index += 3) {
    if (attributes[index] !== "unspecified" && attributes[index] !== "unset")
      throw new Error("HOOK_SNAPSHOT_CUSTOM_FILTER");
  }
}

function eligibleFingerprint(engine) {
  const paths = eligiblePaths(engine);
  if (paths.length > 80) throw new Error("HOOK_SNAPSHOT_FILE_LIMIT");
  let total = 0;
  const records = paths.map((path) => {
    const stat = inspectFile(engine.repo, path);
    if (!stat) return [path, "deleted"];
    total += stat.size;
    if (stat.size > 2 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error("HOOK_SNAPSHOT_BYTE_LIMIT");
    return [path, stat.mode & 0o111, digest(readFileSync(join(engine.repo, path)))];
  });
  return digest(JSON.stringify(records));
}

export function createDirtySnapshot(engine) {
  rejectExternalFilters(engine);
  const before = snapshot(engine);
  const paths = eligiblePaths(engine);
  if (!paths.length) return undefined;
  if (paths.length > 80) throw new Error("HOOK_SNAPSHOT_FILE_LIMIT");
  const directory = join(engine.stateDir, "cursor-hooks");
  mkdirSync(directory, { recursive: true });
  const indexPath = join(directory, `index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  const indexGit = (...args) => execute("git", ["-C", engine.repo, ...args], { env });
  let bytes = 0;
  try {
    indexGit("read-tree", before.head);
    for (const path of paths) {
      const stat = inspectFile(engine.repo, path);
      if (!stat) {
        indexGit("update-index", "--force-remove", "--", path);
        continue;
      }
      bytes += stat.size;
      if (stat.size > 2 * 1024 * 1024 || bytes > 20 * 1024 * 1024) throw new Error("HOOK_SNAPSHOT_BYTE_LIMIT");
      const contents = readFileSync(join(engine.repo, path));
      const filter = git(engine.repo, "check-attr", "-z", "filter", "--", path).split("\0")[2];
      if (filter !== "unspecified" && filter !== "unset") throw new Error("HOOK_SNAPSHOT_CUSTOM_FILTER");
      const object = execute("git", ["-C", engine.repo, "hash-object", "-w", `--path=${path}`, "--stdin"], {
        input: contents,
      }).trim();
      const tracked = git(engine.repo, "ls-files", "--stage", "--", path).match(/^(100644|100755) /);
      const mode = tracked?.[1] ?? (stat.mode & 0o111 && process.platform !== "win32" ? "100755" : "100644");
      indexGit("update-index", "--add", "--cacheinfo", `${mode},${object},${path}`);
    }
    const tree = indexGit("write-tree").trim();
    if (tree === git(engine.repo, "rev-parse", `${before.head}^{tree}`).trim()) return undefined;
    const after = snapshot(engine);
    if (after.head !== before.head || after.fingerprint !== before.fingerprint)
      throw new Error("HOOK_SNAPSHOT_CHANGED_DURING_CAPTURE");
    const date = git(engine.repo, "show", "-s", "--format=%cI", before.head).trim();
    const identity = {
      GIT_AUTHOR_NAME: "Maintenance Snapshot",
      GIT_AUTHOR_EMAIL: "snapshot@example.invalid",
      GIT_COMMITTER_NAME: "Maintenance Snapshot",
      GIT_COMMITTER_EMAIL: "snapshot@example.invalid",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
    const commit = execute(
      "git",
      [
        "-C",
        engine.repo,
        "commit-tree",
        tree,
        "-p",
        before.head,
        "-m",
        `Maintenance dirty snapshot ${before.fingerprint}`,
      ],
      { env: { ...env, ...identity } },
    ).trim();
    const snapshotRef = `refs/maintenance/snapshots/${before.fingerprint}`;
    let existing;
    try {
      existing = git(engine.repo, "rev-parse", "--verify", snapshotRef).trim();
    } catch {
      existing = undefined;
    }
    if (existing && existing !== commit) throw new Error("HOOK_SNAPSHOT_REF_CONFLICT");
    if (!existing) git(engine.repo, "update-ref", snapshotRef, commit, "0".repeat(40));
    return { commit, kind: "snapshot", sourceHead: before.head, sourceFingerprint: before.fingerprint, paths };
  } finally {
    if (existsSync(indexPath)) unlinkSync(indexPath);
    if (existsSync(`${indexPath}.lock`)) unlinkSync(`${indexPath}.lock`);
  }
}

function storeMarker(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

function maintenanceCommand(repo, jobId) {
  const path = repo.replaceAll("\\", "/");
  if (/["$`\r\n]/.test(path)) throw new Error("HOOK_COMMAND_PATH_REQUIRES_MANUAL_INVOCATION");
  return `node "${path}/tools/maintenance/cli.mjs" run --repo "${path}" --provider cursor --job ${jobId}`;
}

export function handleCursorHook(
  engine,
  input,
  { environment = process.env, enqueueJob = enqueue, capture = createDirtySnapshot } = {},
) {
  const event = input.hook_event_name;
  const empty = event === "beforeSubmitPrompt" ? { continue: true } : {};
  if (environment.KS_MAINTENANCE_CHILD === "1") return empty;
  try {
    if (git(engine.repo, "config", "--local", "--get", "maintenance.child").trim() === "true") return empty;
  } catch {
    /* No child marker is the normal interactive profile. */
  }
  if (!markerEvents.has(event) && event !== "stop" && event !== "beforeSubmitPrompt") return empty;
  if (event === "stop" && (input.status !== "completed" || Number(input.loop_count ?? 0) > 0)) return {};
  if (engine.db.prepare("SELECT value FROM settings WHERE key='paused'").get()?.value === "true") return empty;
  if (git(engine.repo, "rev-parse", "--abbrev-ref", "HEAD").trim().startsWith("maintenance/")) return empty;
  const directory = join(engine.stateDir, "cursor-hooks");
  mkdirSync(directory, { recursive: true });
  const markerPath = join(
    directory,
    `${digest(`${String(input.conversation_id ?? "unknown")}\0${String(input.generation_id ?? "unknown")}`)}.json`,
  );
  const marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : {};
  if (event === "beforeSubmitPrompt") {
    storeMarker(markerPath, { baselineFingerprint: eligibleFingerprint(engine), observed: false, updated: Date.now() });
    return empty;
  }
  if (markerEvents.has(event)) {
    let actualEdit = marker.actualEdit ?? false;
    if (event === "afterFileEdit") {
      if (typeof input.file_path !== "string") return {};
      const path = relative(engine.repo, resolve(engine.repo, input.file_path)).replaceAll("\\", "/");
      if (!allowedProposalPath(path)) return {};
      actualEdit = true;
    }
    storeMarker(markerPath, { ...marker, actualEdit, observed: true, event, updated: Date.now() });
    return {};
  }
  if (!marker.observed) return {};
  if (!marker.baselineFingerprint && !marker.actualEdit) return {};
  if (marker.baselineFingerprint === eligibleFingerprint(engine)) return {};
  const state = capture(engine);
  if (!state) return {};
  if (marker.fingerprint === state.sourceFingerprint) return {};
  const existing = engine.db
    .prepare("SELECT id,status FROM jobs WHERE sourceFingerprint=? AND kind='snapshot'")
    .get(state.sourceFingerprint);
  if (existing && ["queued", "running", "proposed", "observed", "superseded"].includes(existing.status)) return {};
  const job = enqueueJob(engine, state);
  if (!job?.id || !["queued", "observed"].includes(job.status)) return {};
  storeMarker(markerPath, { ...marker, fingerprint: state.sourceFingerprint, jobId: job.id });
  if (engine.policy.observe) return {};
  return {
    followup_message: `A bounded maintenance job ${job.id} was queued for an immutable snapshot of your actual Git changes. Run exactly: ${maintenanceCommand(engine.repo, job.id)}\nIt reviews code quality, documentation and meaningful tests in an isolated checkout. Read the resulting receipt and report its status and proposal location. Do not apply, commit, push or merge its proposal automatically. This is the only maintenance follow-up; do not start another agent yourself.`,
  };
}

async function main() {
  let engine;
  const configuredEvent = process.argv[process.argv.indexOf("--event") + 1];
  let empty = configuredEvent === "beforeSubmitPrompt" ? { continue: true } : {};
  try {
    if (process.env.KS_MAINTENANCE_CHILD === "1") {
      process.stdout.write(`${JSON.stringify(empty)}\n`);
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 65536) throw new Error("HOOK_INPUT_TOO_LARGE");
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (input?.hook_event_name === "beforeSubmitPrompt") empty = { continue: true };
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("HOOK_INPUT_INVALID");
    const location = dirname(fileURLToPath(import.meta.url));
    const policy = JSON.parse(readFileSync(join(location, "policy.json"), "utf8"));
    engine = openEngine(resolve(location, "../.."), policy);
    process.stdout.write(`${JSON.stringify(handleCursorHook(engine, input))}\n`);
  } catch (error) {
    process.stderr.write(`Cursor maintenance hook: ${error.message}\n`);
    process.stdout.write(`${JSON.stringify(empty)}\n`);
  } finally {
    engine?.db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
