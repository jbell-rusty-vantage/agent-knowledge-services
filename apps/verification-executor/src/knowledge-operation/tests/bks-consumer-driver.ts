/**
 * WI-05 (OVE-167) cross-repository proof driver: runs the REAL Biotech Knowledge Services dispatch consumer (BKS
 * `packages/kg-ops`, sources loaded from `WI05_BKS_ROOT`) in its own process against the disposable Biotech component
 * PostgreSQL and a disposable Neo4j. Test-only: production Knowledge Services never imports BKS (the K06 binding talks
 * to the BKS executor over HTTP); this driver only lets `native-recovery.integration.test.ts` crash the consumer in a
 * fresh process between the graph commit and the PostgreSQL acknowledgment.
 *
 *   node --import tsx bks-consumer-driver.ts <request.json>
 *
 * request: { step: "prepare" | "consume" | "marker", tenantId, installationId, effectKey?, limit?, clockOffsetMs?,
 *            crash?: "after_graph_commit", revokeDuringAck?: boolean }
 * env: WI05_BKS_ROOT, WI05_OUTBOX_DSN (outbox-worker login role), WI05_ADMIN_DSN (revoke only), NEO4J_TEST_URI,
 *      NEO4J_TEST_PASSWORD. Answers one JSON line on stdout. Never prints credentials.
 * Guards (before anything connects): NEO4J_TEST_URI and both DSNs must be loopback; WI05_BKS_ROOT must exist, be the
 * `biotech-knowledge-services` repository by package name and sit inside the BellLabs workspace.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { requireBksRoot, requireLoopback } from "./proof-guards.js";

interface Request {
  readonly step: "prepare" | "consume" | "marker";
  readonly tenantId: string;
  readonly installationId: string;
  readonly effectKey?: string;
  readonly limit?: number;
  readonly clockOffsetMs?: number;
  readonly crash?: "after_graph_commit";
  readonly revokeDuringAck?: boolean;
}

const request = JSON.parse(readFileSync(process.argv[2] as string, "utf8")) as Request;
const root = requireBksRoot(process.env.WI05_BKS_ROOT);
const neo4jUri = requireLoopback("NEO4J_TEST_URI", process.env.NEO4J_TEST_URI);
if (request.step === "consume") {
  requireLoopback("WI05_OUTBOX_DSN", process.env.WI05_OUTBOX_DSN);
  if (request.revokeDuringAck) requireLoopback("WI05_ADMIN_DSN", process.env.WI05_ADMIN_DSN);
}
const load = (path: string) => import(pathToFileURL(join(root, "packages/kg-ops/src", path)).href);

const [{ GraphClient, toJson }, fence, write, custody, dispatch, verification, apply] = await Promise.all([
  load("neo4j.ts"),
  load("fence.ts"),
  load("write/service.ts"),
  load("custody.ts"),
  load("admission/dispatch.ts"),
  load("admission/verification.ts"),
  load("apply.ts"),
]);

const client = new GraphClient({
  uri: neo4jUri,
  username: "neo4j",
  password: process.env.NEO4J_TEST_PASSWORD as string,
  database: "neo4j",
});
const schema = write.writeSchema();
const scope = { installationId: request.installationId, applicationId: "biotech", tenantId: request.tenantId };
const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

try {
  if (request.step === "prepare") {
    await client.verify();
    await client.write((tx: { run(q: string): Promise<unknown> }) => tx.run("MATCH (n) DETACH DELETE n"));
    await fence.ensureOperationalState(client, schema);
    await fence.installReleaseMarker(
      client,
      { releaseId: schema.releaseId, schemaReleaseDigest: schema.schemaReleaseDigest },
      `wi05-${Date.now().toString(36)}`,
    );
    out({ prepared: true, schemaReleaseDigest: schema.schemaReleaseDigest });
  } else if (request.step === "marker") {
    // Separate native readback: the graph's own marker and projection for the effect, read without the consumer.
    const receipt = await apply.getReceiptV2(client, scope, request.effectKey as string);
    const counts = await client.read(
      async (tx: { run(q: string, p: unknown): Promise<{ records: { get(k: string): unknown }[] }> }) => {
        const markers = await tx.run("MATCH (m:KsIntentMarker {effectKey: $k}) RETURN count(m) AS n", {
          k: request.effectKey,
        });
        const activities = await tx.run("MATCH (a:Activity {effectKey: $k}) RETURN count(a) AS n", {
          k: request.effectKey,
        });
        const reports = await tx.run(
          "MATCH (r:Report)-[:WAS_GENERATED_BY]->(a:Activity {effectKey: $k}) RETURN count(r) AS n",
          { k: request.effectKey },
        );
        return {
          markers: Number(toJson(markers.records[0]?.get("n"))),
          activities: Number(toJson(activities.records[0]?.get("n"))),
          reports: Number(toJson(reports.records[0]?.get("n"))),
        };
      },
    );
    out({
      found: receipt.found,
      status: receipt.found ? receipt.status : null,
      markerDigest: receipt.found ? (receipt.receipt?.admission?.markerDigest ?? null) : null,
      dispatchId: receipt.found ? (receipt.receipt?.admission?.dispatchId ?? null) : null,
      ...counts,
    });
  } else {
    const authority = new verification.PgVerificationAuthority({
      connectionString: process.env.WI05_OUTBOX_DSN as string,
      timeoutMs: 5_000,
    });
    const files = mkdtempSync(join(tmpdir(), "wi05-bks-"));
    const now = () => new Date(Date.now() + (request.clockOffsetMs ?? 0));
    const writer = new write.KnowledgeWriter(client, {
      schema,
      plans: new custody.MemoryPlanStore(),
      snapshots: new custody.FileSnapshotCustody(join(files, "snapshots")),
      verifications: new custody.FileVerificationCustody(join(files, "verifications"), new Map()),
      witnessKeys: new Map(),
      signer: null,
      authority: null,
      localDev: false,
      now,
    });
    const afterCommit = async () => {
      if (request.revokeDuringAck) {
        // Revocation during the acknowledgment: the graph committed; the dispatch is revoked before the ack lands.
        const admin = new pg.Client({ connectionString: process.env.WI05_ADMIN_DSN });
        await admin.connect();
        await admin.query("begin");
        await admin.query("select set_config('app.tenant_id', $1, true)", [request.tenantId]);
        await admin.query("select knowledge_verification.revoke_pending_dispatches($1, $2)", [
          request.tenantId,
          request.effectKey,
        ]);
        await admin.query("commit");
        await admin.end();
      }
      if (request.crash === "after_graph_commit") {
        // A real crash: the Neo4j transaction (effect + KsIntentMarker) committed, the PostgreSQL ack never ran.
        process.stderr.write("WI05_CRASH after_graph_commit\n");
        process.kill(process.pid, "SIGKILL");
      }
    };
    const consumer = new dispatch.DispatchConsumer({
      authority,
      writer,
      now,
      hooks: { applyFaults: { afterCommit } },
    });
    const report = await consumer.consumeOnce(request.tenantId, request.limit ?? 10, now());
    out({
      results: report.results.map((r: Record<string, unknown>) => ({
        dispatchId: r.dispatchId,
        outcome: r.outcome,
        acknowledged: r.acknowledged,
        markerDigest: r.markerDigest ?? null,
        reason: r.reason ?? null,
      })),
    });
    await authority.close();
  }
} finally {
  await client.close();
}
