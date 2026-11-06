import type { KnowledgeTransactions, KnowledgeSqlClient } from "../ports.js";
import type { ArtifactStore } from "@aiengineer/knowledge-core";
import { domainError, infrastructureError } from "../schema-workspace/index.js";
import { canonicalJson, sha256Hex, type Digest } from "./canonical.js";
import { uuidv7 } from "./uuid.js";

export type KnowledgeArtifactType =
  | "knowledge_read_intent"
  | "knowledge_read_snapshot"
  | "knowledge_ingestion_plan"
  | "knowledge_ingestion_receipt"
  | "schema_workspace_manifest"
  | "knowledge_report_markdown"
  | "ingestion_intent"
  | "research_report_structure"
  | "research_report_manifest"
  | "research_report_verification"
  | "content_link_intent"
  | "content_link_plan"
  | "content_link_receipt"
  | "content_summary_text"
  | "content_summary_preparation_receipt"
  | "workspace_file";

export interface ArtifactRecord {
  readonly artifactId: string;
  readonly artifactType: string;
  readonly digest: Digest;
  readonly bucket: string;
  readonly objectPath: string;
  readonly storageState: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly reused: boolean;
}

export interface PutArtifactInput {
  readonly tenantId: string;
  readonly artifactType: KnowledgeArtifactType;
  /** Pre-assigned id when the caller must reference the artifact before it is written (receipts). */
  readonly artifactId?: string;
  readonly value?: unknown;
  readonly text?: string;
  readonly mediaType?: string;
  readonly missionId?: string;
}

export interface LineageEdge {
  readonly tenantId: string;
  readonly from: string;
  readonly to: string;
  readonly relation: "derived_from" | "produced_by" | "consumed_by" | "supersedes" | "corrects";
  readonly receiptId?: string;
}

export interface ArtifactLedgerConfig {
  readonly db: KnowledgeTransactions;
  readonly store: ArtifactStore;
  readonly bucket: string;
  /** True when `store` writes to the named bucket; false marks rows `storage_state='pending'` (bytes kept locally). */
  readonly uploaded: boolean;
  readonly executorVersion: string;
  readonly readStores?: Readonly<Record<string, ArtifactStore>>;
}

const LEDGER_BUCKET_CLASS = "ledger";

/**
 * Content-addressed JSON/Markdown artifacts recorded in `orchestration.artifact` with
 * `artifact_lineage` edges. Bytes live in the configured `ArtifactStore`; the row is the
 * logical index. Every write runs as `executor_service`, the only role with insert.
 */
export class ArtifactLedger {
  constructor(private readonly config: ArtifactLedgerConfig) {}

  async put(input: PutArtifactInput): Promise<ArtifactRecord> {
    return this.config.db.transaction({ tenantId: input.tenantId, role: "executor_service" }, (client) =>
      this.putWith(client, input),
    );
  }

  /** Same as `put`, inside a caller-owned transaction that already runs as `executor_service`. */
  async putWith(client: KnowledgeSqlClient, input: PutArtifactInput): Promise<ArtifactRecord> {
    const encoded = encode(input);
    const stored = await this.writeVerified(input.tenantId, encoded);
    const sha256 = stored.digest.slice(7);
    const artifactId = input.artifactId ?? uuidv7();
    const storageState = this.config.uploaded ? "available" : "pending";
    await client.query(
      `insert into orchestration.artifact(id,tenant_id,artifact_type,sha256,bucket_class,storage_bucket,object_path,media_type,size_bytes,mission_id,storage_state,available_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,case when $11='available' then now() end)
       on conflict (storage_bucket, object_path) where verification_contract_version is null do nothing`,
      [
        artifactId,
        input.tenantId,
        input.artifactType,
        sha256,
        LEDGER_BUCKET_CLASS,
        this.config.bucket,
        stored.storageKey,
        encoded.mediaType,
        encoded.bytes.byteLength,
        input.missionId ?? null,
        storageState,
      ],
    );
    const row = (
      await client.query<{
        id: string;
        storage_state: string;
        object_path: string;
        artifact_type: string;
        sha256: string;
      }>(
        "select id, storage_state, object_path, artifact_type, sha256 from orchestration.artifact where tenant_id=$1 and storage_bucket=$2 and object_path=$3 and verification_contract_version is null",
        [input.tenantId, this.config.bucket, stored.storageKey],
      )
    ).rows[0];
    if (!row) throw domainError("ARTIFACT_NOT_RECORDED", "artifact row vanished after insert", { sha256 });
    if (row.sha256 !== sha256 || row.artifact_type !== input.artifactType)
      throw infrastructureError(
        "ARTIFACT_METADATA_CONFLICT",
        "an artifact with the same object path but different identity exists",
        { objectPath: stored.storageKey, existingType: row.artifact_type },
      );
    if (input.artifactId && row.id !== input.artifactId)
      throw infrastructureError(
        "ARTIFACT_IDENTITY_CONFLICT",
        "Preassigned artifact identity differs from the existing registration",
        { expected: input.artifactId, actual: row.id },
      );
    if (this.config.uploaded && row.storage_state !== "available") {
      await this.markAvailable(client, {
        tenantId: input.tenantId,
        artifactId: row.id,
        digest: stored.digest,
        sizeBytes: encoded.bytes.byteLength,
      });
      row.storage_state = "available";
    }
    return {
      artifactId: row.id,
      artifactType: input.artifactType,
      digest: stored.digest,
      bucket: this.config.bucket,
      objectPath: row.object_path,
      storageState: row.storage_state,
      mediaType: encoded.mediaType,
      sizeBytes: encoded.bytes.byteLength,
      reused: row.id !== artifactId,
    };
  }

  /** Reconciles only verified remote custody; local-only reads remain explicitly pending. */
  async reconcile(input: { readonly tenantId: string; readonly artifactId: string }): Promise<ArtifactRecord> {
    const fetched = await this.get(input.tenantId, input.artifactId);
    if (fetched.json === undefined && fetched.text === undefined)
      throw infrastructureError("STORAGE_PENDING", "Registered artifact bytes are unavailable", input);
    if (!this.config.uploaded || fetched.record.bucket !== this.config.bucket) return fetched.record;
    if (fetched.record.storageState === "available") return fetched.record;
    await this.config.db.transaction({ tenantId: input.tenantId, role: "executor_service" }, (client) =>
      this.markAvailable(client, { ...input, digest: fetched.record.digest, sizeBytes: fetched.record.sizeBytes }),
    );
    return { ...fetched.record, storageState: "available" };
  }

  private async markAvailable(
    client: KnowledgeSqlClient,
    input: { tenantId: string; artifactId: string; digest: Digest; sizeBytes: number },
  ): Promise<void> {
    await client.query("select orchestration.reconcile_legacy_artifact_custody($1,$2,$3,$4,$5)", [
      input.artifactId,
      input.digest.slice(7),
      input.sizeBytes,
      this.config.bucket,
      input.tenantId,
    ]);
  }

  private async writeVerified(tenantId: string, encoded: { bytes: Uint8Array; mediaType: string }) {
    const digest: Digest = `sha256:${sha256Hex(encoded.bytes)}`;
    let stored;
    try {
      stored = await this.config.store.put({ tenantId, mediaType: encoded.mediaType, bytes: encoded.bytes });
    } catch (error) {
      if (!this.config.uploaded) throw error;
      const recovered = await this.config.store.get(tenantId, digest).catch(() => undefined);
      if (!recovered || sha256Hex(recovered) !== digest.slice(7) || recovered.byteLength !== encoded.bytes.byteLength)
        throw error;
      stored = { tenantId, digest, storageKey: `${tenantId}/${digest.slice(7, 9)}/${digest.slice(7)}` };
    }
    if (stored.tenantId !== tenantId || stored.digest !== digest)
      throw infrastructureError("ARTIFACT_METADATA_CONFLICT", "Storage acknowledgement differs from submitted bytes");
    if (this.config.uploaded) {
      const restored = await this.config.store.get(tenantId, digest);
      if (!restored || sha256Hex(restored) !== digest.slice(7) || restored.byteLength !== encoded.bytes.byteLength)
        throw infrastructureError("ARTIFACT_READBACK_FAILED", "Uploaded artifact bytes could not be verified");
      if (stored.storageKey !== `${tenantId}/${digest.slice(7, 9)}/${digest.slice(7)}`)
        throw infrastructureError(
          "ARTIFACT_METADATA_CONFLICT",
          "Remote object address differs from tenant digest custody",
        );
    }
    return stored;
  }

  /**
   * Records a lineage edge. `executor_service` currently has no grant on
   * `orchestration.artifact_lineage` (db-contract follow-up), so a permission refusal is
   * reported as `"denied"` instead of aborting the caller's transaction.
   */
  async link(client: KnowledgeSqlClient, edge: LineageEdge): Promise<"written" | "denied"> {
    if (edge.from === edge.to) return "written";
    const signature = sha256Hex(canonicalJson({ from: edge.from, to: edge.to, relation: edge.relation }));
    await client.query("savepoint lineage_edge");
    try {
      await client.query(
        `insert into orchestration.artifact_lineage(tenant_id,from_artifact_id,to_artifact_id,relation_kind,receipt_id,activity_id,activity_version,transformation_signature)
         values($1,$2,$3,$4,$5,'knowledge-executor',$6,$7)
         on conflict (tenant_id, from_artifact_id, to_artifact_id, relation_kind) do nothing`,
        [
          edge.tenantId,
          edge.from,
          edge.to,
          edge.relation,
          edge.receiptId ?? null,
          this.config.executorVersion,
          signature,
        ],
      );
      await client.query("release savepoint lineage_edge");
      return "written";
    } catch (error) {
      await client.query("rollback to savepoint lineage_edge");
      if ((error as { code?: string }).code === "42501") return "denied";
      throw error;
    }
  }

  async get(tenantId: string, artifactId: string): Promise<{ record: ArtifactRecord; json?: unknown; text?: string }> {
    const row = await this.config.db.transaction(
      { tenantId, role: "pipeline_agent", readOnly: true },
      async (client) =>
        (
          await client.query<ArtifactRow>(
            "select id,artifact_type,sha256,storage_bucket,object_path,storage_state,media_type,size_bytes from orchestration.artifact where tenant_id=$1 and id=$2",
            [tenantId, artifactId],
          )
        ).rows[0],
    );
    if (!row) throw domainError("ARTIFACT_NOT_FOUND", `no artifact ${artifactId} for this tenant`);
    const record: ArtifactRecord = {
      artifactId: row.id,
      artifactType: row.artifact_type,
      digest: `sha256:${row.sha256}`,
      bucket: row.storage_bucket,
      objectPath: row.object_path,
      storageState: row.storage_state,
      mediaType: row.media_type ?? "application/octet-stream",
      sizeBytes: Number(row.size_bytes ?? 0),
      reused: true,
    };
    const store =
      row.storage_bucket === this.config.bucket ? this.config.store : this.config.readStores?.[row.storage_bucket];
    if (!store)
      throw domainError("ARTIFACT_BUCKET_UNCONFIGURED", "No reader configured for the artifact's registered bucket", {
        bucket: row.storage_bucket,
      });
    const bytes = await store.get(tenantId, record.digest);
    if (!bytes) return { record };
    if (`sha256:${sha256Hex(bytes)}` !== record.digest || bytes.byteLength !== record.sizeBytes)
      throw infrastructureError(
        "ARTIFACT_INTEGRITY_FAILED",
        "Stored artifact bytes do not match their registered digest and size",
      );
    const text = Buffer.from(bytes).toString("utf8");
    if (record.mediaType.startsWith("application/json")) {
      try {
        return { record, json: JSON.parse(text) };
      } catch {
        /* fall through to text */
      }
    }
    return { record, text };
  }
}

interface ArtifactRow {
  id: string;
  artifact_type: string;
  sha256: string;
  storage_bucket: string;
  object_path: string;
  storage_state: string;
  media_type: string | null;
  size_bytes: string | number | null;
}

function encode(input: PutArtifactInput): { bytes: Uint8Array; mediaType: string } {
  if (input.text !== undefined)
    return {
      bytes: new TextEncoder().encode(input.text),
      mediaType: input.mediaType ?? "text/markdown; charset=utf-8",
    };
  return {
    bytes: new TextEncoder().encode(canonicalJson(input.value)),
    mediaType: input.mediaType ?? "application/json",
  };
}
