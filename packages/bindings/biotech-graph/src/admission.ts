import {
  type ComponentDatabase,
  ComponentError,
  type SqlClient,
  bindEffect,
  componentError,
  enqueueDispatch,
  putArtifact,
} from "@aiengineer/knowledge-binding-aiengineer-postgres";
import {
  CANONICALIZATION,
  type Digest,
  type Origin,
  boundEffectDigest,
  originDigest,
} from "@aiengineer/knowledge-operation-protocol";
import type { AuthScope } from "@aiengineer/knowledge-research-core";
import {
  ADMISSION_DISPATCH_V1,
  ADMISSION_PAYLOAD_MEDIA_TYPE,
  type AdmissionPayload,
  type CustodyRef,
  INTENT_MARKER_V2,
  INTENT_V2,
  KS_MARKER_SCHEME,
  PAYLOAD_SEAL_KINDS,
  type PayloadSealKind,
  TARGET_BINDING,
} from "./contracts.js";
import { jcs, sha256Bytes } from "./jcs.js";
import { type FrozenReportBinding, assertReportBinding, biotechReportKind } from "./report.js";

/**
 * K06 exact-use admission (design section 7, Biotech): in ONE PostgreSQL transaction of the Biotech application
 * database, `admit_exact_use` decides the exact effect now; on `admitted` the effect is bound, the
 * `biotech-knowledge-admission.v1` payload is stored as an immutable inline `artifact_custody` row whose digest is
 * the dispatch's `payload_digest`, and `enqueue_dispatch` (component 2.2.0, the only enqueue path) writes the outbox
 * row with the bound effect digest, decision, authoritative epoch and expected marker digest. The result is
 * `admitted` with receipt state `pending_dispatch`; the graph is touched later, by the BKS consumer, never in this
 * transaction (PostgreSQL and Neo4j never share a transaction).
 */
const WRITER = "knowledge_verification_writer" as const;
const MAX_INLINE_PAYLOAD = 1024 * 1024;

export type DispatchReceiptState = "pending_dispatch" | "applied" | "revoked" | "refused" | "failed";

export interface DispatchReceipt {
  readonly state: DispatchReceiptState;
  readonly tenantId: string;
  readonly dispatchId: string;
  readonly effectKey: string;
  readonly targetBinding: typeof TARGET_BINDING;
  readonly boundEffectDigest: Digest;
  readonly payloadDigest: Digest;
  readonly useDecision: { readonly id: string; readonly digest: string };
  /** The authoritative epoch the dispatch was enqueued at (component `dispatch_outbox.revocation_epoch`). */
  readonly revocationEpoch: number;
  readonly markerScheme: string | null;
  readonly expectedMarkerDigest: string | null;
}

export type AdmissionResult =
  | {
      readonly outcome: "admitted";
      readonly reason: "OK";
      readonly authoritativeEpoch: number;
      readonly receipt: DispatchReceipt;
    }
  | {
      readonly outcome: "held" | "rejected";
      readonly reason: string;
      readonly authoritativeEpoch: number;
      readonly receipt: null;
    };

export interface BiotechEffectRequest {
  readonly effectKey: string;
  readonly useDecisionId: string;
  /** The exact biotech-knowledge-intent.v2 object; its JCS bytes are the native payload. */
  readonly intent: Record<string, unknown>;
  readonly processedEpoch: number;
  /**
   * The decision's normalized-values digest, always presented (component 2.4.0 / R1 F2: `admit_exact_use` and
   * `enqueue_dispatch` refuse NORMALIZED_VALUES_REQUIRED without it); must equal the decision's digest exactly.
   */
  readonly normalizedValuesDigest: Digest;
  /** The effect's originating origin (defaults to the authenticated scope origin). */
  readonly originatingOrigin?: Origin;
  /** Explicit transmission id (a redelivery); defaults to a digest of the exact admission. */
  readonly dispatchId?: string;
  /**
   * WI-05: the journaled K01 dispatch (component 2.5.0 `effect_dispatch`) this admission runs for. The admission
   * transaction then stamps the native commit with it (`record_effect_commit`, native ref `{outboxDispatchId}`), so a
   * protocol receipt lost after the commit is rebuilt for this original dispatch. Absent: no stamp.
   */
  readonly k01DispatchId?: string;
}

export interface BiotechEffect {
  readonly nativeBytes: Uint8Array;
  readonly semanticPayloadDigest: Digest;
  readonly boundEffectDigest: Digest;
  readonly originatingOriginDigest: Digest;
}

export class BiotechAdmissionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "BiotechAdmissionError";
    this.code = code;
  }
}

/** Native bytes (JCS of the intent), their digest and the K01 bound effect digest over them and the origin. */
export function biotechEffect(intent: Record<string, unknown>, origin: Origin): BiotechEffect {
  if (intent.schemaVersion !== INTENT_V2)
    throw new BiotechAdmissionError("INTENT_UNSUPPORTED", `intent is not ${INTENT_V2}`);
  const nativeBytes = Buffer.from(jcs(intent), "utf8");
  return {
    nativeBytes,
    semanticPayloadDigest: sha256Bytes(nativeBytes),
    boundEffectDigest: boundEffectDigest(nativeBytes, origin),
    originatingOriginDigest: originDigest(origin),
  };
}

export function defaultDispatchId(tenant: string, effectKey: string, useDecisionId: string, bound: string): string {
  return `dsp-${sha256Bytes(`${tenant}\n${effectKey}\n${useDecisionId}\n${bound}`).slice(7, 47)}`;
}

/** The component's expected marker digest (`intent_marker_digest`, ks-intent-marker.v1), recomputed in KS. */
export function expectedMarkerDigest(input: {
  tenantId: string;
  dispatchId: string;
  effectKey: string;
  boundEffectDigest: string;
  useDecisionId: string;
  revocationEpoch: number;
}): Digest {
  return sha256Bytes(
    [
      KS_MARKER_SCHEME,
      input.tenantId,
      input.dispatchId,
      input.effectKey,
      input.boundEffectDigest,
      input.useDecisionId,
      String(input.revocationEpoch),
    ].join("\n"),
  );
}

export function receiptState(state: string): DispatchReceiptState {
  switch (state) {
    case "pending":
    case "dispatched":
      return "pending_dispatch";
    case "acknowledged":
      return "applied";
    case "revoked":
      return "revoked";
    case "refused":
      return "refused";
    default:
      return "failed";
  }
}

type DecisionRow = {
  use_decision_id: string;
  digest: string;
  run_id: string;
  subject_kind: "report" | "assertion";
  subject_id: string;
  subject_digest: string;
  revocation_epoch: string;
  decided_at_record: string | null;
  decided_at: Date;
};

async function query<R extends Record<string, unknown>>(
  c: SqlClient,
  text: string,
  values: readonly unknown[],
): Promise<R[]> {
  try {
    return (await c.query<R>(text, values)).rows;
  } catch (error) {
    throw componentError(error);
  }
}

/** The frozen report revision a report decision names, with its custody refs, checked against the decision digest. */
async function loadFrozenReport(
  c: SqlClient,
  tenant: string,
  decision: DecisionRow,
): Promise<{ binding: FrozenReportBinding; payload: NonNullable<AdmissionPayload["report"]>; custody: CustodyRef[] }> {
  const [row] = await query<{
    report_revision_id: string;
    report_id: string;
    revision: number;
    report_kind: string;
    report_kind_ref_id: string | null;
    schema_version: string;
    digest: string;
    body_digest: string;
    structured_body_artifact_id: string;
    body_artifact_id: string;
    ledger_artifact_id: string;
  }>(
    c,
    `select report_revision_id, report_id, revision, report_kind, report_kind_ref_id, schema_version, digest, body_digest,
            structured_body_artifact_id, body_artifact_id, ledger_artifact_id
       from knowledge_verification.report_revision where tenant_id = $1 and report_revision_id = $2`,
    [tenant, decision.subject_id],
  );
  if (row === undefined) throw new BiotechAdmissionError("REPORT_NOT_FOUND", `report revision ${decision.subject_id}`);
  if (row.digest !== decision.subject_digest) {
    throw new BiotechAdmissionError("REPORT_DIGEST_MISMATCH", "the decision names another revision of this report");
  }
  const kind = biotechReportKind(row.report_kind);
  if (row.report_kind_ref_id === null)
    throw new BiotechAdmissionError("REPORT_KIND_UNPINNED", "report revision carries no kind pin (pre-2.1.0)");
  const artifacts = await query<{
    artifact_id: string;
    digest: string;
    media_type: string;
    byte_length: string;
    custody_kind: string;
    custody_uri: string | null;
  }>(
    c,
    `select artifact_id, digest, media_type, byte_length::text, custody_kind, custody_uri
       from knowledge_verification.artifact_custody where tenant_id = $1 and artifact_id = any($2::text[])`,
    [tenant, [row.structured_body_artifact_id, row.body_artifact_id, row.ledger_artifact_id]],
  );
  const byId = new Map(artifacts.map((a) => [a.artifact_id, a]));
  const ref = (id: string, role: CustodyRef["role"]): CustodyRef => {
    const a = byId.get(id);
    if (a === undefined) throw new BiotechAdmissionError("ARTIFACT_NOT_IN_CUSTODY", `${role} ${id}`);
    return {
      role,
      digest: a.digest,
      mediaType: a.media_type,
      byteLength: Number(a.byte_length),
      locator: { kind: a.custody_kind as CustodyRef["locator"]["kind"], artifactId: a.artifact_id, uri: a.custody_uri },
    };
  };
  const custody = [
    ref(row.structured_body_artifact_id, "report_structured_body"),
    ref(row.body_artifact_id, "report_body"),
    ref(row.ledger_artifact_id, "report_ledger"),
  ];
  const [structured, body, ledger] = custody as [CustodyRef, CustodyRef, CustodyRef];
  if (body.digest !== row.body_digest)
    throw new BiotechAdmissionError("ARTIFACT_DIGEST_MISMATCH", "body custody differs from the frozen body digest");
  return {
    binding: {
      reportRevisionId: row.report_revision_id,
      reportKind: kind,
      reportKindRef: row.report_kind_ref_id,
      reportSchema: row.schema_version,
      bodyDigest: row.body_digest,
      ledgerDigest: ledger.digest,
      structuredBodyDigest: structured.digest,
    },
    payload: {
      reportRevisionId: row.report_revision_id,
      reportId: row.report_id,
      revision: row.revision,
      reportKind: kind,
      reportKindRef: row.report_kind_ref_id,
      reportSchema: row.schema_version,
      digest: row.digest,
    },
    custody,
  };
}

async function loadSealHead(
  c: SqlClient,
  tenant: string,
  runId: string,
): Promise<{ manifestDigest: string; sealKind: PayloadSealKind }> {
  const [row] = await query<{ head_digest: string | null; manifest_kind: string | null }>(
    c,
    `select r.head_digest, m.manifest_kind
       from knowledge_verification.verification_run r
       left join knowledge_verification.run_manifest m
         on m.tenant_id = r.tenant_id and m.run_id = r.run_id and m.manifest_digest = r.head_digest
      where r.tenant_id = $1 and r.run_id = $2::uuid`,
    [tenant, runId],
  );
  if (row === undefined || row.head_digest === null || row.manifest_kind === null) {
    throw new BiotechAdmissionError("RUN_NOT_SEALED", `run ${runId} has no sealed head`);
  }
  if (!(PAYLOAD_SEAL_KINDS as readonly string[]).includes(row.manifest_kind)) {
    throw new BiotechAdmissionError(
      "SEAL_KIND_UNSUPPORTED",
      `head manifest kind ${row.manifest_kind} is not carried by biotech-knowledge-admission.v1`,
    );
  }
  return { manifestDigest: row.head_digest, sealKind: row.manifest_kind as PayloadSealKind };
}

export class BiotechGraphAdmission {
  constructor(
    private readonly db: ComponentDatabase,
    private readonly installation: { readonly installationId: string; readonly applicationId?: string },
  ) {}

  /** Admit the exact effect and enqueue its dispatch in ONE transaction; held/rejected writes no effect or dispatch. */
  async admitExactUse(scope: AuthScope, request: BiotechEffectRequest): Promise<AdmissionResult> {
    const origin = request.originatingOrigin ?? scope.origin;
    const effect = biotechEffect(request.intent, origin);
    try {
      return await this.db.transaction({ tenantId: scope.tenant, role: WRITER }, async (c) => {
        const [verdict] = await query<{
          outcome: "admitted" | "held" | "rejected";
          reason: string;
          authoritative_epoch: string;
        }>(
          c,
          "select outcome, reason, authoritative_epoch::text from knowledge_verification.admit_exact_use($1, $2, $3, $4, now(), $5)",
          [
            scope.tenant,
            request.useDecisionId,
            effect.boundEffectDigest,
            request.processedEpoch,
            request.normalizedValuesDigest,
          ],
        );
        if (verdict === undefined)
          return { outcome: "held", reason: "AUTHORITY_UNAVAILABLE", authoritativeEpoch: -1, receipt: null };
        const authoritativeEpoch = Number(verdict.authoritative_epoch);
        if (verdict.outcome !== "admitted") {
          return { outcome: verdict.outcome, reason: verdict.reason, authoritativeEpoch, receipt: null };
        }
        const [decision] = await query<DecisionRow>(
          c,
          `select use_decision_id, digest, run_id::text, subject_kind, subject_id, subject_digest, revocation_epoch::text,
                  record ->> 'decidedAt' as decided_at_record, decided_at
             from knowledge_verification.use_decision where tenant_id = $1 and use_decision_id = $2`,
          [scope.tenant, request.useDecisionId],
        );
        if (decision === undefined) throw new BiotechAdmissionError("DECISION_NOT_FOUND", request.useDecisionId);
        const report = decision.subject_kind === "report" ? await loadFrozenReport(c, scope.tenant, decision) : null;
        if (report !== null) assertReportBinding(request.intent, report.binding);
        const head = await loadSealHead(c, scope.tenant, decision.run_id);
        await bindEffect(c, scope.tenant, {
          effectKey: request.effectKey,
          semanticPayloadDigest: effect.semanticPayloadDigest,
          originatingOrigin: origin,
          boundEffectDigest: effect.boundEffectDigest,
          canonicalization: CANONICALIZATION,
        });
        const dispatchId =
          request.dispatchId ??
          defaultDispatchId(scope.tenant, request.effectKey, decision.use_decision_id, effect.boundEffectDigest);
        const payload: AdmissionPayload = {
          schemaVersion: ADMISSION_DISPATCH_V1,
          tenantId: scope.tenant,
          installationId: this.installation.installationId,
          applicationId: this.installation.applicationId ?? "biotech",
          targetBinding: TARGET_BINDING,
          dispatchId,
          effectKey: request.effectKey,
          boundEffectDigest: effect.boundEffectDigest,
          semanticPayloadDigest: effect.semanticPayloadDigest,
          originatingOriginDigest: effect.originatingOriginDigest,
          useDecision: { id: decision.use_decision_id, digest: decision.digest },
          report: report?.payload ?? null,
          run: { runId: decision.run_id, manifestDigest: head.manifestDigest, sealKind: head.sealKind },
          revocationEpochAtDecision: Number(decision.revocation_epoch),
          decidedAt: decision.decided_at_record ?? decision.decided_at.toISOString(),
          intent: request.intent,
          custody: report?.custody ?? [],
          expectedMarkerSchemaVersion: INTENT_MARKER_V2,
        };
        const bytes = Buffer.from(jcs(payload), "utf8");
        if (bytes.byteLength > MAX_INLINE_PAYLOAD) {
          throw new BiotechAdmissionError(
            "PAYLOAD_TOO_LARGE",
            "the BKS consumer reads inline payloads of at most 1 MiB",
          );
        }
        const payloadDigest = sha256Bytes(bytes);
        await putArtifact(c, scope.tenant, {
          artifactId: `admission-${payloadDigest.slice(7, 39)}`,
          bytes,
          mediaType: ADMISSION_PAYLOAD_MEDIA_TYPE,
        });
        // The single enqueue path (component 2.2.0 `enqueue_dispatch` through the K05 store): re-runs admit_exact_use
        // for the same bound digest, records the authoritative epoch and the per-dispatch expected marker digest
        // (ks-intent-marker.v1: duplicates and reordered redeliveries each acknowledge their own row).
        const row = await enqueueDispatch(c, scope.tenant, {
          dispatchId,
          effectKey: request.effectKey,
          targetBinding: TARGET_BINDING,
          payloadDigest,
          useDecisionId: decision.use_decision_id,
          boundEffectDigest: effect.boundEffectDigest,
          processedEpoch: request.processedEpoch,
          normalizedValuesDigest: request.normalizedValuesDigest,
          markerScheme: KS_MARKER_SCHEME,
        });
        // WI-05: the native commit (admission + enqueue) names its journaled K01 dispatch, in this same transaction.
        // A second native commit of the effect raises EFFECT_ALREADY_COMMITTED and rolls this transaction back.
        if (request.k01DispatchId !== undefined) {
          await query(c, "select effect_key from knowledge_verification.record_effect_commit($1, $2, $3, $4::jsonb)", [
            scope.tenant,
            request.effectKey,
            request.k01DispatchId,
            JSON.stringify({ outboxDispatchId: row.dispatch_id }),
          ]);
        }
        return {
          outcome: "admitted",
          reason: "OK",
          authoritativeEpoch,
          receipt: {
            state: receiptState(row.state),
            tenantId: scope.tenant,
            dispatchId: row.dispatch_id,
            effectKey: row.effect_key,
            targetBinding: TARGET_BINDING,
            boundEffectDigest: effect.boundEffectDigest,
            payloadDigest,
            useDecision: { id: decision.use_decision_id, digest: decision.digest },
            revocationEpoch: Number(row.revocation_epoch ?? authoritativeEpoch),
            markerScheme: row.marker_scheme,
            expectedMarkerDigest: row.expected_marker_digest,
          },
        };
      });
    } catch (error) {
      // Typed refusals of the exact effect (the transaction rolled back: nothing was bound or enqueued).
      if (
        error instanceof ComponentError &&
        ["EFFECT_CONFLICT", "DISPATCH_CONFLICT", "DISPATCH_NOT_ADMITTED"].includes(error.code)
      ) {
        return { outcome: "rejected", reason: error.code, authoritativeEpoch: -1, receipt: null };
      }
      throw error;
    }
  }

  /**
   * WI-05 read-back (read-only): the admission receipt of a committed effect from its outbox row, exactly as
   * `admitExactUse` answered it (`pending_dispatch`: the receipt is the admission's, the delivery is composed at read
   * time). `null` when the row is absent or belongs to another effect.
   */
  async admitted(
    scope: AuthScope,
    input: { readonly effectKey: string; readonly dispatchId: string },
  ): Promise<{ readonly authoritativeEpoch: number; readonly receipt: DispatchReceipt } | null> {
    return this.db.transaction(
      { tenantId: scope.tenant, role: "knowledge_verification_reader", readOnly: true },
      async (c) => {
        const [row] = await query<{
          dispatch_id: string;
          effect_key: string;
          payload_digest: string;
          bound_effect_digest: string | null;
          use_decision_id: string | null;
          revocation_epoch: string | null;
          marker_scheme: string | null;
          expected_marker_digest: string | null;
          digest: string | null;
        }>(
          c,
          `select o.dispatch_id, o.effect_key, o.payload_digest, o.bound_effect_digest, o.use_decision_id,
                  o.revocation_epoch::text, o.marker_scheme, o.expected_marker_digest, d.digest
             from knowledge_verification.dispatch_outbox o
             left join knowledge_verification.use_decision d
               on d.tenant_id = o.tenant_id and d.use_decision_id = o.use_decision_id
            where o.tenant_id = $1 and o.dispatch_id = $2`,
          [scope.tenant, input.dispatchId],
        );
        if (
          row === undefined ||
          row.effect_key !== input.effectKey ||
          row.bound_effect_digest === null ||
          row.use_decision_id === null ||
          row.revocation_epoch === null ||
          row.digest === null
        ) {
          return null;
        }
        const epoch = Number(row.revocation_epoch);
        return {
          authoritativeEpoch: epoch,
          receipt: {
            state: "pending_dispatch",
            tenantId: scope.tenant,
            dispatchId: row.dispatch_id,
            effectKey: row.effect_key,
            targetBinding: TARGET_BINDING,
            boundEffectDigest: row.bound_effect_digest as Digest,
            payloadDigest: row.payload_digest as Digest,
            useDecision: { id: row.use_decision_id, digest: row.digest },
            revocationEpoch: epoch,
            markerScheme: row.marker_scheme,
            expectedMarkerDigest: row.expected_marker_digest,
          },
        };
      },
    );
  }

  /** Stop-dispatch (no native cancellation): revoke pending/dispatched rows of the effect key; reconciliation follows. */
  async stopDispatch(scope: AuthScope, effectKey: string): Promise<number> {
    return this.db.transaction({ tenantId: scope.tenant, role: WRITER }, async (c) => {
      const [row] = await query<{ n: number }>(
        c,
        "select knowledge_verification.revoke_pending_dispatches($1, $2) as n",
        [scope.tenant, effectKey],
      );
      return Number(row?.n ?? 0);
    });
  }
}
