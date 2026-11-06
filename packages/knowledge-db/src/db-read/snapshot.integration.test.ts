import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TenantPostgres, type TenantSqlClient, type TransactionScope } from "@aiengineer/knowledge-persistence";
import { LocalArtifactStore } from "@aiengineer/knowledge-core";
import { loadWorkspace } from "../schema-workspace/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposableDatabaseUrl } from "../../../persistence/test/disposable.mjs";
import { ArtifactLedger } from "./artifacts.js";
import { ReadExecutor } from "./read-executor.js";
import type { ReadIntentInput } from "./read-intent.js";
import { validatePersistedSnapshot } from "./snapshot.js";

const url = disposableDatabaseUrl();

class InterleavedPostgres extends TenantPostgres {
  afterFirstHead: (() => Promise<void>) | undefined;
  override transaction<T>(scope: TransactionScope, work: (client: TenantSqlClient) => Promise<T>): Promise<T> {
    return super.transaction(scope, (client) =>
      work({
        query: async (sql, params) => {
          const result = await client.query(sql, params);
          if (
            scope.isolationLevel === "repeatable read" &&
            sql === "select knowledge_seq, updated_at from api.knowledge_head()" &&
            this.afterFirstHead
          ) {
            const interleave = this.afterFirstHead;
            this.afterFirstHead = undefined;
            await interleave();
          }
          return result;
        },
      } as TenantSqlClient),
    );
  }
}

describe.skipIf(!url)("P1.2 persisted repeatable snapshots on isolated Postgres", () => {
  let db!: InterleavedPostgres;
  let writer!: TenantPostgres;
  let workspace!: ReturnType<typeof loadWorkspace>;
  const tenantId = randomUUID();
  const entityId = randomUUID();
  let directory: string | undefined;
  let store!: LocalArtifactStore;
  let artifacts!: ArtifactLedger;
  let reads!: ReadExecutor;
  beforeAll(async () => {
    workspace = loadWorkspace(
      resolve(import.meta.dirname, "../../../../../../aiengineer/ai-engineer-db-contract/workspace"),
    );
    db = new InterleavedPostgres({ connectionString: url ?? "postgresql://unused" });
    writer = new TenantPostgres({ connectionString: url ?? "postgresql://unused" });
    directory = mkdtempSync(join(tmpdir(), "ks-p1-snapshots-"));
    store = new LocalArtifactStore(directory);
    artifacts = new ArtifactLedger({
      db,
      store,
      bucket: "research-ingestion-intents",
      uploaded: false,
      executorVersion: "synthetic-p1-snapshot/1",
    });
    reads = new ReadExecutor({ db, workspace, artifacts, executorVersion: "synthetic-p1-snapshot/1" });
    await version("operating", true);
  });
  afterAll(async () => {
    try {
      await db?.close();
    } finally {
      try {
        await writer?.close();
      } finally {
        if (directory) rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  async function version(status: string, create = false): Promise<void> {
    await writer.transaction({ tenantId }, async (client) => {
      const intentId = randomUUID();
      const receiptId = randomUUID();
      await client.query(
        "insert into orchestration.operation_intent(id,tenant_id,intent_type,schema_version,payload,preconditions,idempotency_key,approval_state,policy_decision) values($1::uuid,$2::uuid,'knowledge_ingestion',1,'{}','{}',$1::text,'approved','{\"synthetic\":true}')",
        [intentId, tenantId],
      );
      await client.query(
        "insert into orchestration.operation_receipt(id,intent_id,executor_version,outcome,changes_summary) values($1,$2,'synthetic-p1-snapshot/1','applied','{}')",
        [receiptId, intentId],
      );
      if (create) {
        await client.query(
          "insert into corpus.entity(id,tenant_id,kind,slug,display_name,created_by_receipt_id) values($1::uuid,$2::uuid,'organization',$1::text,'Synthetic snapshot organization',$3)",
          [entityId, tenantId, receiptId],
        );
        await client.query("insert into corpus.organization(id) values($1)", [entityId]);
      }
      await client.query("select temporal.begin_batch((select knowledge_seq from api.knowledge_head()))");
      await client.query(
        "select temporal.assert_state($1,'organization_status','[2026-01-01,)'::tstzrange,'',$2,null,null,null,null,'{}',null,null,'observation_bounded')",
        [entityId, status],
      );
      await client.query("select temporal.commit_batch($1,$2,repeat('0',64),'{}')", [receiptId, intentId]);
    });
  }
  const intent = (overrides: Partial<ReadIntentInput> = {}): ReadIntentInput => ({
    schemaVersion: "knowledge-read-intent.v1",
    intentId: `snapshot-${randomUUID()}`,
    context: { tenantId },
    operations: [
      { opId: "facts", query: "entity.at", params: { entity_id: entityId, at: "2026-02-01T00:00:00Z" } },
      { opId: "head", query: "knowledge.head" },
    ],
    ...overrides,
  });

  it("T01/T02 pins one database snapshot while a second connection commits, then replays historical K", async () => {
    db.afterFirstHead = () => version("acquired");
    const snapshot = await reads.runIntent(intent(), { persist: true });
    expect(snapshot.knowledgeHead.knowledgeSeq).toBe(1);
    expect(snapshot.knowledgeHeadAfter.knowledgeSeq).toBe(1);
    expect(snapshot.headChanged).toBe(false);
    expect(snapshot.operations[0]!.params!.k).toBe(1);
    expect(snapshot.operations[0]!.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "operating" })]),
    );
    expect((await reads.head(tenantId)).knowledgeSeq).toBe(2);
    const historical = await reads.runIntent(
      intent({
        atKnowledgeSeq: 1,
        operations: [
          { opId: "facts", query: "entity.at", params: { entity_id: entityId, at: "2026-02-01T00:00:00Z" } },
        ],
      }),
    );
    const current = await reads.runIntent(intent());
    expect(historical.operations[0]!.rows?.[0]?.status).toBe("operating");
    expect(current.operations[0]!.rows?.[0]?.status).toBe("acquired");
    const stored = await artifacts.get(tenantId, snapshot.storage!.artifactId);
    const original = await artifacts.get(tenantId, snapshot.intentRef.artifactId!);
    expect(
      validatePersistedSnapshot(stored.json, original.json, {
        tenantId,
        snapshotDigest: snapshot.snapshotDigest,
        knowledgeSeq: 1,
        migrationHead: workspace.migrationHead,
      }).snapshotId,
    ).toBe(snapshot.snapshotId);
    await expect(artifacts.get(randomUUID(), snapshot.storage!.artifactId)).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
    const corrupt = new ArtifactLedger({
      db,
      store: { put: (input) => store.put(input), get: async () => Buffer.from("corrupted") },
      bucket: "research-ingestion-intents",
      uploaded: false,
      executorVersion: "synthetic-corrupt-store/1",
    });
    await expect(corrupt.get(tenantId, snapshot.storage!.artifactId)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_FAILED",
    });
    process.stdout.write(
      `${JSON.stringify({ proof: "synthetic-p1-snapshot/1", tenantId, entityId, directory, snapshotArtifactId: snapshot.storage!.artifactId, k0: 1, k1: 2 })}\n`,
    );
  });

  it("rejects contradictory query clocks and unsupported historical current-state queries", async () => {
    await expect(
      reads.runIntent(
        intent({
          atKnowledgeSeq: 0,
          operations: [
            { opId: "bad", query: "entity.at", params: { entity_id: entityId, at: "2026-02-01T00:00:00Z", k: 1 } },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "SNAPSHOT_CLOCK_CONFLICT" });
    await expect(
      reads.runIntent(
        intent({
          atKnowledgeSeq: 0,
          operations: [{ opId: "bad", query: "entity.card", params: { entity_id: entityId } }],
        }),
      ),
    ).rejects.toMatchObject({ code: "HISTORICAL_QUERY_UNSUPPORTED" });
    await expect(
      reads.runIntent(intent({ atKnowledgeSeq: 0, operations: [{ opId: "bad", query: "knowledge.head" }] })),
    ).rejects.toMatchObject({ code: "HISTORICAL_QUERY_UNSUPPORTED" });
  });
});
