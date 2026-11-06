import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// The documented installer shell is pwsh. Windows PowerShell 5.1 turns CLI stderr into a terminating error under
// the runner's Stop preference, so these tests skip rather than substitute it.
const shell =
  process.platform === "win32"
    ? spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id $PID).Path"], {
        encoding: "utf8",
        timeout: 30000,
      })
    : undefined;
const skip = shell === undefined || shell.error !== undefined ? "requires pwsh on Windows" : false;

// Exercise the real runner with a disposable CLI; never start a maintenance job or scheduled task.
function watcherFixture(t, { runtime = true } = {}) {
  assert.ifError(shell.error);
  assert.equal(shell.status, 0, shell.stderr);
  const repo = mkdtempSync(join(tmpdir(), "watcher test "));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const scripts = join(repo, "tools", "maintenance");
  const stateDirectory = join(repo, ".git", "maintenance");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  const runner = join(scripts, "run-watcher.ps1");
  copyFileSync(new URL("./run-watcher.ps1", import.meta.url), runner);
  const nodeLauncher = join(repo, "node launcher.ps1");
  writeFileSync(nodeLauncher, "& $env:WATCHER_TEST_NODE @args\nexit $LASTEXITCODE\n");
  writeFileSync(
    join(scripts, "cli.mjs"),
    `const args = process.argv.slice(2);
console.log(JSON.stringify({ args, cwd: process.cwd(), path: process.env.PATH }));
console.error('stderr:' + args[0]);
process.exit(Number(process.env.WATCHER_TEST_WATCH_EXIT));
`,
  );
  const directories = [join(repo, "provider tools"), join(repo, "git tools")];
  if (runtime) {
    writeFileSync(join(stateDirectory, "watcher-runtime.json"), JSON.stringify({ node: nodeLauncher, directories }));
  }
  const logPath = join(stateDirectory, "watcher-last-run.log");
  writeFileSync(logPath, "previous run\n");
  const inheritedPath = join(repo, "inherited tools");
  return {
    repo,
    directories,
    inheritedPath,
    log: () => readFileSync(logPath, "utf8"),
    run: ({ watchExit = 0, bootstrapGit = true, gitExit = 0 } = {}) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
      return spawnSync(
        shell.stdout.trim(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `${bootstrapGit ? "function git { $global:LASTEXITCODE = [int]$env:WATCHER_TEST_GIT_EXIT; '.git' }" : ""}
$env:Path = $env:WATCHER_TEST_PATH
& $env:WATCHER_TEST_RUNNER
exit $LASTEXITCODE`,
        ],
        {
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...env,
            PATH: inheritedPath,
            WATCHER_TEST_NODE: process.execPath,
            WATCHER_TEST_RUNNER: runner,
            WATCHER_TEST_PATH: inheritedPath,
            WATCHER_TEST_GIT_EXIT: String(gitExit),
            WATCHER_TEST_WATCH_EXIT: String(watchExit),
          },
        },
      );
    },
  };
}

test("Windows watcher restores saved paths with spaces and replaces the log", { skip }, (t) => {
  const watcher = watcherFixture(t);
  const result = watcher.run();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const log = watcher.log();
  const calls = log
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const expectedPath = [...watcher.directories, watcher.inheritedPath].join(delimiter);
  assert.deepEqual(calls, [{ args: ["watch", "--once"], cwd: watcher.repo, path: expectedPath }]);
  assert.match(log, /stderr:watch/);
  assert.doesNotMatch(log, /previous run/);
});

test("Windows watcher returns the watch exit code", { skip }, (t) => {
  const watcher = watcherFixture(t);
  const result = watcher.run({ watchExit: 23 });
  assert.ifError(result.error);
  assert.equal(result.status, 23, result.stderr);
  assert.match(watcher.log(), /stderr:watch/);
});

test("Windows watcher fails before invoking the CLI when runtime metadata is missing", { skip }, (t) => {
  const watcher = watcherFixture(t, { runtime: false });
  const result = watcher.run();
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /watcher-runtime\.json/);
  assert.equal(watcher.log(), "previous run\n");
});

test("Windows watcher still requires Git before restoring the saved PATH", { skip }, (t) => {
  const watcher = watcherFixture(t);
  const result = watcher.run({ bootstrapGit: false });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git.*not recognized/s);
  assert.equal(watcher.log(), "previous run\n");
});

test("Windows watcher rejects a failed Git lookup before invoking the CLI", { skip }, (t) => {
  const watcher = watcherFixture(t);
  const result = watcher.run({ gitExit: 38 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot resolve Git common directory/);
  assert.equal(watcher.log(), "previous run\n");
});
