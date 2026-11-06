import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { buildMaintenanceContext } from "./context.mjs";

function fixture(t, content = "after\n") {
  const repo = mkdtempSync(join(tmpdir(), "maintenance-context-"));
  t.after(() => {
    assert.equal(dirname(resolve(repo)), resolve(tmpdir()));
    assert.ok(basename(repo).startsWith("maintenance-context-"));
    rmSync(repo, { recursive: true, force: true });
  });
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Context Fixture");
  writeFileSync(join(repo, "README.md"), "before\n");
  git("add", "README.md");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "README.md"), content);
  mkdirSync(join(repo, "artifacts"));
  writeFileSync(join(repo, "artifacts/receipt.txt"), "DO_NOT_INCLUDE_CAPTURE");
  writeFileSync(join(repo, ".env"), "DO_NOT_INCLUDE_SECRET");
  git("add", "README.md", "artifacts/receipt.txt", ".env");
  git("commit", "-m", "head");
  return { repo, base, head: git("rev-parse", "HEAD"), paths: ["README.md", "artifacts/receipt.txt", ".env"] };
}
const offline = (command, args, options) =>
  command === "git"
    ? spawnSync(command, args, options)
    : { status: 1, stdout: "", stderr: "sensitive error never included" };

test("snapshot diff is limited to explicit source paths and excludes receipts and env", (t) => {
  const input = fixture(t);
  const packet = buildMaintenanceContext(input, { run: offline });
  assert.equal(packet.checks.gitDiffCheck.status, "passed");
  assert.deepEqual(packet.paths, ["README.md"]);
  assert.match(packet.diff.text, /after/);
  assert.doesNotMatch(JSON.stringify(packet), /DO_NOT_INCLUDE|sensitive error/);
  assert.equal(packet.knowledge.status, "unavailable");
  assert.equal(packet.github.status, "unavailable");
});
test("whitespace violations fail the deterministic check", (t) => {
  const packet = buildMaintenanceContext(fixture(t, "after   \n"), { run: offline });
  assert.equal(packet.checks.gitDiffCheck.status, "failed");
});
test("oversized diffs are omitted explicitly rather than accepted as complete", (t) => {
  const packet = buildMaintenanceContext(fixture(t, `${"line ".repeat(20000)}\n`), { run: offline });
  assert.equal(packet.diff.status, "omitted_too_large");
  assert.equal(packet.diff.text, "");
});
test("no safe paths never falls back to an unrestricted repository diff", (t) => {
  const input = fixture(t);
  const calls = [];
  const packet = buildMaintenanceContext(
    { ...input, paths: [".env", "artifacts/receipt.txt", "../secret"] },
    {
      run(command, args, options) {
        calls.push(command);
        return offline(command, args, options);
      },
    },
  );
  assert.equal(packet.checks.gitDiffCheck.status, "not_executed");
  assert.ok(!calls.includes("git"));
});
test("context and GitHub metadata use separate source revision and bounded shell-free processes", (t) => {
  const input = fixture(t);
  let contextQuery;
  const run = (command, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 5000);
    if (command === "git") return spawnSync(command, args, options);
    if (command === "gh")
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            number: 4,
            state: "OPEN",
            headRefOid: input.base,
            baseRefName: "main",
            url: "https://example.invalid/pr/4",
            isDraft: true,
            mergeStateStatus: "UNKNOWN",
          },
        ]),
      };
    contextQuery = args[args.indexOf("--query") + 1];
    return { status: 0, stdout: JSON.stringify({ exitCode: 0, results: [{ id: "boundaries", modules: [] }] }) };
  };
  const packet = buildMaintenanceContext({ ...input, sourceHead: input.base }, { run });
  assert.ok(contextQuery.length <= 200);
  assert.equal(packet.github.pulls[0].head, input.base);
  assert.equal(packet.knowledge.status, "available");
});
test("mutable revision names and excessive paths fail before subprocess execution", () => {
  assert.throws(() => buildMaintenanceContext({ repo: ".", base: "HEAD", head: "main", paths: [] }), /IMMUTABLE/);
  assert.throws(
    () =>
      buildMaintenanceContext({
        repo: ".",
        base: "a".repeat(40),
        head: "b".repeat(40),
        paths: Array(101).fill("README.md"),
      }),
    /PATH_LIMIT/,
  );
});

test("missing base resolves immutable first parent before collecting diff", (t) => {
  const input = fixture(t);
  const packet = buildMaintenanceContext({ ...input, base: undefined }, { run: offline });
  assert.equal(packet.snapshot.base, input.base);
  assert.equal(packet.checks.gitDiffCheck.status, "passed");
});

test("root commit uses the Git empty tree without inventing a passing check", (t) => {
  const input = fixture(t);
  const packet = buildMaintenanceContext({ ...input, base: undefined, head: input.base }, { run: offline });
  assert.notEqual(packet.snapshot.base, input.base);
  assert.equal(packet.checks.gitDiffCheck.status, "passed");
  assert.match(packet.diff.text, /before/);
});
