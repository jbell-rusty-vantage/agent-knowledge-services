import {
  ContentLinkIntentSchema,
  JsonValueSchema,
  type ContentLinkIntent,
  type ContentLinkOperation,
} from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { ArtifactLedger } from "../../db-read/index.js";
import type { ContentAdmission, KnowledgeDatabase, KnowledgeSqlClient } from "../../ports.js";
import { assertHeadMatches, domainError, isKnowledgeError, type Workspace } from "../../schema-workspace/index.js";
import { awaitWinnerReceipt, isIdempotencyKeyCollision } from "../duplicate.js";
import { verifySnapshotPreflight } from "../snapshot-preflight.js";
import { orderContentOperations } from "./dependencies.js";
import { ContentSourceReader } from "./sources.js";
import {
  applyPreparedContentOperation,
  prepareContentOperation,
  reconcileContentOperationRefs,
  type ContentOperationContext,
  type PreparedContentOperation,
} from "./operations.js";
import { beginContentLedger, finishContentLedger, findContentLedger, reconcileContentLedger } from "./ledger.js";
import type {
  AuthenticatedContentEvidence,
  ContentLinkAuthority,
  ContentLinkOperationResult,
  ContentLinkPlan,
  ContentLinkReceipt,
} from "./types.js";

interface ContentLinkExecutorConfig {
  readonly db: KnowledgeDatabase;
  readonly admission: ContentAdmission;
  readonly workspace: Workspace;
  readonly artifacts: ArtifactLedger;
  readonly authority: ContentLinkAuthority;
  readonly tenantId: string;
  readonly missionId: string;
  readonly attemptId: string;
  readonly policyDigest: string;
  readonly executorVersion: string;
}
interface PreparedPlan {
  readonly plan: ContentLinkPlan;
  readonly prepared: ReadonlyMap<string, PreparedContentOperation>;
  readonly contexts: ReadonlyMap<string, ContentOperationContext>;
}
interface OperationPreparationInput {
  readonly operation: ContentLinkOperation;
  readonly context: Omit<ContentOperationContext, "evidence">;
  readonly policyDigest: string;
}
interface OperationPreparationResult {
  readonly result: ContentLinkOperationResult;
  readonly prepared?: PreparedContentOperation;
  readonly context?: ContentOperationContext;
}
const PLAN_TIMEOUT_MS = 30_000;
const APPLY_TIMEOUT_MS = 120_000;

/** Separate typed content effects share the graph's snapshot, batch and custody gates. */
export class ContentLinkExecutor {
  constructor(private readonly config: ContentLinkExecutorConfig) {}

  async plan(raw: unknown): Promise<ContentLinkPlan> {
    const intent = this.parse(raw);
    await this.preflight(intent);
    return this.config.db.transaction(
      {
        tenantId: intent.context.tenantId,
        role: "executor_service",
        readOnly: true,
        isolationLevel: "repeatable read",
        statementTimeoutMs: PLAN_TIMEOUT_MS,
      },
      async (client) => {
        await requireAttempt(client, intent);
        await requireCurrentHead(client, intent.expectedKnowledgeHead);
        return (await this.prepare(client, intent)).plan;
      },
    );
  }

  async apply(raw: unknown): Promise<ContentLinkReceipt> {
    const intent = this.parse(raw);
    const duplicate = await this.duplicate(intent);
    if (duplicate) return duplicate;
    await this.preflight(intent);
    try {
      return await this.applyOnce(intent);
    } catch (error) {
      if (isIdempotencyKeyCollision(error))
        return awaitWinnerReceipt(() => this.duplicate(intent), {
          intentId: intent.intentId,
          idempotencyKey: this.idempotencyKey(intent),
        });
      const committed = await this.duplicate(intent);
      if (committed) return committed;
      throw error;
    }
  }

  async receipt(receiptId: string): Promise<ContentLinkReceipt> {
    return this.config.db.transaction(
      { tenantId: this.config.tenantId, role: "executor_service", readOnly: true },
      (client) =>
        reconcileContentLedger(
          { client, artifacts: this.config.artifacts, reconcileRows: (receipt) => this.reconcileRows(client, receipt) },
          { tenantId: this.config.tenantId, receiptId },
        ),
    );
  }

  private parse(raw: unknown): ContentLinkIntent {
    const parsed = ContentLinkIntentSchema.safeParse(JsonValueSchema.parse(raw));
    if (!parsed.success)
      throw domainError("CONTENT_INTENT_SCHEMA_INVALID", "Intent does not match content-link-intent.v1", {
        issues: parsed.error.issues,
      });
    const intent = parsed.data;
    if (
      intent.context.tenantId !== this.config.tenantId ||
      intent.contract.policyDigest !== this.config.policyDigest ||
      intent.context.attemptId !== this.config.attemptId ||
      intent.context.missionId !== this.config.missionId
    )
      throw domainError(
        "CONTENT_AUTHORITY_PIN_MISMATCH",
        "Content-link tenant, mission, attempt and policy must match the host pin",
      );
    if (
      intent.contract.migrationHead !== this.config.workspace.migrationHead ||
      intent.contract.workspaceFingerprint !== this.config.workspace.fingerprint
    )
      throw domainError("WORKSPACE_STALE", "Content-link contract must match the installed schema workspace");
    return intent;
  }

  private async preflight(intent: ContentLinkIntent): Promise<void> {
    assertHeadMatches(this.config.workspace, await this.config.db.migrationHead(), false);
    const snapshot = await this.config.artifacts.get(intent.context.tenantId, intent.inputSnapshot.artifact.id);
    if (
      snapshot.record.storageState !== "available" ||
      snapshot.record.digest !== intent.inputSnapshot.artifact.digest ||
      !snapshot.json ||
      typeof snapshot.json !== "object" ||
      !("snapshotDigest" in snapshot.json) ||
      typeof snapshot.json.snapshotDigest !== "string"
    )
      throw domainError(
        "CONTENT_SNAPSHOT_BINDING_INVALID",
        "Content-link snapshot bytes differ from the declared artifact",
      );
    await verifySnapshotPreflight(
      {
        context: intent.context,
        expectedKnowledgeHead: intent.expectedKnowledgeHead,
        inputSnapshot: {
          artifactId: intent.inputSnapshot.artifact.id,
          snapshotDigest: snapshot.json.snapshotDigest,
          knowledgeSeq: intent.inputSnapshot.knowledgeSeq,
        },
      },
      this.config.artifacts,
      this.config.workspace,
    );
  }

  private async prepare(
    client: KnowledgeSqlClient,
    intent: ContentLinkIntent,
    receiptId?: string,
  ): Promise<PreparedPlan> {
    const prepared = new Map<string, PreparedContentOperation>();
    const contexts = new Map<string, ContentOperationContext>();
    const results: ContentLinkOperationResult[] = [];
    const sources = new ContentSourceReader({
      client,
      tenantId: intent.context.tenantId,
      artifacts: this.config.artifacts,
      admission: this.config.admission,
    });
    const context = {
      client,
      tenantId: intent.context.tenantId,
      attemptId: intent.context.attemptId,
      ...(receiptId ? { receiptId } : {}),
      sources,
      priorPrepared: prepared,
    };
    for (const ordered of orderContentOperations(intent.operations)) {
      const operation = { ...ordered.operation, dependsOn: [...ordered.dependsOn] };
      const blocked = operation.dependsOn.some(
        (id) => results.find((result) => result.operationId === id)?.outcome === "held",
      );
      if (blocked) {
        results.push(held(operation, "CONTENT_DEPENDENCY_HELD"));
        continue;
      }
      const current = await this.prepareOne({ operation, context, policyDigest: intent.contract.policyDigest });
      if (current.prepared && current.context) {
        contexts.set(operation.operationId, current.context);
        prepared.set(operation.operationId, current.prepared);
      }
      results.push(current.result);
    }
    return {
      plan: {
        schemaVersion: "content-link-plan.v1",
        intentDigest: contentIntentDigest(intent),
        expectedKnowledgeHead: intent.expectedKnowledgeHead,
        operations: results,
      },
      prepared,
      contexts,
    };
  }

  private async prepareOne(input: OperationPreparationInput): Promise<OperationPreparationResult> {
    const { operation } = input;
    try {
      const evidence: AuthenticatedContentEvidence[] = [];
      for (const reference of operation.evidence)
        evidence.push(
          await this.config.authority.authenticate({
            client: input.context.client,
            tenantId: input.context.tenantId,
            policyDigest: input.policyDigest,
            reference,
          }),
        );
      const context: ContentOperationContext = { ...input.context, evidence };
      const prepared = await prepareContentOperation(context, operation);
      return { result: prepared.result, prepared, context };
    } catch (error) {
      const code = admissionFailure(error);
      if (!code) throw error;
      return { result: held(operation, code) };
    }
  }

  private async applyOnce(intent: ContentLinkIntent): Promise<ContentLinkReceipt> {
    return this.config.db.transaction(
      {
        tenantId: intent.context.tenantId,
        role: "executor_service",
        isolationLevel: "repeatable read",
        statementTimeoutMs: APPLY_TIMEOUT_MS,
      },
      async (client) => {
        await requireAttempt(client, intent);
        const before = await scalarNumber(client, "select temporal.lock_knowledge_head($1::bigint)", [
          intent.expectedKnowledgeHead,
        ]);
        const ids = await beginContentLedger(client, {
          intent,
          intentDigest: contentIntentDigest(intent),
          idempotencyKey: this.idempotencyKey(intent),
          executorVersion: this.config.executorVersion,
        });
        const inspected = await this.prepare(client, intent, ids.receiptId);
        const changes = inspected.plan.operations.some((result) => result.outcome === "applied");
        const after = changes
          ? await scalarNumber(client, "select temporal.begin_batch($1::bigint)", [before])
          : before;
        const operations = await this.applyPrepared(inspected);
        const receipt = await finishContentLedger(
          { client, artifacts: this.config.artifacts },
          {
            intent,
            plan: inspected.plan,
            ids,
            operations,
            head: { before, after },
            executorVersion: this.config.executorVersion,
          },
        );
        if (changes)
          await this.commitBatch({
            client,
            intent,
            receiptId: ids.receiptId,
            expectedHead: after,
            operationCount: operations.length,
          });
        await this.reconcileRows(client, receipt);
        return receipt;
      },
    );
  }

  private async applyPrepared(inspected: PreparedPlan): Promise<ContentLinkOperationResult[]> {
    const operations: ContentLinkOperationResult[] = [];
    for (const result of inspected.plan.operations) {
      const current = inspected.prepared.get(result.operationId);
      const context = inspected.contexts.get(result.operationId);
      operations.push(current && context ? await applyPreparedContentOperation(context, current) : result);
    }
    return operations;
  }

  private async commitBatch(input: {
    client: KnowledgeSqlClient;
    intent: ContentLinkIntent;
    receiptId: string;
    expectedHead: number;
    operationCount: number;
  }): Promise<void> {
    const committed = await scalarNumber(input.client, "select temporal.commit_batch($1,$2,$3,$4::jsonb)", [
      input.receiptId,
      this.idempotencyKey(input.intent).slice(7),
      contentIntentDigest(input.intent).slice(7),
      JSON.stringify({ contentOperations: input.operationCount }),
    ]);
    if (committed !== input.expectedHead) throw new Error("CONTENT_BATCH_COMMIT_MISMATCH");
  }

  private async duplicate(intent: ContentLinkIntent): Promise<ContentLinkReceipt | undefined> {
    return this.config.db.transaction(
      { tenantId: intent.context.tenantId, role: "executor_service", readOnly: true },
      (client) =>
        findContentLedger(
          { client, artifacts: this.config.artifacts, reconcileRows: (receipt) => this.reconcileRows(client, receipt) },
          { intent, intentDigest: contentIntentDigest(intent), idempotencyKey: this.idempotencyKey(intent) },
        ),
    );
  }

  private async reconcileRows(client: KnowledgeSqlClient, receipt: ContentLinkReceipt): Promise<void> {
    for (const result of receipt.operations) {
      const operation = receipt.intent.operations.find((candidate) => candidate.operationId === result.operationId);
      if (!operation) throw new Error("CONTENT_RECEIPT_OPERATION_MISSING");
      await reconcileContentOperationRefs(client, { tenantId: receipt.tenantId, result, operation });
    }
  }

  private idempotencyKey(intent: ContentLinkIntent): string {
    return sha256Digest({
      schemaVersion: "content-link-execution.v1",
      intentDigest: contentIntentDigest(intent),
      executorVersion: this.config.executorVersion,
      policyDigest: this.config.policyDigest,
    });
  }
}

function held(
  operation: { operationId: string; kind: ContentLinkOperationResult["kind"]; dependsOn: string[] },
  reason: string,
): ContentLinkOperationResult {
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    dependsOn: operation.dependsOn,
    outcome: "held",
    reasons: [reason],
    canonicalRefs: [],
  };
}
function admissionFailure(error: unknown): string | undefined {
  if (isKnowledgeError(error) && /^(CONTENT_|EVIDENCE_|ARTIFACT_NOT_FOUND)/.test(error.code)) return error.code;
  return error instanceof Error && error.message === "EVIDENCE_NOT_AUTHORIZED" ? error.message : undefined;
}
async function requireAttempt(client: KnowledgeSqlClient, intent: ContentLinkIntent): Promise<void> {
  const row = (
    await client.query<{ id: string }>(
      "select a.id from orchestration.attempt a join orchestration.work_item w on w.tenant_id=a.tenant_id and w.id=a.work_item_id where a.tenant_id=$1 and a.id=$2 and w.mission_id=$3",
      [intent.context.tenantId, intent.context.attemptId, intent.context.missionId],
    )
  ).rows[0];
  if (!row)
    throw domainError(
      "CONTENT_ATTEMPT_BINDING_INVALID",
      "Content-link attempt must belong to the declared tenant and mission",
    );
}
async function requireCurrentHead(client: KnowledgeSqlClient, expected: number): Promise<number> {
  const current = await scalarNumber(client, "select knowledge_seq from api.knowledge_head()", []);
  if (current !== expected)
    throw domainError("REBASE_REQUIRED", "Knowledge head advanced; refresh the content-link snapshot");
  return current;
}
async function scalarNumber(client: KnowledgeSqlClient, sql: string, values: readonly unknown[]): Promise<number> {
  const row = (await client.query<Record<string, unknown>>(sql, [...values])).rows[0];
  const value = row ? Number(Object.values(row)[0]) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("CONTENT_KNOWLEDGE_HEAD_INVALID");
  return value;
}

function contentIntentDigest(intent: ContentLinkIntent): string {
  return sha256Digest(JsonValueSchema.parse(intent));
}
