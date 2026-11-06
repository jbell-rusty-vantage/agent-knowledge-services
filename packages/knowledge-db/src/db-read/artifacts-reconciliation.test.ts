import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore, type ArtifactStore } from "@aiengineer/knowledge-core";
import { ArtifactLedger } from "./artifacts.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
type Row = Record<string, unknown>;

function fixture(store: ArtifactStore = new InMemoryArtifactStore(), uploaded = true) {
  const rows = new Map<string, Row>();
  const faults = { insert: false };
  const query = async (sql: string, values: readonly unknown[]) => {
    if (sql.startsWith("insert into orchestration.artifact")) {
      if (faults.insert) {
        faults.insert = false;
        throw new Error("DB_WRITE_FAILED");
      }
      const [
        id,
        tenant_id,
        artifact_type,
        sha256,
        _bucketClass,
        storage_bucket,
        object_path,
        media_type,
        size_bytes,
        _missionId,
        storage_state,
      ] = values;
      if (![...rows.values()].some((row) => row.storage_bucket === storage_bucket && row.object_path === object_path))
        rows.set(String(id), {
          id,
          tenant_id,
          artifact_type,
          sha256,
          storage_bucket,
          object_path,
          media_type,
          size_bytes,
          storage_state,
        });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("select orchestration.reconcile_legacy_artifact_custody")) {
      rows.get(String(values[0]))!.storage_state = "available";
      return { rows: [], rowCount: 1 };
    }
    const row = sql.includes("storage_bucket=$2")
      ? [...rows.values()].find(
          (row) => row.tenant_id === values[0] && row.storage_bucket === values[1] && row.object_path === values[2],
        )
      : rows.get(String(values[1]));
    return { rows: row?.tenant_id === values[0] ? [row] : [], rowCount: row ? 1 : 0 };
  };
  const db = {
    transaction: async (_scope: unknown, work: (client: { query: typeof query }) => Promise<unknown>) =>
      work({ query }),
  };
  const ledger = new ArtifactLedger({
    db: db as never,
    store,
    bucket: "research-ingestion-intents",
    uploaded,
    executorVersion: "test",
  });
  return { ledger, rows, faults };
}

const input = {
  tenantId,
  artifactId,
  artifactType: "knowledge_ingestion_receipt" as const,
  value: { result: "sealed" },
};

describe("artifact custody reconciliation", () => {
  it("recovers upload acknowledgement loss after exact readback", async () => {
    const backing = new InMemoryArtifactStore();
    const store: ArtifactStore = {
      async put(value) {
        await backing.put(value);
        throw new Error("ACK_LOST");
      },
      get: (tenant, digest) => backing.get(tenant, digest),
    };
    const value = fixture(store);
    expect(await value.ledger.put(input)).toMatchObject({ artifactId, storageState: "available" });
  });
  it("recovers upload-success database-failure under the preassigned identity", async () => {
    const value = fixture();
    value.faults.insert = true;
    await expect(value.ledger.put(input)).rejects.toThrow("DB_WRITE_FAILED");
    expect(await value.ledger.put(input)).toMatchObject({ artifactId, storageState: "available" });
    expect(value.rows.size).toBe(1);
  });
  it("promotes pending and failed registrations only after verified remote reads", async () => {
    const value = fixture();
    await value.ledger.put(input);
    for (const state of ["pending", "failed"]) {
      value.rows.get(artifactId)!.storage_state = state;
      expect(await value.ledger.reconcile({ tenantId, artifactId })).toMatchObject({
        artifactId,
        storageState: "available",
      });
    }
  });
  it("reused pending metadata reaches available through idempotent put", async () => {
    const value = fixture();
    await value.ledger.put(input);
    value.rows.get(artifactId)!.storage_state = "pending";
    expect(await value.ledger.put(input)).toMatchObject({ artifactId, storageState: "available" });
  });
  it("does not promote missing or tampered remote bytes", async () => {
    const backing = new InMemoryArtifactStore();
    let returned: Uint8Array | undefined;
    let override = false;
    const value = fixture({
      put: (input) => backing.put(input),
      get: (tenant, digest) => (override ? Promise.resolve(returned) : backing.get(tenant, digest)),
    });
    await value.ledger.put(input);
    value.rows.get(artifactId)!.storage_state = "pending";
    override = true;
    await expect(value.ledger.reconcile({ tenantId, artifactId })).rejects.toMatchObject({ code: "STORAGE_PENDING" });
    returned = new TextEncoder().encode("tampered");
    await expect(value.ledger.reconcile({ tenantId, artifactId })).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_FAILED",
    });
    expect(value.rows.get(artifactId)!.storage_state).toBe("pending");
  });
  it("local-only custody remains pending and preassigned identity cannot silently change", async () => {
    const value = fixture(new InMemoryArtifactStore(), false);
    await value.ledger.put(input);
    expect(await value.ledger.reconcile({ tenantId, artifactId })).toMatchObject({ storageState: "pending" });
    await expect(value.ledger.put({ ...input, artifactId: tenantId })).rejects.toMatchObject({
      code: "ARTIFACT_IDENTITY_CONFLICT",
    });
  });
});
