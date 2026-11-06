import { verificationProviderHostTuple, type VerificationProviderHost } from "./verification-provider-host.js";
import { VerificationArtifactHandleSchema, type VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import {
  prepareVerificationProviderTransportResponse,
  VerificationProviderTransportResponseSchema,
  type VerificationProviderTransportResponse,
} from "@aiengineer/knowledge-application";
import { deepFreeze } from "@aiengineer/knowledge-core";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
import type { LeasedStep } from "./types.js";

type Row = Record<string, unknown>;
const hex = (d: string) => d.slice(7);
const uuid = (v: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))
    throw new Error("PROVIDER_RESPONSE_CAPTURE_UUID");
  return v;
};
export interface VerificationProviderResponseCapture {
  readonly tenantId: string;
  readonly providerAttemptId: string;
  readonly operationId: string;
  readonly operationStepId: string;
  readonly profileArtifactId: string;
  readonly profileDigest: `sha256:${string}`;
  readonly dispatchFencingToken: number;
  readonly httpStatus: number;
  readonly responseEnvelopeArtifactId: string;
  readonly transportArtifactId: string;
  readonly transportDigest: `sha256:${string}`;
  readonly capturedAt: string;
}
function snapshot(row: Row): VerificationProviderResponseCapture {
  return deepFreeze({
    tenantId: String(row.tenant_id),
    providerAttemptId: String(row.provider_attempt_id),
    operationId: String(row.operation_id),
    operationStepId: String(row.operation_step_id),
    profileArtifactId: String(row.profile_artifact_id),
    profileDigest: `sha256:${String(row.profile_sha256)}` as `sha256:${string}`,
    dispatchFencingToken: Number(row.dispatch_fencing_token),
    httpStatus: Number(row.http_status),
    responseEnvelopeArtifactId: String(row.response_envelope_artifact_id),
    transportArtifactId: String(row.transport_artifact_id),
    transportDigest: `sha256:${String(row.transport_sha256)}` as `sha256:${string}`,
    capturedAt: row.captured_at instanceof Date ? row.captured_at.toISOString() : String(row.captured_at),
  });
}
function claim(lease: LeasedStep) {
  uuid(lease.tenantId);
  uuid(lease.operationId);
  uuid(lease.id);
  uuid(lease.leaseToken);
  if (!lease.holderIdentity || !Number.isSafeInteger(lease.fencingToken) || lease.fencingToken < 1)
    throw new Error("PROVIDER_RESPONSE_CAPTURE_LEASE");
  return JSON.stringify({
    stepId: lease.id,
    leaseToken: lease.leaseToken,
    fencingToken: lease.fencingToken,
    holderIdentity: lease.holderIdentity,
  });
}
async function live(c: TenantSqlClient, l: LeasedStep, hostName: VerificationProviderHost) {
  const host = verificationProviderHostTuple(hostName);
  await c.query("select set_config('verification.provider_claim',$1,true)", [claim(l)]);
  const op = (
    await c.query<Row>(
      "select id from knowledge_service.operation where tenant_id=$1 and id=$2 and operation_kind=$3 and status='running' for update",
      [l.tenantId, l.operationId, host.operationKind],
    )
  ).rows[0];
  const step = (
    await c.query<Row>(
      "select step.id from knowledge_service.operation_step step join knowledge_service.lease lease on lease.tenant_id=step.tenant_id and lease.operation_step_id=step.id where step.tenant_id=$1 and step.id=$2 and step.operation_id=$3 and step.step_key=$7 and step.step_kind=$7 and step.status='running' and lease.lease_token=$4 and lease.fencing_token=$5 and lease.holder_identity=$6 and lease.released_at is null and lease.expires_at>clock_timestamp() for update",
      [l.tenantId, l.id, l.operationId, l.leaseToken, l.fencingToken, l.holderIdentity, host.stepKey],
    )
  ).rows[0];
  if (!op || !step) throw new Error("PROVIDER_RESPONSE_CAPTURE_STALE_LEASE");
}
export class PostgresVerificationProviderResponseCaptureStore {
  constructor(
    private readonly database: PostgresCanonicalRepository,
    private readonly host: VerificationProviderHost = "structured_extraction",
  ) {
    verificationProviderHostTuple(host);
  }
  async store(input: {
    readonly lease: LeasedStep;
    readonly response: VerificationProviderTransportResponse;
    readonly artifact: VerificationArtifactHandle;
  }): Promise<VerificationProviderResponseCapture> {
    const response = VerificationProviderTransportResponseSchema.parse(input.response),
      artifact = VerificationArtifactHandleSchema.parse(input.artifact),
      prepared = prepareVerificationProviderTransportResponse(response),
      l = deepFreeze(structuredClone(input.lease)),
      b = response.binding;
    if (
      b.tenantId !== l.tenantId ||
      b.operationId !== l.operationId ||
      b.operationStepId !== l.id ||
      artifact.tenantId !== l.tenantId ||
      artifact.digest !== prepared.payloadDigest ||
      artifact.byteLength !== prepared.bytes.byteLength ||
      artifact.transformationSignature !== prepared.transformationSignature ||
      artifact.parentArtifactIds.length !== 2 ||
      artifact.parentArtifactIds[0] !== response.responseEnvelope.artifactId ||
      artifact.parentArtifactIds[1] !== b.profileArtifactId
    )
      throw new Error("PROVIDER_RESPONSE_CAPTURE_TRANSPORT_ARTIFACT");
    return this.database.transaction(l.tenantId, async (c) => {
      await live(c, l, this.host);
      const ledger = (
        await c.query<Row>(
          "select * from orchestration.verification_provider_attempt where tenant_id=$1 and id=$2 for update",
          [l.tenantId, b.providerAttemptId],
        )
      ).rows[0];
      if (
        !ledger ||
        String(ledger.operation_id) !== b.operationId ||
        String(ledger.operation_step_id) !== b.operationStepId ||
        String(ledger.profile_artifact_id) !== b.profileArtifactId ||
        String(ledger.profile_sha256) !== hex(b.profileDigest) ||
        Number(ledger.dispatch_fencing_token) !== b.dispatchFencingToken ||
        !["dispatched", "uncertain", "settled"].includes(String(ledger.state)) ||
        (ledger.response_artifact_id !== null &&
          String(ledger.response_artifact_id) !== response.responseEnvelope.artifactId)
      )
        throw new Error("PROVIDER_RESPONSE_CAPTURE_LEDGER_BINDING");
      const prior = (
        await c.query<Row>(
          "select * from orchestration.verification_provider_response_capture where tenant_id=$1 and provider_attempt_id=$2",
          [l.tenantId, b.providerAttemptId],
        )
      ).rows[0];
      if (prior) {
        const got = snapshot(prior);
        if (
          got.operationId !== b.operationId ||
          got.operationStepId !== b.operationStepId ||
          got.profileArtifactId !== b.profileArtifactId ||
          got.profileDigest !== b.profileDigest ||
          got.dispatchFencingToken !== b.dispatchFencingToken ||
          got.httpStatus !== response.httpStatus ||
          got.responseEnvelopeArtifactId !== response.responseEnvelope.artifactId ||
          got.transportArtifactId !== artifact.artifactId ||
          got.transportDigest !== artifact.digest
        )
          throw new Error("PROVIDER_RESPONSE_CAPTURE_REPLAY_DRIFT");
        return got;
      }
      const row = (
        await c.query<Row>(
          "insert into orchestration.verification_provider_response_capture(tenant_id,provider_attempt_id,operation_id,operation_step_id,profile_artifact_id,profile_sha256,dispatch_fencing_token,http_status,response_envelope_artifact_id,transport_artifact_id,transport_sha256) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *",
          [
            l.tenantId,
            b.providerAttemptId,
            b.operationId,
            b.operationStepId,
            b.profileArtifactId,
            hex(b.profileDigest),
            b.dispatchFencingToken,
            response.httpStatus,
            response.responseEnvelope.artifactId,
            artifact.artifactId,
            hex(artifact.digest),
          ],
        )
      ).rows[0]!;
      return snapshot(row);
    });
  }
  async readForRecovery(input: {
    readonly lease: LeasedStep;
    readonly providerAttemptId: string;
  }): Promise<VerificationProviderResponseCapture | undefined> {
    uuid(input.providerAttemptId);
    const l = deepFreeze(structuredClone(input.lease));
    return this.database.transaction(l.tenantId, async (c) => {
      await live(c, l, this.host);
      const row = (
        await c.query<Row>(
          "select capture.* from orchestration.verification_provider_response_capture capture join orchestration.verification_provider_attempt ledger on ledger.tenant_id=capture.tenant_id and ledger.id=capture.provider_attempt_id where capture.tenant_id=$1 and capture.provider_attempt_id=$2 and capture.operation_id=$3 and capture.operation_step_id=$4 and ledger.operation_id=$3 and ledger.operation_step_id=$4 and ledger.profile_artifact_id=capture.profile_artifact_id and ledger.profile_sha256=capture.profile_sha256 and ledger.dispatch_fencing_token=capture.dispatch_fencing_token and ledger.state in ('dispatched','uncertain','settled') and (ledger.response_artifact_id is null or ledger.response_artifact_id=capture.response_envelope_artifact_id) for update of ledger",
          [l.tenantId, input.providerAttemptId, l.operationId, l.id],
        )
      ).rows[0];
      return row ? snapshot(row) : undefined;
    });
  }
}
