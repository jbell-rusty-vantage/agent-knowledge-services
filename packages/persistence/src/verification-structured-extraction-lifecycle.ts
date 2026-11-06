import { z } from "zod";
import { VerificationArtifactHandleSchema, type VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import {
  structuredExtractionArtifactTransformationSignature,
  type RetainedStructuredExtractionCandidate,
} from "@aiengineer/knowledge-application";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { canonicalizeJson, digestCanonicalJson, sha256Digest } from "@aiengineer/knowledge-verification";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
import type { LeasedStep } from "./types.js";
import { type VerificationProviderResponseCapture } from "./verification-provider-response-capture.js";

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const CanonicalUuidSchema = z.uuid().refine((value) => value === value.toLowerCase(), "UUID must be lower case");
const CanonicalInstantSchema = z.iso
  .datetime()
  .refine((value) => new Date(value).toISOString() === value, "Timestamp must be canonical UTC milliseconds");
const IdentitySchema = z.strictObject({
  tenantId: CanonicalUuidSchema,
  operationId: CanonicalUuidSchema,
  operationStepId: CanonicalUuidSchema,
  producerAttemptId: CanonicalUuidSchema,
  requestDigest: DigestSchema,
  stepInputDigest: DigestSchema,
  captureId: CanonicalUuidSchema,
  profileArtifact: VerificationArtifactHandleSchema,
  schemaArtifact: VerificationArtifactHandleSchema,
  sourceArtifact: VerificationArtifactHandleSchema,
  representationArtifact: VerificationArtifactHandleSchema,
  transformationArtifact: VerificationArtifactHandleSchema,
  promptDigest: DigestSchema,
  schemaDigest: DigestSchema,
});
const CaptureSchema = z.strictObject({
  tenantId: CanonicalUuidSchema,
  providerAttemptId: CanonicalUuidSchema,
  operationId: CanonicalUuidSchema,
  operationStepId: CanonicalUuidSchema,
  profileArtifactId: CanonicalUuidSchema,
  profileDigest: DigestSchema,
  dispatchFencingToken: z.int().positive(),
  httpStatus: z.int().min(200).max(599),
  responseEnvelopeArtifactId: CanonicalUuidSchema,
  transportArtifactId: CanonicalUuidSchema,
  transportDigest: DigestSchema,
  capturedAt: CanonicalInstantSchema,
});

export type StructuredExtractionLifecycleIdentity = z.infer<typeof IdentitySchema>;

export interface DurableStructuredExtractionLifecycle {
  readonly identity: StructuredExtractionLifecycleIdentity;
  readonly identityDigest: `sha256:${string}`;
  readonly status: "running" | "retaining" | "retained";
  readonly startedAt: string;
  readonly retentionStartedAt: string | null;
  readonly completedAt: string | null;
  readonly capture: VerificationProviderResponseCapture | null;
  readonly providerRequestArtifact: VerificationArtifactHandle | null;
  readonly rawResponseArtifact: VerificationArtifactHandle | null;
  readonly responseEnvelopeArtifact: VerificationArtifactHandle | null;
  readonly transportArtifact: VerificationArtifactHandle | null;
  readonly candidateArtifact: VerificationArtifactHandle | null;
  readonly precontextArtifact: VerificationArtifactHandle | null;
  readonly provenanceArtifact: VerificationArtifactHandle | null;
}

interface StoredLifecycle extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  operation_id: string;
  operation_step_id: string;
  producer_attempt_id: string;
  identity_sha256: string;
  request_sha256: string;
  step_input_sha256: string;
  capture_id: string;
  profile_artifact_id: string;
  profile_sha256: string;
  schema_artifact_id: string;
  schema_artifact_sha256: string;
  source_artifact_id: string;
  source_sha256: string;
  representation_artifact_id: string;
  representation_sha256: string;
  transformation_artifact_id: string;
  transformation_sha256: string;
  prompt_sha256: string;
  schema_digest_sha256: string;
  status: "running" | "retaining" | "retained";
  started_at: Date | string;
  retention_started_at: Date | string | null;
  completed_at: Date | string | null;
  provider_attempt_id: string | null;
  original_dispatch_fencing_token: string | number | null;
  http_status: string | number | null;
  captured_at: Date | string | null;
  provider_request_artifact_id: string | null;
  provider_request_sha256: string | null;
  raw_response_artifact_id: string | null;
  raw_response_sha256: string | null;
  response_envelope_artifact_id: string | null;
  response_envelope_sha256: string | null;
  transport_artifact_id: string | null;
  transport_sha256: string | null;
  candidate_artifact_id: string | null;
  candidate_sha256: string | null;
  precontext_artifact_id: string | null;
  precontext_sha256: string | null;
  provenance_artifact_id: string | null;
  provenance_sha256: string | null;
}

interface ArtifactRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  sha256: string;
  media_type: string;
  size_bytes: string | number;
  object_path: string;
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
}

const hex = (value: string): string => DigestSchema.parse(value).slice(7);
const digest = (value: unknown): `sha256:${string}` =>
  DigestSchema.parse(`sha256:${String(value)}`) as `sha256:${string}`;
const iso = (value: Date | string): string => new Date(value).toISOString();
const same = (left: unknown, right: unknown): boolean => canonicalizeJson(left) === canonicalizeJson(right);

/** Durable, lease-fenced custody for an unverified structured extraction candidate. */
export class PostgresStructuredExtractionLifecycleStore {
  constructor(private readonly database: Pick<PostgresCanonicalRepository, "transaction">) {}

  async initialize(input: {
    readonly identity: StructuredExtractionLifecycleIdentity;
    readonly lease: LeasedStep;
  }): Promise<DurableStructuredExtractionLifecycle> {
    const identity = parseIdentity(input.identity);
    const lease = parseLease(input.lease, identity);
    return this.database.transaction(identity.tenantId, async (client) => {
      await lockLiveClaim(client, identity, lease);
      const existing = await get(client, identity);
      if (existing) return project(client, existing, identity);
      await client.query(
        `insert into orchestration.verification_structured_extraction(
        tenant_id,operation_id,operation_step_id,producer_attempt_id,identity_sha256,request_sha256,step_input_sha256,capture_id,
        profile_artifact_id,profile_sha256,schema_artifact_id,schema_artifact_sha256,source_artifact_id,source_sha256,
        representation_artifact_id,representation_sha256,transformation_artifact_id,transformation_sha256,prompt_sha256,schema_digest_sha256)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          identity.tenantId,
          identity.operationId,
          identity.operationStepId,
          identity.producerAttemptId,
          hex(identityDigest(identity)),
          hex(identity.requestDigest),
          hex(identity.stepInputDigest),
          identity.captureId,
          identity.profileArtifact.artifactId,
          hex(identity.profileArtifact.digest),
          identity.schemaArtifact.artifactId,
          hex(identity.schemaArtifact.digest),
          identity.sourceArtifact.artifactId,
          hex(identity.sourceArtifact.digest),
          identity.representationArtifact.artifactId,
          hex(identity.representationArtifact.digest),
          identity.transformationArtifact.artifactId,
          hex(identity.transformationArtifact.digest),
          hex(identity.promptDigest),
          hex(identity.schemaDigest),
        ],
      );
      const stored = await get(client, identity);
      if (!stored) throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_INSERT_LOST");
      return project(client, stored, identity);
    });
  }

  async beginRetention(input: {
    readonly lifecycle: DurableStructuredExtractionLifecycle;
    readonly lease: LeasedStep;
    readonly capture: VerificationProviderResponseCapture;
  }): Promise<DurableStructuredExtractionLifecycle> {
    const expected = deepFreeze(structuredClone(input.lifecycle));
    const identity = parseIdentity(expected.identity);
    const lease = parseLease(input.lease, identity);
    const capture = deepFreeze(CaptureSchema.parse(input.capture)) as VerificationProviderResponseCapture;
    validateExpected(expected, identity);
    if (
      capture.tenantId !== identity.tenantId ||
      capture.operationId !== identity.operationId ||
      capture.operationStepId !== identity.operationStepId ||
      capture.profileArtifactId !== identity.profileArtifact.artifactId ||
      capture.profileDigest !== identity.profileArtifact.digest
    )
      throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_CAPTURE_INVALID");
    return this.database.transaction(identity.tenantId, async (client) => {
      await lockLiveClaim(client, identity, lease);
      await lockCapture(client, identity, capture);
      const stored = await get(client, identity);
      if (!stored) throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_NOT_FOUND");
      const current = await project(client, stored, identity);
      validatePrior(current, expected);
      if (current.status !== "running") {
        if (!current.capture || !same(current.capture, capture))
          throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_CAPTURE_DRIFT");
        return current;
      }
      await client.query(
        `update orchestration.verification_structured_extraction
        set status='retaining',provider_attempt_id=$3
        where tenant_id=$1 and operation_id=$2 and status='running'`,
        [identity.tenantId, identity.operationId, capture.providerAttemptId],
      );
      const retained = await get(client, identity);
      if (!retained) throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_RETENTION_LOST");
      return project(client, retained, identity);
    });
  }

  async completeRetention(input: {
    readonly lifecycle: DurableStructuredExtractionLifecycle;
    readonly lease: LeasedStep;
    readonly candidate: RetainedStructuredExtractionCandidate;
  }): Promise<DurableStructuredExtractionLifecycle> {
    const expected = deepFreeze(structuredClone(input.lifecycle));
    const identity = parseIdentity(expected.identity);
    const lease = parseLease(input.lease, identity);
    validateExpected(expected, identity);
    const candidate = validateCandidate(input.candidate, expected, identity);
    return this.database.transaction(identity.tenantId, async (client) => {
      await lockLiveClaim(client, identity, lease);
      if (!expected.capture) throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_NOT_RETAINING");
      await lockCapture(client, identity, expected.capture);
      const stored = await get(client, identity);
      if (!stored) throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_NOT_FOUND");
      const current = await project(client, stored, identity);
      validatePrior(current, expected);
      if (current.status === "running") throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_NOT_RETAINING");
      if (current.status === "retained") {
        if (
          !same(current.candidateArtifact, candidate.candidateArtifact) ||
          !same(current.precontextArtifact, candidate.precontextArtifact) ||
          !same(current.provenanceArtifact, candidate.provenanceArtifact)
        )
          throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_CANDIDATE_DRIFT");
        return current;
      }
      await client.query(
        `update orchestration.verification_structured_extraction set status='retained',
        candidate_artifact_id=$3,candidate_sha256=$4,precontext_artifact_id=$5,precontext_sha256=$6,
        provenance_artifact_id=$7,provenance_sha256=$8
        where tenant_id=$1 and operation_id=$2 and status='retaining'`,
        [
          identity.tenantId,
          identity.operationId,
          candidate.candidateArtifact.artifactId,
          hex(candidate.candidateArtifact.digest),
          candidate.precontextArtifact?.artifactId ?? null,
          candidate.precontextArtifact ? hex(candidate.precontextArtifact.digest) : null,
          candidate.provenanceArtifact.artifactId,
          hex(candidate.provenanceArtifact.digest),
        ],
      );
      const retained = await get(client, identity);
      if (!retained) throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_COMPLETION_LOST");
      return project(client, retained, identity);
    });
  }
}

function parseIdentity(value: StructuredExtractionLifecycleIdentity): StructuredExtractionLifecycleIdentity {
  const identity = IdentitySchema.parse(value);
  const artifacts = [
    identity.profileArtifact,
    identity.schemaArtifact,
    identity.sourceArtifact,
    identity.representationArtifact,
    identity.transformationArtifact,
  ];
  if (
    artifacts.some((artifact) => artifact.tenantId !== identity.tenantId) ||
    new Set(artifacts.map((artifact) => artifact.artifactId)).size !== artifacts.length
  )
    throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_IDENTITY_INVALID");
  return deepFreeze(structuredClone(identity));
}

function parseLease(value: LeasedStep, identity: StructuredExtractionLifecycleIdentity): LeasedStep {
  if (
    value.tenantId !== identity.tenantId ||
    value.operationId !== identity.operationId ||
    value.id !== identity.operationStepId ||
    value.stepKey !== "extract_and_register" ||
    value.status !== "running" ||
    value.inputSha256 !== hex(identity.stepInputDigest) ||
    !CanonicalUuidSchema.safeParse(value.leaseToken).success ||
    !Number.isSafeInteger(value.fencingToken) ||
    value.fencingToken < 1 ||
    !value.holderIdentity?.trim()
  )
    throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_LEASE_INVALID");
  return deepFreeze(structuredClone(value));
}

function identityDigest(identity: StructuredExtractionLifecycleIdentity): `sha256:${string}` {
  return DigestSchema.parse(digestCanonicalJson(identity)) as `sha256:${string}`;
}

function claim(lease: LeasedStep): string {
  return JSON.stringify({
    stepId: lease.id,
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    holderIdentity: lease.holderIdentity,
  });
}

async function lockLiveClaim(
  client: TenantSqlClient,
  identity: StructuredExtractionLifecycleIdentity,
  lease: LeasedStep,
): Promise<void> {
  const operation = (
    await client.query<{ id: string }>(
      `select id from knowledge_service.operation
    where tenant_id=$1 and id=$2 and operation_kind='verification_structured_extraction' and status='running'
      and attempt_id=$3 and request_sha256=$4 for update`,
      [identity.tenantId, identity.operationId, identity.producerAttemptId, hex(identity.requestDigest)],
    )
  ).rows[0];
  if (!operation) throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_OPERATION_NOT_ACTIVE");
  const step = (
    await client.query<{ id: string }>(
      `select step.id from knowledge_service.operation_step step
    join knowledge_service.lease lease on lease.tenant_id=step.tenant_id and lease.operation_step_id=step.id
    where step.tenant_id=$1 and step.operation_id=$2 and step.id=$3 and step.status='running' and step.step_key='extract_and_register'
      and step.input_sha256=$4 and lease.lease_token=$5 and lease.fencing_token=$6 and lease.holder_identity=$7
      and lease.released_at is null and lease.expires_at>clock_timestamp() for update of step,lease`,
      [
        identity.tenantId,
        identity.operationId,
        identity.operationStepId,
        hex(identity.stepInputDigest),
        lease.leaseToken,
        lease.fencingToken,
        lease.holderIdentity,
      ],
    )
  ).rows[0];
  if (!step) throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_STALE_LEASE");
  await client.query("select set_config('verification.structured_extraction_claim',$1,true)", [claim(lease)]);
}

async function lockCapture(
  client: TenantSqlClient,
  identity: StructuredExtractionLifecycleIdentity,
  capture: VerificationProviderResponseCapture,
): Promise<void> {
  const row = (
    await client.query<{ id: string }>(
      `select provider.id from orchestration.verification_provider_attempt provider
    join orchestration.verification_provider_response_capture capture on capture.tenant_id=provider.tenant_id and capture.provider_attempt_id=provider.id
    where provider.tenant_id=$1 and provider.id=$2 and provider.operation_id=$3 and provider.operation_step_id=$4
      and capture.operation_id=$3 and capture.operation_step_id=$4 and capture.profile_artifact_id=$5 and capture.profile_sha256=$6
      and capture.dispatch_fencing_token=$7 and capture.http_status=$8 and capture.response_envelope_artifact_id=$9
      and capture.transport_artifact_id=$10 and capture.transport_sha256=$11 and date_trunc('milliseconds',capture.captured_at)=$12::timestamptz
    for update of provider,capture`,
      [
        identity.tenantId,
        capture.providerAttemptId,
        identity.operationId,
        identity.operationStepId,
        identity.profileArtifact.artifactId,
        hex(identity.profileArtifact.digest),
        capture.dispatchFencingToken,
        capture.httpStatus,
        capture.responseEnvelopeArtifactId,
        capture.transportArtifactId,
        hex(capture.transportDigest),
        capture.capturedAt,
      ],
    )
  ).rows[0];
  if (!row) throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_CAPTURE_INVALID");
}

async function get(
  client: TenantSqlClient,
  identity: StructuredExtractionLifecycleIdentity,
): Promise<StoredLifecycle | undefined> {
  return (
    await client.query<StoredLifecycle>(
      "select * from orchestration.verification_structured_extraction where tenant_id=$1 and operation_id=$2 for update",
      [identity.tenantId, identity.operationId],
    )
  ).rows[0];
}

async function readArtifact(
  client: TenantSqlClient,
  tenantId: string,
  artifactId: string | null,
): Promise<VerificationArtifactHandle | null> {
  if (!artifactId) return null;
  const row = (
    await client.query<ArtifactRow>(
      `select a.id,a.tenant_id,a.sha256,a.media_type,a.size_bytes,a.object_path,a.created_at,
    m.producer_activity_id,m.producer_version,m.content_encoding,m.encryption_class,m.retention_class,m.data_classification,
    m.parent_artifact_ids,m.transformation_signature,m.attestation_artifact_id
    from orchestration.artifact a join orchestration.verification_artifact_metadata m on m.tenant_id=a.tenant_id and m.artifact_id=a.id
    where a.tenant_id=$1 and a.id=$2 and a.storage_state='available' and a.verification_contract_version='verification.v1'`,
      [tenantId, artifactId],
    )
  ).rows[0];
  if (!row) throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_ARTIFACT_MISSING");
  return VerificationArtifactHandleSchema.parse({
    artifactId: row.id,
    tenantId: row.tenant_id,
    digest: digest(row.sha256),
    mediaType: row.media_type,
    byteLength: Number(row.size_bytes),
    objectKey: row.object_path,
    ...(row.content_encoding ? { contentEncoding: row.content_encoding } : {}),
    createdAt: iso(row.created_at),
    producerActivityId: row.producer_activity_id,
    producerVersion: row.producer_version,
    encryptionClass: row.encryption_class,
    retentionClass: row.retention_class,
    dataClassification: row.data_classification,
    parentArtifactIds: row.parent_artifact_ids.map(String),
    ...(row.transformation_signature ? { transformationSignature: digest(row.transformation_signature) } : {}),
    ...(row.attestation_artifact_id ? { attestationArtifactId: row.attestation_artifact_id } : {}),
  });
}

async function project(
  client: TenantSqlClient,
  row: StoredLifecycle,
  identity: StructuredExtractionLifecycleIdentity,
): Promise<DurableStructuredExtractionLifecycle> {
  if (
    row.tenant_id !== identity.tenantId ||
    row.operation_id !== identity.operationId ||
    row.operation_step_id !== identity.operationStepId ||
    row.producer_attempt_id !== identity.producerAttemptId ||
    row.identity_sha256 !== hex(identityDigest(identity)) ||
    row.request_sha256 !== hex(identity.requestDigest) ||
    row.step_input_sha256 !== hex(identity.stepInputDigest) ||
    row.capture_id !== identity.captureId ||
    row.profile_artifact_id !== identity.profileArtifact.artifactId ||
    row.profile_sha256 !== hex(identity.profileArtifact.digest) ||
    row.schema_artifact_id !== identity.schemaArtifact.artifactId ||
    row.schema_artifact_sha256 !== hex(identity.schemaArtifact.digest) ||
    row.source_artifact_id !== identity.sourceArtifact.artifactId ||
    row.source_sha256 !== hex(identity.sourceArtifact.digest) ||
    row.representation_artifact_id !== identity.representationArtifact.artifactId ||
    row.representation_sha256 !== hex(identity.representationArtifact.digest) ||
    row.transformation_artifact_id !== identity.transformationArtifact.artifactId ||
    row.transformation_sha256 !== hex(identity.transformationArtifact.digest) ||
    row.prompt_sha256 !== hex(identity.promptDigest) ||
    row.schema_digest_sha256 !== hex(identity.schemaDigest)
  )
    throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_IDENTITY_DRIFT");
  const [
    providerRequestArtifact,
    rawResponseArtifact,
    responseEnvelopeArtifact,
    transportArtifact,
    candidateArtifact,
    precontextArtifact,
    provenanceArtifact,
  ] = await Promise.all([
    readArtifact(client, identity.tenantId, row.provider_request_artifact_id),
    readArtifact(client, identity.tenantId, row.raw_response_artifact_id),
    readArtifact(client, identity.tenantId, row.response_envelope_artifact_id),
    readArtifact(client, identity.tenantId, row.transport_artifact_id),
    readArtifact(client, identity.tenantId, row.candidate_artifact_id),
    readArtifact(client, identity.tenantId, row.precontext_artifact_id),
    readArtifact(client, identity.tenantId, row.provenance_artifact_id),
  ]);
  const artifactDigests = [
    row.provider_request_sha256,
    row.raw_response_sha256,
    row.response_envelope_sha256,
    row.transport_sha256,
    row.candidate_sha256,
    row.precontext_sha256,
    row.provenance_sha256,
  ];
  for (const [index, artifact] of [
    providerRequestArtifact,
    rawResponseArtifact,
    responseEnvelopeArtifact,
    transportArtifact,
    candidateArtifact,
    precontextArtifact,
    provenanceArtifact,
  ].entries()) {
    const expected = artifactDigests[index];
    if ((artifact === null) !== (expected === null) || (artifact && artifact.digest !== digest(expected)))
      throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_ARTIFACT_DIGEST_DRIFT");
  }
  const capture =
    row.provider_attempt_id === null
      ? null
      : deepFreeze<VerificationProviderResponseCapture>({
          tenantId: identity.tenantId,
          providerAttemptId: row.provider_attempt_id,
          operationId: identity.operationId,
          operationStepId: identity.operationStepId,
          profileArtifactId: identity.profileArtifact.artifactId,
          profileDigest: identity.profileArtifact.digest as `sha256:${string}`,
          dispatchFencingToken: Number(row.original_dispatch_fencing_token),
          httpStatus: Number(row.http_status),
          responseEnvelopeArtifactId: String(row.response_envelope_artifact_id),
          transportArtifactId: String(row.transport_artifact_id),
          transportDigest: digest(row.transport_sha256),
          capturedAt: iso(row.captured_at!),
        });
  return deepFreeze({
    identity,
    identityDigest: identityDigest(identity),
    status: row.status,
    startedAt: iso(row.started_at),
    retentionStartedAt: row.retention_started_at === null ? null : iso(row.retention_started_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    capture,
    providerRequestArtifact,
    rawResponseArtifact,
    responseEnvelopeArtifact,
    transportArtifact,
    candidateArtifact,
    precontextArtifact,
    provenanceArtifact,
  });
}

function validateExpected(
  value: DurableStructuredExtractionLifecycle,
  identity: StructuredExtractionLifecycleIdentity,
): void {
  if (
    value.identityDigest !== identityDigest(identity) ||
    !CanonicalInstantSchema.safeParse(value.startedAt).success ||
    (value.retentionStartedAt !== null && !CanonicalInstantSchema.safeParse(value.retentionStartedAt).success) ||
    (value.completedAt !== null && !CanonicalInstantSchema.safeParse(value.completedAt).success)
  )
    throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_EXPECTED_INVALID");
}

function validatePrior(
  current: DurableStructuredExtractionLifecycle,
  expected: DurableStructuredExtractionLifecycle,
): void {
  if (
    current.identityDigest !== expected.identityDigest ||
    current.startedAt !== expected.startedAt ||
    (expected.retentionStartedAt !== null && current.retentionStartedAt !== expected.retentionStartedAt) ||
    (expected.capture !== null && !same(current.capture, expected.capture))
  )
    throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_EXPECTED_DRIFT");
  if (
    expected.status === "retained" &&
    (!same(current.candidateArtifact, expected.candidateArtifact) ||
      !same(current.precontextArtifact, expected.precontextArtifact) ||
      !same(current.provenanceArtifact, expected.provenanceArtifact) ||
      current.completedAt !== expected.completedAt)
  )
    throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_EXPECTED_DRIFT");
}

function validateCandidate(
  value: RetainedStructuredExtractionCandidate,
  lifecycle: DurableStructuredExtractionLifecycle,
  identity: StructuredExtractionLifecycleIdentity,
): RetainedStructuredExtractionCandidate {
  if (
    lifecycle.status === "running" ||
    !lifecycle.capture ||
    !lifecycle.retentionStartedAt ||
    !lifecycle.providerRequestArtifact ||
    !lifecycle.rawResponseArtifact ||
    !lifecycle.responseEnvelopeArtifact ||
    !lifecycle.transportArtifact
  )
    throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_NOT_RETAINING");
  const candidateArtifact = VerificationArtifactHandleSchema.parse(value.candidateArtifact);
  const precontextArtifact =
    value.precontextArtifact === null ? null : VerificationArtifactHandleSchema.parse(value.precontextArtifact);
  const provenanceArtifact = VerificationArtifactHandleSchema.parse(value.provenanceArtifact);
  const provenance = value.provenance;
  const baseParents = [
    identity.profileArtifact.artifactId,
    identity.schemaArtifact.artifactId,
    identity.sourceArtifact.artifactId,
    identity.representationArtifact.artifactId,
    identity.transformationArtifact.artifactId,
    lifecycle.transportArtifact.artifactId,
    lifecycle.responseEnvelopeArtifact.artifactId,
    lifecycle.providerRequestArtifact.artifactId,
    lifecycle.rawResponseArtifact.artifactId,
  ];
  const precontextParents = [
    lifecycle.transportArtifact.artifactId,
    lifecycle.responseEnvelopeArtifact.artifactId,
    lifecycle.providerRequestArtifact.artifactId,
    lifecycle.rawResponseArtifact.artifactId,
    identity.profileArtifact.artifactId,
  ];
  const provenanceParents = [
    candidateArtifact.artifactId,
    ...(precontextArtifact ? [precontextArtifact.artifactId] : []),
    ...baseParents,
  ];
  const expectedSignature = (
    artifact: VerificationArtifactHandle,
    artifactType:
      | "verification_extraction_candidate"
      | "verification_structured_extraction_precontext"
      | "verification_structured_extraction_provenance",
    parentArtifactIds: readonly string[],
  ) =>
    structuredExtractionArtifactTransformationSignature({
      artifactType,
      payloadDigest: artifact.digest as `sha256:${string}`,
      tenantId: identity.tenantId,
      operationId: identity.operationId,
      providerAttemptId: lifecycle.capture!.providerAttemptId,
      originalDispatchFencingToken: lifecycle.capture!.dispatchFencingToken,
      profileArtifactId: identity.profileArtifact.artifactId,
      profileDigest: identity.profileArtifact.digest as `sha256:${string}`,
      promptDigest: identity.promptDigest as `sha256:${string}`,
      schemaDigest: identity.schemaDigest as `sha256:${string}`,
      parentArtifactIds,
    });
  const newArtifacts = [candidateArtifact, ...(precontextArtifact ? [precontextArtifact] : []), provenanceArtifact];
  if (
    value.status !== "unverified_candidate" ||
    newArtifacts.some(
      (artifact) => artifact.tenantId !== identity.tenantId || artifact.createdAt !== lifecycle.retentionStartedAt,
    ) ||
    !same(candidateArtifact.parentArtifactIds, baseParents) ||
    candidateArtifact.transformationSignature !==
      expectedSignature(candidateArtifact, "verification_extraction_candidate", baseParents) ||
    (precontextArtifact !== null &&
      (!same(precontextArtifact.parentArtifactIds, precontextParents) ||
        precontextArtifact.transformationSignature !==
          expectedSignature(precontextArtifact, "verification_structured_extraction_precontext", precontextParents))) ||
    !same(provenanceArtifact.parentArtifactIds, provenanceParents) ||
    provenanceArtifact.transformationSignature !==
      expectedSignature(provenanceArtifact, "verification_structured_extraction_provenance", provenanceParents)
  )
    throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_CANDIDATE_INVALID");
  if (
    provenance.schemaVersion !== "verification-structured-extraction-provenance.v1" ||
    provenance.status !== "unverified_candidate" ||
    provenance.tenantId !== identity.tenantId ||
    provenance.operationId !== identity.operationId ||
    provenance.operationStepId !== identity.operationStepId ||
    provenance.providerAttemptId !== lifecycle.capture.providerAttemptId ||
    provenance.producerAttemptId !== identity.producerAttemptId ||
    provenance.originalDispatchFencingToken !== lifecycle.capture.dispatchFencingToken ||
    provenance.createdAt !== lifecycle.retentionStartedAt ||
    provenance.input.captureId !== identity.captureId ||
    !same(provenance.profile.artifact, identity.profileArtifact) ||
    !same(provenance.extraction.schemaArtifact, identity.schemaArtifact) ||
    !same(provenance.input.sourceArtifact, identity.sourceArtifact) ||
    !same(provenance.input.representationArtifact, identity.representationArtifact) ||
    !same(provenance.input.transformationArtifact, identity.transformationArtifact) ||
    provenance.extraction.promptDigest !== identity.promptDigest ||
    provenance.extraction.schemaDigest !== identity.schemaDigest ||
    !same(provenance.response.transportArtifact, lifecycle.transportArtifact) ||
    !same(provenance.response.responseEnvelopeArtifact, lifecycle.responseEnvelopeArtifact) ||
    !same(provenance.response.requestArtifact, lifecycle.providerRequestArtifact) ||
    !same(provenance.response.rawResponseArtifact, lifecycle.rawResponseArtifact) ||
    provenance.response.httpStatus !== lifecycle.capture.httpStatus ||
    provenance.response.capturedAt !== lifecycle.capture.capturedAt ||
    provenance.response.externalRequests !== 0 ||
    !same(provenance.candidate.artifact, candidateArtifact) ||
    provenance.candidate.digest !== candidateArtifact.digest ||
    provenance.candidate.byteLength !== candidateArtifact.byteLength ||
    provenance.candidate.status !== "unverified_candidate" ||
    (precontextArtifact === null) !== (provenance.precontext === null) ||
    (precontextArtifact !== null &&
      (!same(provenance.precontext!.artifact, precontextArtifact) ||
        provenance.precontext!.digest !== precontextArtifact.digest ||
        provenance.precontext!.byteLength !== precontextArtifact.byteLength))
  )
    throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_PROVENANCE_INVALID");
  const outputBytes = new TextEncoder().encode(canonicalizeJson(value.output));
  const outputDigest = sha256Digest(outputBytes);
  const candidateEnvelope = {
    schemaVersion: "verification-extraction-candidate.v1",
    tenantId: identity.tenantId,
    operationId: identity.operationId,
    providerAttemptId: lifecycle.capture.providerAttemptId,
    originalDispatchFencingToken: lifecycle.capture.dispatchFencingToken,
    profileArtifactId: identity.profileArtifact.artifactId,
    profileDigest: identity.profileArtifact.digest,
    promptDigest: identity.promptDigest,
    schemaDigest: identity.schemaDigest,
    outputDigest,
    outputVerification: "unverified_candidate",
    output: value.output,
  };
  const candidateBytes = new TextEncoder().encode(canonicalizeJson(candidateEnvelope));
  const provenanceBytes = new TextEncoder().encode(canonicalizeJson(provenance));
  if (
    provenance.candidate.outputDigest !== outputDigest ||
    sha256Digest(candidateBytes) !== candidateArtifact.digest ||
    candidateBytes.byteLength !== candidateArtifact.byteLength ||
    sha256Digest(provenanceBytes) !== provenanceArtifact.digest ||
    provenanceBytes.byteLength !== provenanceArtifact.byteLength
  )
    throw new Error("STRUCTURED_EXTRACTION_LIFECYCLE_PAYLOAD_DRIFT");
  return deepFreeze(structuredClone(value));
}
