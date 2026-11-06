import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, openEngine } from "./engine.mjs";
import { createDirtySnapshot, handleCursorHook } from "./cursor-hooks.mjs";

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), "cursor-hooks-test-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo, "packages"));
  writeFileSync(join(repo, "packages", "sample.mjs"), "export const value = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const engine = openEngine(repo, {
    observe: false,
    provider: "cursor",
    maxAttempts: 2,
    leaseMs: 1000,
    timeoutMs: 10000,
    validation: [["node", "--version"]],
  });
  t.after(() => {
    engine.db.close();
    rmSync(repo, { recursive: true, force: true });
  });
  return engine;
}
const event = (hook_event_name, extra = {}) => ({
  conversation_id: "fixture",
  generation_id: "turn-1",
  hook_event_name,
  file_path: "packages/sample.mjs",
  ...extra,
});
test("file and shell events record metadata without capture or queue work", (t) => {
  const engine = fixture(t);
  for (const name of ["afterFileEdit", "afterShellExecution"])
    assert.deepEqual(handleCursorHook(engine, event(name), { capture: () => assert.fail("snapshot during edit") }), {});
  assert.equal(engine.db.prepare("SELECT count(*) AS total FROM jobs").get().total, 0);
});
test("unchanged completion skips maintenance", (t) => {
  const engine = fixture(t);
  handleCursorHook(engine, event("afterShellExecution"));
  assert.deepEqual(handleCursorHook(engine, event("stop", { status: "completed", loop_count: 0 })), {});
});
test("child, error, aborted and loop followups skip capture", (t) => {
  const engine = fixture(t);
  const capture = () => assert.fail("unexpected snapshot");
  assert.deepEqual(
    handleCursorHook(engine, event("afterFileEdit"), { environment: { KS_MAINTENANCE_CHILD: "1" }, capture }),
    {},
  );
  for (const status of ["error", "aborted"])
    assert.deepEqual(handleCursorHook(engine, event("stop", { status }), { capture }), {});
  assert.deepEqual(handleCursorHook(engine, event("stop", { status: "completed", loop_count: 1 }), { capture }), {});
});
test("immutable snapshot preserves partial staging and captures current bytes", (t) => {
  const engine = fixture(t);
  const file = join(engine.repo, "packages", "sample.mjs");
  writeFileSync(file, "export const value = 2;\n");
  git(engine.repo, "add", "packages/sample.mjs");
  writeFileSync(file, "export const value = 3;\n");
  const staged = git(engine.repo, "write-tree");
  const head = git(engine.repo, "rev-parse", "HEAD");
  const result = createDirtySnapshot(engine);
  assert.equal(git(engine.repo, "write-tree"), staged);
  assert.equal(git(engine.repo, "rev-parse", "HEAD"), head);
  assert.equal(git(engine.repo, "show", `${result.commit}:packages/sample.mjs`), "export const value = 3;\n");
  assert.equal(readFileSync(file, "utf8"), "export const value = 3;\n");
  assert.equal(createDirtySnapshot(engine).commit, result.commit);
});
test("secret-only and artifact-only changes do not create snapshots", (t) => {
  const engine = fixture(t);
  writeFileSync(join(engine.repo, ".env"), "SECRET=do-not-read\n");
  mkdirSync(join(engine.repo, "artifacts"));
  writeFileSync(join(engine.repo, "artifacts", "run.json"), "{}");
  assert.equal(createDirtySnapshot(engine), undefined);
});
test("completed dirty stop queues once and produces one bounded followup", (t) => {
  const engine = fixture(t);
  writeFileSync(join(engine.repo, "packages", "sample.mjs"), "export const value = 2;\n");
  handleCursorHook(engine, event("afterFileEdit"));
  const output = handleCursorHook(engine, event("stop", { status: "completed", loop_count: 0 }));
  const queued = engine.db.prepare("SELECT id FROM jobs WHERE kind='snapshot'").get();
  const absoluteRepo = engine.repo.replaceAll("\\", "/");
  assert.ok(
    output.followup_message.includes(
      `node "${absoluteRepo}/tools/maintenance/cli.mjs" run --repo "${absoluteRepo}" --provider cursor --job ${queued.id}`,
    ),
  );
  assert.deepEqual(handleCursorHook(engine, event("stop", { status: "completed", loop_count: 0 })), {});
  assert.equal(engine.db.prepare("SELECT count(*) AS total FROM jobs WHERE kind='snapshot'").get().total, 1);
});
test("already queued snapshot is skipped across conversations", (t) => {
  const engine = fixture(t);
  writeFileSync(join(engine.repo, "packages", "sample.mjs"), "export const value = 2;\n");
  handleCursorHook(engine, event("afterFileEdit"));
  handleCursorHook(engine, event("stop", { status: "completed" }));
  handleCursorHook(engine, event("afterFileEdit", { conversation_id: "other" }));
  assert.deepEqual(handleCursorHook(engine, event("stop", { conversation_id: "other", status: "completed" })), {});
});
test("paused maintenance never captures or schedules", (t) => {
  const engine = fixture(t);
  engine.db.prepare("INSERT OR REPLACE INTO settings VALUES(?,?)").run("paused", "true");
  assert.deepEqual(
    handleCursorHook(engine, event("stop", { status: "completed" }), {
      capture: () => assert.fail("capture while paused"),
    }),
    {},
  );
});
test("snapshot retains deletions without changing the real index", (t) => {
  const engine = fixture(t);
  const initial = git(engine.repo, "write-tree");
  unlinkSync(join(engine.repo, "packages", "sample.mjs"));
  const result = createDirtySnapshot(engine);
  assert.equal(git(engine.repo, "ls-tree", "-r", "--name-only", result.commit), "");
  assert.equal(git(engine.repo, "write-tree"), initial);
});
test("child invocation emits exactly one JSON response without reading stdin", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./cursor-hooks.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    { encoding: "utf8", env: { ...process.env, KS_MAINTENANCE_CHILD: "1" }, input: "not valid JSON" },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "{}\n");
});
test("baseline skips read-only turns over preexisting dirty source", (t) => {
  const engine = fixture(t);
  writeFileSync(join(engine.repo, "packages", "sample.mjs"), "export const value = 2;\n");
  assert.deepEqual(handleCursorHook(engine, event("beforeSubmitPrompt")), { continue: true });
  handleCursorHook(engine, event("afterShellExecution"));
  assert.deepEqual(handleCursorHook(engine, event("stop", { status: "completed" })), {});
  assert.equal(engine.db.prepare("SELECT count(*) AS total FROM jobs").get().total, 0);
});
test("baseline admits a real shell-only change during the turn", (t) => {
  const engine = fixture(t);
  handleCursorHook(engine, event("beforeSubmitPrompt"));
  writeFileSync(join(engine.repo, "packages", "sample.mjs"), "export const value = 2;\n");
  handleCursorHook(engine, event("afterShellExecution"));
  assert.match(
    handleCursorHook(engine, event("stop", { status: "completed" })).followup_message,
    /--provider cursor --job/,
  );
});
test("irrelevant edit and shell event without baseline do not claim old dirty work", (t) => {
  const engine = fixture(t);
  writeFileSync(join(engine.repo, "packages", "sample.mjs"), "export const value = 2;\n");
  handleCursorHook(engine, event("afterFileEdit", { file_path: ".env" }));
  handleCursorHook(engine, event("afterShellExecution"));
  assert.deepEqual(handleCursorHook(engine, event("stop", { status: "completed" })), {});
});
test("repository child marker suppresses cloud hook recursion", (t) => {
  const engine = fixture(t);
  git(engine.repo, "config", "--local", "maintenance.child", "true");
  assert.deepEqual(handleCursorHook(engine, event("beforeSubmitPrompt")), { continue: true });
  assert.deepEqual(handleCursorHook(engine, event("afterFileEdit")), {});
});
test("protected tool edits cannot attribute preexisting eligible dirty source to this turn", (t) => {
  const engine = fixture(t);
  writeFileSync(join(engine.repo, "packages", "sample.mjs"), "export const value = 2;\n");
  handleCursorHook(engine, event("beforeSubmitPrompt"));
  mkdirSync(join(engine.repo, "tools", "maintenance"), { recursive: true });
  writeFileSync(join(engine.repo, "tools", "maintenance", "private-controller.mjs"), "export const changed = true;\n");
  handleCursorHook(engine, event("afterFileEdit", { file_path: "tools/maintenance/private-controller.mjs" }));
  handleCursorHook(engine, event("afterShellExecution"));
  assert.deepEqual(handleCursorHook(engine, event("stop", { status: "completed" })), {});
});
test("staging metadata alone does not trigger a dirty-source review", (t) => {
  const engine = fixture(t);
  writeFileSync(join(engine.repo, "packages", "sample.mjs"), "export const value = 2;\n");
  handleCursorHook(engine, event("beforeSubmitPrompt"));
  git(engine.repo, "add", "packages/sample.mjs");
  handleCursorHook(engine, event("afterShellExecution"));
  assert.deepEqual(handleCursorHook(engine, event("stop", { status: "completed" })), {});
});
test("Windows CRLF edits produce a clean snapshot checkout and whitespace-safe diff", (t) => {
  const engine = fixture(t);
  git(engine.repo, "config", "core.autocrlf", "true");
  writeFileSync(join(engine.repo, "packages", "sample.mjs"), "export const value = 2;\r\n");
  const originalIndex = git(engine.repo, "write-tree");
  const result = createDirtySnapshot(engine);
  const worktree = join(engine.stateDir, "crlf-worktree");
  git(engine.repo, "worktree", "add", "--detach", worktree, result.commit);
  assert.equal(git(worktree, "status", "--porcelain"), "");
  assert.doesNotThrow(() => git(engine.repo, "diff", "--check", `${result.commit}^`, result.commit));
  assert.equal(git(engine.repo, "show", `${result.commit}:packages/sample.mjs`), "export const value = 2;\n");
  assert.equal(readFileSync(join(engine.repo, "packages", "sample.mjs"), "utf8"), "export const value = 2;\r\n");
  assert.equal(git(engine.repo, "write-tree"), originalIndex);
});
test("dirty snapshots reject external clean filters before invoking them", (t) => {
  const engine = fixture(t);
  writeFileSync(join(engine.repo, ".gitattributes"), "packages/sample.mjs filter=unsafe\n");
  git(engine.repo, "config", "filter.unsafe.clean", "unavailable-clean-command");
  git(engine.repo, "config", "filter.unsafe.required", "true");
  writeFileSync(join(engine.repo, "packages", "sample.mjs"), "export const value = 2;\n");
  assert.throws(() => createDirtySnapshot(engine), /HOOK_SNAPSHOT_CUSTOM_FILTER/);
});
