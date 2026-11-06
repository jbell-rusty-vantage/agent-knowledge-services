import { z } from "zod";
import {
  UuidSchema,
  VerificationArtifactHandleSchema,
  VerificationBenchmarkPublicationManifestSchema,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import type { PostgresCanonicalRepository, TenantSqlClient } from "./postgres.js";
import type { LeasedStep } from "./types.js";

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const SideSchema = z.strictObject({
  runId: UuidSchema,
  publicationArtifact: VerificationArtifactHandleSchema,
  payloadDigest: DigestSchema,
});
const IdentitySchema = z.strictObject({
  tenantId: UuidSchema,
  operationId: UuidSchema,
  comparisonId: UuidSchema,
  baseline: SideSchema,
  candidate: SideSchema,
  profileId: z.enum(["paired_default", "regression_gate"]),
  profileArtifact: VerificationArtifactHandleSchema,
  runtime: VerificationBenchmarkPublicationManifestSchema.shape.runtime,
});
export type VerificationBenchmarkComparisonIdentity = z.infer<typeof IdentitySchema>;
export interface DurableVerificationBenchmarkComparison {
  readonly identity: VerificationBenchmarkComparisonIdentity;
  readonly identityDigest: string;
  readonly status: "running" | "completed" | "sealed";
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly resultArtifact: { readonly artifactId: string; readonly digest: string } | null;
  readonly resultDigest: string | null;
  readonly engineeringGateOutcome: "not_requested" | "pass" | "fail" | null;
  readonly publicationArtifact: { readonly artifactId: string; readonly digest: string } | null;
  readonly publicationPayloadDigest: string | null;
}
type Stored = {
  id: string;
  tenant_id: string;
  operation_id: string;
  baseline_run_id: string;
  candidate_run_id: string;
  baseline_publication_artifact_id: string;
  baseline_publication_sha256: string;
  baseline_payload_sha256: string;
  candidate_publication_artifact_id: string;
  candidate_publication_sha256: string;
  candidate_payload_sha256: string;
  profile_id: string;
  profile_artifact_id: string;
  profile_sha256: string;
  runtime: unknown;
  runtime_sha256: string;
  status: "running" | "completed" | "sealed";
  started_at: Date | string;
  completed_at: Date | string | null;
  result_artifact_id: string | null;
  result_sha256: string | null;
  result_digest_sha256: string | null;
  engineering_gate_outcome: "not_requested" | "pass" | "fail" | null;
  publication_artifact_id: string | null;
  publication_sha256: string | null;
  publication_payload_sha256: string | null;
};
const hex = (digest: string) => DigestSchema.parse(digest).slice(7);
const iso = (time: Date | string) => new Date(time).toISOString();

/** Canonical operation/lease lock precedes comparison lifecycle changes. */
export class PostgresVerificationBenchmarkComparisonStore {
  constructor(private readonly database: Pick<PostgresCanonicalRepository, "transaction">) {}

  async initialize(
    input: VerificationBenchmarkComparisonIdentity,
    lease: LeasedStep,
  ): Promise<DurableVerificationBenchmarkComparison> {
    const identity = parseIdentity(input),
      claim = parseLease(lease, identity.operationId);
    return this.database.transaction(identity.tenantId, async (client) => {
      await live(client, identity, claim);
      const existing = await get(client, identity);
      if (existing) return project(existing, identity);
      await client.query(
        `insert into evaluation.verification_benchmark_comparison
        (id,tenant_id,operation_id,baseline_run_id,candidate_run_id,baseline_publication_artifact_id,baseline_publication_sha256,baseline_payload_sha256,
         candidate_publication_artifact_id,candidate_publication_sha256,candidate_payload_sha256,profile_id,profile_artifact_id,profile_sha256,runtime,runtime_sha256)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)`,
        [
          identity.comparisonId,
          identity.tenantId,
          identity.operationId,
          identity.baseline.runId,
          identity.candidate.runId,
          identity.baseline.publicationArtifact.artifactId,
          hex(identity.baseline.publicationArtifact.digest),
          hex(identity.baseline.payloadDigest),
          identity.candidate.publicationArtifact.artifactId,
          hex(identity.candidate.publicationArtifact.digest),
          hex(identity.candidate.payloadDigest),
          identity.profileId,
          identity.profileArtifact.artifactId,
          hex(identity.profileArtifact.digest),
          JSON.stringify(identity.runtime),
          hex(digestCanonicalJson(identity.runtime)),
        ],
      );
      const stored = await get(client, identity);
      if (!stored) throw new Error("BENCHMARK_COMPARISON_INSERT_LOST");
      return project(stored, identity);
    });
  }

  async complete(input: {
    comparison: DurableVerificationBenchmarkComparison;
    lease: LeasedStep;
    resultArtifact: VerificationArtifactHandle;
    resultDigest: string;
    engineeringGateOutcome: "not_requested" | "pass" | "fail";
  }): Promise<DurableVerificationBenchmarkComparison> {
    const identity = parseIdentity(input.comparison.identity),
      claim = parseLease(input.lease, identity.operationId),
      expected = expectedRecord(input.comparison, identity);
    const artifact = VerificationArtifactHandleSchema.parse(input.resultArtifact),
      resultDigest = DigestSchema.parse(input.resultDigest),
      outcome = z.enum(["not_requested", "pass", "fail"]).parse(input.engineeringGateOutcome);
    if (
      artifact.tenantId !== identity.tenantId ||
      (identity.profileId === "paired_default") !== (outcome === "not_requested")
    )
      throw new Error("BENCHMARK_COMPARISON_RESULT_INPUT_INVALID");
    return this.database.transaction(identity.tenantId, async (client) => {
      await live(client, identity, claim);
      const stored = await get(client, identity);
      if (!stored) throw new Error("BENCHMARK_COMPARISON_NOT_FOUND");
      const current = project(stored, identity);
      assertExpected(current, expected);
      if (current.status !== "running") {
        if (
          current.resultArtifact?.artifactId !== artifact.artifactId ||
          current.resultArtifact.digest !== artifact.digest ||
          current.resultDigest !== resultDigest ||
          current.engineeringGateOutcome !== outcome
        )
          throw new Error("BENCHMARK_COMPARISON_RESULT_DRIFT");
        return current;
      }
      await client.query(
        `update evaluation.verification_benchmark_comparison set status='completed',completed_at=clock_timestamp(),result_artifact_id=$3,result_sha256=$4,result_digest_sha256=$5,engineering_gate_outcome=$6
        where tenant_id=$1 and id=$2 and status='running'`,
        [
          identity.tenantId,
          identity.comparisonId,
          artifact.artifactId,
          hex(artifact.digest),
          hex(resultDigest),
          outcome,
        ],
      );
      const completed = await get(client, identity);
      if (!completed) throw new Error("BENCHMARK_COMPARISON_COMPLETION_LOST");
      return project(completed, identity);
    });
  }

  async seal(input: {
    comparison: DurableVerificationBenchmarkComparison;
    lease: LeasedStep;
    publicationArtifact: VerificationArtifactHandle;
    publicationPayloadDigest: string;
  }): Promise<DurableVerificationBenchmarkComparison> {
    const identity = parseIdentity(input.comparison.identity),
      claim = parseLease(input.lease, identity.operationId),
      expected = expectedRecord(input.comparison, identity);
    const artifact = VerificationArtifactHandleSchema.parse(input.publicationArtifact),
      payloadDigest = DigestSchema.parse(input.publicationPayloadDigest);
    if (artifact.tenantId !== identity.tenantId) throw new Error("BENCHMARK_COMPARISON_PUBLICATION_INPUT_INVALID");
    return this.database.transaction(identity.tenantId, async (client) => {
      await live(client, identity, claim);
      const stored = await get(client, identity);
      if (!stored) throw new Error("BENCHMARK_COMPARISON_NOT_FOUND");
      const current = project(stored, identity);
      assertExpected(current, expected);
      if (
        current.status === "running" ||
        expected.status === "running" ||
        current.resultDigest !== expected.resultDigest ||
        current.completedAt !== expected.completedAt ||
        digestCanonicalJson(current.resultArtifact) !== digestCanonicalJson(expected.resultArtifact) ||
        current.engineeringGateOutcome !== expected.engineeringGateOutcome
      )
        throw new Error("BENCHMARK_COMPARISON_NOT_COMPLETED");
      if (current.status === "sealed") {
        if (
          current.publicationArtifact?.artifactId !== artifact.artifactId ||
          current.publicationArtifact.digest !== artifact.digest ||
          current.publicationPayloadDigest !== payloadDigest
        )
          throw new Error("BENCHMARK_COMPARISON_PUBLICATION_DRIFT");
        return current;
      }
      await client.query(
        `update evaluation.verification_benchmark_comparison set status='sealed',publication_artifact_id=$3,publication_sha256=$4,publication_payload_sha256=$5 where tenant_id=$1 and id=$2 and status='completed'`,
        [identity.tenantId, identity.comparisonId, artifact.artifactId, hex(artifact.digest), hex(payloadDigest)],
      );
      const sealed = await get(client, identity);
      if (!sealed) throw new Error("BENCHMARK_COMPARISON_PUBLICATION_LOST");
      return project(sealed, identity);
    });
  }
}

function parseIdentity(input: VerificationBenchmarkComparisonIdentity): VerificationBenchmarkComparisonIdentity {
  const value = IdentitySchema.parse(input);
  if (
    value.baseline.runId === value.candidate.runId ||
    [
      value.baseline.publicationArtifact,
      value.candidate.publicationArtifact,
      value.profileArtifact,
      ...(value.runtime.dirtyStateArtifact ? [value.runtime.dirtyStateArtifact] : []),
    ].some((a) => a.tenantId !== value.tenantId) ||
    (value.runtime.dirty && !value.runtime.dirtyStateArtifact)
  )
    throw new Error("BENCHMARK_COMPARISON_IDENTITY_INVALID");
  return deepFreeze(value);
}
function parseLease(value: LeasedStep, operationId: string): LeasedStep {
  if (
    value.operationId !== operationId ||
    !UuidSchema.safeParse(value.id).success ||
    !UuidSchema.safeParse(value.leaseToken).success ||
    !Number.isSafeInteger(value.fencingToken) ||
    value.fencingToken < 1 ||
    typeof value.holderIdentity !== "string" ||
    !value.holderIdentity.trim()
  )
    throw new Error("BENCHMARK_COMPARISON_LEASE_INVALID");
  return { ...value };
}
async function live(
  client: TenantSqlClient,
  identity: VerificationBenchmarkComparisonIdentity,
  lease: LeasedStep,
): Promise<void> {
  const op = (
    await client.query<{ status: string; operation_kind: string; attempt_id: string }>(
      "select status,operation_kind,attempt_id from knowledge_service.operation where tenant_id=$1 and id=$2 for update",
      [identity.tenantId, identity.operationId],
    )
  ).rows[0];
  if (
    !op ||
    op.status !== "running" ||
    op.operation_kind !== "verification_benchmark_compare" ||
    op.attempt_id !== identity.runtime.attemptId
  )
    throw new Error("BENCHMARK_COMPARISON_OPERATION_NOT_ACTIVE");
  const row = (
    await client.query<{ id: string }>(
      `select step.id from knowledge_service.operation_step step join knowledge_service.lease lease on lease.tenant_id=step.tenant_id and lease.operation_step_id=step.id
    where step.tenant_id=$1 and step.operation_id=$2 and step.id=$3 and step.status='running' and step.step_key='compare_registered_and_publish'
    and lease.lease_token=$4 and lease.fencing_token=$5 and lease.holder_identity=$6 and lease.released_at is null and lease.expires_at>clock_timestamp()`,
      [identity.tenantId, identity.operationId, lease.id, lease.leaseToken, lease.fencingToken, lease.holderIdentity],
    )
  ).rows[0];
  if (!row) throw new Error("BENCHMARK_COMPARISON_STALE_LEASE");
  await client.query("select set_config('verification.comparison_claim',$1,true)", [
    JSON.stringify({
      stepId: lease.id,
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
      holderIdentity: lease.holderIdentity,
    }),
  ]);
}
async function get(
  client: TenantSqlClient,
  identity: VerificationBenchmarkComparisonIdentity,
): Promise<Stored | undefined> {
  return (
    await client.query<Stored>(
      "select * from evaluation.verification_benchmark_comparison where tenant_id=$1 and id=$2 for update",
      [identity.tenantId, identity.comparisonId],
    )
  ).rows[0];
}
function project(
  row: Stored,
  identity: VerificationBenchmarkComparisonIdentity,
): DurableVerificationBenchmarkComparison {
  if (
    row.id !== identity.comparisonId ||
    row.tenant_id !== identity.tenantId ||
    row.operation_id !== identity.operationId ||
    row.baseline_run_id !== identity.baseline.runId ||
    row.candidate_run_id !== identity.candidate.runId ||
    row.baseline_publication_artifact_id !== identity.baseline.publicationArtifact.artifactId ||
    row.baseline_publication_sha256 !== hex(identity.baseline.publicationArtifact.digest) ||
    row.baseline_payload_sha256 !== hex(identity.baseline.payloadDigest) ||
    row.candidate_publication_artifact_id !== identity.candidate.publicationArtifact.artifactId ||
    row.candidate_publication_sha256 !== hex(identity.candidate.publicationArtifact.digest) ||
    row.candidate_payload_sha256 !== hex(identity.candidate.payloadDigest) ||
    row.profile_id !== identity.profileId ||
    row.profile_artifact_id !== identity.profileArtifact.artifactId ||
    row.profile_sha256 !== hex(identity.profileArtifact.digest) ||
    row.runtime_sha256 !== hex(digestCanonicalJson(identity.runtime)) ||
    digestCanonicalJson(row.runtime) !== digestCanonicalJson(identity.runtime)
  )
    throw new Error("BENCHMARK_COMPARISON_IDENTITY_DRIFT");
  return deepFreeze({
    identity,
    identityDigest: identityDigest(identity),
    status: row.status,
    startedAt: iso(row.started_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
    resultArtifact: row.result_artifact_id
      ? { artifactId: row.result_artifact_id, digest: `sha256:${row.result_sha256}` }
      : null,
    resultDigest: row.result_digest_sha256 ? `sha256:${row.result_digest_sha256}` : null,
    engineeringGateOutcome: row.engineering_gate_outcome,
    publicationArtifact: row.publication_artifact_id
      ? { artifactId: row.publication_artifact_id, digest: `sha256:${row.publication_sha256}` }
      : null,
    publicationPayloadDigest: row.publication_payload_sha256 ? `sha256:${row.publication_payload_sha256}` : null,
  });
}
function expectedRecord(
  input: DurableVerificationBenchmarkComparison,
  identity: VerificationBenchmarkComparisonIdentity,
): DurableVerificationBenchmarkComparison {
  const snapshot = structuredClone(input);
  if (snapshot.identityDigest !== identityDigest(identity) || iso(snapshot.startedAt) !== snapshot.startedAt)
    throw new Error("BENCHMARK_COMPARISON_EXPECTED_IDENTITY_INVALID");
  return deepFreeze(snapshot);
}
function assertExpected(
  current: DurableVerificationBenchmarkComparison,
  expected: DurableVerificationBenchmarkComparison,
): void {
  if (current.identityDigest !== expected.identityDigest || current.startedAt !== expected.startedAt)
    throw new Error("BENCHMARK_COMPARISON_EXPECTED_IDENTITY_INVALID");
}

/** Mirrors durable identity columns; registry metadata is resolved by the trusted artifact boundary. */
function identityDigest(identity: VerificationBenchmarkComparisonIdentity): string {
  const reference = (artifact: VerificationArtifactHandle) => ({
    artifactId: artifact.artifactId,
    digest: artifact.digest,
  });
  return digestCanonicalJson({
    ...identity,
    baseline: { ...identity.baseline, publicationArtifact: reference(identity.baseline.publicationArtifact) },
    candidate: { ...identity.candidate, publicationArtifact: reference(identity.candidate.publicationArtifact) },
    profileArtifact: reference(identity.profileArtifact),
  });
}
