import {
  type Digest,
  type JsonValue,
  type Origin,
  OriginSchema,
  canonicalJson,
  digestCanonical,
  originDigest,
  originIdentity,
} from "@aiengineer/knowledge-operation-protocol";
import type { KnowledgeSqlClient } from "../ports.js";

/**
 * The ONE exact-use admission code path (design §7, SV-08 KS half). Every caller passes the client of the transaction
 * that performs the native write, so the component's `admit_exact_use` (epoch row locked FOR SHARE until commit), the
 * native domain write and the effect receipt commit or roll back together:
 *  - `admitExactUseWithin` (native ingestion, `IngestionExecutor.applyOnce`) binds the effect, admits the exact
 *    decision/effect/normalized-values digests and, on an ai-engineer installation with the AIDB projection, also runs
 *    `research.assert_admitted_use(..., p_normalized_values_digest)` so AIDB's same-transaction commit guards accept the
 *    receipt (on ai-engineer the guard is required, never skipped); any non-admitted
 *    outcome throws a typed error and the whole transaction rolls back;
 *  - `evaluateExactUse` returns the outcome without throwing (the binding's diagnostic `admitExactUse`);
 *  - `recordExactUseReceipt` writes the effect receipt (and the decision -> effect dependency edge) before commit.
 */
export const ADMISSION_ERROR_CODES = [
  "STALE_DECISION",
  "REVIEW_REQUIRED",
  "EFFECT_CONFLICT",
  "UNRESOLVED_EFFECT",
  "EXACT_REVISION_UNAVAILABLE",
] as const;
export type AdmissionErrorCode = (typeof ADMISSION_ERROR_CODES)[number];

export class ExactUseAdmissionError extends Error {
  readonly code: AdmissionErrorCode;
  readonly outcome: string;
  readonly reason: string;
  readonly path: AdmissionPath;
  constructor(
    code: AdmissionErrorCode,
    input: { outcome: string; reason: string; path: AdmissionPath; detail?: string },
  ) {
    super(`${code}: ${input.outcome}/${input.reason}${input.detail ? ` (${input.detail})` : ""}`);
    this.name = "ExactUseAdmissionError";
    this.code = code;
    this.outcome = input.outcome;
    this.reason = input.reason;
    this.path = input.path;
  }
}

/**
 * Which authority ran: the component function alone (`component_only`, installations without the AIDB projection), or
 * the component plus the AIDB native guard (`aidb_guard`, required on the AI Engineer installation).
 */
export type AdmissionPath = "component_only" | "aidb_guard";

export interface ExactUseBinding {
  readonly useDecisionId: string;
  readonly boundEffectDigest: Digest | string;
  readonly processedEpoch: number;
  /** K01 canonical digest of the normalized values the native write carries; compared with the decision's. */
  readonly normalizedValuesDigest: Digest | string;
}

export interface EffectToBind {
  readonly effectKey: string;
  readonly semanticPayloadDigest: Digest | string;
  readonly originatingOrigin: Origin;
}

export interface AdmissionOutcome {
  readonly outcome: "admitted" | "held" | "rejected";
  readonly reason: string;
  readonly authoritativeEpoch: number;
}

/** Map a component reason (stable code) to the K01 typed error, the same mapping AIDB's guard uses (KSA01..04). */
export function admissionErrorCode(reason: string): AdmissionErrorCode {
  switch (reason) {
    case "STALE_DECISION":
    case "REVOCATION_EPOCH_STALE":
    case "INVALIDATION_CLOSURE_INCOMPLETE":
    case "DECISION_EXPIRED":
    case "DECISION_INVALIDATED":
      return "STALE_DECISION";
    case "EFFECT_DIGEST_MISMATCH":
    case "NORMALIZED_VALUES_MISMATCH":
      return "EFFECT_CONFLICT";
    case "DECISION_NOT_FOUND":
    case "AUTHORITY_UNAVAILABLE":
      return "UNRESOLVED_EFFECT";
    default:
      return "REVIEW_REQUIRED";
  }
}

/** AIDB native guard SQLSTATEs (`20261024010100_research_report_v2_projection.sql`) -> K01 typed errors. */
export const AIDB_GUARD_SQLSTATES: Readonly<Record<string, AdmissionErrorCode>> = {
  KSA01: "STALE_DECISION",
  KSA02: "REVIEW_REQUIRED",
  KSA03: "EFFECT_CONFLICT",
  KSA04: "UNRESOLVED_EFFECT",
  KSA05: "EXACT_REVISION_UNAVAILABLE",
  KSA06: "UNRESOLVED_EFFECT",
  KSA07: "EXACT_REVISION_UNAVAILABLE",
};

/** The typed admission error for a PostgreSQL error raised by the AIDB guard or the component; null otherwise. */
export function admissionErrorFromSql(
  error: unknown,
  path: AdmissionPath = "aidb_guard",
): ExactUseAdmissionError | null {
  if (error instanceof ExactUseAdmissionError) return error;
  const pg = error as { code?: string; message?: string; detail?: string } | null;
  const code = pg?.code ? AIDB_GUARD_SQLSTATES[pg.code] : undefined;
  if (code !== undefined) {
    return new ExactUseAdmissionError(code, {
      outcome: "refused",
      reason: pg?.message ?? code,
      path,
      ...(pg?.detail ? { detail: pg.detail } : {}),
    });
  }
  const message = pg?.message ?? "";
  if (/^EFFECT_CONFLICT\b/.test(message)) {
    return new ExactUseAdmissionError("EFFECT_CONFLICT", { outcome: "refused", reason: "EFFECT_CONFLICT", path });
  }
  return null;
}

/** The component check, returned (never thrown): used for diagnostics and as the first step of a native admission. */
export async function evaluateExactUse(
  client: KnowledgeSqlClient,
  tenantId: string,
  binding: ExactUseBinding,
): Promise<AdmissionOutcome> {
  const rows = await client.query<{
    outcome: AdmissionOutcome["outcome"];
    reason: string;
    authoritative_epoch: string;
  }>(
    "select outcome, reason, authoritative_epoch::text from knowledge_verification.admit_exact_use($1, $2, $3, $4, now(), $5)",
    [
      tenantId,
      binding.useDecisionId,
      binding.boundEffectDigest,
      binding.processedEpoch,
      binding.normalizedValuesDigest,
    ],
  );
  const row = rows.rows[0];
  if (!row) return { outcome: "held", reason: "AUTHORITY_UNAVAILABLE", authoritativeEpoch: -1 };
  return { outcome: row.outcome, reason: row.reason, authoritativeEpoch: Number(row.authoritative_epoch) };
}

/** Register the originating origin and bind the effect key to the exact digest (idempotent; other bytes conflict). */
export async function bindExactEffect(
  client: KnowledgeSqlClient,
  tenantId: string,
  effect: EffectToBind,
  boundEffectDigest: Digest | string,
): Promise<void> {
  const origin = OriginSchema.parse(effect.originatingOrigin);
  const mission = origin.mission;
  await client.query(
    `insert into knowledge_verification.origin (tenant_id, origin_digest, kind, installation_id, application_id, issuer, subject,
       mission_id, mission_run_id, activation_id, operation_id, operation_attempt, execution_generation, lane, recovery_authority_ref, identity)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
     on conflict (tenant_id, origin_digest) do nothing`,
    [
      tenantId,
      originDigest(origin),
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
  try {
    await client.query("select effect_key from knowledge_verification.bind_effect($1, $2, $3, $4, $5)", [
      tenantId,
      effect.effectKey,
      effect.semanticPayloadDigest,
      originDigest(origin),
      boundEffectDigest,
    ]);
  } catch (error) {
    throw admissionErrorFromSql(error, "component_only") ?? error;
  }
}

/** The AIDB native guard signature since AIDB migration 20261024010200 (normalized-values digest forwarded). */
export const AIDB_GUARD_SIGNATURE = "research.assert_admitted_use(uuid,text,text,bigint,text)";

/** An installation fact that makes native admission impossible (infrastructure, not a domain refusal). */
export class AdmissionInstallationError extends Error {
  readonly code = "AIDB_GUARD_REQUIRED" as const;
  constructor(message: string) {
    super(`AIDB_GUARD_REQUIRED: ${message}`);
    this.name = "AdmissionInstallationError";
  }
}

/** Which installation this database serves and whether the AIDB native guard (5-argument form) is installed. */
export async function aidbGuardStatus(client: KnowledgeSqlClient): Promise<{ aiEngineer: boolean; guard: boolean }> {
  const rows = await client.query<{ guard: boolean; ai_engineer: boolean }>(
    `select to_regprocedure($1) is not null as guard,
            exists (select 1 from knowledge_verification.installation where application_id = 'ai-engineer') as ai_engineer`,
    [AIDB_GUARD_SIGNATURE],
  );
  return { aiEngineer: Boolean(rows.rows[0]?.ai_engineer), guard: Boolean(rows.rows[0]?.guard) };
}

/**
 * Admit the exact use INSIDE the caller's native transaction. Throws `ExactUseAdmissionError` (STALE_DECISION,
 * REVIEW_REQUIRED, EFFECT_CONFLICT, UNRESOLVED_EFFECT) on any non-admitted outcome; the caller lets it propagate so
 * the transaction rolls back and nothing is written. Returns which authority path ran: `aidb_guard` on the AI Engineer
 * installation (the guard is REQUIRED there; its absence throws `AdmissionInstallationError`, never a silent
 * fallback), `component_only` on every other installation (no AIDB projection exists there).
 */
export async function admitExactUseWithin(
  client: KnowledgeSqlClient,
  tenantId: string,
  binding: ExactUseBinding,
  options: { readonly effect?: EffectToBind } = {},
): Promise<{ readonly path: AdmissionPath; readonly authoritativeEpoch: number }> {
  if (options.effect) await bindExactEffect(client, tenantId, options.effect, binding.boundEffectDigest);
  // The component rule always runs first (it is the only check that compares normalized values).
  const outcome = await evaluateExactUse(client, tenantId, binding);
  if (outcome.outcome !== "admitted") {
    throw new ExactUseAdmissionError(admissionErrorCode(outcome.reason), { ...outcome, path: "component_only" });
  }
  const installation = await aidbGuardStatus(client);
  if (!installation.aiEngineer) return { path: "component_only", authoritativeEpoch: outcome.authoritativeEpoch };
  if (!installation.guard) {
    throw new AdmissionInstallationError(
      `the ai-engineer installation has no ${AIDB_GUARD_SIGNATURE}; apply AIDB migration 20261024010200 before native admission`,
    );
  }
  try {
    await client.query("select * from research.assert_admitted_use($1, $2, $3, $4, $5)", [
      tenantId,
      binding.useDecisionId,
      binding.boundEffectDigest,
      binding.processedEpoch,
      binding.normalizedValuesDigest,
    ]);
  } catch (error) {
    throw admissionErrorFromSql(error, "aidb_guard") ?? error;
  }
  return { path: "aidb_guard", authoritativeEpoch: outcome.authoritativeEpoch };
}

export interface ExactUseReceipt {
  readonly effectKey: string;
  readonly outcome: "applied" | "noop" | "partial" | "rejected";
  readonly nativeReceiptRef: JsonValue;
  readonly affectedRefs?: readonly JsonValue[];
  readonly concurrencyBefore?: string | null;
  readonly concurrencyAfter?: string | null;
  readonly processedEpoch: number;
  readonly itemOutcomes?: readonly JsonValue[];
  readonly useDecisionId: string;
}

export function exactUseReceiptDigest(receipt: ExactUseReceipt): Digest {
  return digestCanonical({
    effectKey: receipt.effectKey,
    outcome: receipt.outcome,
    nativeReceiptRef: receipt.nativeReceiptRef,
    affectedRefs: [...(receipt.affectedRefs ?? [])],
    concurrencyBefore: receipt.concurrencyBefore ?? null,
    concurrencyAfter: receipt.concurrencyAfter ?? null,
    processedEpoch: receipt.processedEpoch,
    itemOutcomes: [...(receipt.itemOutcomes ?? [])],
    useDecisionId: receipt.useDecisionId,
  });
}

/** Record the one receipt of the effect on the native transaction's client (idempotent for identical bytes). */
export async function recordExactUseReceipt(
  client: KnowledgeSqlClient,
  tenantId: string,
  receipt: ExactUseReceipt,
): Promise<{ readonly outcome: string; readonly digest: string }> {
  const digest = exactUseReceiptDigest(receipt);
  const rows = await client.query<{ outcome: string; digest: string }>(
    "select outcome, digest from knowledge_verification.record_effect_receipt($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11)",
    [
      tenantId,
      receipt.effectKey,
      receipt.outcome,
      canonicalJson(receipt.nativeReceiptRef),
      JSON.stringify(receipt.affectedRefs ?? []),
      receipt.concurrencyBefore ?? null,
      receipt.concurrencyAfter ?? null,
      receipt.processedEpoch,
      JSON.stringify(receipt.itemOutcomes ?? []),
      receipt.useDecisionId,
      digest,
    ],
  );
  await client.query(
    `insert into knowledge_verification.dependency_edge (tenant_id, from_kind, from_id, to_kind, to_id, edge_kind)
     values ($1, 'use_decision', $2, 'effect', $3, 'applied_from') on conflict do nothing`,
    [tenantId, receipt.useDecisionId, receipt.effectKey],
  );
  const row = rows.rows[0];
  if (!row) throw new Error("RECEIPT_NOT_RECORDED");
  return row;
}

/**
 * WI-05 (component 2.5.0): stamp the native commit with the journaled K01 dispatch, on the native transaction's own
 * client, so a protocol receipt lost after this commit is rebuilt for that original dispatch. A second native commit of
 * the effect raises `EFFECT_ALREADY_COMMITTED` and the native transaction rolls back (no duplicated native write); a
 * dispatch the host did not journal raises `DISPATCH_NOT_JOURNALED`.
 */
export async function recordEffectCommit(
  client: KnowledgeSqlClient,
  tenantId: string,
  commit: { readonly effectKey: string; readonly dispatchId: string; readonly nativeRef: JsonValue },
): Promise<void> {
  try {
    await client.query("select effect_key from knowledge_verification.record_effect_commit($1, $2, $3, $4::jsonb)", [
      tenantId,
      commit.effectKey,
      commit.dispatchId,
      canonicalJson(commit.nativeRef),
    ]);
  } catch (error) {
    throw admissionErrorFromSql(error, "component_only") ?? error;
  }
}

/** Receipt-first recovery: the committed receipt of an effect key, or null (an uncertain effect stays unresolved). */
export async function lookupExactUseReceipt(
  client: KnowledgeSqlClient,
  tenantId: string,
  effectKey: string,
): Promise<{ readonly outcome: string; readonly digest: string; readonly useDecisionId: string | null } | null> {
  const rows = await client.query<{ outcome: string; digest: string; use_decision_id: string | null }>(
    "select outcome, digest, use_decision_id from knowledge_verification.effect_receipt where tenant_id = $1 and effect_key = $2",
    [tenantId, effectKey],
  );
  const row = rows.rows[0];
  return row ? { outcome: row.outcome, digest: row.digest, useDecisionId: row.use_decision_id } : null;
}
