import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Usage: node offline.mjs /absolute/path/to/knowledge-verify/dist/index.js
// The caller supplies a built CLI, never a server URL. All state is disposable.
// SV-17: the CLI captures, locates and registers artifacts; the verification chain is retired (ks.knowledge_operation.v2).
const cli = process.argv[2];
assert.ok(cli, "Supply the path to the built knowledge-verify CLI JavaScript file.");
const directory = await mkdtemp(join(tmpdir(), "verification-example-"));
const run = "offline-example";
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(VERIFY_|KNOWLEDGE_|POSTGRES_|SUPABASE_|AI_GATEWAY_|FIRECRAWL_)/i.test(key)),
  ),
  VERIFY_STORE_DIR: join(directory, "store"),
};

function invoke(args) {
  return spawnSync(process.execPath, [resolve(cli), ...args], { env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
}

function command(args, expectedExit = 0) {
  const result = invoke(args);
  assert.ifError(result.error);
  assert.equal(result.status, expectedExit, `${args[0]}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

try {
  const source = join(directory, "source.txt");
  await writeFile(source, "Panel A has 42 samples.\nPanel B has 42 samples.\nCurrency: USD 12.00\n");
  const captured = command(["capture-file", source, "--capture-id", "panel", "--run", run]);
  assert.equal(captured.captureId, "panel");
  const ambiguous = command(["locate", "panel", "42 samples", "--run", run], 1);
  assert.equal(ambiguous.status, "ambiguous");
  const quote = "Panel A has 42 samples.";
  const located = command(["locate", "panel", quote, "--run", run]);
  assert.equal(located.status, "resolved");

  const note = join(directory, "note.md");
  await writeFile(note, "# Working note\n");
  const registered = command(["register", note, "--label", "note", "--run", run]);
  const artifact = command(["artifact", registered.artifactId, "--as", "text"]);
  assert.equal(artifact.content, "# Working note\n");

  for (const retired of ["verify-claims", "policy", "seal", "status"]) {
    const result = invoke([retired, "--run", run]);
    assert.equal(result.status, 2, retired);
    assert.match(result.stderr, /retired \(SV-17\)/);
  }

  const unsupported = join(directory, "image.png");
  await writeFile(unsupported, new Uint8Array([137, 80, 78, 71]));
  const rejected = invoke(["capture-file", unsupported, "--run", run]);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /UNSUPPORTED/);

  console.log(
    JSON.stringify(
      {
        example: "capture → locate → register → artifact (verification chain retired)",
        located: located.status,
        ambiguousQuote: "extended and resolved",
        registered: registered.digest,
        rawImage: "unsupported",
        providersCalled: 0,
      },
      null,
      2,
    ),
  );
} finally {
  // Remove only the directory this invocation created, never an operator store.
  await rm(directory, { recursive: true, force: true });
}
