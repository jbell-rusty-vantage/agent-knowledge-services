import {
  type Digest,
  type EffectBinding,
  type JsonValue,
  type Origin,
  canonicalJson,
  digestCanonical,
  originDigest,
  originIdentity,
} from "@aiengineer/knowledge-operation-protocol";
import { evaluateExactUse } from "@aiengineer/knowledge-db";
import type { QueryResultRow } from "pg";
import type { SqlClient } from "./client.js";

/**
 * The durable record writers over the `knowledge_verification` component (K05). Every function runs inside a
 * caller-supplied transaction (`ComponentDatabase.transaction`) so a run's records, its seal and its decision share
 * one atomic boundary when the application needs it. Bodies are stored as validated JSON (research-core validates
 * them); indexed columns are extracted here. Digests are K01 canonical digests of the stored body.
 */
export class ComponentError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ComponentError";
    this.code = code;
  }
}

/** Map a PostgreSQL error raised by the component (message is the code) to a typed error. */
export function componentError(error: unknown): ComponentError {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^[A-Z][A-Z_]+$/.exec(message.split(":")[0]?.trim() ?? "")?.[0] ?? "COMPONENT_FAILURE";
  return new ComponentError(code, message);
}

async function run<R extends QueryResultRow>(
  client: SqlClient,
  text: string,
  values: readonly unknown[],
): Promise<R[]> {
  try {
    const result = await client.query<R>(text, values);
    return result.rows;
  } catch (error) {
    throw componentError(error);
  }
}

export async function registerOrigin(client: SqlClient, tenantId: string, origin: Origin): Promise<Digest> {
  const digest = originDigest(origin);
  const mission = origin.mission;
  await run(
    client,
    `insert into knowledge_verification.origin (tenant_id, origin_digest, kind, installation_id, application_id, issuer, subject,
       mission_id, mission_run_id, activation_id, operation_id, operation_attempt, execution_generation, lane, recovery_authority_ref, identity)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
     on conflict (tenant_id, origin_digest) do nothing`,
    [
      tenantId,
      digest,
      origin.kind,
      origin.installationId,
      origin.applicationId,
      origin.issuer,
      origin.subject,
      mission?.missionId ?? null,
      mission?.runId ?? null,
      mission?.activationId ?? null,
      mission?.operationId ?? null,
      mission?.operationAttempt ?? null,
      mission?.executionGeneration ?? null,
      mission?.lane ?? null,
      origin.recoveryAuthorityRef,
      JSON.stringify(originIdentity(origin)),
    ],
  );
  return digest;
}

export interface EffectRow {
  readonly effect_key: string;
  readonly bound_effect_digest: string;
  readonly semantic_payload_digest: string;
  readonly originating_origin_digest: string;
  readonly created_at: Date;
}

export async function bindEffect(
  client: SqlClient,
  tenantId: string,
  binding: EffectBinding,
  lineageEffectKey: string | null = null,
): Promise<EffectRow> {
  const originating = await registerOrigin(client, tenantId, binding.originatingOrigin);
  const rows = await run<EffectRow>(
    client,
    "select effect_key, bound_effect_digest, semantic_payload_digest, originating_origin_digest, created_at from knowledge_verification.bind_effect($1, $2, $3, $4, $5, $6)",
    [
      tenantId,
      binding.effectKey,
      binding.semanticPayloadDigest,
      originating,
      binding.boundEffectDigest,
      lineageEffectKey,
    ],
  );
  const row = rows[0];
  if (!row) throw new ComponentError("EFFECT_NOT_BOUND");
  return row;
}

export interface FrozenTask {
  readonly taskId: string;
  readonly originalTaskRef: JsonValue;
  readonly use: string;
  readonly audience: string;
  readonly minimumRisk: "low" | "medium" | "high" | "critical";
  readonly rubricRef: string;
  readonly policyRef: string;
  readonly body: JsonValue;
}

/**
 * An identical record registered twice is a no-op (same id, same digest -> same ref); the same id with other bytes
 * refuses `<KIND>_CONFLICT`; the same bytes under another id refuse `<KIND>_DIGEST_EXISTS`. Never a duplicate-key error.
 */
async function idempotentInsert(
  client: SqlClient,
  kind: "TASK" | "FRAGMENT" | "ASSERTION" | "SUPPORT_SET",
  inserted: readonly unknown[],
  lookup: { sql: string; values: readonly unknown[]; id: string; digest: string },
): Promise<void> {
  if (inserted.length > 0) return;
  const rows = await run<{ id: string; digest: string }>(client, lookup.sql, lookup.values);
  const sameId = rows.find((row) => row.id === lookup.id);
  if (sameId !== undefined) {
    if (sameId.digest !== lookup.digest)
      throw new ComponentError(`${kind}_CONFLICT`, `${lookup.id} holds another record`);
    return;
  }
  throw new ComponentError(`${kind}_DIGEST_EXISTS`, `this record is stored as ${rows[0]?.id ?? "<unknown>"}`);
}

export async function freezeTask(client: SqlClient, tenantId: string, task: FrozenTask): Promise<Digest> {
  const digest = digestCanonical(task.body);
  const inserted = await run(
    client,
    `insert into knowledge_verification.verification_task (tenant_id, task_id, schema_version, task_digest, original_task_ref, use_name, audience, minimum_risk, rubric_ref, policy_ref, body)
     values ($1, $2, 'research-core.task.v2', $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb)
     on conflict do nothing returning task_id`,
    [
      tenantId,
      task.taskId,
      digest,
      JSON.stringify(task.originalTaskRef),
      task.use,
      task.audience,
      task.minimumRisk,
      task.rubricRef,
      task.policyRef,
      canonicalJson(task.body),
    ],
  );
  await idempotentInsert(client, "TASK", inserted, {
    sql: "select task_id as id, task_digest as digest from knowledge_verification.verification_task where tenant_id = $1 and (task_id = $2 or task_digest = $3)",
    values: [tenantId, task.taskId, digest],
    id: task.taskId,
    digest,
  });
  return digest;
}

export interface OpenRunInput {
  readonly taskId: string;
  readonly binding: string;
  readonly originatingOrigin: Origin;
  readonly schemaVersions?: Record<string, string>;
}

export interface RunRow {
  readonly run_id: string;
  readonly state: string;
  readonly head_digest: string | null;
  readonly head_sequence: number;
  readonly record: JsonValue | null;
  readonly record_digest: string | null;
}

export async function openRun(client: SqlClient, tenantId: string, input: OpenRunInput): Promise<RunRow> {
  const origin = await registerOrigin(client, tenantId, input.originatingOrigin);
  const mission = input.originatingOrigin.mission;
  const rows = await run<RunRow>(
    client,
    `insert into knowledge_verification.verification_run (tenant_id, task_id, binding, originating_origin_digest, mission_id, mission_run_id, activation_id, operation_id, operation_attempt, execution_generation, schema_versions)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) returning run_id::text, state, head_digest, head_sequence, record, record_digest`,
    [
      tenantId,
      input.taskId,
      input.binding,
      origin,
      mission?.missionId ?? null,
      mission?.runId ?? null,
      mission?.activationId ?? null,
      mission?.operationId ?? null,
      mission?.operationAttempt ?? null,
      mission?.executionGeneration ?? null,
      JSON.stringify(input.schemaVersions ?? {}),
    ],
  );
  const row = rows[0];
  if (!row) throw new ComponentError("RUN_NOT_OPENED");
  return row;
}

export async function markRunObserving(client: SqlClient, tenantId: string, runId: string): Promise<void> {
  await run(
    client,
    "update knowledge_verification.verification_run set state = 'observing' where tenant_id = $1 and run_id = $2::uuid and state = 'preparing'",
    [tenantId, runId],
  );
}

/** Store the K02 VerificationRun record on the opened run (once; the trigger refuses rewriting it). */
export async function putRunRecord(
  client: SqlClient,
  tenantId: string,
  runId: string,
  record: JsonValue,
): Promise<Digest> {
  const digest = digestCanonical(record);
  await run(
    client,
    "update knowledge_verification.verification_run set record = $3::jsonb, record_digest = $4 where tenant_id = $1 and run_id = $2::uuid",
    [tenantId, runId, canonicalJson(record), digest],
  );
  return digest;
}

export async function loadRun(client: SqlClient, tenantId: string, runId: string): Promise<RunRow | null> {
  const rows = await run<RunRow>(
    client,
    "select run_id::text, state, head_digest, head_sequence, record, record_digest from knowledge_verification.verification_run where tenant_id = $1 and run_id = $2::uuid",
    [tenantId, runId],
  );
  return rows[0] ?? null;
}

export interface AssertionInput {
  readonly assertionId: string;
  readonly logicalId: string;
  readonly kind: "source_report" | "world_fact" | "derivation" | "recommendation" | "forecast";
  readonly proposition: string;
  readonly profileRef: string;
  readonly qualifiers: JsonValue;
  readonly producer: Origin;
  readonly premises: readonly string[];
  readonly body: JsonValue;
}

export async function recordAssertion(client: SqlClient, tenantId: string, input: AssertionInput): Promise<Digest> {
  const producer = await registerOrigin(client, tenantId, input.producer);
  const digest = digestCanonical(input.body);
  const inserted = await run(
    client,
    `insert into knowledge_verification.assertion (tenant_id, assertion_id, logical_id, schema_version, digest, kind, proposition, profile_ref, qualifiers, qualifiers_digest, producer_origin_digest, premises, body)
     values ($1, $2, $3, 'research-core.assertion.v2', $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb)
     on conflict do nothing returning assertion_id`,
    [
      tenantId,
      input.assertionId,
      input.logicalId,
      digest,
      input.kind,
      input.proposition,
      input.profileRef,
      canonicalJson(input.qualifiers),
      digestCanonical(input.qualifiers),
      producer,
      JSON.stringify(input.premises),
      canonicalJson(input.body),
    ],
  );
  await idempotentInsert(client, "ASSERTION", inserted, {
    sql: "select assertion_id as id, digest from knowledge_verification.assertion where tenant_id = $1 and (assertion_id = $2 or digest = $3)",
    values: [tenantId, input.assertionId, digest],
    id: input.assertionId,
    digest,
  });
  return digest;
}

export interface FragmentInput {
  readonly fragmentId: string;
  readonly sourceRef: JsonValue;
  readonly captureDigest: string;
  readonly representationDigest: string;
  readonly selector: JsonValue;
  readonly resolverVersion: string;
  readonly completeness: "complete" | "partial" | "truncated" | "unknown";
  readonly rightsScope: string;
  readonly body: JsonValue;
}

export async function recordFragment(client: SqlClient, tenantId: string, input: FragmentInput): Promise<Digest> {
  const digest = digestCanonical(input.body);
  const inserted = await run(
    client,
    `insert into knowledge_verification.fragment (tenant_id, fragment_id, schema_version, digest, source_ref, capture_digest, representation_digest, selector, resolver_version, completeness, rights_scope, body)
     values ($1, $2, 'research-core.fragment.v2', $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb)
     on conflict do nothing returning fragment_id`,
    [
      tenantId,
      input.fragmentId,
      digest,
      canonicalJson(input.sourceRef),
      input.captureDigest,
      input.representationDigest,
      canonicalJson(input.selector),
      input.resolverVersion,
      input.completeness,
      input.rightsScope,
      canonicalJson(input.body),
    ],
  );
  await idempotentInsert(client, "FRAGMENT", inserted, {
    sql: "select fragment_id as id, digest from knowledge_verification.fragment where tenant_id = $1 and (fragment_id = $2 or digest = $3)",
    values: [tenantId, input.fragmentId, digest],
    id: input.fragmentId,
    digest,
  });
  return digest;
}

export interface SupportSetInput {
  readonly supportSetId: string;
  readonly assertionId: string;
  readonly required: JsonValue[];
  readonly contrary: JsonValue[];
  readonly body: JsonValue;
}

export async function recordSupportSet(client: SqlClient, tenantId: string, input: SupportSetInput): Promise<Digest> {
  const digest = digestCanonical(input.body);
  const inserted = await run(
    client,
    `insert into knowledge_verification.support_set (tenant_id, support_set_id, schema_version, digest, assertion_id, required, contrary, body)
     values ($1, $2, 'research-core.support_set.v2', $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
     on conflict do nothing returning support_set_id`,
    [
      tenantId,
      input.supportSetId,
      digest,
      input.assertionId,
      JSON.stringify(input.required),
      JSON.stringify(input.contrary),
      canonicalJson(input.body),
    ],
  );
  await idempotentInsert(client, "SUPPORT_SET", inserted, {
    sql: "select support_set_id as id, digest from knowledge_verification.support_set where tenant_id = $1 and (support_set_id = $2 or digest = $3)",
    values: [tenantId, input.supportSetId, digest],
    id: input.supportSetId,
    digest,
  });
  return digest;
}

export interface ArtifactInput {
  readonly artifactId: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  /** Inline up to 1 MiB; larger bodies are placed by the custody adapter and referenced by URI. */
  readonly custody?: { kind: "bucket" | "volume" | "external"; uri: string };
}

/** Inline custody holds at most 1 MiB (component check); larger bodies need an external custody placement. */
export const INLINE_CUSTODY_LIMIT = 1048576;

/**
 * Put one immutable artifact. Idempotent for identical bytes: `on conflict do nothing` covers BOTH unique keys
 * (tenant, artifact_id) and (tenant, digest), so two concurrent puts of the same bytes both succeed (the loser waits
 * for the winner's commit, then does nothing). An existing row is then re-read: the same id with other bytes refuses
 * `ARTIFACT_CONFLICT`; the same bytes under another id refuses `ARTIFACT_DIGEST_EXISTS` (naming the existing id).
 */
export async function putArtifact(client: SqlClient, tenantId: string, input: ArtifactInput): Promise<Digest> {
  const { createHash } = await import("node:crypto");
  const digest = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}` as Digest;
  if (!input.custody && input.bytes.byteLength > INLINE_CUSTODY_LIMIT) {
    throw new ComponentError("ARTIFACT_TOO_LARGE_FOR_INLINE", `${input.bytes.byteLength} bytes need external custody`);
  }
  const inserted = input.custody
    ? await run<{ artifact_id: string }>(
        client,
        `insert into knowledge_verification.artifact_custody (tenant_id, artifact_id, digest, byte_length, media_type, custody_kind, custody_uri)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing returning artifact_id`,
        [
          tenantId,
          input.artifactId,
          digest,
          input.bytes.byteLength,
          input.mediaType,
          input.custody.kind,
          input.custody.uri,
        ],
      )
    : await run<{ artifact_id: string }>(
        client,
        `insert into knowledge_verification.artifact_custody (tenant_id, artifact_id, digest, byte_length, media_type, custody_kind, inline_bytes)
         values ($1, $2, $3, $4, $5, 'inline', $6) on conflict do nothing returning artifact_id`,
        [tenantId, input.artifactId, digest, input.bytes.byteLength, input.mediaType, Buffer.from(input.bytes)],
      );
  if (inserted.length > 0) return digest;
  const existing = await run<{ artifact_id: string; digest: string }>(
    client,
    "select artifact_id, digest from knowledge_verification.artifact_custody where tenant_id = $1 and (artifact_id = $2 or digest = $3)",
    [tenantId, input.artifactId, digest],
  );
  const sameId = existing.find((row) => row.artifact_id === input.artifactId);
  if (sameId !== undefined) {
    if (sameId.digest !== digest)
      throw new ComponentError("ARTIFACT_CONFLICT", `${input.artifactId} holds other bytes`);
    return digest;
  }
  throw new ComponentError(
    "ARTIFACT_DIGEST_EXISTS",
    `these bytes are stored as ${existing[0]?.artifact_id ?? "<unknown>"}`,
  );
}

export async function readInlineArtifact(
  client: SqlClient,
  tenantId: string,
  artifactId: string,
): Promise<{
  digest: string;
  bytes: Uint8Array | null;
  mediaType: string;
  custodyKind: string;
  uri: string | null;
} | null> {
  const rows = await run<{
    digest: string;
    inline_bytes: Buffer | null;
    media_type: string;
    custody_kind: string;
    custody_uri: string | null;
  }>(
    client,
    "select digest, inline_bytes, media_type, custody_kind, custody_uri from knowledge_verification.artifact_custody where tenant_id = $1 and artifact_id = $2",
    [tenantId, artifactId],
  );
  const row = rows[0];
  return row
    ? {
        digest: row.digest,
        bytes: row.inline_bytes,
        mediaType: row.media_type,
        custodyKind: row.custody_kind,
        uri: row.custody_uri,
      }
    : null;
}

/** Dependency edge (2.2.0 reading): `from` is upstream, `to` depends on it. Idempotent. */
export type EdgeKind = "capture" | "fragment" | "assertion" | "support_set" | "report" | "use_decision" | "effect";
export async function recordDependencyEdge(
  client: SqlClient,
  tenantId: string,
  edge: {
    from: { kind: EdgeKind; id: string };
    to: { kind: EdgeKind; id: string };
    edgeKind:
      | "captured_from"
      | "extracted_from"
      | "supports"
      | "contradicts"
      | "premise_of"
      | "occurs_in"
      | "decided_from"
      | "applied_from";
  },
): Promise<void> {
  await run(
    client,
    `insert into knowledge_verification.dependency_edge (tenant_id, from_kind, from_id, to_kind, to_id, edge_kind)
     values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
    [tenantId, edge.from.kind, edge.from.id, edge.to.kind, edge.to.id, edge.edgeKind],
  );
}

export interface ReportRevisionInput {
  readonly reportRevisionId: string;
  readonly reportId: string;
  readonly revision: number;
  readonly reportKind: string;
  readonly taskId: string;
  readonly runId: string;
  readonly structuredBodyArtifactId: string;
  readonly bodyArtifactId: string;
  readonly ledgerArtifactId: string;
  readonly bodyDigest: string;
  readonly rendererVersion: string;
  readonly assertionRefs: JsonValue[];
  readonly timeCoverage: JsonValue;
  readonly derivationCandidates?: JsonValue[];
  readonly supersedesReportRevisionId?: string | null;
  /** The K02 ReportRevision record; its canonical digest is the revision digest. */
  readonly record: JsonValue;
}

export async function registerReportRevision(
  client: SqlClient,
  tenantId: string,
  input: ReportRevisionInput,
): Promise<Digest> {
  const digest = digestCanonical(input.record);
  await run(
    client,
    `insert into knowledge_verification.report_revision (tenant_id, report_revision_id, report_id, revision, schema_version, report_kind, task_id, run_id,
       structured_body_artifact_id, body_artifact_id, ledger_artifact_id, body_digest, renderer_version, assertion_refs, time_coverage, derivation_candidates, supersedes_report_revision_id, record, digest)
     values ($1, $2, $3, $4, 'research-report.v2', $5, $6, $7::uuid, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16, $17::jsonb, $18)`,
    [
      tenantId,
      input.reportRevisionId,
      input.reportId,
      input.revision,
      input.reportKind,
      input.taskId,
      input.runId,
      input.structuredBodyArtifactId,
      input.bodyArtifactId,
      input.ledgerArtifactId,
      input.bodyDigest,
      input.rendererVersion,
      JSON.stringify(input.assertionRefs),
      canonicalJson(input.timeCoverage),
      JSON.stringify(input.derivationCandidates ?? []),
      input.supersedesReportRevisionId ?? null,
      canonicalJson(input.record),
      digest,
    ],
  );
  return digest;
}

export interface OccurrenceInput {
  readonly occurrenceId: string;
  readonly assertionId: string;
  readonly reportRevisionId: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly blockPath: string;
  readonly quoteDigest: string;
  readonly obligations: readonly string[];
}

export async function recordOccurrence(client: SqlClient, tenantId: string, input: OccurrenceInput): Promise<void> {
  await run(
    client,
    `insert into knowledge_verification.occurrence (tenant_id, occurrence_id, assertion_id, report_revision_id, span_start, span_end, block_path, quote_digest, obligations)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      tenantId,
      input.occurrenceId,
      input.assertionId,
      input.reportRevisionId,
      input.spanStart,
      input.spanEnd,
      input.blockPath,
      input.quoteDigest,
      JSON.stringify(input.obligations),
    ],
  );
}

export interface ObservationInput {
  readonly observationId: string;
  readonly runId: string;
  readonly target: { kind: "assertion" | "support_set" | "report"; id: string; digest: string };
  readonly property: "integrity" | "support" | "authority" | "attribution" | "census" | "challenge";
  readonly inputDigest: string;
  readonly methodRef: string;
  readonly evaluator: JsonValue;
  readonly evaluatorRole: "producer" | "judge" | "second_family_judge" | "auditor" | "human_reviewer";
  readonly outcome: JsonValue;
  readonly rationale: string;
  readonly limitations?: readonly string[];
  readonly evidenceRefs?: JsonValue[];
  readonly rawResponseArtifactId?: string | null;
  readonly usage?: { providerCalls: number; tokens: number; costUsd: string };
  /** The full K02 VerificationObservation record when the caller has one; otherwise the minimal body is stored. */
  readonly record?: JsonValue;
}

export async function appendObservation(client: SqlClient, tenantId: string, input: ObservationInput): Promise<Digest> {
  const body: JsonValue = {
    observationId: input.observationId,
    target: input.target,
    property: input.property,
    inputDigest: input.inputDigest,
    methodRef: input.methodRef,
    evaluator: input.evaluator,
    outcome: input.outcome,
    rationale: input.rationale,
    limitations: [...(input.limitations ?? [])],
  };
  const record = input.record ?? body;
  const digest = digestCanonical(record);
  await run(
    client,
    `insert into knowledge_verification.observation (tenant_id, observation_id, schema_version, run_id, target_kind, target_id, target_digest, property, input_digest, method_ref, evaluator, evaluator_role,
       outcome, rationale, limitations, evidence_refs, raw_response_artifact_id, provider_calls, tokens, cost_usd, record, digest)
     values ($1, $2, 'research-core.observation.v2', $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20::jsonb, $21)`,
    [
      tenantId,
      input.observationId,
      input.runId,
      input.target.kind,
      input.target.id,
      input.target.digest,
      input.property,
      input.inputDigest,
      input.methodRef,
      canonicalJson(input.evaluator),
      input.evaluatorRole,
      canonicalJson(input.outcome),
      input.rationale,
      JSON.stringify(input.limitations ?? []),
      JSON.stringify(input.evidenceRefs ?? []),
      input.rawResponseArtifactId ?? null,
      input.usage?.providerCalls ?? 0,
      input.usage?.tokens ?? 0,
      input.usage?.costUsd ?? "0",
      canonicalJson(record),
      digest,
    ],
  );
  return digest;
}

export interface ObservationRow {
  readonly observation_id: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly property: string;
  readonly evaluator_role: string;
  readonly outcome: JsonValue;
  readonly record: JsonValue;
  readonly digest: string;
  readonly recorded_at: Date;
}

export async function listObservations(client: SqlClient, tenantId: string, runId: string): Promise<ObservationRow[]> {
  return run<ObservationRow>(
    client,
    "select observation_id, target_kind, target_id, property, evaluator_role, outcome, record, digest, recorded_at from knowledge_verification.observation where tenant_id = $1 and run_id = $2::uuid order by seq",
    [tenantId, runId],
  );
}

export interface SealInput {
  readonly runId: string;
  readonly expectedHead: string | null;
  readonly manifestKind: "verification_snapshot" | "decision_snapshot" | "admission_snapshot" | "correction_snapshot";
  /** Canonical unsigned manifest: references and digests only; never its own digest or signature. */
  readonly manifest: JsonValue;
  readonly familyRefs: Record<string, string>;
  readonly signer: string;
  /** Detached Ed25519 seal (component 2.2.0): algorithm, pinned key id, 64-byte signature and its signed context. */
  readonly signature: {
    readonly algorithm: "Ed25519";
    readonly keyId: string;
    readonly bytes: Uint8Array;
    readonly context: JsonValue;
  };
}

export interface SealRow {
  readonly sequence: number;
  readonly manifest_digest: string;
  readonly predecessor_digest: string | null;
  readonly sealed_at: Date;
}

export async function sealRun(client: SqlClient, tenantId: string, input: SealInput): Promise<SealRow> {
  const manifestDigest = digestCanonical(input.manifest);
  const rows = await run<SealRow>(
    client,
    "select sequence, manifest_digest, predecessor_digest, sealed_at from knowledge_verification.seal_run($1, $2::uuid, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12::jsonb)",
    [
      tenantId,
      input.runId,
      input.expectedHead,
      input.manifestKind,
      canonicalJson(input.manifest),
      manifestDigest,
      JSON.stringify(input.familyRefs),
      input.signer,
      input.signature.algorithm,
      input.signature.keyId,
      Buffer.from(input.signature.bytes),
      canonicalJson(input.signature.context),
    ],
  );
  const row = rows[0];
  if (!row) throw new ComponentError("RUN_NOT_SEALED");
  return row;
}

export interface UseDecisionInput {
  readonly useDecisionId: string;
  readonly subject: { kind: "assertion" | "report"; id: string; digest: string };
  readonly runId: string;
  readonly boundEffectDigest: string;
  readonly use: string;
  readonly audience: string;
  readonly disposition: "admitted" | "held" | "rejected";
  readonly conditions?: readonly string[];
  readonly policyRef: string;
  readonly rubricRef: string;
  /** Null for a report subject (component 2.2.0 check: assertion subjects bind one, report subjects none). */
  readonly qualifiersDigest: string | null;
  readonly supportSetId?: string | null;
  /** OQ2 normalized values and their K01 canonical digest (compared by admit_exact_use). */
  readonly normalizedValues?: JsonValue;
  readonly normalizedValuesDigest?: string | null;
  readonly revocationEpoch: number;
  readonly expiresAt?: string | null;
  readonly reviewerAdjudicationId?: string | null;
  readonly supersedesUseDecisionId?: string | null;
  /** The full K02 UseDecision record when the caller has one. */
  readonly record?: JsonValue;
}

export async function recordUseDecision(client: SqlClient, tenantId: string, input: UseDecisionInput): Promise<Digest> {
  const body: JsonValue = {
    useDecisionId: input.useDecisionId,
    subject: input.subject,
    runId: input.runId,
    boundEffectDigest: input.boundEffectDigest,
    use: input.use,
    audience: input.audience,
    disposition: input.disposition,
    conditions: [...(input.conditions ?? [])],
    policyRef: input.policyRef,
    rubricRef: input.rubricRef,
    qualifiersDigest: input.qualifiersDigest,
    supportSetId: input.supportSetId ?? null,
    revocationEpoch: input.revocationEpoch,
    expiresAt: input.expiresAt ?? null,
    reviewerAdjudicationId: input.reviewerAdjudicationId ?? null,
    supersedesUseDecisionId: input.supersedesUseDecisionId ?? null,
  };
  const record = input.record ?? body;
  const digest = digestCanonical(record);
  await run(
    client,
    `insert into knowledge_verification.use_decision (tenant_id, use_decision_id, schema_version, subject_kind, subject_id, subject_digest, run_id, bound_effect_digest, use_name, audience, disposition, conditions,
       policy_ref, rubric_ref, qualifiers_digest, support_set_id, revocation_epoch, expires_at, reviewer_adjudication_id, supersedes_use_decision_id, record, digest,
     normalized_values, normalized_values_digest)
     values ($1, $2, 'research-core.use_decision.v2', $3, $4, $5, $6::uuid, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21,
             $22::jsonb, $23)`,
    [
      tenantId,
      input.useDecisionId,
      input.subject.kind,
      input.subject.id,
      input.subject.digest,
      input.runId,
      input.boundEffectDigest,
      input.use,
      input.audience,
      input.disposition,
      JSON.stringify(input.conditions ?? []),
      input.policyRef,
      input.rubricRef,
      input.qualifiersDigest,
      input.supportSetId ?? null,
      input.revocationEpoch,
      input.expiresAt ?? null,
      input.reviewerAdjudicationId ?? null,
      input.supersedesUseDecisionId ?? null,
      canonicalJson(record),
      digest,
      input.normalizedValues === undefined ? null : canonicalJson(input.normalizedValues),
      input.normalizedValuesDigest ?? null,
    ],
  );
  return digest;
}

export interface AdmissionOutcome {
  readonly outcome: "admitted" | "held" | "rejected";
  readonly reason: string;
  readonly authoritativeEpoch: number;
}

/**
 * The exact-use oracle, delegated to the ONE admission module (`@aiengineer/knowledge-db` exact-use-admission) so the
 * binding and the native ingestion transaction share a single code path; checked under the component's epoch lock
 * on the caller's transaction client.
 */
export async function admitExactUse(
  client: SqlClient,
  tenantId: string,
  useDecisionId: string,
  boundEffectDigest: string,
  processedEpoch: number,
  normalizedValuesDigest: string,
): Promise<AdmissionOutcome> {
  try {
    return await evaluateExactUse(client, tenantId, {
      useDecisionId,
      boundEffectDigest,
      processedEpoch,
      normalizedValuesDigest,
    });
  } catch (error) {
    throw componentError(error);
  }
}

export interface ReviewerGrantRow {
  readonly grant_id: string;
}

export async function grantReviewer(
  client: SqlClient,
  tenantId: string,
  grant: { reviewerId: string; scope: JsonValue; grantedBy: string; grantedAt: string },
): Promise<string> {
  const rows = await run<ReviewerGrantRow>(
    client,
    "insert into knowledge_verification.reviewer_grant (tenant_id, reviewer_id, scope, granted_by, granted_at) values ($1, $2, $3::jsonb, $4, $5::timestamptz) returning grant_id::text",
    [tenantId, grant.reviewerId, canonicalJson(grant.scope), grant.grantedBy, grant.grantedAt],
  );
  const row = rows[0];
  if (!row) throw new ComponentError("GRANT_NOT_RECORDED");
  return row.grant_id;
}

export async function revokeReviewerGrant(
  client: SqlClient,
  tenantId: string,
  grantId: string,
  at: string,
): Promise<void> {
  await run(
    client,
    "update knowledge_verification.reviewer_grant set revoked_at = $3::timestamptz where tenant_id = $1 and grant_id = $2::uuid and revoked_at is null",
    [tenantId, grantId, at],
  );
}

/** The trigger refuses REVIEWER_NOT_QUALIFIED / ADJUDICATION_SUBJECT_MISMATCH / REVIEW_BINDING_MISMATCH. */
export async function recordAdjudication(
  client: SqlClient,
  tenantId: string,
  input: {
    adjudicationId: string;
    useDecisionId: string;
    subject: { kind: string; id: string; digest: string };
    boundEffectDigest: string;
    qualifiersDigest: string | null;
    reviewerId: string;
    decision: "approve" | "hold" | "reject";
    rationale: string;
    decidedAt: string;
    record: JsonValue;
  },
): Promise<Digest> {
  const digest = digestCanonical(input.record);
  await run(
    client,
    `insert into knowledge_verification.adjudication (tenant_id, adjudication_id, subject_kind, subject_id, subject_digest, bound_effect_digest, reviewer_id,
       decision, rationale, digest, decided_at, use_decision_id, qualifiers_digest, record)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13, $14::jsonb)`,
    [
      tenantId,
      input.adjudicationId,
      input.subject.kind,
      input.subject.id,
      input.subject.digest,
      input.boundEffectDigest,
      input.reviewerId,
      input.decision,
      input.rationale,
      digest,
      input.decidedAt,
      input.useDecisionId,
      input.qualifiersDigest,
      canonicalJson(input.record),
    ],
  );
  return digest;
}

/**
 * Record the invalidation (epoch advance) and list its affected closure over dependency_edge in the SAME transaction,
 * then mark the closure processed: dependent decisions are invalidated at once; unrelated branches are untouched.
 */
export async function recordCorrectionClosure(
  client: SqlClient,
  tenantId: string,
  corrected: { kind: "fragment" | "capture"; id: string },
  reason: string,
): Promise<{ invalidationId: string; epoch: number; affected: { kind: string; id: string }[] }> {
  const recorded = await recordInvalidation(client, tenantId, corrected, reason);
  const affected = await run<{ kind: string; id: string }>(
    client,
    `with recursive closure(kind, id) as (
       select $2::text, $3::text
       union
       select e.to_kind, e.to_id from knowledge_verification.dependency_edge e
         join closure c on e.from_kind = c.kind and e.from_id = c.id
        where e.tenant_id = $1
     )
     select kind, id from closure where not (kind = $2 and id = $3) order by kind, id`,
    [tenantId, corrected.kind, corrected.id],
  );
  const listable = affected.filter((item) =>
    ["fragment", "assertion", "support_set", "report", "use_decision", "effect"].includes(item.kind),
  );
  await closeInvalidation(client, tenantId, recorded.invalidationId, listable);
  return { ...recorded, affected: listable };
}

export async function currentRevocationEpoch(client: SqlClient, tenantId: string): Promise<number> {
  const rows = await run<{ epoch: string }>(
    client,
    "select knowledge_verification.current_revocation_epoch($1)::text as epoch",
    [tenantId],
  );
  return Number(rows[0]?.epoch ?? 0);
}

export async function recordInvalidation(
  client: SqlClient,
  tenantId: string,
  corrected: { kind: string; id: string },
  reason: string,
): Promise<{ invalidationId: string; epoch: number }> {
  const rows = await run<{ invalidation_id: string; epoch: string }>(
    client,
    "select invalidation_id::text, epoch::text from knowledge_verification.record_invalidation($1, $2, $3, $4)",
    [tenantId, corrected.kind, corrected.id, reason],
  );
  const row = rows[0];
  if (!row) throw new ComponentError("INVALIDATION_NOT_RECORDED");
  return { invalidationId: row.invalidation_id, epoch: Number(row.epoch) };
}

export async function closeInvalidation(
  client: SqlClient,
  tenantId: string,
  invalidationId: string,
  affected: readonly { kind: string; id: string }[],
): Promise<void> {
  for (const item of affected) {
    await run(
      client,
      "insert into knowledge_verification.invalidation_affected (tenant_id, invalidation_id, affected_kind, affected_id) values ($1, $2::uuid, $3, $4) on conflict do nothing",
      [tenantId, invalidationId, item.kind, item.id],
    );
  }
  await run(
    client,
    "update knowledge_verification.invalidation set closure_processed_at = now() where tenant_id = $1 and invalidation_id = $2::uuid and closure_processed_at is null",
    [tenantId, invalidationId],
  );
}

export interface EffectReceiptInput {
  readonly effectKey: string;
  readonly outcome: "applied" | "noop" | "partial" | "rejected";
  readonly nativeReceiptRef: JsonValue;
  readonly affectedRefs?: JsonValue[];
  readonly concurrencyBefore?: string | null;
  readonly concurrencyAfter?: string | null;
  readonly processedEpoch: number;
  readonly itemOutcomes?: JsonValue[];
  readonly useDecisionId?: string | null;
}

export async function recordEffectReceipt(
  client: SqlClient,
  tenantId: string,
  input: EffectReceiptInput,
): Promise<{ outcome: string; digest: string }> {
  const digest = digestCanonical({
    effectKey: input.effectKey,
    outcome: input.outcome,
    nativeReceiptRef: input.nativeReceiptRef,
    affectedRefs: input.affectedRefs ?? [],
    concurrencyBefore: input.concurrencyBefore ?? null,
    concurrencyAfter: input.concurrencyAfter ?? null,
    processedEpoch: input.processedEpoch,
    itemOutcomes: input.itemOutcomes ?? [],
    useDecisionId: input.useDecisionId ?? null,
  });
  const rows = await run<{ outcome: string; digest: string }>(
    client,
    "select outcome, digest from knowledge_verification.record_effect_receipt($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11)",
    [
      tenantId,
      input.effectKey,
      input.outcome,
      canonicalJson(input.nativeReceiptRef),
      JSON.stringify(input.affectedRefs ?? []),
      input.concurrencyBefore ?? null,
      input.concurrencyAfter ?? null,
      input.processedEpoch,
      JSON.stringify(input.itemOutcomes ?? []),
      input.useDecisionId ?? null,
      digest,
    ],
  );
  const row = rows[0];
  if (!row) throw new ComponentError("RECEIPT_NOT_RECORDED");
  return row;
}

export async function lookupEffectReceipt(
  client: SqlClient,
  tenantId: string,
  effectKey: string,
): Promise<{ outcome: string; digest: string; appliedAt: Date } | null> {
  const rows = await run<{ outcome: string; digest: string; applied_at: Date }>(
    client,
    "select outcome, digest, applied_at from knowledge_verification.effect_receipt where tenant_id = $1 and effect_key = $2",
    [tenantId, effectKey],
  );
  const row = rows[0];
  return row ? { outcome: row.outcome, digest: row.digest, appliedAt: row.applied_at } : null;
}

/**
 * Enqueue through the component's guarded function (2.2.0): the effect is bound to the same digest, the payload is an
 * inline custody row with `payload_digest`, and `admit_exact_use` admits the decision now. Idempotent by dispatch id.
 */
export async function enqueueDispatch(
  client: SqlClient,
  tenantId: string,
  dispatch: {
    dispatchId: string;
    effectKey: string;
    targetBinding: string;
    payloadDigest: string;
    useDecisionId: string;
    boundEffectDigest: string;
    processedEpoch: number;
    /**
     * Required key (R1 F2, component 2.4.0): the digest of the normalized values the dispatch writes. Null is passed
     * through only so the SQL authority decides: admit_exact_use raises NORMALIZED_VALUES_REQUIRED when the decision
     * binds values.
     */
    normalizedValuesDigest: string | null;
    markerScheme?: "ks-intent-marker.v1" | "bks-intent-marker-digest.v1";
  },
): Promise<DispatchRow> {
  const rows = await run<DispatchRow>(
    client,
    `select ${DISPATCH_COLUMNS} from knowledge_verification.enqueue_dispatch($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tenantId,
      dispatch.dispatchId,
      dispatch.effectKey,
      dispatch.targetBinding,
      dispatch.payloadDigest,
      dispatch.useDecisionId,
      dispatch.boundEffectDigest,
      dispatch.processedEpoch,
      dispatch.normalizedValuesDigest,
      dispatch.markerScheme ?? "ks-intent-marker.v1",
    ],
  );
  const row = rows[0];
  if (!row) throw new ComponentError("DISPATCH_NOT_ENQUEUED");
  return row;
}

const DISPATCH_COLUMNS =
  "dispatch_id, effect_key, target_binding, payload_digest, state, attempts, bound_effect_digest, use_decision_id, revocation_epoch::int as revocation_epoch, marker_scheme, expected_marker_digest, ack_digest, ack_outcome, graph_tx_ref";

export interface DispatchRow {
  readonly dispatch_id: string;
  readonly effect_key: string;
  readonly target_binding: string;
  readonly payload_digest: string;
  readonly state: string;
  readonly attempts: number;
  readonly bound_effect_digest: string | null;
  readonly use_decision_id: string | null;
  readonly revocation_epoch: number | null;
  readonly marker_scheme: string | null;
  readonly expected_marker_digest: string | null;
  readonly ack_digest: string | null;
  readonly ack_outcome: string | null;
  readonly graph_tx_ref: string | null;
}

export async function claimDispatches(
  client: SqlClient,
  tenantId: string,
  limit: number,
  targetBinding: string | null = null,
): Promise<DispatchRow[]> {
  return run<DispatchRow>(
    client,
    `select ${DISPATCH_COLUMNS} from knowledge_verification.claim_dispatches($1, $2, now(), $3)`,
    [tenantId, limit, targetBinding],
  );
}

/** Verified acknowledgment (only from `dispatched`); the acknowledgment record is stored with the dispatch. */
export async function acknowledgeDispatch(
  client: SqlClient,
  tenantId: string,
  dispatchId: string,
  ackDigest: string,
  ackRecord: JsonValue | null = null,
): Promise<DispatchRow> {
  const rows = await run<DispatchRow>(
    client,
    `select ${DISPATCH_COLUMNS} from knowledge_verification.acknowledge_dispatch($1, $2, $3, now(), $4::jsonb)`,
    [tenantId, dispatchId, ackDigest, ackRecord === null ? null : canonicalJson(ackRecord)],
  );
  const row = rows[0];
  if (!row) throw new ComponentError("DISPATCH_NOT_FOUND");
  return row;
}

/** Terminal not-applied settlement for the outbox worker: `revoked` or `refused`, with a reason record. */
export async function settleDispatch(
  client: SqlClient,
  tenantId: string,
  dispatchId: string,
  outcome: "revoked" | "refused",
  detail: JsonValue,
): Promise<DispatchRow> {
  const rows = await run<DispatchRow>(
    client,
    `select ${DISPATCH_COLUMNS} from knowledge_verification.settle_dispatch($1, $2, $3, $4::jsonb)`,
    [tenantId, dispatchId, outcome, canonicalJson(detail)],
  );
  const row = rows[0];
  if (!row) throw new ComponentError("DISPATCH_NOT_FOUND");
  return row;
}

/** Side-effect-free eligibility (official reads; reader role): the admission rule at the current epoch. */
export async function checkUseEligibility(
  client: SqlClient,
  tenantId: string,
  useDecisionId: string,
  boundEffectDigest: string,
): Promise<{ state: string; reason: string; authoritativeEpoch: number; decisionEpoch: number | null }> {
  const rows = await run<{ state: string; reason: string; authoritative_epoch: string; decision_epoch: string | null }>(
    client,
    "select state, reason, authoritative_epoch::text, decision_epoch::text from knowledge_verification.check_use_eligibility($1, $2, $3)",
    [tenantId, useDecisionId, boundEffectDigest],
  );
  const row = rows[0];
  if (!row) return { state: "held", reason: "AUTHORITY_UNAVAILABLE", authoritativeEpoch: -1, decisionEpoch: null };
  return {
    state: row.state,
    reason: row.reason,
    authoritativeEpoch: Number(row.authoritative_epoch),
    decisionEpoch: row.decision_epoch === null ? null : Number(row.decision_epoch),
  };
}

export async function failDispatch(
  client: SqlClient,
  tenantId: string,
  dispatchId: string,
  error: string,
): Promise<DispatchRow> {
  const rows = await run<DispatchRow>(
    client,
    `select ${DISPATCH_COLUMNS} from knowledge_verification.fail_dispatch($1, $2, $3)`,
    [tenantId, dispatchId, error],
  );
  const row = rows[0];
  if (!row) throw new ComponentError("DISPATCH_NOT_CLAIMED");
  return row;
}

export async function revokePendingDispatches(client: SqlClient, tenantId: string, effectKey: string): Promise<number> {
  const rows = await run<{ n: number }>(
    client,
    "select knowledge_verification.revoke_pending_dispatches($1, $2) as n",
    [tenantId, effectKey],
  );
  return rows[0]?.n ?? 0;
}

const RECORD_LOOKUPS = {
  task: "select task_id as id, task_digest as digest from knowledge_verification.verification_task where tenant_id = $1 and (task_id = $2 or task_digest = $3)",
  fragment:
    "select fragment_id as id, digest from knowledge_verification.fragment where tenant_id = $1 and (fragment_id = $2 or digest = $3)",
  assertion:
    "select assertion_id as id, digest from knowledge_verification.assertion where tenant_id = $1 and (assertion_id = $2 or digest = $3)",
  support_set:
    "select support_set_id as id, digest from knowledge_verification.support_set where tenant_id = $1 and (support_set_id = $2 or digest = $3)",
} as const;

/**
 * W1 D19 preflight: the same lookups `idempotentInsert` runs after a no-op insert, before any insert: the same id with
 * other bytes is `record_id_conflict`; the same bytes under another id is `record_digest_exists`.
 */
export async function recordCollisions(
  client: SqlClient,
  tenantId: string,
  records: readonly {
    readonly kind: keyof typeof RECORD_LOOKUPS;
    readonly id: string;
    readonly digest: string;
  }[],
): Promise<
  { reason: "record_id_conflict" | "record_digest_exists"; record: keyof typeof RECORD_LOOKUPS; id: string }[]
> {
  const collisions: {
    reason: "record_id_conflict" | "record_digest_exists";
    record: keyof typeof RECORD_LOOKUPS;
    id: string;
  }[] = [];
  for (const probe of records) {
    const rows = await run<{ id: string; digest: string }>(client, RECORD_LOOKUPS[probe.kind], [
      tenantId,
      probe.id,
      probe.digest,
    ]);
    const sameId = rows.find((row) => row.id === probe.id);
    if (sameId !== undefined) {
      if (sameId.digest !== probe.digest) {
        collisions.push({ reason: "record_id_conflict", record: probe.kind, id: probe.id });
      }
      continue;
    }
    const sameBytes = rows[0];
    if (sameBytes !== undefined)
      collisions.push({ reason: "record_digest_exists", record: probe.kind, id: sameBytes.id });
  }
  return collisions;
}
