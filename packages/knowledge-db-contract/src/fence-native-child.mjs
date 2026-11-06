// WI-05 test helper (child process): a "native" transaction on the component that binds an effect and stamps its
// commit, pausing at a chosen point until a release file appears. Run by effect-journal.integration.test.ts only.
//   node fence-native-child.mjs <request.json>
// request: { tenant, effectKey, dispatchId, boundDigest, semanticDigest, originDigest, pause: "before_stamp" |
//            "before_commit", releaseFile }; env WI05_FENCE_DSN (loopback disposable database). Prints READY when
// paused, then COMMITTED or REFUSED <code>.
import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
const dsn = process.env.WI05_FENCE_DSN;
const host = new URL(dsn.replace(/^postgres(ql)?:/, "http:")).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error("WI05_GUARD: loopback database only");

const waitRelease = async () => {
  process.stdout.write("READY\n");
  while (!existsSync(request.releaseFile)) await new Promise((done) => setTimeout(done, 50));
};
const client = new pg.Client({ connectionString: dsn });
await client.connect();
try {
  await client.query("begin");
  await client.query("select set_config('app.tenant_id', $1, true)", [request.tenant]);
  await client.query("set local role knowledge_verification_writer");
  await client.query("select effect_key from knowledge_verification.bind_effect($1, $2, $3, $4, $5)", [
    request.tenant,
    request.effectKey,
    request.semanticDigest,
    request.originDigest,
    request.boundDigest,
  ]);
  if (request.pause === "before_stamp") await waitRelease();
  await client.query("select effect_key from knowledge_verification.record_effect_commit($1, $2, $3, $4::jsonb)", [
    request.tenant,
    request.effectKey,
    request.dispatchId,
    JSON.stringify({ receiptId: "r-fence" }),
  ]);
  if (request.pause === "before_commit") await waitRelease();
  await client.query("commit");
  process.stdout.write("COMMITTED\n");
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  process.stdout.write(`REFUSED ${String(error.message).split(":")[0]}\n`);
} finally {
  await client.end();
}
