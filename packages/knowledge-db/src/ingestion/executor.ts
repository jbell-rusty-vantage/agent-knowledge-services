import { uuidv7, type ArtifactLedger } from "../db-read/index.js";
import type { KnowledgeDatabase, KnowledgeSqlClient } from "../ports.js";
import {
  assertHeadMatches,
  domainError,
  infrastructureError,
  isKnowledgeError,
  KnowledgeError,
  type ExitClass,
  type Workspace,
} from "../schema-workspace/index.js";
import { applyPlan, targetsWithoutBatch, type ApplyOutcome } from "./apply.js";
import { insertReceiptTargets, projectReportV2 } from "./receipt-targets.js";
import { awaitWinnerReceipt, isIdempotencyKeyCollision } from "./duplicate.js";
import { gatherFacts, type EvidenceOracle } from "./facts.js";
import {
  IngestionIntentSchema,
  IngestionPreviewIntentSchema,
  type DeclaredUse,
  type IngestionIntent,
  type IngestionPreviewIntent,
} from "./intent.js";
import { digestCanonical, originDigest } from "@aiengineer/knowledge-operation-protocol";
import { buildPlan, intentDigestOf, intentIdempotencyKey, type IngestionPlan } from "./plan.js";
import type { AffectedRef, IngestionReceipt, ReceiptFailure } from "./receipt.js";
import { loadRules } from "./rules.js";
import { loadVocabulary, type Vocabulary } from "./vocabulary.js";
import { reconcileReceipt } from "./receipt-reconciliation.js";
import { verifySnapshotPreflight } from "./snapshot-preflight.js";
import {
  AdmissionInstallationError,
  type AdmissionPath,
  ExactUseAdmissionError,
  admissionErrorFromSql,
  admitExactUseWithin,
  lookupExactUseReceipt,
  recordEffectCommit,
  recordExactUseReceipt,
} from "./exact-use-admission.js";

export interface IngestionExecutorConfig {
  readonly db: KnowledgeDatabase;
  readonly workspace: Workspace;
  readonly artifacts: ArtifactLedger;
  readonly executorVersion: string;
  /** Trusted host supplies an authenticated evidence oracle; fixtures must opt in explicitly. */
  readonly evidence?: (intent: IngestionIntent) => EvidenceOracle;
  readonly allowStale?: boolean;
  /**
   * R1 F9: the K08 use-class policy (research-core `useClassPolicy(registry)` over `catalog/research/use-classes.json`).
   * With it, an intent whose declared (or, undeclared, default) use class is official or consequential and which carries
   * no `exactUse` is refused `REVIEW_REQUIRED`. An intent that declares a use to an executor without a policy is refused
   * `SCHEMA_UNSUPPORTED`: the executor cannot classify it, so it never guesses "internal".
   */
  readonly useClasses?: UseClassPolicy;
}

/** Structural port of research-core's `UseClassPolicy` (the registry stays the one authority; no copy of its rules). */
export interface UseClassPolicy {
  readonly registry: {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
  };
  classOf(declared: DeclaredUse | null): "official" | "consequential" | "internal" | "draft";
}

export interface IngestionOptions {
  readonly expectedHead?: number;
  /**
   * WI-05: the journaled K01 dispatch (component 2.5.0 `effect_dispatch`) this apply runs for. An exact-use apply then
   * stamps its native commit with it (`record_effect_commit`) inside the ingestion transaction, so a protocol receipt
   * lost after the commit is rebuilt for this original dispatch. Absent: no stamp (direct, non-K01 use).
   */
  readonly effectDispatchId?: string;
}

const INTENT_TYPE = "knowledge_ingestion";
/** `operation_receipt` is readable only by executor_service; ledger lookups run read-only under it. */
const LEDGER_READER = "executor_service" as const;
const STANDALONE_POLICY = { mode: "standalone", policy: "executor-default.v1" };
const BATCH_OPEN_RETRIES = 3;
const BATCH_OPEN_WAIT_MS = 500;
const PLAN_STATEMENT_TIMEOUT_MS = 30_000;
const APPLY_STATEMENT_TIMEOUT_MS = 120_000;
const MAX_VERIFY_INTENT_ID_LENGTH = 64;
/** Stand-ins for the decision fields a preview intent lacks (the plan id and effect never depend on them). */
const PREVIEW_DECISION_ID = "plan-preview";
const PREVIEW_PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;
/** K01 canonical digest of no normalized values (`{}`), what an intent that presents none binds. */
const EMPTY_NORMALIZED_VALUES_DIGEST = digestCanonical({});
/** Apply failures the agent can act on (exit 1); everything else is infrastructure (exit 2). */
const DOMAIN_FAILURE_CODES: ReadonlySet<string> = new Set([
  "REBASE_REQUIRED",
  "VOCABULARY_VIOLATION",
  "CONSTRAINT_VIOLATION",
  "HELPER_REJECTED",
  // SV-08 exact-use admission inside the native transaction (K01 typed errors):
  "STALE_DECISION",
  "REVIEW_REQUIRED",
  "EFFECT_CONFLICT",
  "UNRESOLVED_EFFECT",
  "EXACT_REVISION_UNAVAILABLE",
]);

type Row = Record<string, unknown>;
const hex = (digest: string): string => digest.replace(/^sha256:/, "");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const exitClassOf = (code: string): ExitClass => (DOMAIN_FAILURE_CODES.has(code) ? 1 : 2);

interface Planned {
  readonly intent: IngestionIntent;
  readonly plan: IngestionPlan;
  readonly vocabulary: Vocabulary;
}
interface LedgerEntry {
  readonly intent: IngestionIntent;
  readonly plan: IngestionPlan;
  readonly receiptArtifactId: string;
  readonly outcome: IngestionReceipt["outcome"];
  readonly failure: ReceiptFailure | null;
}
/**
 * `knowledge.plan_preview` result: what `knowledge.apply`'s own planning produces for the same intent in the same
 * database state. `boundEffectDigest` is the plan-level K01 bound digest the use decision must bind (and the envelope
 * and intent carry); `semanticPayloadDigest` is the digest of the native effect bytes (`knowledge-ingestion-effect.v1`)
 * the native transaction binds; `processedEpoch` is the authoritative revocation epoch now; `normalizedValuesDigest` is
 * what the native write presents (the intent's, or the digest of `{}`); `migrationHead` is the executor workspace head.
 */
export interface IngestionPlanPreview {
  readonly planId: string;
  readonly semanticPayloadDigest: string;
  readonly boundEffectDigest: string;
  readonly normalizedValuesDigest: string;
  readonly processedEpoch: number;
  readonly migrationHead: string;
}

/** A receipt of an exact-use ingestion also records which admission path ran and the effect receipt digest. */
export type ExactUseIngestionReceipt = IngestionReceipt & {
  readonly admission?: {
    readonly path: AdmissionPath;
    readonly useDecisionId: string;
    readonly boundEffectDigest: string;
    readonly effectKey: string;
    readonly authoritativeEpoch: number;
    readonly effectReceiptDigest: string;
  };
};

interface LedgerIds {
  readonly operationIntentId: string;
  readonly receiptId: string;
}

export class IngestionExecutor {
  constructor(private readonly config: IngestionExecutorConfig) {
    if (!config.evidence)
      throw infrastructureError("EVIDENCE_ORACLE_REQUIRED", "An authenticated evidence oracle is required");
  }

  parse(raw: unknown, options: IngestionOptions = {}): IngestionIntent {
    const parsed = IngestionIntentSchema.safeParse(raw);
    if (!parsed.success)
      throw domainError("INTENT_SCHEMA_INVALID", "intent does not match knowledge-ingestion-intent.v1", {
        issues: parsed.error.issues,
      });
    return this.checkContract(parsed.data, options);
  }

  private checkContract<T extends IngestionIntent | IngestionPreviewIntent>(parsed: T, options: IngestionOptions): T {
    const intent =
      options.expectedHead === undefined ? parsed : { ...parsed, expectedKnowledgeHead: options.expectedHead };
    if (intent.contract.migrationHead && intent.contract.migrationHead !== this.config.workspace.migrationHead)
      throw infrastructureError("WORKSPACE_STALE", "intent.contract.migrationHead ≠ executor workspace head", {
        intent: intent.contract.migrationHead,
        workspace: this.config.workspace.migrationHead,
      });
    if (
      intent.contract.workspaceFingerprint &&
      this.config.workspace.fingerprint &&
      intent.contract.workspaceFingerprint !== this.config.workspace.fingerprint
    )
      throw infrastructureError(
        "WORKSPACE_STALE",
        "intent.contract.workspaceFingerprint ≠ executor workspace fingerprint",
      );
    return intent;
  }

  /** Phases 1–7: parse, contract check, gather facts read-only as `pipeline_agent`, plan. No writes. */
  async plan(raw: unknown, options: IngestionOptions = {}): Promise<IngestionPlan> {
    const intent = this.parse(raw, options);
    return (await this.planWithContext(intent)).plan;
  }

  /**
   * `knowledge.plan_preview` (read-only): exactly what `apply` would plan and admit for this intent in the current
   * database state, BEFORE a use decision exists, so the caller can decide on the plan-level effect. The intent's
   * `exactUse` names the effect (`effectKey`, `originatingOrigin`); its decision fields may be absent and are ignored.
   * Runs the same contract, use-class and applicability checks as `apply` (a preview that answers implies `apply` reaches
   * admission with these digests), then reads the authoritative revocation epoch `admit_exact_use` compares against.
   * Writes nothing: the plan runs in a read-only `pipeline_agent` transaction and the epoch read is read-only.
   */
  async preview(raw: unknown, options: IngestionOptions = {}): Promise<IngestionPlanPreview> {
    const parsed = IngestionPreviewIntentSchema.safeParse(raw);
    if (!parsed.success)
      throw domainError(
        "INTENT_SCHEMA_INVALID",
        "intent does not match knowledge-ingestion-intent.v1 with an exact-use effect binding (effectKey, originatingOrigin)",
        { issues: parsed.error.issues },
      );
    const preview = this.checkContract(parsed.data, options);
    const presentedValues = preview.exactUse.normalizedValuesDigest;
    // The plan (its id and effect) does not depend on the decision fields: fill them so the planner sees an apply intent.
    const intent: IngestionIntent = {
      ...preview,
      exactUse: {
        ...preview.exactUse,
        useDecisionId: preview.exactUse.useDecisionId ?? PREVIEW_DECISION_ID,
        boundEffectDigest: preview.exactUse.boundEffectDigest ?? PREVIEW_PLACEHOLDER_DIGEST,
        processedEpoch: preview.exactUse.processedEpoch ?? 0,
        normalizedValuesDigest: presentedValues ?? PREVIEW_PLACEHOLDER_DIGEST,
      },
    };
    assertUseAdmissible(intent, this.config.useClasses);
    const planned = await this.planWithContext(intent);
    assertApplicable(planned.plan);
    const effect = planned.plan.effect;
    if (effect === null) throw infrastructureError("EXECUTOR_INTERNAL", "an exact-use plan carries no native effect");
    const processedEpoch = await this.authoritativeEpoch(intent.context.tenantId);
    return {
      planId: planned.plan.planId,
      semanticPayloadDigest: effect.semanticPayloadDigest,
      boundEffectDigest: effect.boundEffectDigest,
      // The native write presents the intent's own digest; there is no native derivation of normalized values, so
      // the decision must carry what the intent presents, or the digest of no normalized values (`{}`).
      normalizedValuesDigest: presentedValues ?? EMPTY_NORMALIZED_VALUES_DIGEST,
      processedEpoch,
      migrationHead: this.config.workspace.migrationHead,
    };
  }

  /** The authoritative revocation epoch `admit_exact_use` checks `processedEpoch` against (read-only). */
  private async authoritativeEpoch(tenantId: string): Promise<number> {
    const value = await this.config.db
      .transaction({ tenantId, role: LEDGER_READER, readOnly: true }, (client) =>
        scalarOrNull(client, "select knowledge_verification.current_revocation_epoch($1)::text as epoch", [tenantId]),
      )
      .catch((error: unknown) => {
        throw infrastructureError("DB_UNAVAILABLE", error instanceof Error ? error.message : String(error));
      });
    const epoch = value === null ? Number.NaN : Number(value);
    if (!Number.isSafeInteger(epoch) || epoch < 0)
      throw infrastructureError("EXECUTOR_INTERNAL", "the component returned no revocation epoch for this tenant");
    return epoch;
  }

  /** Phases 1–10: plan, then apply admitted proposals in one transaction as `executor_service`, then receipt. */
  async apply(raw: unknown, options: IngestionOptions = {}): Promise<IngestionReceipt> {
    const intent = this.parse(raw, options);
    assertUseAdmissible(intent, this.config.useClasses);
    const idempotencyKey = intentIdempotencyKey(intent, loadRules(this.config.workspace).rulesVersion);
    const duplicate = await this.findDuplicate(intent, idempotencyKey);
    if (duplicate) return duplicate;
    const planned = await this.planWithContext(intent);
    assertApplicable(planned.plan);
    assertExactEffect(planned);
    return this.applyWithRetry(planned, idempotencyKey, options.effectDispatchId ?? null);
  }

  async receipt(receiptId: string, tenantId: string): Promise<IngestionReceipt> {
    return reconcileReceipt({ db: this.config.db, artifacts: this.config.artifacts }, { receiptId, tenantId });
  }

  /**
   * WI-05 native read-back (read-only, never applies): the committed exact-use receipt of an effect, from the immutable
   * ingestion receipt the native commit wrote, checked against the component `effect_receipt` the same transaction
   * recorded (effect key and digest). `duplicateOf` is null: this is the receipt of the commit itself.
   */
  async committedExactUseReceipt(input: {
    readonly tenantId: string;
    readonly effectKey: string;
    readonly receiptId: string;
  }): Promise<ExactUseIngestionReceipt> {
    const stored = await this.config.db.transaction(
      { tenantId: input.tenantId, role: LEDGER_READER, readOnly: true },
      (client) => lookupExactUseReceipt(client, input.tenantId, input.effectKey),
    );
    if (!stored) throw domainError("RECEIPT_NOT_FOUND", `no committed effect receipt for ${input.effectKey}`);
    const receipt = (await this.receipt(input.receiptId, input.tenantId)) as ExactUseIngestionReceipt;
    const admission = receipt.admission;
    if (
      admission === undefined ||
      admission.effectKey !== input.effectKey ||
      admission.effectReceiptDigest !== stored.digest ||
      receipt.outcome === "rejected"
    ) {
      throw infrastructureError(
        "RECEIPT_ARTIFACT_INVALID",
        "the native ingestion receipt does not bind the committed effect receipt",
      );
    }
    return { ...receipt, duplicateOf: null };
  }

  private async planWithContext(intent: IngestionIntent): Promise<Planned> {
    await verifySnapshotPreflight(intent, this.config.artifacts, this.config.workspace);
    const databaseHead = await this.config.db.migrationHead().catch((error: unknown) => {
      throw infrastructureError("DB_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    });
    assertHeadMatches(this.config.workspace, databaseHead, this.config.allowStale ?? false);
    const rules = loadRules(this.config.workspace);
    const oracle = this.config.evidence!(intent);
    // Vocabularies are read as the executor's login identity: `taxonomy.entity_kind` carries a
    // deny-all RLS policy for every bounded role (db-contract follow-up). Everything else runs as pipeline_agent.
    return this.config.db.transaction(
      {
        tenantId: intent.context.tenantId,
        readOnly: true,
        isolationLevel: "repeatable read",
        statementTimeoutMs: PLAN_STATEMENT_TIMEOUT_MS,
      },
      async (client) => {
        const vocabulary = await loadVocabulary(client);
        await client.query("set local role pipeline_agent");
        const facts = await gatherFacts(client, intent, {
          vocabulary,
          rules,
          evidence: oracle,
        });
        return {
          intent,
          plan: buildPlan(intent, facts, {
            version: this.config.executorVersion,
            migrationHead: this.config.workspace.migrationHead,
          }),
          vocabulary,
        };
      },
    );
  }

  /** `BATCH_OPEN` is retried; an idempotency-key collision defers to the winner; anything else leaves a rejected receipt. */
  private async applyWithRetry(
    planned: Planned,
    idempotencyKey: string,
    effectDispatchId: string | null,
  ): Promise<IngestionReceipt> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.applyOnce(planned, effectDispatchId);
      } catch (error) {
        if (isIdempotencyKeyCollision(error)) return this.awaitWinner(planned.intent, idempotencyKey);
        // A transaction can commit successfully while its response is lost. Reconcile before recording rejection.
        const committed = await this.findDuplicate(planned.intent, idempotencyKey);
        if (committed) return committed;
        const failure = classifyFailure(error);
        if (failure.code === "BATCH_OPEN" && attempt < BATCH_OPEN_RETRIES) {
          await sleep(BATCH_OPEN_WAIT_MS);
          continue;
        }
        const receipt = await this.recordRejection(planned, failure);
        throw new KnowledgeError(failure.code, failure.message, exitClassOf(failure.code), { receipt, failure });
      }
    }
  }

  /** Same bytes ⇒ same key ⇒ the existing receipt, checked before planning so a created subject cannot shadow its own resubmission. */
  private async findDuplicate(intent: IngestionIntent, idempotencyKey: string): Promise<IngestionReceipt | undefined> {
    const tenantId = intent.context.tenantId;
    const existing = await this.config.db.transaction(
      { tenantId, role: LEDGER_READER, readOnly: true },
      async (client) =>
        (
          await client.query<Row>(
            "select r.id receipt_id from orchestration.operation_intent i join orchestration.operation_receipt r on r.intent_id=i.id where i.tenant_id=$1 and i.idempotency_key=$2",
            [tenantId, hex(idempotencyKey)],
          )
        ).rows[0],
    );
    if (!existing) return undefined;
    const receipt = await this.receipt(String(existing.receipt_id), tenantId);
    if (receipt.intentRef.intentDigest !== intentDigestOf(intent))
      throw domainError("IDEMPOTENCY_CONFLICT", "The idempotency key already belongs to a different request digest");
    return { ...receipt, duplicateOf: String(existing.receipt_id) };
  }

  /** The loser of a parallel submission (23505 on the idempotency key) returns the winner's receipt instead of failing. */
  private awaitWinner(intent: IngestionIntent, idempotencyKey: string): Promise<IngestionReceipt> {
    const lookup = (): Promise<IngestionReceipt | undefined> =>
      this.findDuplicate(intent, idempotencyKey).catch((error: unknown) => {
        if (isKnowledgeError(error) && error.code === "STORAGE_PENDING") return undefined;
        throw error;
      });
    return awaitWinnerReceipt(lookup, {
      intentId: intent.intentId,
      idempotencyKey,
    });
  }

  private async priorReceipts(
    client: KnowledgeSqlClient,
    intent: IngestionIntent,
    excludingKey: string,
  ): Promise<string[]> {
    return (
      await client.query<Row>(
        "select r.id from orchestration.operation_intent i join orchestration.operation_receipt r on r.intent_id=i.id where i.tenant_id=$1 and i.intent_type=$2 and i.payload->>'intentId'=$3 and i.idempotency_key<>$4 order by r.applied_at",
        [intent.context.tenantId, INTENT_TYPE, intent.intentId, excludingKey],
      )
    ).rows.map((row) => String(row.id));
  }

  private async applyOnce(
    { intent, plan, vocabulary }: Planned,
    effectDispatchId: string | null,
  ): Promise<ExactUseIngestionReceipt> {
    const tenantId = intent.context.tenantId;
    const executedAt = new Date().toISOString();
    const receiptArtifactId = uuidv7();
    const needsBatch = plan.plannedOutcome !== "noop";
    return this.config.db.transaction(
      {
        tenantId,
        role: "executor_service",
        statementTimeoutMs: APPLY_STATEMENT_TIMEOUT_MS,
      },
      async (client) => {
        const entry = {
          intent,
          plan,
          receiptArtifactId,
          outcome: plan.plannedOutcome,
          failure: null,
        };
        const ids = await this.insertLedger(client, entry);
        await client.query(
          "set constraints corpus.entity_created_by_receipt_id_fkey, staging.resolution_decision_receipt_id_fkey, evidence.claim_created_by_receipt_id_fkey, corpus.entity_receipt_tenant, knowledge.record_created_by_receipt_id_fkey, knowledge.record_receipt_tenant deferred",
        );
        const knowledgeSeq = needsBatch
          ? Number(await scalar(client, "select temporal.begin_batch($1::bigint)", [plan.head.effectiveExpectedHead]))
          : null;
        // SV-08: admit the exact use on THIS client inside the batch, before any canonical write. Any non-admitted
        // outcome throws a typed error and the whole transaction (ledger, domain rows, receipt) rolls back.
        const admission = intent.exactUse ? await this.admitWithin(client, intent, plan) : null;
        const applied = needsBatch
          ? await applyPlan({
              client,
              tenantId,
              receiptId: ids.receiptId,
              intent,
              plan,
              vocabulary,
              artifacts: this.config.artifacts,
            })
          : outcomeWithoutBatch(plan);
        await this.insertReceipt(client, entry, {
          ...ids,
          affectedRefs: applied.affectedRefs,
          ...(admission?.path === "aidb_guard" && intent.exactUse ? { admission: intent.exactUse } : {}),
        });
        // AI Engineer installation: project the admitted exact use into research.report_v2_* (guards re-check it).
        const projection =
          admission?.path === "aidb_guard" && intent.exactUse
            ? await projectReportV2(client, {
                tenantId,
                useDecisionId: intent.exactUse.useDecisionId,
                boundEffectDigest: intent.exactUse.boundEffectDigest,
                operationIntentId: ids.operationIntentId,
                receiptId: ids.receiptId,
                outcome: entry.outcome,
              })
            : null;
        const targets = await insertReceiptTargets(client, tenantId, ids.receiptId, [
          ...applied.targets,
          ...(projection?.targets ?? []),
        ]);
        const summary = {
          proposals: plan.plannedSummary,
          affected: applied.affectedRefs.length,
        };
        const committed = needsBatch
          ? Number(
              await scalar(client, "select temporal.commit_batch($1,$2,$3,$4::jsonb)", [
                ids.receiptId,
                hex(plan.intentRef.idempotencyKey),
                hex(plan.intentRef.intentDigest),
                JSON.stringify(summary),
              ]),
            )
          : plan.head.current;
        if (knowledgeSeq !== null && committed !== knowledgeSeq)
          throw infrastructureError("EXECUTOR_INTERNAL", "commit_batch returned an unexpected knowledge_seq", {
            opened: knowledgeSeq,
            committed,
          });
        // The effect receipt commits with the domain rows (receipt-first recovery finds it after a lost response).
        const effectReceipt =
          intent.exactUse && admission
            ? await recordExactUseReceipt(client, tenantId, {
                effectKey: intent.exactUse.effectKey,
                outcome:
                  plan.plannedOutcome === "partial" ? "partial" : plan.plannedOutcome === "noop" ? "noop" : "applied",
                nativeReceiptRef: {
                  schemaVersion: "knowledge-ingestion-receipt.v1",
                  receiptId: ids.receiptId,
                  planId: plan.planId,
                  intentDigest: plan.intentRef.intentDigest,
                  knowledgeSeq: committed,
                },
                affectedRefs: applied.affectedRefs.map((ref) => JSON.parse(JSON.stringify(ref))),
                processedEpoch: intent.exactUse.processedEpoch,
                useDecisionId: intent.exactUse.useDecisionId,
              })
            : null;
        // WI-05: the native commit names its journaled K01 dispatch, in this same transaction.
        if (intent.exactUse && effectReceipt && effectDispatchId !== null) {
          await recordEffectCommit(client, tenantId, {
            effectKey: intent.exactUse.effectKey,
            dispatchId: effectDispatchId,
            nativeRef: {
              schemaVersion: "knowledge-ingestion-receipt.v1",
              receiptId: ids.receiptId,
            },
          });
        }
        const intentArtifact = await this.config.artifacts.putWith(client, {
          tenantId,
          artifactType: "ingestion_intent",
          value: intent,
          ...(intent.context.missionId ? { missionId: intent.context.missionId } : {}),
        });
        const planArtifact = await this.config.artifacts.putWith(client, {
          tenantId,
          artifactType: "knowledge_ingestion_plan",
          value: {
            ...plan,
            intentRef: {
              ...plan.intentRef,
              artifactId: intentArtifact.artifactId,
            },
          },
        });
        const receipt: ExactUseIngestionReceipt = {
          schemaVersion: "knowledge-ingestion-receipt.v1",
          receiptId: ids.receiptId,
          operationIntentId: ids.operationIntentId,
          intentRef: plan.intentRef,
          planRef: { planId: plan.planId, artifactId: planArtifact.artifactId },
          outcome: plan.plannedOutcome,
          knowledgeBatch: needsBatch
            ? {
                knowledgeSeq: committed,
                inputDigest: plan.intentRef.intentDigest,
              }
            : null,
          head: {
            before: plan.head.current,
            after: committed,
            rebased: plan.head.rebased,
          },
          proposals: applied.proposals,
          subjects: applied.subjects,
          claims: applied.claims,
          affectedRefs: applied.affectedRefs,
          targets,
          report: projection?.report ?? null,
          duplicateOf: null,
          priorReceiptsForIntentId: await this.priorReceipts(client, intent, hex(plan.intentRef.idempotencyKey)),
          failure: null,
          storage: {
            intentArtifactId: intentArtifact.artifactId,
            planArtifactId: planArtifact.artifactId,
            receiptArtifactId,
            storageState:
              intentArtifact.storageState === "available" && planArtifact.storageState === "available"
                ? "stored"
                : "pending",
          },
          verify: suggestedVerification(intent, applied, plan.head.current, committed),
          executedAt,
          executorVersion: this.config.executorVersion,
          ...(admission && effectReceipt && intent.exactUse
            ? {
                admission: {
                  path: admission.path,
                  useDecisionId: intent.exactUse.useDecisionId,
                  boundEffectDigest: intent.exactUse.boundEffectDigest,
                  effectKey: intent.exactUse.effectKey,
                  authoritativeEpoch: admission.authoritativeEpoch,
                  effectReceiptDigest: effectReceipt.digest,
                },
              }
            : {}),
        };
        await this.config.artifacts.putWith(client, {
          tenantId,
          artifactType: "knowledge_ingestion_receipt",
          artifactId: receiptArtifactId,
          value: receipt,
        });
        const lineage = await this.linkLineage(client, {
          tenantId,
          receiptId: ids.receiptId,
          intentArtifactId: intentArtifact.artifactId,
          planArtifactId: planArtifact.artifactId,
          receiptArtifactId,
        });
        return { ...receipt, storage: { ...receipt.storage, lineage } };
      },
    );
  }

  /** The single admission code path, on this transaction's client; failures become typed domain errors. */
  private async admitWithin(
    client: KnowledgeSqlClient,
    intent: IngestionIntent,
    plan: IngestionPlan,
  ): Promise<{ path: AdmissionPath; authoritativeEpoch: number }> {
    const exactUse = intent.exactUse;
    if (!exactUse) throw infrastructureError("EXECUTOR_INTERNAL", "admission without an exact-use binding");
    try {
      return await admitExactUseWithin(
        client,
        intent.context.tenantId,
        {
          useDecisionId: exactUse.useDecisionId,
          boundEffectDigest: exactUse.boundEffectDigest,
          processedEpoch: exactUse.processedEpoch,
          normalizedValuesDigest: exactUse.normalizedValuesDigest,
        },
        {
          effect: {
            effectKey: exactUse.effectKey,
            // The plan computed both digests from the same native bytes (`assertExactEffect` checked the bound one).
            semanticPayloadDigest: plan.effect?.semanticPayloadDigest ?? exactUse.boundEffectDigest,
            originatingOrigin: exactUse.originatingOrigin,
          },
        },
      );
    } catch (error) {
      if (error instanceof AdmissionInstallationError) throw infrastructureError(error.code, error.message);
      const typed = error instanceof ExactUseAdmissionError ? error : admissionErrorFromSql(error, "component_only");
      if (typed === null) throw error;
      throw domainError(typed.code, typed.message, {
        outcome: typed.outcome,
        reason: typed.reason,
        path: typed.path,
      });
    }
  }

  /** Plan `derived_from` intent; receipt `produced_by` plan and `consumed_by` intent (spec §6.4). */
  private async linkLineage(
    client: KnowledgeSqlClient,
    refs: {
      tenantId: string;
      receiptId: string;
      intentArtifactId: string;
      planArtifactId: string;
      receiptArtifactId: string;
    },
  ): Promise<"written" | "denied"> {
    const { tenantId, receiptId } = refs;
    const states = [
      await this.config.artifacts.link(client, {
        tenantId,
        from: refs.planArtifactId,
        to: refs.intentArtifactId,
        relation: "derived_from",
        receiptId,
      }),
      await this.config.artifacts.link(client, {
        tenantId,
        from: refs.receiptArtifactId,
        to: refs.planArtifactId,
        relation: "produced_by",
        receiptId,
      }),
      await this.config.artifacts.link(client, {
        tenantId,
        from: refs.receiptArtifactId,
        to: refs.intentArtifactId,
        relation: "consumed_by",
        receiptId,
      }),
    ];
    return states.every((state) => state === "written") ? "written" : "denied";
  }

  /** A failed apply still leaves a durable `rejected` receipt (no batch is opened for it). */
  private async recordRejection(
    { intent, plan }: Planned,
    failure: ReceiptFailure,
  ): Promise<IngestionReceipt | undefined> {
    const tenantId = intent.context.tenantId;
    const receiptArtifactId = uuidv7();
    try {
      return await this.config.db.transaction({ tenantId, role: "executor_service" }, async (client) => {
        const entry: LedgerEntry = {
          intent,
          plan,
          receiptArtifactId,
          outcome: "rejected",
          failure,
        };
        const ids = await this.insertLedger(client, entry);
        await this.insertReceipt(client, entry, { ...ids, affectedRefs: [] });
        const current = Number(
          (await client.query<Row>("select knowledge_seq from api.knowledge_head()")).rows[0]?.knowledge_seq ??
            plan.head.current,
        );
        const receipt: IngestionReceipt = {
          schemaVersion: "knowledge-ingestion-receipt.v1",
          receiptId: ids.receiptId,
          operationIntentId: ids.operationIntentId,
          intentRef: plan.intentRef,
          planRef: { planId: plan.planId },
          outcome: "rejected",
          knowledgeBatch: null,
          head: { before: plan.head.current, after: current, rebased: false },
          proposals: plan.proposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            outcome: "rejected" as const,
            reason: failure.code,
          })),
          subjects: plan.subjects.map((subject) => ({
            ref: subject.ref,
            entityId: subject.resolution === "create" ? null : subject.entityId,
            created: false,
          })),
          claims: [],
          affectedRefs: [],
          targets: [],
          report: null,
          duplicateOf: null,
          priorReceiptsForIntentId: [],
          failure,
          storage: { receiptArtifactId, storageState: "pending" },
          verify: null,
          executedAt: new Date().toISOString(),
          executorVersion: this.config.executorVersion,
        };
        await this.config.artifacts.putWith(client, {
          tenantId,
          artifactType: "knowledge_ingestion_receipt",
          artifactId: receiptArtifactId,
          value: receipt,
        });
        return receipt;
      });
    } catch {
      return undefined;
    }
  }

  private async insertLedger(client: KnowledgeSqlClient, entry: LedgerEntry): Promise<LedgerIds> {
    const { intent, plan } = entry;
    const { proposals: _proposals, subjects: _subjects, notes: _notes, ...envelope } = intent;
    const operationIntentId = uuidv7();
    const origin = intent.exactUse?.originatingOrigin;
    const mission = origin?.mission ?? null;
    await client.query(
      `insert into orchestration.operation_intent(id,intent_type,schema_version,payload,preconditions,idempotency_key,proposed_by_attempt,mission_id,approval_state,policy_decision,tenant_id,
         origin_digest,origin_kind,mc_mission_id,mc_run_id,mc_activation_id,mc_operation_id,mc_operation_attempt,mc_execution_generation,mc_lane)
       values($1,$2,1,$3::jsonb,$4::jsonb,$5,$6,$7,'approved',$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        operationIntentId,
        INTENT_TYPE,
        JSON.stringify({
          ...envelope,
          proposalCount: intent.proposals.length,
          subjectCount: intent.subjects.length,
        }),
        JSON.stringify({
          expectedKnowledgeHead: plan.head.effectiveExpectedHead,
          snapshotDigest: intent.inputSnapshot?.snapshotDigest ?? null,
          rebased: plan.head.rebased,
        }),
        hex(plan.intentRef.idempotencyKey),
        intent.context.attemptId ?? null,
        intent.context.missionId ?? null,
        JSON.stringify(STANDALONE_POLICY),
        intent.context.tenantId,
        origin ? originDigest(origin) : null,
        origin?.kind ?? null,
        mission?.missionId ?? null,
        mission?.runId ?? null,
        mission?.activationId ?? null,
        mission?.operationId ?? null,
        mission?.operationAttempt ?? null,
        mission?.executionGeneration ?? null,
        mission?.lane ?? null,
      ],
    );
    return { operationIntentId, receiptId: uuidv7() };
  }

  private async insertReceipt(
    client: KnowledgeSqlClient,
    entry: LedgerEntry,
    ids: LedgerIds & {
      affectedRefs: readonly AffectedRef[];
      admission?: {
        readonly useDecisionId: string;
        readonly boundEffectDigest: string;
      };
    },
  ): Promise<void> {
    const { plan, intent } = entry;
    // With the AIDB projection (20261024010100) the receipt names the admitted decision and digest, which arms AIDB's
    // same-transaction commit guards over the canonical rows written under it.
    const admission = ids.admission;
    const origin = intent.exactUse?.originatingOrigin;
    await client.query(
      admission
        ? `insert into orchestration.operation_receipt(id,intent_id,executor_version,precondition_results,outcome,changes_summary,affected_refs,origin_digest,requires_admission,use_decision_id,bound_effect_digest) values($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb,$8,true,$9,$10)`
        : `insert into orchestration.operation_receipt(id,intent_id,executor_version,precondition_results,outcome,changes_summary,affected_refs,origin_digest) values($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb,$8)`,
      [
        ids.receiptId,
        ids.operationIntentId,
        this.config.executorVersion,
        JSON.stringify({
          expectedKnowledgeHead: plan.head.effectiveExpectedHead,
          observedHead: plan.head.current,
          snapshotDigest: intent.inputSnapshot?.snapshotDigest ?? null,
          rebased: plan.head.rebased,
        }),
        entry.outcome,
        JSON.stringify({
          planId: plan.planId,
          receiptArtifactId: entry.receiptArtifactId,
          intentDigest: plan.intentRef.intentDigest,
          planned: plan.plannedSummary,
          ...(entry.failure ? { failure: entry.failure } : {}),
        }),
        JSON.stringify(ids.affectedRefs),
        origin ? originDigest(origin) : null,
        ...(admission ? [admission.useDecisionId, admission.boundEffectDigest] : []),
      ],
    );
  }
}

/** The intent's exact-use binding must bind the plan's exact native bytes (planned proposals + originating origin). */
function assertExactEffect({ intent, plan }: Planned): void {
  if (!intent.exactUse) return;
  if (plan.effect === null || plan.effect.boundEffectDigest !== intent.exactUse.boundEffectDigest)
    throw domainError("EFFECT_CONFLICT", "the exact-use binding does not bind this plan's native effect bytes", {
      planned: plan.effect?.boundEffectDigest ?? null,
      bound: intent.exactUse.boundEffectDigest,
    });
}

/** Submit refuses a plan with errors, and one where nothing would be written or staged. */
function assertApplicable(plan: IngestionPlan): void {
  const first = plan.errors[0];
  if (first)
    throw new KnowledgeError(first.code, first.message, 1, {
      errors: plan.errors,
      plan,
    });
  if (plan.proposals.every((proposal) => proposal.outcome === "held"))
    throw domainError("REVIEW_REQUIRED_ONLY", "every proposal is held or requires review; nothing to apply", { plan });
}

/**
 * R1 F9: admission is not opt-in for official or consequential uses. Refuses before any read or write: an official or
 * consequential intent must name the admitted use decision it applies (`exactUse`).
 */
export function assertUseAdmissible(intent: IngestionIntent, policy: UseClassPolicy | undefined): void {
  if (policy === undefined) {
    if (intent.declaredUse !== undefined)
      throw infrastructureError(
        "SCHEMA_UNSUPPORTED",
        "the intent declares a use but this executor has no K08 use-class policy to classify it",
        { declaredUse: intent.declaredUse },
      );
    return;
  }
  const useClass = policy.classOf(intent.declaredUse ?? null);
  if ((useClass === "official" || useClass === "consequential") && intent.exactUse === undefined)
    throw domainError("REVIEW_REQUIRED", `a ${useClass} use must carry an admitted exact-use binding (exactUse)`, {
      useClass,
      declaredUse: intent.declaredUse ?? null,
      registry: policy.registry,
    });
}

/** A `noop` plan opens no batch: the receipt echoes the planned outcomes and known ids. */
function outcomeWithoutBatch(plan: IngestionPlan): ApplyOutcome {
  return {
    proposals: plan.proposals.map((proposal) => ({
      proposalId: proposal.proposalId,
      outcome: proposal.outcome,
      ...(proposal.existing ? { existing: proposal.existing } : {}),
    })),
    affectedRefs: [],
    subjects: plan.subjects.map((subject) => ({
      ref: subject.ref,
      entityId: subject.entityId,
      created: false,
    })),
    claims: plan.evidence.claims.map((claim) => ({
      runId: claim.runId,
      claimId: claim.claimId,
      claimRowId: claim.claimRowId,
    })),
    targets: targetsWithoutBatch(plan),
  };
}

async function scalarOrNull(
  client: KnowledgeSqlClient,
  sql: string,
  params: readonly unknown[],
): Promise<string | null> {
  const row = (await client.query<Row>(sql, params)).rows[0];
  const value = row ? Object.values(row)[0] : null;
  return value === null || value === undefined ? null : String(value);
}

async function scalar(client: KnowledgeSqlClient, sql: string, params: readonly unknown[]): Promise<string> {
  const row = (await client.query<Row>(sql, params)).rows[0];
  if (!row) throw infrastructureError("EXECUTOR_INTERNAL", `no row from ${sql}`);
  return String(Object.values(row)[0]);
}

function suggestedVerification(
  intent: IngestionIntent,
  applied: ApplyOutcome,
  before: number,
  after: number,
): IngestionReceipt["verify"] {
  const entityIds = applied.subjects.map((subject) => subject.entityId).filter((id): id is string => Boolean(id));
  if (entityIds.length === 0 || before === after) return null;
  return {
    suggestedReadIntent: {
      schemaVersion: "knowledge-read-intent.v1",
      intentId: `verify-${intent.intentId}`.slice(0, MAX_VERIFY_INTENT_ID_LENGTH),
      context: { tenantId: intent.context.tenantId },
      operations: entityIds.map((entityId, index) => ({
        opId: `changed-${index}`,
        kind: "named_query",
        query: "entity.what_changed",
        params: { entity_id: entityId, k_from: before, k_to: after },
      })),
    },
  };
}

/** Maps helper and constraint failures onto the contract's error codes. */
export function classifyFailure(error: unknown): ReceiptFailure {
  const admission = admissionErrorFromSql(error);
  if (admission !== null && !isKnowledgeError(error)) {
    const pg = error as { code?: string };
    return {
      code: admission.code,
      message: admission.message,
      ...(pg.code ? { sqlstate: pg.code } : {}),
    };
  }
  if (isKnowledgeError(error))
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  const pg = error as { code?: string; message?: string; detail?: string };
  const message = pg.message ?? String(error);
  if (pg.code === "40001" || /rebase_required/.test(message))
    return {
      code: "REBASE_REQUIRED",
      message: "knowledge head advanced since the snapshot; re-snapshot and resubmit",
      sqlstate: "40001",
    };
  if (/knowledge batch already open/.test(message))
    return { code: "BATCH_OPEN", message, sqlstate: pg.code ?? "P0001" };
  if (pg.code === "23514")
    return {
      code: "VOCABULARY_VIOLATION",
      message,
      sqlstate: pg.code,
      ...(pg.detail ? { details: pg.detail } : {}),
    };
  if (pg.code?.startsWith("23"))
    return {
      code: "CONSTRAINT_VIOLATION",
      message,
      sqlstate: pg.code,
      ...(pg.detail ? { details: pg.detail } : {}),
    };
  if (pg.code === "P0001" || pg.code === "P0002") return { code: "HELPER_REJECTED", message, sqlstate: pg.code };
  if (pg.code === "42501") return { code: "ROLE_DENIED", message, sqlstate: pg.code };
  if (pg.code?.startsWith("08") || pg.code === "57P01" || pg.code === "ECONNREFUSED")
    return {
      code: "DB_UNAVAILABLE",
      message,
      ...(pg.code ? { sqlstate: pg.code } : {}),
    };
  return {
    code: "EXECUTOR_INTERNAL",
    message,
    ...(pg.code ? { sqlstate: pg.code } : {}),
  };
}

// SV-08: the one exact-use admission code path (shared with the PostgreSQL research binding).
export * from "./exact-use-admission.js";
