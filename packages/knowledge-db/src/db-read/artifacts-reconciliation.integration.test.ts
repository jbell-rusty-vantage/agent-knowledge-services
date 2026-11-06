import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TenantPostgres, type TenantSqlClient, type TransactionScope } from "@aiengineer/knowledge-persistence";
import { SupabaseArtifactStore } from "@aiengineer/knowledge-core";
import { ArtifactLedger } from "./artifacts.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { disposableDatabaseUrl, disposableStorageConfig } from "../../../persistence/test/disposable.mjs";

const databaseUrl = disposableDatabaseUrl();
const storageConfig = disposableStorageConfig();
const bucket = "research-ingestion-intents";
const tenantId = randomUUID();
const version = "synthetic-receipt-custody-proof/v1";

class RollbackOncePostgres extends TenantPostgres {
  failWrite = false;
  override async transaction<T>(scope: TransactionScope, work: (client: TenantSqlClient) => Promise<T>): Promise<T> {
    if (!this.failWrite || scope.readOnly) return super.transaction(scope, work);
    this.failWrite = false;
    return super.transaction(scope, async (client) => {
      await work(client);
      throw new Error("SYNTHETIC_DATABASE_ROLLBACK_AFTER_UPLOAD");
    });
  }
}

describe.skipIf(!databaseUrl || !storageConfig)(
  "ArtifactLedger real Postgres and Supabase custody reconciliation",
  () => {
    const db = new RollbackOncePostgres({ connectionString: databaseUrl ?? "postgresql://unused" });
    const config = {
      projectUrl: storageConfig?.projectUrl ?? "http://127.0.0.1",
      serviceRoleKey: storageConfig?.secretKey ?? "unused",
      bucket,
      maximumBytes: 1024 * 1024,
    };
    const store = new SupabaseArtifactStore(config);
    const ledger = new ArtifactLedger({ db, store, bucket, uploaded: true, executorVersion: version });
    afterAll(async () => {
      await db.close();
    });

    const state = (artifactId: string) =>
      db.transaction(
        { tenantId, role: "executor_service", readOnly: true },
        async (client) =>
          (
            await client.query<{ storage_state: string }>(
              "select storage_state from orchestration.artifact where tenant_id=$1 and id=$2",
              [tenantId, artifactId],
            )
          ).rows[0]?.storage_state,
      );

    async function pending(value: unknown, upload: boolean) {
      const artifactId = randomUUID(),
        bytes = new TextEncoder().encode(canonicalJson(value)),
        digest = `sha256:${sha256Hex(bytes)}` as const;
      if (upload) await store.put({ tenantId, mediaType: "application/json", bytes });
      await db.transaction({ tenantId, role: "executor_service" }, (client) =>
        client.query(
          `insert into orchestration.artifact
      (id,tenant_id,artifact_type,sha256,bucket_class,storage_bucket,object_path,media_type,size_bytes,storage_state,available_at)
      values($1,$2,'knowledge_ingestion_receipt',$3,'ledger',$4,$5,'application/json',$6,'pending',null)`,
          [
            artifactId,
            tenantId,
            digest.slice(7),
            bucket,
            `${tenantId}/${digest.slice(7, 9)}/${digest.slice(7)}`,
            bytes.byteLength,
          ],
        ),
      );
      return { artifactId, digest, bytes };
    }

    it("fresh consumers reconcile uploaded bytes with original pending metadata", async () => {
      const value = { test: "pending", nonce: randomUUID() };
      const original = await pending(value, true);
      expect(await state(original.artifactId)).toBe("pending");
      const fresh = new ArtifactLedger({
        db,
        store: new SupabaseArtifactStore(config),
        bucket,
        uploaded: true,
        executorVersion: version,
      });
      expect(await fresh.reconcile({ tenantId, artifactId: original.artifactId })).toMatchObject({
        artifactId: original.artifactId,
        digest: original.digest,
        storageState: "available",
      });
      expect((await fresh.get(tenantId, original.artifactId)).json).toEqual(value);
      expect(await state(original.artifactId)).toBe("available");
    });

    it("recovers a lost successful HTTP upload acknowledgement by actual remote readback", async () => {
      let uploaded = false;
      const lossy = new SupabaseArtifactStore(config, async (url, init) => {
        const response = await fetch(url, init);
        if (init?.method === "POST" && response.ok && !uploaded) {
          uploaded = true;
          throw new Error("SYNTHETIC_UPLOAD_ACK_LOSS");
        }
        return response;
      });
      const target = new ArtifactLedger({ db, store: lossy, bucket, uploaded: true, executorVersion: version });
      const artifactId = randomUUID(),
        value = { test: "ack-loss", nonce: randomUUID() };
      expect(
        await target.put({ tenantId, artifactId, artifactType: "knowledge_ingestion_receipt", value }),
      ).toMatchObject({ artifactId, storageState: "available" });
      expect(uploaded).toBe(true);
      expect((await ledger.get(tenantId, artifactId)).json).toEqual(value);
    });

    it("reuses uploaded bytes after database rollback under the original preassigned id", async () => {
      const artifactId = randomUUID(),
        value = { test: "database-rollback", nonce: randomUUID() };
      const input = { tenantId, artifactId, artifactType: "knowledge_ingestion_receipt" as const, value };
      db.failWrite = true;
      await expect(ledger.put(input)).rejects.toThrow("SYNTHETIC_DATABASE_ROLLBACK_AFTER_UPLOAD");
      expect(await state(artifactId)).toBeUndefined();
      const bytes = new TextEncoder().encode(canonicalJson(value)),
        digest = `sha256:${sha256Hex(bytes)}` as const;
      expect(await store.get(tenantId, digest)).toEqual(bytes);
      expect(await ledger.put(input)).toMatchObject({ artifactId, storageState: "available" });
      expect((await ledger.get(tenantId, artifactId)).json).toEqual(value);
    });

    it("refuses to promote a registered object whose bytes never reached storage", async () => {
      const original = await pending({ test: "missing", nonce: randomUUID() }, false);
      expect(await store.get(tenantId, original.digest)).toBeUndefined();
      await expect(ledger.reconcile({ tenantId, artifactId: original.artifactId })).rejects.toMatchObject({
        code: "STORAGE_PENDING",
      });
      expect(await state(original.artifactId)).toBe("pending");
    });

    it("cannot read or reconcile another tenant's registration", async () => {
      const original = await pending({ test: "tenant", nonce: randomUUID() }, true);
      await expect(ledger.reconcile({ tenantId: randomUUID(), artifactId: original.artifactId })).rejects.toMatchObject(
        { code: "ARTIFACT_NOT_FOUND" },
      );
      expect(await state(original.artifactId)).toBe("pending");
    });
  },
);
