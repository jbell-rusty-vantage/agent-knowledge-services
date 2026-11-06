import {
  VerificationArtifactHandleSchema,
  VerificationStructuredExtractionPublicationSchema,
  type VerificationArtifactHandle,
  type VerificationStructuredExtractionPublication,
} from "@aiengineer/knowledge-contracts";
import {
  structuredExtractionPublicationParentArtifactIds,
  structuredExtractionPublicationTransformationSignature,
  structuredExtractionProviderCallDigest,
} from "@aiengineer/knowledge-application";
import {
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  type AuditBundleSignatureVerifier,
} from "@aiengineer/knowledge-verification";
import { deepFreeze } from "@aiengineer/knowledge-core";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
import type { LeasedStep } from "./types.js";

type Row = Record<string, unknown>;
type Digest = `sha256:${string}`;
const hex = (value: string) => value.slice(7);
const same = (a: unknown, b: unknown) => canonicalizeJson(a) === canonicalizeJson(b);
const iso = (value: unknown) => new Date(value as string).toISOString();
export interface StructuredExtractionPublicationBinding {
  readonly tenantId: string;
  readonly operationId: string;
  readonly publicationArtifactId: string;
  readonly publicationDigest: Digest;
  readonly sealPayloadDigest: Digest;
  readonly providerCallDigest: Digest;
  readonly publishedAt: string;
}
function project(row: Row): StructuredExtractionPublicationBinding {
  return deepFreeze({
    tenantId: String(row.tenant_id),
    operationId: String(row.operation_id),
    publicationArtifactId: String(row.publication_artifact_id),
    publicationDigest: `sha256:${row.publication_sha256}`,
    sealPayloadDigest: `sha256:${row.seal_payload_sha256}`,
    providerCallDigest: `sha256:${row.provider_call_sha256}`,
    publishedAt: iso(row.published_at),
  });
}

/** Commits an authenticated custody publication. Terminal operation receipts are a separate boundary. */
export class PostgresStructuredExtractionPublicationStore {
  constructor(
    private readonly database: Pick<PostgresCanonicalRepository, "transaction">,
    private readonly verifier: AuditBundleSignatureVerifier,
  ) {}
  async publish(input: {
    readonly lease: LeasedStep;
    readonly manifest: VerificationStructuredExtractionPublication;
    readonly artifact: VerificationArtifactHandle;
  }): Promise<StructuredExtractionPublicationBinding> {
    const lease = deepFreeze(structuredClone(input.lease));
    const manifest = deepFreeze(VerificationStructuredExtractionPublicationSchema.parse(input.manifest));
    const artifact = deepFreeze(VerificationArtifactHandleSchema.parse(input.artifact));
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    if (
      ![lease.tenantId, lease.operationId, lease.id, lease.leaseToken].every((v) => uuid.test(v)) ||
      lease.status !== "running" ||
      lease.stepKey !== "extract_and_register" ||
      !lease.holderIdentity?.trim() ||
      !Number.isSafeInteger(lease.fencingToken) ||
      lease.fencingToken < 1 ||
      !/^[0-9a-f]{64}$/u.test(lease.inputSha256) ||
      lease.tenantId !== manifest.tenantId ||
      lease.operationId !== manifest.operationId ||
      lease.id !== manifest.operationStepId ||
      lease.inputSha256 !== hex(manifest.stepInputDigest)
    )
      throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_LEASE_INVALID");
    const { seal, ...body } = manifest,
      bytes = new TextEncoder().encode(canonicalizeJson(manifest));
    const payloadDigest = sha256Digest(bytes),
      parents = structuredExtractionPublicationParentArtifactIds(manifest);
    const signature = structuredExtractionPublicationTransformationSignature({
      payloadDigest,
      sealPayloadDigest: seal.payloadDigest as Digest,
      tenantId: manifest.tenantId,
      operationId: manifest.operationId,
      operationStepId: manifest.operationStepId,
      producerAttemptId: manifest.producerAttemptId,
      executionDigest: manifest.execution.payloadDigest as Digest,
      candidateDigest: manifest.output.candidateArtifact.digest as Digest,
      provenanceDigest: manifest.output.provenanceArtifact.digest as Digest,
      providerCallDigest: manifest.providerCallDigest as Digest,
      originalDispatchFencingToken: manifest.response.capture.dispatchFencingToken,
      startedAt: manifest.startedAt,
      retentionStartedAt: manifest.retentionStartedAt,
      completedAt: manifest.completedAt,
      parentArtifactIds: parents,
    });
    if (
      digestCanonicalJson(body) !== seal.payloadDigest ||
      structuredExtractionProviderCallDigest(manifest.providerCall) !== manifest.providerCallDigest ||
      digestCanonicalJson(manifest.execution.manifest) !== manifest.execution.payloadDigest ||
      digestCanonicalJson(manifest.execution.manifest.runtime) !== manifest.execution.runtimeDigest ||
      artifact.tenantId !== manifest.tenantId ||
      artifact.digest !== payloadDigest ||
      artifact.byteLength !== bytes.byteLength ||
      artifact.createdAt !== manifest.completedAt ||
      !same(artifact.parentArtifactIds, parents) ||
      artifact.transformationSignature !== signature
    )
      throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_PAYLOAD_INVALID");
    if (
      !(await this.verifier.verify({
        keyId: seal.signature.keyId,
        payload: new TextEncoder().encode(canonicalizeJson(body)),
        signatureBase64: seal.signature.signatureBase64,
      }))
    )
      throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_SIGNATURE_INVALID");
    return this.database.transaction(lease.tenantId, async (client) => {
      await live(client, lease, manifest);
      const prior = (
        await client.query<Row>(
          "select * from orchestration.verification_structured_extraction_publication where tenant_id=$1 and operation_id=$2 for update",
          [lease.tenantId, lease.operationId],
        )
      ).rows[0];
      if (prior) {
        const found = project(prior);
        if (
          found.publicationArtifactId !== artifact.artifactId ||
          found.publicationDigest !== artifact.digest ||
          found.sealPayloadDigest !== seal.payloadDigest ||
          found.providerCallDigest !== manifest.providerCallDigest
        )
          throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_BINDING_DRIFT");
        return found;
      }
      await canonical(client, manifest);
      const row = (
        await client.query<Row>(
          "insert into orchestration.verification_structured_extraction_publication(tenant_id,operation_id,publication_artifact_id,publication_sha256,seal_payload_sha256,provider_call_sha256) values($1,$2,$3,$4,$5,$6) returning *",
          [
            lease.tenantId,
            lease.operationId,
            artifact.artifactId,
            hex(artifact.digest),
            hex(seal.payloadDigest),
            hex(manifest.providerCallDigest),
          ],
        )
      ).rows[0];
      if (!row) throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_INSERT_LOST");
      return project(row);
    });
  }
}

async function live(
  client: TenantSqlClient,
  lease: LeasedStep,
  manifest: VerificationStructuredExtractionPublication,
): Promise<void> {
  const op = (
    await client.query<Row>(
      "select attempt_id,request_sha256 from knowledge_service.operation where tenant_id=$1 and id=$2 and operation_kind='verification_structured_extraction' and status='running' for update",
      [lease.tenantId, lease.operationId],
    )
  ).rows[0];
  if (!op || op.attempt_id !== manifest.producerAttemptId || op.request_sha256 !== hex(manifest.requestDigest))
    throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_OPERATION_NOT_ACTIVE");
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
  if (!step) throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_STALE_LEASE");
  await client.query("select set_config('verification.structured_extraction_claim',$1,true)", [
    JSON.stringify({
      stepId: lease.id,
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
      holderIdentity: lease.holderIdentity,
    }),
  ]);
}

async function canonical(client: TenantSqlClient, m: VerificationStructuredExtractionPublication): Promise<void> {
  const execution = (
    await client.query<Row>(
      "select * from orchestration.verification_structured_extraction_execution where tenant_id=$1 and operation_id=$2 for update",
      [m.tenantId, m.operationId],
    )
  ).rows[0];
  const lifecycle = (
    await client.query<Row>(
      "select * from orchestration.verification_structured_extraction where tenant_id=$1 and operation_id=$2 for update",
      [m.tenantId, m.operationId],
    )
  ).rows[0];
  if (!execution || !lifecycle) throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_CANONICAL_RECORD_MISSING");
  const fields: Record<string, unknown> = {
    tenant_id: m.tenantId,
    operation_id: m.operationId,
    operation_step_id: m.operationStepId,
    producer_attempt_id: m.producerAttemptId,
    request_sha256: hex(m.requestDigest),
    step_input_sha256: hex(m.stepInputDigest),
    profile_artifact_id: m.input.profileArtifact.artifactId,
    profile_sha256: hex(m.input.profileArtifact.digest),
  };
  assertFields(execution, {
    ...fields,
    execution_artifact_id: m.execution.artifact.artifactId,
    execution_sha256: hex(m.execution.payloadDigest),
    runtime_sha256: hex(m.execution.runtimeDigest),
    execution_mode: m.execution.manifest.execution.mode,
    dirty_artifact_id: m.execution.manifest.runtime.code.dirtyStateArtifact?.artifactId ?? null,
    dirty_sha256: m.execution.manifest.runtime.code.dirtyStateArtifact
      ? hex(m.execution.manifest.runtime.code.dirtyStateArtifact.digest)
      : null,
  });
  if (iso(execution.execution_created_at) !== m.execution.manifest.createdAt)
    throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_CANONICAL_DRIFT");
  assertFields(lifecycle, {
    ...fields,
    status: "retained",
    identity_sha256: hex(m.lifecycleIdentityDigest),
    capture_id: m.input.captureId,
    schema_artifact_id: m.input.schemaArtifact.artifactId,
    schema_artifact_sha256: hex(m.input.schemaArtifact.digest),
    source_artifact_id: m.input.sourceArtifact.artifactId,
    source_sha256: hex(m.input.sourceArtifact.digest),
    representation_artifact_id: m.input.representationArtifact.artifactId,
    representation_sha256: hex(m.input.representationArtifact.digest),
    transformation_artifact_id: m.input.transformationArtifact.artifactId,
    transformation_sha256: hex(m.input.transformationArtifact.digest),
    prompt_sha256: hex(m.input.promptDigest),
    schema_digest_sha256: hex(m.input.schemaDigest),
    provider_attempt_id: m.response.capture.providerAttemptId,
    provider_request_artifact_id: m.response.providerRequestArtifact.artifactId,
    provider_request_sha256: hex(m.response.providerRequestArtifact.digest),
    raw_response_artifact_id: m.response.rawResponseArtifact.artifactId,
    raw_response_sha256: hex(m.response.rawResponseArtifact.digest),
    response_envelope_artifact_id: m.response.responseEnvelopeArtifact.artifactId,
    response_envelope_sha256: hex(m.response.responseEnvelopeArtifact.digest),
    transport_artifact_id: m.response.transportArtifact.artifactId,
    transport_sha256: hex(m.response.transportArtifact.digest),
    candidate_artifact_id: m.output.candidateArtifact.artifactId,
    candidate_sha256: hex(m.output.candidateArtifact.digest),
    provenance_artifact_id: m.output.provenanceArtifact.artifactId,
    provenance_sha256: hex(m.output.provenanceArtifact.digest),
    precontext_artifact_id: m.output.precontextArtifact?.artifactId ?? null,
    precontext_sha256: m.output.precontextArtifact ? hex(m.output.precontextArtifact.digest) : null,
  });
  if (
    Number(lifecycle.original_dispatch_fencing_token) !== m.response.capture.dispatchFencingToken ||
    Number(lifecycle.http_status) !== m.response.capture.httpStatus ||
    iso(lifecycle.captured_at) !== m.response.capture.capturedAt ||
    iso(lifecycle.started_at) !== m.startedAt ||
    iso(lifecycle.retention_started_at) !== m.retentionStartedAt ||
    iso(lifecycle.completed_at) !== m.completedAt
  )
    throw new Error("STRUCTURED_EXTRACTION_PUBLICATION_CANONICAL_DRIFT");
  // The SQL trigger independently correlates the provider call snapshot and metadata signature.
}
function assertFields(row: Row, expected: Row): void {
  for (const [key, value] of Object.entries(expected))
    if (row[key] !== value) throw new Error(`STRUCTURED_EXTRACTION_PUBLICATION_CANONICAL_DRIFT:${key}`);
}
