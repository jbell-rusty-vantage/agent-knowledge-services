import { randomUUID } from "node:crypto";
import {
  CheckpointReceiptSchema,
  CheckpointScopeSchema,
  type CheckpointReceipt,
  type CheckpointScope,
} from "@aiengineer/knowledge-contracts";
import { canonicalizeJson } from "@aiengineer/knowledge-verification";
import type { CheckpointStore, CheckpointStoredRecord } from "@aiengineer/knowledge-application";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
type Row = Record<string, unknown>;
function storedRecord(row: Row): CheckpointStoredRecord {
  return {
    requestDigest: String(row.request_digest),
    receipt: CheckpointReceiptSchema.parse({
      checkpointId: row.id,
      scopeId: row.scope_id,
      manifestArtifact: row.manifest_handle,
      revision: Number(row.revision),
      mode: row.mode,
      committedAt:
        row.committed_at instanceof Date
          ? row.committed_at.toISOString()
          : new Date(String(row.committed_at)).toISOString(),
      ...(row.harness_request_digest ? { harnessRequestDigest: row.harness_request_digest } : {}),
    }),
  };
}
export class PostgresCheckpointStore implements CheckpointStore {
  constructor(private readonly database: Pick<PostgresCanonicalRepository, "transaction">) {}
  async ensureScope(input: Parameters<CheckpointStore["ensureScope"]>[0]): Promise<void> {
    await this.database.transaction(input.tenantId, (client) => this.ensureScopeInTransaction(client, input));
  }
  async findScopeBySession(
    input: Parameters<CheckpointStore["findScopeBySession"]>[0],
  ): Promise<CheckpointScope | undefined> {
    return this.database.transaction(input.tenantId, async (client) => {
      const rows = (
        await client.query<Row>(
          `select scope from knowledge_service.checkpoint_scope
    where tenant_id=$1 and scope->>'runId'=$2 and scope->>'producerAttemptId'=$3 and scope->>'sessionId'=$4 limit 2`,
          [input.tenantId, input.runId, input.producerAttemptId, input.sessionId],
        )
      ).rows;
      if (rows.length > 1) throw new Error("CHECKPOINT_PARENT_SCOPE_AMBIGUOUS");
      return rows[0] ? CheckpointScopeSchema.parse(rows[0].scope) : undefined;
    });
  }
  async findByKey(input: Parameters<CheckpointStore["findByKey"]>[0]): Promise<CheckpointStoredRecord | undefined> {
    return this.database.transaction(input.tenantId, async (client) => {
      const row = (
        await client.query<Row>(
          "select * from knowledge_service.scoped_checkpoint where tenant_id=$1 and scope_id=$2 and idempotency_key=$3",
          [input.tenantId, input.scopeId, input.idempotencyKey],
        )
      ).rows[0];
      return row ? storedRecord(row) : undefined;
    });
  }
  async read(input: Parameters<CheckpointStore["read"]>[0]): Promise<CheckpointStoredRecord | undefined> {
    return this.database.transaction(input.tenantId, async (client) => {
      const row = (
        await client.query<Row>("select * from knowledge_service.scoped_checkpoint where tenant_id=$1 and id=$2", [
          input.tenantId,
          input.checkpointId,
        ])
      ).rows[0];
      return row ? storedRecord(row) : undefined;
    });
  }
  async head(input: Parameters<CheckpointStore["head"]>[0]): Promise<CheckpointReceipt | undefined> {
    return this.database.transaction(input.tenantId, async (client) => {
      const row = (
        await client.query<Row>(
          `select c.* from knowledge_service.checkpoint_scope s join knowledge_service.scoped_checkpoint c on c.tenant_id=s.tenant_id and c.id=s.head_checkpoint_id
    where s.tenant_id=$1 and s.id=$2`,
          [input.tenantId, input.scopeId],
        )
      ).rows[0];
      return row ? storedRecord(row).receipt : undefined;
    });
  }
  async commit(input: Parameters<CheckpointStore["commit"]>[0]): Promise<CheckpointReceipt> {
    return this.database.transaction(input.tenantId, async (client) => {
      await this.ensureScopeInTransaction(client, {
        tenantId: input.tenantId,
        scopeId: input.scopeId,
        scope: input.request.manifest.scope,
      });
      const scope = (
        await client.query<Row>(
          "select * from knowledge_service.checkpoint_scope where tenant_id=$1 and id=$2 for update",
          [input.tenantId, input.scopeId],
        )
      ).rows[0]!;
      const existing = (
        await client.query<Row>(
          "select * from knowledge_service.scoped_checkpoint where tenant_id=$1 and scope_id=$2 and idempotency_key=$3",
          [input.tenantId, input.scopeId, input.request.idempotencyKey],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.request_digest !== input.requestDigest ||
          existing.manifest_artifact_id !== input.manifestArtifact.artifactId
        )
          throw new Error("CHECKPOINT_IDEMPOTENCY_CONFLICT");
        return storedRecord(existing).receipt;
      }
      if ((scope.head_checkpoint_id ?? null) !== input.request.expectedHead)
        throw new Error("CHECKPOINT_HEAD_CONFLICT");
      const artifactIds = [...new Set(input.closure.map((artifact) => artifact.artifactId))].sort();
      if (!artifactIds.includes(input.manifestArtifact.artifactId))
        throw new Error("CHECKPOINT_MANIFEST_CLOSURE_REQUIRED");
      await this.assertLiveInTransaction(client, input.tenantId, artifactIds, true);
      const checkpointId = randomUUID();
      const revision = Number(scope.revision) + 1;
      const row = (
        await client.query<Row>(
          `insert into knowledge_service.scoped_checkpoint
    (tenant_id,id,scope_id,parent_checkpoint_id,revision,idempotency_key,request_digest,manifest_artifact_id,manifest_handle,mode,harness_request_digest)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) returning *`,
          [
            input.tenantId,
            checkpointId,
            input.scopeId,
            input.request.expectedHead,
            revision,
            input.request.idempotencyKey,
            input.requestDigest,
            input.manifestArtifact.artifactId,
            JSON.stringify(input.manifestArtifact),
            input.request.manifest.mode,
            input.request.harnessRequestDigest ?? null,
          ],
        )
      ).rows[0]!;
      for (const artifactId of artifactIds)
        await client.query(
          "insert into knowledge_service.checkpoint_artifact_reference(tenant_id,checkpoint_id,artifact_id) values($1,$2,$3)",
          [input.tenantId, checkpointId, artifactId],
        );
      await client.query(
        "update knowledge_service.checkpoint_scope set head_checkpoint_id=$3,revision=$4 where tenant_id=$1 and id=$2",
        [input.tenantId, input.scopeId, checkpointId, revision],
      );
      return storedRecord(row).receipt;
    });
  }
  async pinReconciledArtifacts(input: Parameters<CheckpointStore["pinReconciledArtifacts"]>[0]): Promise<void> {
    await this.database.transaction(input.tenantId, async (client) => {
      const checkpoint = (
        await client.query("select id from knowledge_service.scoped_checkpoint where tenant_id=$1 and id=$2", [
          input.tenantId,
          input.checkpointId,
        ])
      ).rows[0];
      if (!checkpoint) throw new Error("CHECKPOINT_NOT_FOUND");
      const ids = [...new Set(input.artifactIds)].sort();
      await this.assertLiveInTransaction(client, input.tenantId, ids, true);
      for (const artifactId of ids) {
        await client.query(
          "insert into knowledge_service.checkpoint_artifact_reference(tenant_id,checkpoint_id,artifact_id) values($1,$2,$3) on conflict do nothing",
          [input.tenantId, input.checkpointId, artifactId],
        );
      }
    });
  }
  async assertLive(input: Parameters<CheckpointStore["assertLive"]>[0]): Promise<void> {
    await this.database.transaction(input.tenantId, (client) =>
      this.assertLiveInTransaction(client, input.tenantId, input.artifactIds, false),
    );
  }
  async tombstone(input: Parameters<CheckpointStore["tombstone"]>[0]): Promise<void> {
    await this.database.transaction(input.tenantId, async (client) => {
      const existing = (
        await client.query<Row>(
          "select reason from orchestration.artifact_tombstone where tenant_id=$1 and artifact_id=$2",
          [input.tenantId, input.artifactId],
        )
      ).rows[0];
      if (existing) {
        if (existing.reason !== input.reason) throw new Error("CHECKPOINT_TOMBSTONE_CONFLICT");
        return;
      }
      await client.query(
        "insert into orchestration.artifact_tombstone(tenant_id,artifact_id,reason) values($1,$2,$3)",
        [input.tenantId, input.artifactId, input.reason],
      );
    });
  }
  private async ensureScopeInTransaction(
    client: TenantSqlClient,
    input: Parameters<CheckpointStore["ensureScope"]>[0],
  ): Promise<void> {
    const scope = CheckpointScopeSchema.parse(input.scope);
    if (scope.tenantId !== input.tenantId) throw new Error("CHECKPOINT_TENANT_DENIED");
    if (scope.parentScopeId) {
      const parent = (
        await client.query<Row>("select scope from knowledge_service.checkpoint_scope where tenant_id=$1 and id=$2", [
          input.tenantId,
          scope.parentScopeId,
        ])
      ).rows[0];
      if (!parent) throw new Error("CHECKPOINT_PARENT_SCOPE_NOT_FOUND");
      const parentScope = CheckpointScopeSchema.parse(parent.scope);
      if (
        parentScope.runId !== scope.runId ||
        parentScope.producerAttemptId !== scope.producerAttemptId ||
        parentScope.sessionId === scope.sessionId
      )
        throw new Error("CHECKPOINT_PARENT_SCOPE_MISMATCH");
    }
    await client.query(
      `insert into knowledge_service.checkpoint_scope(tenant_id,id,scope,parent_scope_id) values($1,$2,$3::jsonb,$4) on conflict do nothing`,
      [input.tenantId, input.scopeId, JSON.stringify(scope), scope.parentScopeId ?? null],
    );
    const existing = (
      await client.query<Row>("select scope from knowledge_service.checkpoint_scope where tenant_id=$1 and id=$2", [
        input.tenantId,
        input.scopeId,
      ])
    ).rows[0];
    if (!existing || canonicalizeJson(existing.scope) !== canonicalizeJson(scope))
      throw new Error("CHECKPOINT_SCOPE_CONFLICT");
  }
  private async assertLiveInTransaction(
    client: TenantSqlClient,
    tenantId: string,
    artifactIds: readonly string[],
    lock: boolean,
  ): Promise<void> {
    const ids = [...new Set(artifactIds)].sort();
    if (!ids.length) return;
    const rows = (
      await client.query<Row>(
        `select a.id,a.storage_state from orchestration.artifact a
   where a.tenant_id=$1 and a.id=any($2::uuid[]) order by a.id ${lock ? "for update" : ""}`,
        [tenantId, ids],
      )
    ).rows;
    if (rows.length !== ids.length || rows.some((row) => row.storage_state !== "available"))
      throw new Error("CHECKPOINT_ARTIFACT_UNAVAILABLE");
    if (
      (
        await client.query<Row>(
          "select artifact_id from orchestration.artifact_tombstone where tenant_id=$1 and artifact_id=any($2::uuid[]) limit 1",
          [tenantId, ids],
        )
      ).rows[0]
    )
      throw new Error("CHECKPOINT_ARTIFACT_TOMBSTONED");
  }
}
