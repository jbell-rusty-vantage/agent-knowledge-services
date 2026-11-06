import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CheckpointApplicationService,
  checkpointScopeId,
  type CheckpointCustody,
  type CheckpointPolicy,
  type CheckpointOperationReconciler,
} from "@aiengineer/knowledge-application";
import {
  CheckpointManifestSchema,
  CheckpointSemanticHandoffSchema,
  type CheckpointCommitRequest,
  type CheckpointScope,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { SupabaseArtifactStore, deterministicUuid } from "@aiengineer/knowledge-core";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import { disposableDatabaseUrl, disposableStorageConfig } from "../test/disposable.mjs";
import { PostgresCanonicalRepository, type TenantSqlClient } from "./postgres.js";
import { PostgresVerificationRepository, createVerificationArtifactHandle } from "./verification.js";
import { PostgresCheckpointStore } from "./checkpoints.js";
const databaseUrl = disposableDatabaseUrl();
const storage = disposableStorageConfig();
const live = databaseUrl && storage ? describe : describe.skip;
const encoder = new TextEncoder();
const bucket = "ai-engineer-cloud-bucket";
class AckDatabase extends PostgresCanonicalRepository {
  loseCommit = false;
  override async transaction<T>(tenantId: string, work: (client: TenantSqlClient) => Promise<T>): Promise<T> {
    let committed = false;
    const result = await super.transaction(tenantId, async (client) =>
      work({
        query: async (sql, params) => {
          const output = await client.query(sql, params);
          if (sql.includes("update knowledge_service.checkpoint_scope set head_checkpoint_id")) committed = true;
          return output as never;
        },
      }),
    );
    if (committed && this.loseCommit) {
      this.loseCommit = false;
      throw new Error("TEST_CHECKPOINT_COMMIT_ACK_LOST");
    }
    return result;
  }
}
async function fixture() {
  const tenantId = randomUUID();
  const database = new AckDatabase({ connectionString: databaseUrl! });
  const secondDatabase = new PostgresCanonicalRepository({ connectionString: databaseUrl! });
  const physical = new SupabaseArtifactStore({
    projectUrl: storage!.projectUrl,
    serviceRoleKey: storage!.secretKey,
    bucket,
    maximumBytes: 2000000,
  });
  const artifacts = new PostgresVerificationRepository(database, physical, { async authorize() {} });
  const store = new PostgresCheckpointStore(database);
  const scope: CheckpointScope = {
    tenantId,
    runId: randomUUID(),
    producerAttemptId: randomUUID(),
    sessionId: randomUUID(),
    sandboxId: randomUUID(),
    namespace: "root",
  };
  const policy: CheckpointPolicy = {
    profilePins: {
      storageProfileVersion: "fixture.v1",
      storageProfileDigest: sha256Digest("storage"),
      retentionPolicyVersion: "retain-while-referenced.v1",
      retentionPolicyDigest: sha256Digest("retention"),
      capabilityProfileVersion: "fixture.v1",
      capabilityProfileDigest: sha256Digest("capabilities"),
    },
    allowedRoots: ["notes", "drafts", "handoff.md"],
    maximumFiles: 20,
    maximumBytes: 2000000,
    maximumClosureBytes: 8000000,
    maximumManifestBytes: 2000000,
    maximumClosureArtifacts: 100,
  };
  async function register(label: string, bytes: Uint8Array, parents: readonly string[] = []) {
    const handle = createVerificationArtifactHandle({
      tenantId,
      bytes,
      mediaType: "application/json",
      createdAt: "2020-01-01T00:00:00.123Z",
      producerActivityId: label,
      producerVersion: "checkpoint.v1",
      encryptionClass: "managed",
      retentionClass: "audit",
      dataClassification: "internal",
      parentArtifactIds: parents,
      ...(parents.length ? { transformationSignature: sha256Digest(canonicalizeJson({ label, parents })) } : {}),
    });
    handle.artifactId = deterministicUuid(
      "checkpoint-test",
      canonicalizeJson({ tenantId, label, parents, digest: handle.digest }),
    );
    handle.objectKey = `logical/${handle.artifactId}`;
    return artifacts.registerArtifact({
      handle,
      bytes,
      artifactType: "workspace_file",
      bucketClass: "candidate",
      storageBucket: bucket,
    });
  }
  const reconciler: CheckpointOperationReconciler = {
    reconcile: vi.fn(async ({ operation }) => ({ ...operation, state: "unresolved", artifacts: [] })),
  };
  const custody: CheckpointCustody = {
    resolve: (input) => artifacts.getLogicalArtifact(input),
    registerManifest: ({ bytes, parentArtifactIds }) => register("checkpoint-manifest", bytes, parentArtifactIds),
    async validateExecutorState({ scope: expected, artifact }) {
      const value = await artifacts.getLogicalArtifact({ tenantId, artifactId: artifact.artifactId });
      expect(JSON.parse(new TextDecoder().decode(value!.bytes))).toEqual({ scope: expected });
    },
    async validateSemanticHandoff({ scope: expected, artifact, pendingOperations }) {
      const value = await artifacts.getLogicalArtifact({ tenantId, artifactId: artifact.artifactId });
      const handoff = CheckpointSemanticHandoffSchema.parse(JSON.parse(new TextDecoder().decode(value!.bytes)));
      expect(handoff.scope).toEqual(expected);
      expect(handoff.pendingOperations).toEqual(pendingOperations);
      expect(handoff.status).toBe(pendingOperations.length ? "partial" : "ready_for_continuation");
      const notes = await artifacts.getLogicalArtifact({ tenantId, artifactId: handoff.notesArtifact.artifactId });
      expect(new TextDecoder("utf-8", { fatal: true }).decode(notes!.bytes).trim()).not.toBe("");
      expect(artifact.parentArtifactIds).toContain(handoff.notesArtifact.artifactId);
    },
  };
  const service = (other = false) =>
    new CheckpointApplicationService(
      other ? new PostgresCheckpointStore(secondDatabase) : store,
      custody,
      reconciler,
      policy,
    );
  const file = await register("notes", encoder.encode("actual intermediate notes"));
  const manifest = () =>
    CheckpointManifestSchema.parse({
      schemaVersion: "scoped-checkpoint.v1",
      scope,
      parentCheckpointId: null,
      ...policy.profilePins,
      mode: "archive",
      boundary: "dirty_interval",
      files: [{ path: "notes/work.md", artifact: file }],
      requiredArtifacts: [],
      pendingOperations: [],
    });
  const request = (): CheckpointCommitRequest => ({
    idempotencyKey: randomUUID(),
    expectedHead: null,
    manifest: manifest(),
  });
  const restoreRequest = (checkpointId: string) => ({
    checkpointId,
    expectedScope: scope,
    expectedProfilePins: policy.profilePins,
  });
  return {
    tenantId,
    database,
    secondDatabase,
    physical,
    artifacts,
    store,
    scope,
    policy,
    register,
    custody,
    reconciler,
    service,
    file,
    manifest,
    request,
    restoreRequest,
    close: async () => {
      await secondDatabase.close();
      await database.close();
    },
  };
}
live("scoped checkpoints with real PostgreSQL and Storage", () => {
  it("commits once across independent writers, preserves parent manifest and exact handles", async () => {
    const f = await fixture();
    try {
      const request = f.request();
      const [a, b] = await Promise.all([
        f.service().commit(f.tenantId, request),
        f.service(true).commit(f.tenantId, request),
      ]);
      expect(a).toEqual(b);
      const next = await f.service().commit(f.tenantId, {
        ...request,
        idempotencyKey: randomUUID(),
        expectedHead: a.checkpointId,
        manifest: { ...request.manifest, parentCheckpointId: a.checkpointId, boundary: "transfer" },
      });
      expect(next.revision).toBe(2);
      expect(next.manifestArtifact.parentArtifactIds).toContain(a.manifestArtifact.artifactId);
      const restored = await f.service(true).read(f.tenantId, f.restoreRequest(next.checkpointId));
      expect(restored.manifest.files[0]!.artifact).toEqual(f.file);
      expect(restored.ready).toBe(false);
      expect((await f.service().head(f.tenantId, f.scope))!.checkpointId).toBe(next.checkpointId);
      await expect(f.service().commit(f.tenantId, { ...request, idempotencyKey: randomUUID() })).rejects.toThrow(
        "CHECKPOINT_HEAD_CONFLICT",
      );
      await expect(
        f.service().commit(f.tenantId, { ...request, manifest: { ...request.manifest, boundary: "manual" } }),
      ).rejects.toThrow("CHECKPOINT_IDEMPOTENCY_CONFLICT");
      await expect(
        f.service().read(f.tenantId, {
          ...f.restoreRequest(next.checkpointId),
          expectedScope: { ...f.scope, sandboxId: "wrong-sandbox" },
        }),
      ).rejects.toThrow("CHECKPOINT_SCOPE_MISMATCH");
      await expect(f.service().read(randomUUID(), f.restoreRequest(next.checkpointId))).rejects.toThrow(
        "CHECKPOINT_TENANT_DENIED",
      );
    } finally {
      await f.close();
    }
  });
  it("recovers uploaded manifest acknowledgement loss and committed database response loss", async () => {
    const f = await fixture();
    try {
      const request = { ...f.request(), harnessRequestDigest: sha256Digest("stable-harness-input") };
      const original = f.custody.registerManifest;
      vi.spyOn(f.custody, "registerManifest").mockImplementationOnce(async (input) => {
        await original(input);
        throw new Error("TEST_MANIFEST_ACK_LOST");
      });
      await expect(f.service().commit(f.tenantId, request)).rejects.toThrow("TEST_MANIFEST_ACK_LOST");
      expect(await f.service().head(f.tenantId, f.scope)).toBeUndefined();
      f.database.loseCommit = true;
      await expect(f.service().commit(f.tenantId, request)).rejects.toThrow("TEST_CHECKPOINT_COMMIT_ACK_LOST");
      const recovered = await f.service(true).commit(f.tenantId, request);
      expect(recovered.revision).toBe(1);
      expect(
        await f.service().findCommittedByKey(f.tenantId, {
          scope: f.scope,
          idempotencyKey: request.idempotencyKey,
          harnessRequestDigest: request.harnessRequestDigest,
        }),
      ).toEqual(recovered);
      await expect(
        f.service().findCommittedByKey(f.tenantId, {
          scope: f.scope,
          idempotencyKey: request.idempotencyKey,
          harnessRequestDigest: sha256Digest("changed-input"),
        }),
      ).rejects.toThrow("CHECKPOINT_HARNESS_INPUT_CONFLICT");
      expect((await f.service().read(f.tenantId, f.restoreRequest(recovered.checkpointId))).manifest).toEqual(
        request.manifest,
      );
    } finally {
      await f.close();
    }
  });
  it("rejects partial closure and forbidden paths without advancing the prior head", async () => {
    const f = await fixture();
    try {
      const first = await f.service().commit(f.tenantId, f.request());
      const request = {
        ...f.request(),
        expectedHead: first.checkpointId,
        manifest: { ...f.manifest(), parentCheckpointId: first.checkpointId },
      };
      const resolve = f.custody.resolve;
      vi.spyOn(f.custody, "resolve").mockImplementation((input) =>
        input.artifactId === f.file.artifactId ? Promise.resolve(undefined) : resolve(input),
      );
      await expect(f.service().commit(f.tenantId, request)).rejects.toThrow("CHECKPOINT_ARTIFACT_UNAVAILABLE");
      expect((await f.store.head({ tenantId: f.tenantId, scopeId: checkpointScopeId(f.scope) }))!.checkpointId).toBe(
        first.checkpointId,
      );
      vi.mocked(f.custody.resolve).mockRestore();
      for (const path of ["notes/.env", "notes/secrets.json", "notes/tokens.txt", "private/work.md"])
        await expect(
          f
            .service()
            .commit(f.tenantId, { ...request, manifest: { ...request.manifest, files: [{ path, artifact: f.file }] } }),
        ).rejects.toThrow("CHECKPOINT_PATH_DENIED");
      await expect(
        f.service().read(f.tenantId, {
          ...f.restoreRequest(first.checkpointId),
          expectedProfilePins: { ...f.policy.profilePins, storageProfileDigest: sha256Digest("wrong") },
        }),
      ).rejects.toThrow("CHECKPOINT_PROFILE_MISMATCH");
    } finally {
      await f.close();
    }
  });
  it("keeps child archives separate and reconciles original pending owners before continuation", async () => {
    const f = await fixture();
    try {
      const parentId = await f.service().registerScope(f.tenantId, f.scope);
      expect(await f.service().head(f.tenantId, f.scope)).toBeUndefined();
      expect(
        await f.service().resolveParentScope(f.tenantId, {
          runId: f.scope.runId,
          producerAttemptId: f.scope.producerAttemptId,
          sessionId: f.scope.sessionId,
        }),
      ).toBe(parentId);
      const child = {
        ...f.scope,
        sessionId: randomUUID(),
        sandboxId: randomUUID(),
        namespace: "children/source",
        parentScopeId: parentId,
        childId: "source-specialist",
      };
      const childReceipt = await f
        .service()
        .commit(f.tenantId, { ...f.request(), manifest: { ...f.manifest(), scope: child, boundary: "failure" } });
      expect(childReceipt.scopeId).not.toBe(parentId);
      const operation = {
        owner: "ingestion" as const,
        operationId: randomUUID(),
        requestDigest: sha256Digest("original-input"),
      };
      const state = await f.register("state", encoder.encode(canonicalizeJson({ scope: f.scope })));
      const handoff = await f.register(
        "handoff",
        encoder.encode(
          canonicalizeJson({
            schemaVersion: "checkpoint-handoff.v1",
            scope: f.scope,
            pendingOperations: [operation],
            notesArtifact: f.file,
            status: "partial",
          }),
        ),
        [f.file.artifactId],
      );
      const receipt = await f.service().commit(f.tenantId, {
        ...f.request(),
        manifest: {
          ...f.manifest(),
          mode: "continuation",
          executorStateArtifact: state,
          semanticHandoffArtifact: handoff,
          pendingOperations: [operation],
        },
      });
      expect((await f.service().restore(f.tenantId, f.restoreRequest(receipt.checkpointId))).ready).toBe(false);
      const dependency = await f.register("later-dependency", encoder.encode("recovered dependency"));
      const recovered = await f.register("later-outcome", encoder.encode("recovered outcome"), [dependency.artifactId]);
      vi.mocked(f.reconciler.reconcile).mockResolvedValue({
        ...operation,
        state: "settled",
        outcome: "succeeded",
        artifacts: [recovered],
      });
      const ready = await f.service().restore(f.tenantId, f.restoreRequest(receipt.checkpointId));
      expect(ready.ready).toBe(true);
      await f.service().restore(f.tenantId, f.restoreRequest(receipt.checkpointId));
      const pins = await f.database.transaction(
        f.tenantId,
        async (client) =>
          (
            await client.query<{ artifact_id: string }>(
              "select artifact_id from knowledge_service.checkpoint_artifact_reference where tenant_id=$1 and checkpoint_id=$2",
              [f.tenantId, receipt.checkpointId],
            )
          ).rows,
      );
      expect(pins.map((row) => row.artifact_id)).toEqual(
        expect.arrayContaining([recovered.artifactId, dependency.artifactId]),
      );
      // Simulate elapsed age only for these disposable fixtures, retaining production guards.
      await f.database.transaction(f.tenantId, async (client) => {
        await client.query("alter table orchestration.artifact disable trigger artifact_registration_clock");
        await client.query("alter table orchestration.artifact disable trigger artifact_immutable");
        await client.query(
          "update orchestration.artifact set custody_registered_at=clock_timestamp()-interval '31 days' where tenant_id=$1 and id=any($2::uuid[])",
          [f.tenantId, [recovered.artifactId, dependency.artifactId]],
        );
        await client.query("alter table orchestration.artifact enable trigger artifact_immutable");
        await client.query("alter table orchestration.artifact enable trigger artifact_registration_clock");
      });
      for (const handle of [recovered, dependency])
        await expect(
          f.service().tombstone(f.tenantId, { artifactId: handle.artifactId, reason: "expired reconciliation" }),
        ).rejects.toThrow("artifact has retained canonical references");
      expect(ready.operationOutcomes[0]).toMatchObject({ ...operation, outcome: "succeeded" });
      expect(f.reconciler.reconcile).toHaveBeenLastCalledWith({ tenantId: f.tenantId, scope: f.scope, operation });
    } finally {
      await f.close();
    }
  });
  it("denies actual Storage deletion of referenced bytes and rejects forged old retention clocks", async () => {
    const f = await fixture();
    try {
      await f.service().commit(f.tenantId, f.request());
      await expect(
        f.service().tombstone(f.tenantId, { artifactId: f.file.artifactId, reason: "expired" }),
      ).rejects.toThrow("minimum retention");
      const clock = await f.database.transaction(
        f.tenantId,
        async (client) =>
          (
            await client.query(
              "select custody_registered_at>clock_timestamp()-interval '1 minute' recent from orchestration.artifact where tenant_id=$1 and id=$2",
              [f.tenantId, f.file.artifactId],
            )
          ).rows[0]!,
      );
      expect(clock.recent).toBe(true);
      const key = `${f.tenantId}/${f.file.digest.slice(7, 9)}/${f.file.digest.slice(7)}`;
      const deletion = await fetch(`${storage!.projectUrl}/storage/v1/object/${bucket}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${storage!.secretKey}`,
          apikey: storage!.secretKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prefixes: [key] }),
      });
      expect(deletion.ok).toBe(false);
      expect(await f.physical.get(f.tenantId, f.file.digest as `sha256:${string}`)).toEqual(
        encoder.encode("actual intermediate notes"),
      );
    } finally {
      await f.close();
    }
  });
});
live("checkpoint retirement reference races", () => {
  it.each(["reference-first", "retirement-first"] as const)(
    "serializes %s against independent canonical writers after simulated elapsed age",
    async (order) => {
      const f = await fixture();
      try {
        // The fixture advances only this artifact's registration clock under an exclusive transaction lock.
        await f.database.transaction(f.tenantId, async (client) => {
          await client.query("alter table orchestration.artifact disable trigger artifact_registration_clock");
          await client.query("alter table orchestration.artifact disable trigger artifact_immutable");
          await client.query(
            "update orchestration.artifact set custody_registered_at=clock_timestamp()-interval '31 days' where tenant_id=$1 and id=$2",
            [f.tenantId, f.file.artifactId],
          );
          await client.query("alter table orchestration.artifact enable trigger artifact_immutable");
          await client.query("alter table orchestration.artifact enable trigger artifact_registration_clock");
        });
        let release!: () => void;
        let announce!: () => void;
        const ready = new Promise<void>((resolve) => {
          announce = resolve;
        });
        const insertReference = (client: TenantSqlClient) =>
          client.query(
            `insert into evidence.source_query(tenant_id,provider_code,query_text,purpose,parameters,response_artifact_id)
    select $1,code,'retirement-race','test','{}',$2 from evidence.search_provider order by code limit 1`,
            [f.tenantId, f.file.artifactId],
          );
        const insertRetirement = (client: TenantSqlClient) =>
          client.query(
            "insert into orchestration.artifact_tombstone(tenant_id,artifact_id,reason) values($1,$2,'expired orphan')",
            [f.tenantId, f.file.artifactId],
          );
        const first = f.database.transaction(f.tenantId, async (client) => {
          await (order === "reference-first" ? insertReference(client) : insertRetirement(client));
          announce();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        });
        await ready;
        let waitingPid: number | undefined;
        const second = f.secondDatabase
          .transaction(f.tenantId, async (client) => {
            waitingPid = Number((await client.query("select pg_backend_pid() pid")).rows[0]!.pid);
            await (order === "reference-first" ? insertRetirement(client) : insertReference(client));
          })
          .then(
            () => undefined,
            (error) => error as Error,
          );
        try {
          await vi.waitFor(
            async () => {
              expect(waitingPid).toBeDefined();
              const waiting = await f.database.transaction(
                f.tenantId,
                async (client) =>
                  (await client.query("select wait_event_type from pg_stat_activity where pid=$1", [waitingPid]))
                    .rows[0]?.wait_event_type,
              );
              expect(waiting).toBe("Lock");
            },
            { timeout: 3000 },
          );
        } finally {
          release();
        }
        await first;
        expect(await second).toMatchObject({
          message:
            order === "reference-first"
              ? "artifact has retained canonical references"
              : "canonical reference cannot bind a retired artifact",
        });
        if (order === "retirement-first") {
          await expect(
            f.artifacts.getLogicalArtifact({ tenantId: f.tenantId, artifactId: f.file.artifactId }),
          ).rejects.toThrow();
          await expect(
            f.artifacts.registerArtifact({
              handle: f.file,
              bytes: encoder.encode("actual intermediate notes"),
              artifactType: "workspace_file",
              bucketClass: "candidate",
              storageBucket: bucket,
            }),
          ).rejects.toThrow("retired artifact cannot regain custody");
        }
      } finally {
        await f.close();
      }
    },
  );
});
live("checkpoint physical alias retention", () => {
  it("retains bytes until every aged unreferenced alias is tombstoned", async () => {
    const f = await fixture();
    try {
      const bytes = encoder.encode("actual intermediate notes");
      const alias = await f.register("second-logical-alias", bytes);
      expect(alias.artifactId).not.toBe(f.file.artifactId);
      expect(alias.digest).toBe(f.file.digest);
      // Explicit elapsed-age simulation for these two disposable artifacts only.
      await f.database.transaction(f.tenantId, async (client) => {
        await client.query("alter table orchestration.artifact disable trigger artifact_registration_clock");
        await client.query("alter table orchestration.artifact disable trigger artifact_immutable");
        await client.query(
          "update orchestration.artifact set custody_registered_at=clock_timestamp()-interval '31 days' where tenant_id=$1 and id=any($2::uuid[])",
          [f.tenantId, [f.file.artifactId, alias.artifactId]],
        );
        await client.query("alter table orchestration.artifact enable trigger artifact_immutable");
        await client.query("alter table orchestration.artifact enable trigger artifact_registration_clock");
      });
      const remove = () =>
        fetch(`${storage!.projectUrl}/storage/v1/object/${bucket}`, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${storage!.secretKey}`,
            apikey: storage!.secretKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ prefixes: [`${f.tenantId}/${f.file.digest.slice(7, 9)}/${f.file.digest.slice(7)}`] }),
        });
      await f.service().tombstone(f.tenantId, { artifactId: f.file.artifactId, reason: "aged orphan" });
      expect((await remove()).ok).toBe(false);
      expect(await f.physical.get(f.tenantId, f.file.digest as `sha256:${string}`)).toEqual(bytes);
      await f.service().tombstone(f.tenantId, { artifactId: alias.artifactId, reason: "aged orphan" });
      expect((await remove()).ok).toBe(true);
      expect(await f.physical.get(f.tenantId, f.file.digest as `sha256:${string}`)).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});

live("checkpoint active workspace budgets", () => {
  it("accepts an exact-budget workspace across repeated revisions without charging lifetime snapshots", async () => {
    const f = await fixture();
    try {
      const policy = {
        ...f.policy,
        maximumBytes: 128,
        maximumClosureBytes: 128,
        maximumManifestBytes: 20_000,
        maximumClosureArtifacts: 2,
      };
      const service = new CheckpointApplicationService(f.store, f.custody, f.reconciler, policy);
      let head: string | null = null;
      let first: string | undefined;
      for (let revision = 0; revision < 10; revision++) {
        const file = await f.register(`revision-${revision}`, encoder.encode(String(revision).repeat(128)));
        const receipt = await service.commit(f.tenantId, {
          idempotencyKey: `revision-${revision}`,
          expectedHead: head,
          manifest: {
            ...f.manifest(),
            parentCheckpointId: head,
            files: [{ path: "notes/current.txt", artifact: file }],
          },
        });
        first ??= receipt.checkpointId;
        head = receipt.checkpointId;
        expect(receipt.revision).toBe(revision + 1);
        expect((await service.read(f.tenantId, f.restoreRequest(head))).manifest.files[0]!.artifact).toEqual(file);
      }
      expect((await service.read(f.tenantId, f.restoreRequest(first!))).manifest.files[0]!.artifact.byteLength).toBe(
        128,
      );
      const references = await f.database.transaction(
        f.tenantId,
        async (client) =>
          (
            await client.query(
              "select count(*) n from knowledge_service.checkpoint_artifact_reference where tenant_id=$1",
              [f.tenantId],
            )
          ).rows[0]!.n,
      );
      expect(Number(references)).toBeGreaterThanOrEqual(29);
      const tooLarge = await f.register("over-budget", encoder.encode("x".repeat(129)));
      await expect(
        service.commit(f.tenantId, {
          idempotencyKey: "over-budget",
          expectedHead: head,
          manifest: {
            ...f.manifest(),
            parentCheckpointId: head,
            files: [{ path: "notes/current.txt", artifact: tooLarge }],
          },
        }),
      ).rejects.toThrow("CHECKPOINT_FILE_BYTE_LIMIT");
      expect((await service.head(f.tenantId, f.scope))!.checkpointId).toBe(head);
    } finally {
      await f.close();
    }
  });
});
