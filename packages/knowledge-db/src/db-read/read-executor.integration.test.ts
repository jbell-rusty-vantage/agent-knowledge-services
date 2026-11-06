import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TenantPostgres } from "@aiengineer/knowledge-persistence";
import { LocalArtifactStore } from "@aiengineer/knowledge-core";
import { loadWorkspace } from "../schema-workspace/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ArtifactLedger } from "./artifacts.js";
import { ReadExecutor } from "./read-executor.js";
import type { ReadIntentInput } from "./read-intent.js";
import { disposableDatabaseUrl } from "../../../persistence/test/disposable.mjs";

const url = disposableDatabaseUrl();
const TENANT = "00000000-0000-7000-8000-000000000001";
const REAL_WORKSPACE = resolve(import.meta.dirname, "../../../../../../aiengineer/ai-engineer-db-contract/workspace");
const workspaces = [["db-contract", REAL_WORKSPACE]] as [string, string][];

const MIGRATION_HEAD_PATTERN = /^\d{14}$/;

describe.skipIf(!url).each(workspaces)(
  "ReadExecutor against the disposable database (%s workspace)",
  (label, workspaceDir) => {
    // The package fixture is a frozen snapshot; only the real db-contract tree is expected to match the database head.
    const workspaceTracksDatabase = label === "db-contract";
    let db!: TenantPostgres;
    let storeDir: string | undefined;
    let workspace!: ReturnType<typeof loadWorkspace>;
    let artifacts!: ArtifactLedger;
    let executor!: ReadExecutor;
    beforeAll(() => {
      workspace = loadWorkspace(workspaceDir);
      db = new TenantPostgres({ connectionString: url ?? "postgresql://unused", maximumPoolSize: 2 });
      storeDir = mkdtempSync(join(tmpdir(), "ks-read-artifacts-"));
      artifacts = new ArtifactLedger({
        db,
        store: new LocalArtifactStore(storeDir),
        bucket: "research-ingestion-intents",
        uploaded: false,
        executorVersion: "knowledge-executor/test",
      });
      executor = new ReadExecutor({ db, workspace, artifacts, executorVersion: "knowledge-executor/test" });
    });
    afterAll(async () => {
      try {
        await db?.close();
      } finally {
        if (storeDir) rmSync(storeDir, { recursive: true, force: true });
      }
    });

    const intent = (extra: Partial<ReadIntentInput> = {}): ReadIntentInput => ({
      schemaVersion: "knowledge-read-intent.v1",
      intentId: "exp3-read-check",
      context: { tenantId: TENANT, correlationId: "vitest" },
      operations: [
        { opId: "resolve", kind: "named_query", query: "entity.resolve", params: { text: "OpenAI" } },
        { opId: "head", kind: "named_query", query: "knowledge.head" },
        { opId: "streams", kind: "named_query", query: "vocab.stream_kind", limit: 50 },
        {
          opId: "card",
          kind: "named_query",
          query: "entity.card",
          params: { entity_id: "$resolve.rows[0].entity_id" },
        },
      ],
      ...extra,
    });

    it("reports the tenant head and the migration head", async () => {
      const head = await executor.head(TENANT);
      expect(head.knowledgeSeq).toBeGreaterThanOrEqual(0);
      const databaseHead = await executor.databaseHead();
      expect(databaseHead).toMatch(MIGRATION_HEAD_PATTERN);
      if (workspaceTracksDatabase) expect(databaseHead).toBe(workspace.migrationHead);
    });

    it("runs three catalog queries under their catalog roles with stable digests", async () => {
      const first = await executor.runIntent(intent());
      const second = await executor.runIntent(intent());
      expect(first.operations.map((operation) => [operation.opId, operation.role, operation.status])).toEqual([
        ["resolve", "app_reader", expect.stringMatching(/ok|empty/)],
        ["head", "app_reader", "ok"],
        ["streams", "pipeline_agent", "ok"],
        ["card", expect.anything(), expect.stringMatching(/ok|skipped/)],
      ]);
      expect(first.operations[2]?.rowCount).toBeGreaterThan(10);
      expect(first.snapshotDigest).toBe(second.snapshotDigest);
      expect(first.headChanged).toBe(false);
      expect(first.contract.migrationHead).toBe(workspace.migrationHead);
    });

    it("rejects bad parameters, unknown queries, and role escalation statically", () => {
      expect(() =>
        executor.validateIntent(
          intent({
            operations: [{ opId: "x", kind: "named_query", query: "entity.card", params: { entity_id: "nope" } }],
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: "PARAMS_INVALID", exit: 1 }));
      expect(() =>
        executor.validateIntent(intent({ operations: [{ opId: "x", kind: "named_query", query: "entity.nope" }] })),
      ).toThrowError(expect.objectContaining({ code: "QUERY_UNKNOWN" }));
      expect(() =>
        executor.validateIntent(
          intent({
            operations: [
              {
                opId: "x",
                kind: "named_query",
                query: "entity.resolve",
                params: { text: "a" },
                role: "pipeline_agent",
              },
            ],
          }),
        ),
      ).toThrowError(expect.objectContaining({ code: "ROLE_DENIED" }));
    });

    it("persists intent and snapshot as ledger artifacts with lineage", async () => {
      const snapshot = await executor.runIntent(intent({ intentId: "exp3-read-persist" }), { persist: true });
      expect(snapshot.storage?.artifactId).toMatch(/^[0-9a-f-]{36}$/);
      expect(snapshot.intentRef.artifactId).toBeDefined();
      const stored = await artifacts.get(TENANT, snapshot.storage!.artifactId);
      expect(stored.record.artifactType).toBe("knowledge_read_snapshot");
      expect((stored.json as { snapshotDigest: string }).snapshotDigest).toBe(snapshot.snapshotDigest);
    });

    it("serves guarded read-only SQL as pipeline_agent and enforces read-only at the database", async () => {
      const result = await executor.sqlReadonly({
        tenantId: TENANT,
        sql: "select code from temporal.stream_kind order by code",
        limit: 5,
      });
      expect(result.role).toBe("pipeline_agent");
      expect(result.rows).toHaveLength(5);
      expect(result.truncated).toBe(true);
      await expect(executor.sqlReadonly({ tenantId: TENANT, sql: "delete from corpus.entity" })).rejects.toMatchObject({
        code: "SQL_NOT_SELECT",
      });
      await expect(executor.sqlReadonly({ tenantId: TENANT, sql: "select lo_create(0)" })).rejects.toMatchObject({
        code: "25006",
      });
      const explained = await executor.explain({ tenantId: TENANT, sql: "select count(*) from corpus.entity" });
      expect(Array.isArray(explained.plan)).toBe(true);
    });
  },
);
