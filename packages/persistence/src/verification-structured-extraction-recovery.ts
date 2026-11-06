import {
  VerificationArtifactHandleSchema,
  VerificationStructuredExtractionPublicationSchema,
  VerificationStructuredExtractionFailureSchema,
  VerificationStructuredExtractionResultSchema,
  VerificationStructuredExtractionFailureResultSchema,
  type VerificationArtifactHandle,
  type VerificationStructuredExtractionPublication,
  type VerificationStructuredExtractionFailure,
  type VerificationStructuredExtractionResult,
  type VerificationStructuredExtractionFailureResult,
} from "@aiengineer/knowledge-contracts";
import {
  createStructuredExtractionOperationResult,
  createStructuredExtractionFailureOperationResult,
} from "@aiengineer/knowledge-application";
import {
  canonicalizeJson,
  sha256Digest,
  type TrustedArtifactResolver,
  type AuditBundleSignatureVerifier,
} from "@aiengineer/knowledge-verification";
import { deepFreeze } from "@aiengineer/knowledge-core";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
import type { LeasedStep } from "./types.js";

export type RecoveredStructuredExtractionPublication =
  | {
      readonly kind: "accepted";
      readonly manifest: VerificationStructuredExtractionPublication;
      readonly artifact: VerificationArtifactHandle;
      readonly result: VerificationStructuredExtractionResult;
    }
  | {
      readonly kind: "failed";
      readonly manifest: VerificationStructuredExtractionFailure;
      readonly artifact: VerificationArtifactHandle;
      readonly result: VerificationStructuredExtractionFailureResult;
    };
type Row = Record<string, unknown>;
const same = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b);
const active = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error("STRUCTURED_EXTRACTION_RECOVERY_CANCELLED");
};

/** Internal fenced recovery, preserving the committed accounting snapshot. No provider dispatch port. */
export class PostgresStructuredExtractionRecoveryStore {
  constructor(
    private readonly database: Pick<PostgresCanonicalRepository, "transaction">,
    private readonly createResolver: () => TrustedArtifactResolver,
    private readonly verifier: AuditBundleSignatureVerifier,
  ) {}

  async readPublished(input: {
    readonly lease: LeasedStep;
    readonly signal?: AbortSignal;
  }): Promise<RecoveredStructuredExtractionPublication | undefined> {
    const lease = deepFreeze(structuredClone(input.lease)),
      signal = input.signal;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    if (
      ![lease.tenantId, lease.operationId, lease.id, lease.leaseToken].every((v) => uuid.test(v)) ||
      lease.status !== "running" ||
      lease.stepKey !== "extract_and_register" ||
      !lease.holderIdentity?.trim() ||
      !Number.isSafeInteger(lease.fencingToken) ||
      lease.fencingToken < 1 ||
      !/^[0-9a-f]{64}$/u.test(lease.inputSha256)
    )
      throw new Error("STRUCTURED_EXTRACTION_RECOVERY_LEASE_INVALID");
    active(signal);
    const snapshot = await this.database.transaction(lease.tenantId, async (client) => {
      await live(client, lease);
      const row = (
        await client.query<Row>(
          `select
        exists(select 1 from orchestration.verification_structured_extraction_publication where tenant_id=$1 and operation_id=$2) accepted,
        exists(select 1 from orchestration.verification_structured_extraction_failure where tenant_id=$1 and operation_id=$2 and status='published') failed,
        orchestration.structured_extraction_result_body($1,$2) accepted_body,
        orchestration.structured_extraction_failure_result_body($1,$2) failed_body`,
          [lease.tenantId, lease.operationId],
        )
      ).rows[0];
      if (!row) throw new Error("STRUCTURED_EXTRACTION_RECOVERY_QUERY_LOST");
      if (row.accepted === true && row.failed === true) throw new Error("STRUCTURED_EXTRACTION_RECOVERY_AMBIGUOUS");
      if (row.accepted === true) {
        if (!row.accepted_body) throw new Error("STRUCTURED_EXTRACTION_RECOVERY_PUBLICATION_UNAVAILABLE");
        return {
          kind: "accepted" as const,
          result: VerificationStructuredExtractionResultSchema.parse(row.accepted_body),
        };
      }
      if (row.failed === true) {
        if (!row.failed_body) throw new Error("STRUCTURED_EXTRACTION_RECOVERY_PUBLICATION_UNAVAILABLE");
        return {
          kind: "failed" as const,
          result: VerificationStructuredExtractionFailureResultSchema.parse(row.failed_body),
        };
      }
      if (row.accepted_body !== null || row.failed_body !== null)
        throw new Error("STRUCTURED_EXTRACTION_RECOVERY_CANONICAL_DRIFT");
      return undefined;
    });
    active(signal);
    if (!snapshot) return undefined;
    const expected = deepFreeze(structuredClone(snapshot.result)),
      artifact = expected.resultArtifact;
    if (
      artifact.tenantId !== lease.tenantId ||
      expected.operationId !== lease.operationId ||
      artifact.byteLength > 256_000
    )
      throw new Error("STRUCTURED_EXTRACTION_RECOVERY_SCOPE_INVALID");
    const resolver = this.createResolver();
    await resolver.authorizeArtifact({
      tenantId: lease.tenantId,
      artifactId: artifact.artifactId,
      purpose: "verification_replay",
    });
    active(signal);
    const loaded = await resolver.hydrateRegisteredArtifact({
      tenantId: lease.tenantId,
      artifactId: artifact.artifactId,
    });
    active(signal);
    const bytes = loaded.bytes.slice(),
      registered = VerificationArtifactHandleSchema.parse(loaded.registration);
    if (
      !same(registered, artifact) ||
      bytes.byteLength !== artifact.byteLength ||
      sha256Digest(bytes) !== artifact.digest
    )
      throw new Error("STRUCTURED_EXTRACTION_RECOVERY_ARTIFACT_INVALID");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      decoded: unknown = JSON.parse(raw);
    if (canonicalizeJson(decoded) !== raw) throw new Error("STRUCTURED_EXTRACTION_RECOVERY_CANONICAL_BYTES_INVALID");
    let recovered: RecoveredStructuredExtractionPublication;
    if (snapshot.kind === "accepted") {
      const manifest = VerificationStructuredExtractionPublicationSchema.parse(decoded);
      const result = await createStructuredExtractionOperationResult({ manifest, artifact, verifier: this.verifier });
      recovered = { kind: "accepted", manifest, artifact, result };
    } else {
      const manifest = VerificationStructuredExtractionFailureSchema.parse(decoded);
      const result = await createStructuredExtractionFailureOperationResult({
        manifest,
        artifact,
        verifier: this.verifier,
      });
      recovered = { kind: "failed", manifest, artifact, result };
    }
    if (
      !same(recovered.result, expected) ||
      recovered.manifest.tenantId !== lease.tenantId ||
      recovered.manifest.operationId !== lease.operationId ||
      recovered.manifest.operationStepId !== lease.id ||
      recovered.manifest.stepInputDigest !== `sha256:${lease.inputSha256}`
    )
      throw new Error("STRUCTURED_EXTRACTION_RECOVERY_PUBLICATION_DRIFT");
    active(signal);
    // Hydration and signature verification can outlive a lease or cancellation.
    await this.database.transaction(lease.tenantId, (client) => live(client, lease));
    active(signal);
    return deepFreeze(recovered);
  }
}

async function live(client: TenantSqlClient, lease: LeasedStep): Promise<void> {
  const op = (
    await client.query<Row>(
      "select id from knowledge_service.operation where tenant_id=$1 and id=$2 and operation_kind='verification_structured_extraction' and status='running' for update",
      [lease.tenantId, lease.operationId],
    )
  ).rows[0];
  if (!op) throw new Error("STRUCTURED_EXTRACTION_RECOVERY_OPERATION_NOT_ACTIVE");
  const step = (
    await client.query<Row>(
      "select s.id from knowledge_service.operation_step s join knowledge_service.lease l on l.tenant_id=s.tenant_id and l.operation_step_id=s.id where s.tenant_id=$1 and s.operation_id=$2 and s.id=$3 and s.status='running' and s.step_key='extract_and_register' and s.input_sha256=$4 and l.lease_token=$5 and l.fencing_token=$6 and l.holder_identity=$7 and l.released_at is null and l.expires_at>clock_timestamp() for update of s,l",
      [
        lease.tenantId,
        lease.operationId,
        lease.id,
        lease.inputSha256,
        lease.leaseToken,
        lease.fencingToken,
        lease.holderIdentity,
      ],
    )
  ).rows[0];
  if (!step) throw new Error("STRUCTURED_EXTRACTION_RECOVERY_STALE_LEASE");
}
