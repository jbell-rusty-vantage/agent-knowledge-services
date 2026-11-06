import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueue, git, openEngine, runJob, cursorApiKey, CURSOR_MODEL } from "./engine.mjs";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--run-provider")) throw new Error("Paid provider smoke requires --run-provider");
const previousKey = process.env.CURSOR_API_KEY;
process.env.CURSOR_API_KEY = cursorApiKey(fileURLToPath(new URL("../../", import.meta.url)));
const repo = mkdtempSync(join(tmpdir(), "ks-maintenance-provider-smoke-"));
git(repo, "init", "-b", "main");
git(repo, "config", "user.name", "Maintenance Smoke");
git(repo, "config", "user.email", "maintenance@example.invalid");
mkdirSync(join(repo, "packages"));
writeFileSync(join(repo, "README.md"), "# Smoke calculator\n\n`sum` adds two finite numbers.\n");
writeFileSync(
  join(repo, "AGENTS.md"),
  "This is a disposable maintenance smoke fixture. Review the small calculator and its tests. Keep code behavior. There are no external dependencies or production services. Write the requested maintenance-review.json.\n",
);
writeFileSync(
  join(repo, "packages", "sum.mjs"),
  'export function sum(left, right) { if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error("Finite inputs required"); return left + right; }\n',
);
writeFileSync(
  join(repo, "packages", "sum.test.mjs"),
  'import {test} from "node:test"; import assert from "node:assert/strict"; import {sum} from "./sum.mjs"; test("adds finite inputs", () => assert.equal(sum(2,3),5)); test("rejects a nonfinite input", () => assert.throws(() => sum(Infinity,1), /Finite/));\n',
);
git(repo, "add", ".");
git(repo, "commit", "-m", "Add calculator smoke fixture");
const engine = openEngine(repo, {
  observe: false,
  provider: "cursor",
  model: CURSOR_MODEL,
  timeoutMs: 900000,
  leaseMs: 960000,
  maxAttempts: 1,
  validation: [["node", "--test", "packages/sum.test.mjs"]],
});
try {
  enqueue(engine);
  const receipt = runJob(engine);
  process.stdout.write(`${JSON.stringify({ repo, ...receipt }, null, 2)}\n`);
  if (receipt.status !== "proposed") process.exitCode = 1;
} finally {
  engine.db.close();
  if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = previousKey;
}
