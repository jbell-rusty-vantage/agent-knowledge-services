import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore, type ArtifactStore } from "@aiengineer/knowledge-core";
import { createVerificationArtifactHandle, PostgresVerificationRepository } from "./verification.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const encoder = new TextEncoder();

type Row = Record<string, unknown>;

function fixture(store: ArtifactStore = new InMemoryArtifactStore()) {
  const artifacts = new Map<string, Row>();
  const metadata = new Map<string, Row>();
  const faults = { availabilityCommits: 0, leaseLive: true };
  const query = async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes("select operation_id from knowledge_service.operation_step"))
      return { rows: [{ operation_id: tenantId }], rowCount: 1 };
    if (sql.includes("select id,attempt_id,status from knowledge_service.operation"))
      return { rows: [{ id: tenantId, attempt_id: tenantId, status: "running" }], rowCount: 1 };
    if (sql.includes("select step.id from knowledge_service.operation_step"))
      return { rows: faults.leaseLive ? [{ id: tenantId }] : [], rowCount: 1 };
    if (sql.includes("insert into orchestration.artifact\n")) {
      const [
        id,
        tenant_id,
        artifact_type,
        sha256,
        bucket_class,
        storage_bucket,
        object_path,
        media_type,
        size_bytes,
        producer_attempt_id,
        mission_id,
        created_at,
      ] = values;
      if (!artifacts.has(String(id)))
        artifacts.set(String(id), {
          id,
          tenant_id,
          artifact_type,
          schema_version: 1,
          sha256,
          bucket_class,
          storage_bucket,
          object_path,
          media_type,
          size_bytes,
          producer_attempt_id,
          mission_id,
          created_at,
          storage_state: "pending",
          available_at: null,
          verification_contract_version: "verification.v1",
        });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("select a.id from orchestration.artifact a")) {
      const row = artifacts.get(String(values[1]));
      return {
        rows: row?.storage_state === "available" && row.tenant_id === values[0] ? [{ id: row.id }] : [],
        rowCount: 1,
      };
    }
    if (sql.includes("select verification_contract_version from orchestration.artifact")) {
      const row = artifacts.get(String(values[1]));
      return {
        rows: row ? [{ verification_contract_version: row.verification_contract_version }] : [],
        rowCount: row ? 1 : 0,
      };
    }
    if (sql.includes("insert into orchestration.verification_artifact_metadata")) {
      const [
        storedTenantId,
        artifact_id,
        producer_activity_id,
        producer_version,
        content_encoding,
        encryption_class,
        retention_class,
        data_classification,
        parent_artifact_ids,
        transformation_signature,
        attestation_artifact_id,
        created_at,
        logical_object_key,
      ] = values;
      if (!metadata.has(String(artifact_id)))
        metadata.set(String(artifact_id), {
          tenant_id: storedTenantId,
          artifact_id,
          producer_activity_id,
          producer_version,
          content_encoding,
          encryption_class,
          retention_class,
          data_classification,
          parent_artifact_ids,
          transformation_signature,
          attestation_artifact_id,
          created_at,
          logical_object_key,
        });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("from orchestration.artifact a join orchestration.verification_artifact_metadata")) {
      const artifact = artifacts.get(String(values[1])),
        meta = metadata.get(String(values[1]));
      return { rows: artifact && meta ? [{ ...artifact, ...meta }] : [], rowCount: artifact && meta ? 1 : 0 };
    }
    if (sql.includes("select storage_state from orchestration.artifact") && sql.includes("for update")) {
      const row = artifacts.get(String(values[1]));
      return { rows: row ? [{ storage_state: row.storage_state }] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("set storage_state='available'")) {
      if (faults.availabilityCommits-- > 0) throw new Error("DATABASE_COMMIT_LOST");
      const row = artifacts.get(String(values[1]));
      if (row) {
        row.storage_state = "available";
        row.available_at = "2026-09-08T00:00:01.000Z";
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("set storage_state='failed'")) {
      const row = artifacts.get(String(values[1]));
      if (row && row.storage_state === "pending") {
        row.storage_state = "failed";
        row.available_at = null;
        row.registration_error_class = "object_write_failed";
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("insert into orchestration.artifact_lineage")) return { rows: [], rowCount: 1 };
    throw new Error(`UNEXPECTED_SQL:${sql.slice(0, 80)}`);
  };
  const database = {
    transaction: async (_tenant: string, work: (client: { query: typeof query }) => Promise<unknown>) =>
      work({ query }),
  };
  const repository = new PostgresVerificationRepository(database as never, store, { async authorize() {} });
  return { artifacts, metadata, repository, faults };
}

function input(name: string) {
  const bytes = encoder.encode(`artifact:${name}`);
  const handle = createVerificationArtifactHandle({
    tenantId,
    bytes,
    mediaType: "text/plain",
    createdAt: "2026-09-08T00:00:00.000Z",
    producerActivityId: "artifact-registration-test",
    producerVersion: "v1",
    encryptionClass: "managed",
    retentionClass: "verification-audit",
    dataClassification: "restricted",
  });
  return {
    handle,
    bytes,
    artifactType: "verification_policy" as const,
    bucketClass: "ledger" as const,
    storageBucket: "proof",
  };
}

describe("PostgresVerificationRepository artifact registration", () => {
  it("round-trips a registered object through CAS and records matching available relational metadata", async () => {
    const value = fixture();
    const registered = await value.repository.registerArtifact(input("roundtrip"));
    const row = value.artifacts.get(registered.artifactId)!;
    expect(row.storage_state).toBe("available");
    expect(row.sha256).toBe(registered.digest.slice(7));
    expect(row.object_path).toBe(registered.objectKey);
    expect(value.metadata.get(registered.artifactId)).toMatchObject({
      tenant_id: tenantId,
      data_classification: "restricted",
      parent_artifact_ids: [],
    });
  });

  it("rejects a collision before a second object-store write", async () => {
    let puts = 0;
    const backing = new InMemoryArtifactStore();
    const store: ArtifactStore = {
      async put(value) {
        puts++;
        return backing.put(value);
      },
      get: (id, digest) => backing.get(id, digest),
    };
    const value = fixture(store),
      first = input("collision");
    await value.repository.registerArtifact(first);
    await expect(
      value.repository.registerArtifact({ ...first, artifactType: "verification_policy_inputs" }),
    ).rejects.toThrow("ARTIFACT_REGISTRATION_COLLISION");
    expect(puts).toBe(1);
    expect(value.artifacts.get(first.handle.artifactId)?.storage_state).toBe("available");
  });

  it("marks a relational registration failed when the object-store write fails, leaving no available orphan", async () => {
    const store: ArtifactStore = {
      async put() {
        throw new Error("SYNTHETIC_OBJECT_STORE_FAILURE");
      },
      async get() {
        return undefined;
      },
    };
    const value = fixture(store),
      artifact = input("write-failure");
    await expect(value.repository.registerArtifact(artifact)).rejects.toThrow("SYNTHETIC_OBJECT_STORE_FAILURE");
    expect(value.artifacts.get(artifact.handle.artifactId)).toMatchObject({
      storage_state: "failed",
      registration_error_class: "object_write_failed",
      available_at: null,
    });
  });
});

describe("logical artifact custody", () => {
  it("preserves exact logical handles and different parents while sharing one digest upload", async () => {
    const backing = new InMemoryArtifactStore();
    const writes: string[] = [];
    const store: ArtifactStore = {
      async put(value) {
        const result = await backing.put(value);
        writes.push(result.digest);
        return result;
      },
      get: (tenant, digest) => backing.get(tenant, digest),
    };
    const value = fixture(store);
    const parentA = await value.repository.registerArtifact(input("parent-a"));
    const parentB = await value.repository.registerArtifact(input("parent-b"));
    const base = input("derived");
    const first = {
      ...base,
      handle: {
        ...base.handle,
        artifactId: "22222222-2222-4222-8222-222222222222",
        objectKey: "artifacts/local-a.json",
        parentArtifactIds: [parentA.artifactId],
        transformationSignature: base.handle.digest,
      },
    };
    const second = {
      ...base,
      handle: {
        ...base.handle,
        artifactId: "33333333-3333-4333-8333-333333333333",
        objectKey: "artifacts/local-b.json",
        parentArtifactIds: [parentB.artifactId],
        transformationSignature: base.handle.digest,
      },
    };
    expect(await value.repository.registerLogicalArtifact(first)).toEqual(first.handle);
    expect(await value.repository.registerLogicalArtifact(second)).toEqual(second.handle);
    expect(await value.repository.getLogicalArtifact({ tenantId, artifactId: first.handle.artifactId })).toEqual({
      handle: first.handle,
      bytes: first.bytes,
    });
    expect(await value.repository.getLogicalArtifact({ tenantId, artifactId: second.handle.artifactId })).toEqual({
      handle: second.handle,
      bytes: second.bytes,
    });
    expect(writes.filter((digest) => digest === base.handle.digest)).toHaveLength(1);
    expect(value.artifacts.get(first.handle.artifactId)?.object_path).toBe(
      value.artifacts.get(second.handle.artifactId)?.object_path,
    );
    await expect(
      value.repository.registerLogicalArtifact({
        ...first,
        handle: { ...first.handle, parentArtifactIds: [parentB.artifactId] },
      }),
    ).rejects.toThrow("ARTIFACT_REGISTRATION_COLLISION");
  });

  it("recovers upload acknowledgement loss only after reading exact bytes", async () => {
    const backing = new InMemoryArtifactStore();
    const store: ArtifactStore = {
      async put(value) {
        await backing.put(value);
        throw new Error("ACK_LOST");
      },
      get: (tenant, digest) => backing.get(tenant, digest),
    };
    const value = fixture(store),
      artifact = input("ack-lost");
    expect(await value.repository.registerLogicalArtifact(artifact)).toEqual(artifact.handle);
    expect(value.artifacts.get(artifact.handle.artifactId)?.storage_state).toBe("available");
  });

  it("repairs upload-success database-failure without another upload or changing identity", async () => {
    const backing = new InMemoryArtifactStore();
    let puts = 0;
    const store: ArtifactStore = {
      async put(value) {
        puts++;
        return backing.put(value);
      },
      get: (tenant, digest) => backing.get(tenant, digest),
    };
    const value = fixture(store),
      artifact = input("db-lost");
    value.faults.availabilityCommits = 1;
    await expect(value.repository.registerArtifact(artifact)).rejects.toThrow("DATABASE_COMMIT_LOST");
    expect(await value.repository.registerArtifact(artifact)).toEqual(artifact.handle);
    expect(puts).toBe(1);
    expect(value.artifacts.get(artifact.handle.artifactId)?.storage_state).toBe("available");
  });

  it("refuses unavailable parents before writing child bytes", async () => {
    const value = fixture(),
      artifact = input("unavailable-parent");
    await expect(
      value.repository.registerLogicalArtifact({
        ...artifact,
        handle: {
          ...artifact.handle,
          parentArtifactIds: ["22222222-2222-4222-8222-222222222222"],
          transformationSignature: artifact.handle.digest,
        },
      }),
    ).rejects.toThrow("ARTIFACT_PARENT_NOT_AVAILABLE");
    expect(value.artifacts.size).toBe(0);
  });
});

it("fences availability and failure updates when the worker loses its lease during upload", async () => {
  const backing = new InMemoryArtifactStore();
  let loseLease = () => {};
  const store: ArtifactStore = {
    async put(input) {
      const stored = await backing.put(input);
      loseLease();
      return stored;
    },
    get: (tenant, digest) => backing.get(tenant, digest),
  };
  const value = fixture(store),
    artifact = input("lease-loss");
  loseLease = () => {
    value.faults.leaseLive = false;
  };
  const fence = {
    producerAttemptId: tenantId,
    lease: { stepId: tenantId, leaseToken: "lease", fencingToken: 1, holderIdentity: "worker" },
  };
  await expect(value.repository.registerLogicalArtifact(artifact, fence)).rejects.toThrow(
    "VERIFICATION_RUN_STALE_LEASE",
  );
  expect(value.artifacts.get(artifact.handle.artifactId)?.storage_state).toBe("pending");
  value.faults.leaseLive = true;
  expect(
    await value.repository.registerLogicalArtifact(artifact, { ...fence, lease: { ...fence.lease, fencingToken: 2 } }),
  ).toEqual(artifact.handle);
});

it("retries a pending CAS registration using the original immutable producer metadata", async () => {
  const value = fixture(),
    artifact = input("cas-recovery");
  await value.repository.registerArtifact(artifact);
  value.artifacts.get(artifact.handle.artifactId)!.storage_state = "pending";
  expect(
    await value.repository.registerContentAddressedArtifact({
      tenantId,
      mediaType: artifact.handle.mediaType,
      producerVersion: "v1",
      encryptionClass: "managed",
      retentionClass: "verification-audit",
      dataClassification: "restricted",
      bytes: artifact.bytes,
      artifactType: artifact.artifactType,
      bucketClass: artifact.bucketClass,
      storageBucket: artifact.storageBucket,
      producerActivityId: "retry-worker",
      createdAt: "2026-09-09T00:00:00.000Z",
    }),
  ).toEqual(artifact.handle);
});

it("exposes original pending and failed registration metadata without acknowledging availability", async () => {
  const value = fixture(),
    artifact = input("lookup-pending");
  const key = { tenantId, artifactId: artifact.handle.artifactId };
  expect(await value.repository.getLogicalArtifactRegistration(key)).toBeUndefined();
  await value.repository.registerLogicalArtifact(artifact);
  for (const storageState of ["pending", "failed", "available"] as const) {
    value.artifacts.get(artifact.handle.artifactId)!.storage_state = storageState;
    expect(await value.repository.getLogicalArtifactRegistration(key)).toEqual({
      handle: artifact.handle,
      storageState,
    });
    if (storageState !== "available")
      await expect(value.repository.getLogicalArtifact(key)).rejects.toThrow("ARTIFACT_NOT_AVAILABLE");
  }
});

it("authorizes metadata lookup before consulting the registry", async () => {
  let reads = 0;
  const database = {
    async transaction() {
      reads++;
      throw new Error("UNEXPECTED_READ");
    },
  };
  const repository = new PostgresVerificationRepository(database as never, new InMemoryArtifactStore(), {
    async authorize() {
      throw new Error("ARTIFACT_ACCESS_DENIED");
    },
  });
  await expect(repository.getLogicalArtifactRegistration({ tenantId, artifactId: tenantId })).rejects.toThrow(
    "ARTIFACT_ACCESS_DENIED",
  );
  expect(reads).toBe(0);
});
