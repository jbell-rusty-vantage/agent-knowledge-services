import {
  AssertionSchema,
  ResolvedSelectorSchema,
  VerificationArtifactHandleSchema,
  VerificationSelectorSchema,
  VerificationSourceCaptureSchema,
  VerificationSourceSchema,
  type Assertion,
  type ResolvedSelector,
  type VerificationArtifactHandle,
  type VerificationSelector,
  type VerificationSource,
  type VerificationSourceCapture,
} from "@aiengineer/knowledge-contracts";
import { digestCanonicalJson, sha256Digest, type TrustedArtifactResolver } from "@aiengineer/knowledge-verification";
import { deterministicUuid, type ArtifactStore } from "@aiengineer/knowledge-core";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";

type BucketClass = "source_captures" | "candidate" | "accepted" | "ledger" | "published";

export interface VerificationRunLease {
  readonly stepId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
  readonly holderIdentity: string;
}

const digestHex = (digest: string) => {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("INVALID_SHA256_DIGEST");
  return digest.slice(7);
};
const requireDigest = (digest: string): `sha256:${string}` => {
  digestHex(digest);
  return digest as `sha256:${string}`;
};
const requireUuid = (value: string, field: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error(`PERSISTENCE_CANONICAL_UUID_REQUIRED:${field}`);
  return value;
};
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
export interface ArtifactAuthorizationPort {
  authorize(input: {
    readonly tenantId: string;
    readonly artifactId: string;
    readonly purpose: "verification_replay" | "policy_replay" | "verification_admission";
  }): Promise<void>;
}

export interface CreateVerificationArtifactHandleInput {
  readonly tenantId: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly createdAt: string;
  readonly producerActivityId: string;
  readonly producerVersion: string;
  readonly encryptionClass: string;
  readonly retentionClass: string;
  readonly dataClassification: "public" | "internal" | "confidential" | "restricted";
  readonly parentArtifactIds?: readonly string[];
  readonly transformationSignature?: `sha256:${string}`;
  readonly attestationArtifactId?: string;
  readonly contentEncoding?: string;
}

export function createVerificationArtifactHandle(
  input: CreateVerificationArtifactHandleInput,
): VerificationArtifactHandle {
  const digest = sha256Digest(input.bytes);
  const artifactId = deterministicUuid("artifact", `${input.tenantId}:${digest}`);
  const createdAt = new Date(input.createdAt).toISOString();
  return VerificationArtifactHandleSchema.parse({
    artifactId,
    tenantId: input.tenantId,
    digest,
    mediaType: input.mediaType,
    byteLength: input.bytes.byteLength,
    objectKey: `${input.tenantId}/${digest.slice(7, 9)}/${digest.slice(7)}`,
    ...(input.contentEncoding ? { contentEncoding: input.contentEncoding } : {}),
    createdAt,
    producerActivityId: input.producerActivityId,
    producerVersion: input.producerVersion,
    encryptionClass: input.encryptionClass,
    retentionClass: input.retentionClass,
    dataClassification: input.dataClassification,
    parentArtifactIds: [...(input.parentArtifactIds ?? [])],
    ...(input.transformationSignature ? { transformationSignature: input.transformationSignature } : {}),
    ...(input.attestationArtifactId ? { attestationArtifactId: input.attestationArtifactId } : {}),
  });
}

export interface RegisterVerificationArtifactInput {
  readonly handle: VerificationArtifactHandle;
  readonly bytes: Uint8Array;
  readonly artifactType: string;
  readonly bucketClass: BucketClass;
  readonly storageBucket: string;
  readonly producerAttemptId?: string;
  readonly missionId?: string;
}

export interface RegisterContentAddressedVerificationArtifactInput extends CreateVerificationArtifactHandleInput {
  readonly artifactType: string;
  readonly bucketClass: BucketClass;
  readonly storageBucket: string;
  readonly producerAttemptId?: string;
  readonly missionId?: string;
}

interface ArtifactRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  artifact_type: string;
  schema_version: number;
  sha256: string;
  verification_contract_version: "verification.v1";
  bucket_class: BucketClass;
  storage_bucket: string;
  object_path: string;
  media_type: string;
  size_bytes: string | number;
  storage_state: "pending" | "available" | "failed";
  created_at: Date | string;
  producer_activity_id: string;
  producer_version: string;
  content_encoding: string | null;
  encryption_class: string;
  retention_class: string;
  data_classification: VerificationArtifactHandle["dataClassification"];
  parent_artifact_ids: string[];
  transformation_signature: string | null;
  attestation_artifact_id: string | null;
  logical_object_key?: string | null;
}

function handleFromRow(row: ArtifactRow): VerificationArtifactHandle {
  return VerificationArtifactHandleSchema.parse({
    artifactId: String(row.id),
    tenantId: String(row.tenant_id),
    digest: `sha256:${String(row.sha256)}`,
    mediaType: String(row.media_type),
    byteLength: Number(row.size_bytes),
    objectKey: String(row.logical_object_key ?? row.object_path),
    ...(row.content_encoding ? { contentEncoding: String(row.content_encoding) } : {}),
    createdAt: iso(row.created_at),
    producerActivityId: String(row.producer_activity_id),
    producerVersion: String(row.producer_version),
    encryptionClass: String(row.encryption_class),
    retentionClass: String(row.retention_class),
    dataClassification: row.data_classification,
    parentArtifactIds: row.parent_artifact_ids.map(String),
    ...(row.transformation_signature ? { transformationSignature: `sha256:${row.transformation_signature}` } : {}),
    ...(row.attestation_artifact_id ? { attestationArtifactId: String(row.attestation_artifact_id) } : {}),
  });
}

export class PostgresVerificationRepository {
  constructor(
    private readonly database: PostgresCanonicalRepository,
    private readonly artifacts: ArtifactStore,
    private readonly authorization: ArtifactAuthorizationPort,
  ) {}

  async #readArtifact(client: TenantSqlClient, tenantId: string, artifactId: string): Promise<ArtifactRow | undefined> {
    return (
      await client.query<ArtifactRow>(
        `select a.*,m.producer_activity_id,m.producer_version,m.content_encoding,
      m.encryption_class,m.retention_class,m.data_classification,m.parent_artifact_ids,m.transformation_signature,m.attestation_artifact_id,m.logical_object_key
      from orchestration.artifact a join orchestration.verification_artifact_metadata m
       on m.tenant_id=a.tenant_id and m.artifact_id=a.id where a.tenant_id=$1 and a.id=$2
       and a.verification_contract_version='verification.v1'`,
        [tenantId, artifactId],
      )
    ).rows[0];
  }

  async registerArtifact(
    inputValue: RegisterVerificationArtifactInput,
    fence?: { readonly producerAttemptId: string; readonly lease: VerificationRunLease },
  ): Promise<VerificationArtifactHandle> {
    const input = { ...inputValue, handle: VerificationArtifactHandleSchema.parse(inputValue.handle) };
    const { handle } = input;
    const storageKey = `${handle.tenantId}/${handle.digest.slice(7, 9)}/${handle.digest.slice(7)}`;
    requireUuid(handle.tenantId, "tenantId");
    requireUuid(handle.artifactId, "artifactId");
    if (handle.createdAt !== new Date(handle.createdAt).toISOString())
      throw new Error("ARTIFACT_CREATED_AT_NOT_CANONICAL");
    if (handle.downloadHandle) throw new Error("VOLATILE_DOWNLOAD_HANDLE_NOT_PERSISTABLE");
    if (sha256Digest(input.bytes) !== handle.digest || input.bytes.byteLength !== handle.byteLength)
      throw new Error("ARTIFACT_BYTES_DO_NOT_MATCH_HANDLE");
    if (handle.parentArtifactIds.length > 0 && !handle.transformationSignature)
      throw new Error("ARTIFACT_TRANSFORMATION_SIGNATURE_REQUIRED");
    const initialState = await this.database.transaction(handle.tenantId, async (client) => {
      if (fence) await this.#assertLiveArtifactLease(client, handle.tenantId, fence.producerAttemptId, fence.lease);
      for (const parentId of [
        ...handle.parentArtifactIds,
        ...(handle.attestationArtifactId ? [handle.attestationArtifactId] : []),
      ]) {
        const parent = (
          await client.query<{ id: string }>(
            `select a.id from orchestration.artifact a
          join orchestration.verification_artifact_metadata m on m.tenant_id=a.tenant_id and m.artifact_id=a.id
          where a.tenant_id=$1 and a.id=$2 and a.storage_state='available'
          and a.verification_contract_version='verification.v1'`,
            [handle.tenantId, parentId],
          )
        ).rows[0];
        if (!parent) throw new Error(`ARTIFACT_PARENT_NOT_AVAILABLE:${parentId}`);
      }
      await client.query(
        `insert into orchestration.artifact
        (id,tenant_id,artifact_type,schema_version,sha256,bucket_class,storage_bucket,object_path,media_type,size_bytes,
         producer_attempt_id,mission_id,created_at,storage_state,available_at,verification_contract_version)
        values($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',null,'verification.v1') on conflict do nothing`,
        [
          handle.artifactId,
          handle.tenantId,
          input.artifactType,
          input.handle.digest.slice(7),
          input.bucketClass,
          input.storageBucket,
          storageKey,
          handle.mediaType,
          handle.byteLength,
          input.producerAttemptId ?? null,
          input.missionId ?? null,
          handle.createdAt,
        ],
      );
      const marker = (
        await client.query<{ verification_contract_version: string | null }>(
          "select verification_contract_version from orchestration.artifact where tenant_id=$1 and id=$2",
          [handle.tenantId, handle.artifactId],
        )
      ).rows[0];
      if (marker?.verification_contract_version !== "verification.v1")
        throw new Error("ARTIFACT_REGISTRATION_COLLISION");
      await client.query(
        `insert into orchestration.verification_artifact_metadata
        (tenant_id,artifact_id,producer_activity_id,producer_version,content_encoding,encryption_class,retention_class,
         data_classification,parent_artifact_ids,transformation_signature,attestation_artifact_id,created_at,logical_object_key)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid[],$10,$11,$12,$13) on conflict do nothing`,
        [
          handle.tenantId,
          handle.artifactId,
          handle.producerActivityId,
          handle.producerVersion,
          handle.contentEncoding ?? null,
          handle.encryptionClass,
          handle.retentionClass,
          handle.dataClassification,
          handle.parentArtifactIds,
          handle.transformationSignature ? digestHex(handle.transformationSignature) : null,
          handle.attestationArtifactId ?? null,
          handle.createdAt,
          handle.objectKey === storageKey ? null : handle.objectKey,
        ],
      );
      for (const parentId of handle.parentArtifactIds)
        await client.query(
          `insert into orchestration.artifact_lineage
        (tenant_id,from_artifact_id,to_artifact_id,relation_kind,activity_id,activity_version,transformation_signature,created_at)
        values($1,$2,$3,'generated',$4,$5,$6,$7) on conflict do nothing`,
          [
            handle.tenantId,
            handle.artifactId,
            parentId,
            handle.producerActivityId,
            handle.producerVersion,
            digestHex(handle.transformationSignature!),
            handle.createdAt,
          ],
        );
      const stored = await this.#readArtifact(client, handle.tenantId, handle.artifactId);
      if (
        !stored ||
        stored.verification_contract_version !== "verification.v1" ||
        stored.storage_bucket !== input.storageBucket ||
        stored.artifact_type !== input.artifactType ||
        stored.bucket_class !== input.bucketClass ||
        stored.object_path !== storageKey ||
        digestCanonicalJson(handleFromRow(stored)) !== digestCanonicalJson(handle)
      ) {
        throw new Error("ARTIFACT_REGISTRATION_COLLISION");
      }
      return stored.storage_state;
    });
    if (initialState === "available") {
      const existing = await this.artifacts.get(handle.tenantId, handle.digest);
      if (!existing || existing.byteLength !== handle.byteLength || sha256Digest(existing) !== handle.digest)
        throw new Error("REGISTERED_ARTIFACT_BYTES_UNAVAILABLE");
      return handle;
    }
    try {
      await this.#ensureArtifactBytes(input, storageKey);
      await this.database.transaction(handle.tenantId, async (client) => {
        if (fence) await this.#assertLiveArtifactLease(client, handle.tenantId, fence.producerAttemptId, fence.lease);
        const row = (
          await client.query<{ storage_state: string }>(
            "select storage_state from orchestration.artifact where tenant_id=$1 and id=$2 for update",
            [handle.tenantId, handle.artifactId],
          )
        ).rows[0];
        if (!row) throw new Error("ARTIFACT_REGISTRATION_LOST");
        if (row.storage_state !== "available")
          await client.query(
            `update orchestration.artifact set storage_state='available',available_at=clock_timestamp(),registration_error_class=null where tenant_id=$1 and id=$2`,
            [handle.tenantId, handle.artifactId],
          );
      });
      return handle;
    } catch (error) {
      await this.database
        .transaction(handle.tenantId, async (client) => {
          if (fence) await this.#assertLiveArtifactLease(client, handle.tenantId, fence.producerAttemptId, fence.lease);
          await client.query(
            `update orchestration.artifact set storage_state='failed',available_at=null,registration_error_class='object_write_failed'
          where tenant_id=$1 and id=$2 and storage_state='pending'`,
            [handle.tenantId, handle.artifactId],
          );
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async #ensureArtifactBytes(input: RegisterVerificationArtifactInput, storageKey: string): Promise<void> {
    const { handle } = input;
    const existing = await this.artifacts.get(handle.tenantId, requireDigest(handle.digest));
    if (!existing) {
      try {
        const stored = await this.artifacts.put({
          tenantId: handle.tenantId,
          mediaType: handle.mediaType,
          bytes: input.bytes,
        });
        if (
          stored.tenantId !== handle.tenantId ||
          stored.digest !== handle.digest ||
          stored.mediaType !== handle.mediaType ||
          stored.byteLength !== handle.byteLength ||
          stored.storageKey !== storageKey
        ) {
          throw new Error("OBJECT_STORE_REGISTRATION_MISMATCH");
        }
      } catch (error) {
        if (error instanceof Error && error.message === "OBJECT_STORE_REGISTRATION_MISMATCH") throw error;
        // A successful upload can lose its acknowledgement. Only verified bytes recover it.
        const recovered = await this.artifacts
          .get(handle.tenantId, requireDigest(handle.digest))
          .catch(() => undefined);
        if (!recovered || recovered.byteLength !== handle.byteLength || sha256Digest(recovered) !== handle.digest)
          throw error;
      }
    }
    const hydrated = await this.artifacts.get(handle.tenantId, requireDigest(handle.digest));
    if (!hydrated || hydrated.byteLength !== handle.byteLength || sha256Digest(hydrated) !== handle.digest)
      throw new Error("OBJECT_STORE_WRITE_NOT_VERIFIED");
  }

  async registerLogicalArtifact(
    input: RegisterVerificationArtifactInput,
    fence?: { readonly producerAttemptId: string; readonly lease: VerificationRunLease },
  ): Promise<VerificationArtifactHandle> {
    return this.registerArtifact(input, fence);
  }

  /** Metadata discovery is not an availability acknowledgement; callers must still register or hydrate bytes. */
  async getLogicalArtifactRegistration(input: { readonly tenantId: string; readonly artifactId: string }): Promise<
    | {
        handle: VerificationArtifactHandle;
        storageState: "pending" | "available" | "failed";
      }
    | undefined
  > {
    requireUuid(input.tenantId, "tenantId");
    requireUuid(input.artifactId, "artifactId");
    await this.authorization.authorize({ ...input, purpose: "verification_replay" });
    const row = await this.database.transaction(input.tenantId, (client) =>
      this.#readArtifact(client, input.tenantId, input.artifactId),
    );
    return row ? { handle: handleFromRow(row), storageState: row.storage_state } : undefined;
  }

  async getLogicalArtifact(input: {
    readonly tenantId: string;
    readonly artifactId: string;
  }): Promise<{ handle: VerificationArtifactHandle; bytes: Uint8Array } | undefined> {
    requireUuid(input.tenantId, "tenantId");
    requireUuid(input.artifactId, "artifactId");
    await this.authorization.authorize({ ...input, purpose: "verification_replay" });
    const row = await this.database.transaction(input.tenantId, (client) =>
      this.#readArtifact(client, input.tenantId, input.artifactId),
    );
    if (!row) return undefined;
    const hydrated = await this.#hydrateRegisteredArtifact(input);
    return { handle: hydrated.registration, bytes: hydrated.bytes };
  }

  /**
   * Registers content identity once and returns the original immutable metadata on reuse.
   * This is the application-facing CAS operation; callers must represent each new
   * parent-specific derivation with a separate transformation artifact.
   */
  async registerContentAddressedArtifact(
    input: RegisterContentAddressedVerificationArtifactInput,
  ): Promise<VerificationArtifactHandle> {
    const proposed = createVerificationArtifactHandle(input);
    const existing = await this.database.transaction(input.tenantId, async (client) =>
      this.#readArtifact(client, input.tenantId, proposed.artifactId),
    );
    if (existing)
      return this.#verifyReusableArtifact(existing, input, requireDigest(proposed.digest), proposed.byteLength);
    try {
      return await this.registerArtifact({
        handle: proposed,
        bytes: input.bytes,
        artifactType: input.artifactType,
        bucketClass: input.bucketClass,
        storageBucket: input.storageBucket,
        ...(input.producerAttemptId ? { producerAttemptId: input.producerAttemptId } : {}),
        ...(input.missionId ? { missionId: input.missionId } : {}),
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "ARTIFACT_REGISTRATION_COLLISION") throw error;
      const raced = await this.database.transaction(input.tenantId, async (client) =>
        this.#readArtifact(client, input.tenantId, proposed.artifactId),
      );
      if (!raced) throw error;
      return this.#verifyReusableArtifact(raced, input, requireDigest(proposed.digest), proposed.byteLength);
    }
  }

  /** Makes artifact availability conditional on the live operation step lease. */
  async registerFencedContentAddressedArtifact(input: {
    readonly artifact: RegisterContentAddressedVerificationArtifactInput;
    readonly lease: VerificationRunLease;
  }): Promise<VerificationArtifactHandle> {
    const artifact = input.artifact;
    if (!artifact.producerAttemptId) throw new Error("VERIFICATION_ARTIFACT_PRODUCER_ATTEMPT_REQUIRED");
    const proposed = createVerificationArtifactHandle(artifact);
    const existing = await this.database.transaction(artifact.tenantId, async (client) => {
      await this.#assertLiveArtifactLease(client, artifact.tenantId, artifact.producerAttemptId!, input.lease);
      return this.#readArtifact(client, artifact.tenantId, proposed.artifactId);
    });
    if (existing)
      return this.#verifyReusableArtifact(
        existing,
        artifact,
        requireDigest(proposed.digest),
        proposed.byteLength,
        input.lease,
      );
    try {
      return await this.registerArtifact(
        {
          handle: proposed,
          bytes: artifact.bytes,
          artifactType: artifact.artifactType,
          bucketClass: artifact.bucketClass,
          storageBucket: artifact.storageBucket,
          producerAttemptId: artifact.producerAttemptId,
          ...(artifact.missionId ? { missionId: artifact.missionId } : {}),
        },
        { producerAttemptId: artifact.producerAttemptId, lease: input.lease },
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "ARTIFACT_REGISTRATION_COLLISION") throw error;
      const raced = await this.database.transaction(artifact.tenantId, async (client) => {
        await this.#assertLiveArtifactLease(client, artifact.tenantId, artifact.producerAttemptId!, input.lease);
        return this.#readArtifact(client, artifact.tenantId, proposed.artifactId);
      });
      if (!raced) throw error;
      return this.#verifyReusableArtifact(
        raced,
        artifact,
        requireDigest(proposed.digest),
        proposed.byteLength,
        input.lease,
      );
    }
  }

  async #verifyReusableArtifact(
    row: ArtifactRow,
    input: RegisterContentAddressedVerificationArtifactInput,
    digest: `sha256:${string}`,
    byteLength: number,
    lease?: VerificationRunLease,
  ): Promise<VerificationArtifactHandle> {
    const registration = handleFromRow(row);
    if (
      row.artifact_type !== input.artifactType ||
      row.bucket_class !== input.bucketClass ||
      row.storage_bucket !== input.storageBucket ||
      registration.digest !== digest ||
      registration.byteLength !== byteLength ||
      registration.mediaType !== input.mediaType ||
      registration.objectKey !== `${input.tenantId}/${digest.slice(7, 9)}/${digest.slice(7)}` ||
      registration.contentEncoding !== input.contentEncoding ||
      registration.encryptionClass !== input.encryptionClass ||
      registration.retentionClass !== input.retentionClass ||
      registration.dataClassification !== input.dataClassification ||
      digestCanonicalJson(registration.parentArtifactIds) !== digestCanonicalJson(input.parentArtifactIds ?? []) ||
      registration.transformationSignature !== input.transformationSignature ||
      registration.attestationArtifactId !== input.attestationArtifactId
    ) {
      throw new Error("ARTIFACT_REGISTRATION_COLLISION");
    }
    if (row.storage_state !== "available")
      return this.registerArtifact(
        {
          handle: registration,
          bytes: input.bytes,
          artifactType: input.artifactType,
          bucketClass: input.bucketClass,
          storageBucket: input.storageBucket,
          ...(input.producerAttemptId ? { producerAttemptId: input.producerAttemptId } : {}),
          ...(input.missionId ? { missionId: input.missionId } : {}),
        },
        lease && input.producerAttemptId ? { producerAttemptId: input.producerAttemptId, lease } : undefined,
      );
    const bytes = await this.artifacts.get(input.tenantId, digest);
    if (
      !bytes ||
      bytes.byteLength !== byteLength ||
      sha256Digest(bytes) !== digest ||
      sha256Digest(input.bytes) !== digest
    ) {
      throw new Error("REGISTERED_ARTIFACT_BYTES_UNAVAILABLE");
    }
    return registration;
  }

  async getRegisteredCapture(input: {
    readonly tenantId: string;
    readonly captureId: string;
  }): Promise<{ source: VerificationSource; capture: VerificationSourceCapture }> {
    requireUuid(input.tenantId, "tenantId");
    requireUuid(input.captureId, "captureId");
    return this.database.transaction(input.tenantId, async (client) => {
      const row = (
        await client.query<Record<string, unknown>>(
          `select c.*,s.source_class,s.canonical_url,s.logical_identity
        from evidence.source_capture c join evidence.source s on s.tenant_id=c.tenant_id and s.id=c.source_id
        where c.tenant_id=$1 and c.id=$2`,
          [input.tenantId, input.captureId],
        )
      ).rows[0];
      if (!row) throw new Error("CAPTURE_NOT_REGISTERED");
      const artifact = await this.#readArtifact(client, input.tenantId, String(row.artifact_id));
      if (!artifact || artifact.storage_state !== "available") throw new Error("CAPTURE_ARTIFACT_NOT_AVAILABLE");
      const source = VerificationSourceSchema.parse({
        sourceId: String(row.source_id),
        kind: String(row.source_class),
        canonicalUri: String(row.canonical_url),
        logicalIdentity: String(row.logical_identity),
      });
      const context =
        row.context !== null && typeof row.context === "object" ? (row.context as Record<string, unknown>) : {};
      const capture = VerificationSourceCaptureSchema.parse({
        captureId: String(row.id),
        sourceId: String(row.source_id),
        capturedAt: iso(row.captured_at),
        ...(typeof context.effectiveAt === "string" ? { effectiveAt: context.effectiveAt } : {}),
        captureMethod: String(row.capture_method),
        captureMethodVersion: String(row.capture_method_version),
        contentArtifact: handleFromRow(artifact),
      });
      return { source, capture };
    });
  }

  async #hydrateRegisteredArtifact(input: { tenantId: string; artifactId: string }) {
    const row = await this.database.transaction(input.tenantId, async (client) =>
      this.#readArtifact(client, input.tenantId, input.artifactId),
    );
    if (!row || row.storage_state !== "available") throw new Error("ARTIFACT_NOT_AVAILABLE");
    const registration = handleFromRow(row);
    const bytes = await this.artifacts.get(input.tenantId, requireDigest(registration.digest));
    if (!bytes || bytes.byteLength !== registration.byteLength || sha256Digest(bytes) !== registration.digest)
      throw new Error("ARTIFACT_HYDRATION_INTEGRITY_FAILURE");
    return { registration, bytes };
  }

  /** A resolver is single-request state: authorization is consumed by the next matching hydration. */
  createTrustedArtifactResolver(): TrustedArtifactResolver {
    let ticket: { tenantId: string; artifactId: string } | undefined;
    return {
      authorizeArtifact: async (input) => {
        requireUuid(input.tenantId, "tenantId");
        requireUuid(input.artifactId, "artifactId");
        if (ticket) throw new Error("ARTIFACT_AUTHORIZATION_ALREADY_PENDING");
        await this.authorization.authorize(input);
        ticket = { tenantId: input.tenantId, artifactId: input.artifactId };
      },
      hydrateRegisteredArtifact: async (input) => {
        if (!ticket || ticket.tenantId !== input.tenantId || ticket.artifactId !== input.artifactId) {
          throw new Error("ARTIFACT_HYDRATION_NOT_AUTHORIZED");
        }
        ticket = undefined;
        return this.#hydrateRegisteredArtifact(input);
      },
    };
  }

  async recordCapture(input: {
    tenantId: string;
    source: VerificationSource;
    capture: VerificationSourceCapture;
    producerAttemptId: string;
  }): Promise<void> {
    const source = VerificationSourceSchema.parse(input.source);
    const capture = VerificationSourceCaptureSchema.parse(input.capture);
    for (const [field, value] of [
      ["source.sourceId", source.sourceId],
      ["capture.captureId", capture.captureId],
      ["producerAttemptId", input.producerAttemptId],
    ] as const)
      requireUuid(value, field);
    if (source.sourceId !== capture.sourceId || capture.contentArtifact.tenantId !== input.tenantId)
      throw new Error("CAPTURE_IDENTITY_MISMATCH");
    await this.database.transaction(input.tenantId, async (client) => {
      await client.query(
        `insert into evidence.source(id,tenant_id,source_class,canonical_url,sensitivity,verification_contract_version,logical_identity)
        values($1,$2,$3,$4,$5,'verification.v1',$6) on conflict(tenant_id,source_class,logical_identity) do nothing`,
        [
          source.sourceId,
          input.tenantId,
          source.kind,
          source.canonicalUri,
          capture.contentArtifact.dataClassification === "public" ? "public" : "restricted",
          source.logicalIdentity,
        ],
      );
      const storedSource = (
        await client.query<Record<string, unknown>>("select * from evidence.source where tenant_id=$1 and id=$2", [
          input.tenantId,
          source.sourceId,
        ])
      ).rows[0];
      if (
        !storedSource ||
        storedSource.source_class !== source.kind ||
        storedSource.canonical_url !== source.canonicalUri ||
        storedSource.logical_identity !== source.logicalIdentity
      )
        throw new Error("SOURCE_IDENTITY_COLLISION");
      await client.query(
        `insert into evidence.source_capture
        (id,tenant_id,source_id,artifact_id,content_sha256,media_type,captured_at,capture_method,capture_method_version,context,produced_by_attempt_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) on conflict(id) do nothing`,
        [
          capture.captureId,
          input.tenantId,
          source.sourceId,
          capture.contentArtifact.artifactId,
          digestHex(capture.contentArtifact.digest),
          capture.contentArtifact.mediaType,
          capture.capturedAt,
          capture.captureMethod,
          capture.captureMethodVersion,
          JSON.stringify({ effectiveAt: capture.effectiveAt ?? null }),
          input.producerAttemptId,
        ],
      );
      const storedCapture = (
        await client.query<Record<string, unknown>>(
          "select * from evidence.source_capture where tenant_id=$1 and id=$2",
          [input.tenantId, capture.captureId],
        )
      ).rows[0];
      const expectedContext = { effectiveAt: capture.effectiveAt ?? null };
      if (
        !storedCapture ||
        storedCapture.source_id !== source.sourceId ||
        storedCapture.artifact_id !== capture.contentArtifact.artifactId ||
        storedCapture.content_sha256 !== digestHex(capture.contentArtifact.digest) ||
        storedCapture.media_type !== capture.contentArtifact.mediaType ||
        iso(storedCapture.captured_at) !== capture.capturedAt ||
        storedCapture.capture_method !== capture.captureMethod ||
        storedCapture.capture_method_version !== capture.captureMethodVersion ||
        storedCapture.produced_by_attempt_id !== input.producerAttemptId ||
        digestCanonicalJson(storedCapture.context) !== digestCanonicalJson(expectedContext)
      )
        throw new Error("CAPTURE_IDENTITY_COLLISION");
    });
  }

  async recordResolvedLocator(input: {
    tenantId: string;
    locatorId: string;
    captureId: string;
    mediaType: string;
    selector: VerificationSelector;
    resolution: ResolvedSelector;
    selectedBytes: Uint8Array;
    producerAttemptId: string;
  }): Promise<void> {
    for (const [field, value] of [
      ["locatorId", input.locatorId],
      ["captureId", input.captureId],
      ["producerAttemptId", input.producerAttemptId],
    ] as const)
      requireUuid(value, field);
    const selector = VerificationSelectorSchema.parse(input.selector);
    const resolution = ResolvedSelectorSchema.parse(input.resolution);
    if (resolution.status !== "resolved" || resolution.selectedContentDigest === undefined)
      throw new Error("LOCATOR_MUST_BE_RESOLVED");
    const selectedContentDigest = resolution.selectedContentDigest;
    if (
      resolution.captureId !== input.captureId ||
      selectedContentDigest !== sha256Digest(input.selectedBytes) ||
      resolution.selectorDigest !== digestCanonicalJson(selector)
    )
      throw new Error("LOCATOR_RESOLUTION_BINDING_MISMATCH");
    await this.database.transaction(input.tenantId, async (client) => {
      await client.query(
        `insert into evidence.locator
       (id,tenant_id,verification_contract_version,capture_id,representation_artifact_id,media_type,selector,selector_sha256,
        selected_content_sha256,selected_size_bytes,occurrence_count,resolution_state,normalization_policy,resolution_version,
        extractor_name,extractor_version,extraction_params)
       values($1,$2,'verification.v1',$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,'knowledge-verification',$13,'{}'::jsonb)`,
        [
          input.locatorId,
          input.tenantId,
          input.captureId,
          resolution.representationArtifactId,
          input.mediaType,
          JSON.stringify(selector),
          digestHex(resolution.selectorDigest),
          digestHex(selectedContentDigest),
          input.selectedBytes.byteLength,
          resolution.occurrenceCount,
          resolution.status,
          resolution.normalization,
          resolution.resolverVersion,
        ],
      );
      await client.query(
        `insert into evidence.extraction_signature
       (tenant_id,verification_contract_version,locator_id,signature_sha256,produced_by_attempt_id)
       values($1,'verification.v1',$2,$3,$4)`,
        [
          input.tenantId,
          input.locatorId,
          digestHex(digestCanonicalJson({ captureId: input.captureId, selector, resolution })),
          input.producerAttemptId,
        ],
      );
    });
  }

  async recordAssertion(input: { tenantId: string; assertion: Assertion; producerAttemptId: string }): Promise<void> {
    const assertion = AssertionSchema.parse(input.assertion);
    for (const [field, value] of [
      ["assertion.assertionId", assertion.assertionId],
      ["producerAttemptId", input.producerAttemptId],
      ["assertion.producer.attemptId", assertion.producer.attemptId],
    ] as const)
      requireUuid(value, field);
    if (assertion.producer.attemptId !== input.producerAttemptId)
      throw new Error("ASSERTION_PRODUCER_ATTEMPT_MISMATCH");
    if (!assertion.proposition || !assertion.claimType) throw new Error("PERSISTENCE_CLAIM_ASSERTION_REQUIRED");
    const structured = {
      value: assertion.value ?? null,
      qualifiers: assertion.qualifiers,
      entityBindings: assertion.entityBindings,
      derivation: assertion.derivation,
      intent: assertion.intent,
      riskClass: assertion.riskClass,
      downstreamUse: assertion.downstreamUse,
    };
    await this.database.transaction(input.tenantId, async (client) => {
      await client.query(
        `insert into evidence.claim(id,tenant_id,claim_type,statement,structured,status,composite,producer_attempt_id)
        values($1,$2,$3,$4,$5::jsonb,'proposed',$6,$7) on conflict(id) do nothing`,
        [
          assertion.assertionId,
          input.tenantId,
          assertion.claimType,
          assertion.proposition,
          JSON.stringify(structured),
          !assertion.atomic,
          input.producerAttemptId,
        ],
      );
      const row = (
        await client.query<Record<string, unknown>>("select * from evidence.claim where tenant_id=$1 and id=$2", [
          input.tenantId,
          assertion.assertionId,
        ])
      ).rows[0];
      if (
        !row ||
        row.claim_type !== assertion.claimType ||
        row.statement !== assertion.proposition ||
        row.composite !== !assertion.atomic ||
        row.producer_attempt_id !== input.producerAttemptId ||
        digestCanonicalJson(row.structured) !== digestCanonicalJson(structured)
      ) {
        throw new Error("ASSERTION_IDENTITY_COLLISION");
      }
    });
  }

  async #assertLiveArtifactLease(
    client: TenantSqlClient,
    tenantId: string,
    producerAttemptId: string,
    lease: VerificationRunLease,
  ): Promise<void> {
    requireUuid(tenantId, "tenantId");
    requireUuid(producerAttemptId, "producerAttemptId");
    requireUuid(lease.stepId, "lease.stepId");
    if (
      !lease.leaseToken.trim() ||
      !lease.holderIdentity.trim() ||
      !Number.isSafeInteger(lease.fencingToken) ||
      lease.fencingToken < 1
    )
      throw new Error("VERIFICATION_RUN_LEASE_INVALID");
    const binding = (
      await client.query<{ operation_id: string }>(
        "select operation_id from knowledge_service.operation_step where tenant_id=$1 and id=$2",
        [tenantId, lease.stepId],
      )
    ).rows[0];
    if (!binding) throw new Error("VERIFICATION_RUN_STALE_LEASE");
    const operation = (
      await client.query<{ id: string; attempt_id: string | null; status: string }>(
        "select id,attempt_id,status from knowledge_service.operation where tenant_id=$1 and id=$2 for update",
        [tenantId, binding.operation_id],
      )
    ).rows[0];
    if (!operation || operation.status !== "running" || operation.attempt_id !== producerAttemptId)
      throw new Error("VERIFICATION_RUN_STALE_LEASE");
    await this.#assertLiveOperationLease(client, tenantId, operation.id, lease);
  }

  async #assertLiveOperationLease(
    client: TenantSqlClient,
    tenantId: string,
    operationId: string,
    lease: VerificationRunLease,
  ): Promise<void> {
    // recordVerificationRun already holds the operation row. CompleteStep holds
    // lease/step then locks that operation, so this intentionally does not add
    // an inverse operation -> lease/step lock. The operation lock is the
    // linearization point for a cancellation or completion transition.
    const row = (
      await client.query<{ id: string }>(
        `select step.id from knowledge_service.operation_step step
      join knowledge_service.lease lease on lease.tenant_id=step.tenant_id and lease.operation_step_id=step.id
      where step.tenant_id=$1 and step.id=$2 and step.operation_id=$3 and lease.lease_token=$4
       and lease.fencing_token=$5 and lease.holder_identity=$6 and lease.released_at is null
       and lease.expires_at>clock_timestamp() and step.status='running'`,
        [tenantId, lease.stepId, operationId, lease.leaseToken, lease.fencingToken, lease.holderIdentity],
      )
    ).rows[0];
    if (!row) throw new Error("VERIFICATION_RUN_STALE_LEASE");
  }
}
