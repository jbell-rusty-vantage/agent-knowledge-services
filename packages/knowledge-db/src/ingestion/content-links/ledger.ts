import { z } from "zod";
import { ContentLinkIntentSchema, type ContentLinkIntent } from "@aiengineer/knowledge-contracts";
import { canonicalJson, sha256Digest } from "@aiengineer/knowledge-core";
import { uuidv7, type ArtifactLedger, type ArtifactRecord, type LineageEdge } from "../../db-read/index.js";
import type { KnowledgeSqlClient } from "../../ports.js";
import { domainError } from "../../schema-workspace/index.js";
import type { ContentLinkOperationResult, ContentLinkPlan, ContentLinkReceipt } from "./types.js";
import { orderContentOperations } from "./dependencies.js";

type Row = Record<string, unknown>;
type ReceiptSummary = {
  artifacts?: { intent: ArtifactRecord; plan: ArtifactRecord; receipt: ArtifactRecord };
  intentDigest?: string;
  receiptArtifactId?: string;
  head?: unknown;
  operations?: unknown;
};
export interface ContentLedgerIds {
  readonly operationIntentId: string;
  readonly receiptId: string;
  readonly receiptArtifactId: string;
}
interface LedgerDependencies {
  readonly client: KnowledgeSqlClient;
  readonly artifacts: ArtifactLedger;
}
interface ReconciliationDependencies extends LedgerDependencies {
  readonly reconcileRows: (receipt: ContentLinkReceipt) => Promise<void>;
}
interface BeginInput {
  readonly intent: ContentLinkIntent;
  readonly intentDigest: string;
  readonly idempotencyKey: string;
  readonly executorVersion: string;
}
interface FinishInput {
  readonly intent: ContentLinkIntent;
  readonly plan: ContentLinkPlan;
  readonly ids: ContentLedgerIds;
  readonly operations: readonly ContentLinkOperationResult[];
  readonly head: { readonly before: number; readonly after: number };
  readonly executorVersion: string;
}

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(63);
const RowReference = z.strictObject({
  schema: z.enum(["content", "retrieval"]),
  table: Identifier,
  key: z
    .record(Identifier, z.string().min(1).max(1000))
    .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 16),
});
const Operation = z.strictObject({
  operationId: z.string(),
  kind: z.string(),
  outcome: z.enum(["applied", "held", "no_op"]),
  dependsOn: z.array(z.string()).max(256),
  reasons: z.array(z.string()).max(256),
  canonicalRefs: z.array(RowReference).max(4096),
});
const Plan = z.strictObject({
  schemaVersion: z.literal("content-link-plan.v1"),
  intentDigest: Digest,
  expectedKnowledgeHead: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  operations: z.array(Operation).min(1).max(256),
});
const Receipt = z.strictObject({
  schemaVersion: z.literal("content-link-receipt.v1"),
  receiptId: z.uuid(),
  operationIntentId: z.uuid(),
  tenantId: z.uuid(),
  intentId: z.string(),
  intentDigest: Digest,
  outcome: z.enum(["applied", "partial", "noop", "rejected"]),
  head: z.strictObject({
    before: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    after: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  operations: z.array(Operation).min(1).max(256),
  intent: ContentLinkIntentSchema,
  artifacts: z.strictObject({ intentId: z.uuid(), planId: z.uuid(), receiptId: z.uuid() }),
  duplicateOf: z.null(),
  executedAt: z.iso.datetime({ offset: true }),
  executorVersion: z.string().min(1).max(256),
});

function reject(message: string): never {
  throw domainError("CONTENT_LEDGER_CONFLICT", message);
}
// Unlike the legacy ledger serializer, domain canonical JSON preserves Unicode code points.
function json(value: unknown): string {
  return canonicalJson(value as Parameters<typeof canonicalJson>[0]);
}
function digest(value: unknown): string {
  return sha256Digest(json(value));
}
function equal(left: unknown, right: unknown): boolean {
  return json(left) === json(right);
}
function key(value: string): string {
  return Digest.parse(value).slice(7);
}

function validateIntent(intent: ContentLinkIntent, expectedDigest: string): void {
  const parsed = ContentLinkIntentSchema.parse(intent);
  if (!equal(parsed, intent) || digest(intent) !== expectedDigest)
    reject("Full intent differs from its canonical digest");
}

function validateOperations(intent: ContentLinkIntent, operations: readonly ContentLinkOperationResult[]): void {
  if (
    operations.length !== intent.operations.length ||
    new Set(operations.map((value) => value.operationId)).size !== operations.length
  )
    reject("Operation census differs from the intent");
  const ordered = orderContentOperations(intent.operations);
  for (const operation of operations) {
    Operation.parse(operation);
    const original = ordered.find((value) => value.operation.operationId === operation.operationId);
    if (!original || original.operation.kind !== operation.kind || !equal(original.dependsOn, operation.dependsOn))
      reject("Operation identity or dependencies differ from the intent");
  }
}

function validateFinalOutcomes(plan: ContentLinkPlan, operations: readonly ContentLinkOperationResult[]): void {
  const held = new Set(
    operations.filter((operation) => operation.outcome === "held").map((operation) => operation.operationId),
  );
  for (const operation of operations) {
    if (operation.outcome !== "held" && operation.dependsOn.some((dependency) => held.has(dependency)))
      reject("Final outcome depends on a held operation");
    if (operation.outcome === "held" ? operation.canonicalRefs.length !== 0 : operation.canonicalRefs.length === 0)
      reject("Operation outcome lacks exact canonical row references");
    const planned = plan.operations.find((value) => value.operationId === operation.operationId)!;
    if (
      (planned.outcome === "held" && operation.outcome !== "held") ||
      (planned.outcome === "no_op" && operation.outcome === "applied")
    )
      reject("Final outcome escalates the admitted plan");
    if (planned.outcome !== operation.outcome && !operation.reasons.length)
      reject("Downgraded outcome requires an explicit reason");
  }
}

function validateHead(
  intent: ContentLinkIntent,
  operations: readonly ContentLinkOperationResult[],
  head: ContentLinkReceipt["head"],
): void {
  const applied = operations.some((operation) => operation.outcome === "applied");
  if (
    !Number.isSafeInteger(head.before) ||
    !Number.isSafeInteger(head.after) ||
    head.before !== intent.expectedKnowledgeHead ||
    (applied ? head.after !== head.before + 1 : head.after !== head.before)
  )
    reject("Receipt head does not match its applied effects");
}

function validateStoredIntent(
  row: Row | undefined,
  input: { intent: ContentLinkIntent; intentDigest: string; executorVersion: string },
): void {
  const { intent, intentDigest, executorVersion } = input;
  if (
    !row ||
    !equal(row.payload, intent) ||
    row.schema_version !== 1 ||
    row.tenant_id !== intent.context.tenantId ||
    row.proposed_by_attempt !== intent.context.attemptId ||
    row.mission_id !== intent.context.missionId ||
    row.approval_state !== "approved" ||
    !equal(row.policy_decision ?? null, { executorVersion, policyDigest: intent.contract.policyDigest }) ||
    !equal(row.preconditions ?? null, { intentDigest, expectedKnowledgeHead: intent.expectedKnowledgeHead })
  )
    reject("Ledger intent authority differs from immutable intent");
}

function outcome(operations: readonly ContentLinkOperationResult[]): ContentLinkReceipt["outcome"] {
  const held = operations.filter((operation) => operation.outcome === "held").length;
  if (held === operations.length) return "rejected";
  if (held) return "partial";
  return operations.some((operation) => operation.outcome === "applied") ? "applied" : "noop";
}

export async function beginContentLedger(client: KnowledgeSqlClient, input: BeginInput): Promise<ContentLedgerIds> {
  validateIntent(input.intent, input.intentDigest);
  const ids = { operationIntentId: uuidv7(), receiptId: uuidv7(), receiptArtifactId: uuidv7() };
  await client.query(
    `insert into orchestration.operation_intent
    (id,intent_type,schema_version,payload,preconditions,idempotency_key,proposed_by_attempt,mission_id,approval_state,policy_decision,tenant_id)
    values($1,'content_link',1,$2::jsonb,$3::jsonb,$4,$5,$6,'approved',$7::jsonb,$8)`,
    [
      ids.operationIntentId,
      json(input.intent),
      json({ intentDigest: input.intentDigest, expectedKnowledgeHead: input.intent.expectedKnowledgeHead }),
      key(input.idempotencyKey),
      input.intent.context.attemptId,
      input.intent.context.missionId,
      json({ executorVersion: input.executorVersion, policyDigest: input.intent.contract.policyDigest }),
      input.intent.context.tenantId,
    ],
  );
  return ids;
}

function validateStored(record: ArtifactRecord, expected: { type: string; digest: string; id?: string }): void {
  if (
    record.storageState !== "available" ||
    record.artifactType !== expected.type ||
    record.digest !== expected.digest ||
    (expected.id !== undefined && record.artifactId !== expected.id)
  )
    reject("Artifact custody identity, type or availability differs");
}

async function put(
  dependencies: LedgerDependencies,
  input: {
    intent: ContentLinkIntent;
    type: "content_link_intent" | "content_link_plan" | "content_link_receipt";
    value: unknown;
    id?: string;
  },
): Promise<ArtifactRecord> {
  const stored = await dependencies.artifacts.putWith(dependencies.client, {
    tenantId: input.intent.context.tenantId,
    missionId: input.intent.context.missionId,
    artifactType: input.type,
    ...(input.id ? { artifactId: input.id } : {}),
    text: json(input.value),
    mediaType: "application/json",
  });
  validateStored(stored, { type: input.type, digest: digest(input.value), ...(input.id ? { id: input.id } : {}) });
  return stored;
}

function edges(receipt: ContentLinkReceipt): LineageEdge[] {
  const tenantId = receipt.tenantId;
  const dependencies = new Set([
    receipt.intent.inputSnapshot.artifact.id,
    ...receipt.intent.operations.flatMap((operation) => operation.evidence.map((evidence) => evidence.manifest.id)),
  ]);
  return [
    ...[...dependencies].map((to) => ({
      tenantId,
      from: receipt.artifacts.intentId,
      to,
      relation: "derived_from" as const,
    })),
    { tenantId, from: receipt.artifacts.planId, to: receipt.artifacts.intentId, relation: "derived_from" },
    {
      tenantId,
      from: receipt.artifacts.receiptId,
      to: receipt.artifacts.intentId,
      relation: "derived_from",
      receiptId: receipt.receiptId,
    },
    {
      tenantId,
      from: receipt.artifacts.receiptId,
      to: receipt.artifacts.planId,
      relation: "derived_from",
      receiptId: receipt.receiptId,
    },
  ];
}

async function verifyEdges(client: KnowledgeSqlClient, receipt: ContentLinkReceipt): Promise<void> {
  const expected = edges(receipt);
  const rows = (
    await client.query<Row>(
      `select from_artifact_id,to_artifact_id,relation_kind,receipt_id from orchestration.artifact_lineage
    where tenant_id=$1 and from_artifact_id=any($2::uuid[])`,
      [receipt.tenantId, [receipt.artifacts.intentId, receipt.artifacts.planId, receipt.artifacts.receiptId]],
    )
  ).rows;
  if (
    expected.some(
      (edge) =>
        !rows.some(
          (row) =>
            row.from_artifact_id === edge.from &&
            row.to_artifact_id === edge.to &&
            row.relation_kind === edge.relation &&
            row.receipt_id === (edge.receiptId ?? null),
        ),
    )
  )
    reject("Required artifact lineage is missing or bound to another receipt");
}

async function verifyInputs(artifacts: ArtifactLedger, intent: ContentLinkIntent): Promise<void> {
  const references = [
    intent.inputSnapshot.artifact,
    ...intent.operations.flatMap((operation) => operation.evidence.map((evidence) => evidence.manifest)),
  ];
  const unique = new Map(references.map((reference) => [reference.id, reference]));
  for (const reference of unique.values()) {
    const fetched = await artifacts.get(intent.context.tenantId, reference.id);
    if (
      fetched.record.artifactId !== reference.id ||
      fetched.record.digest !== reference.digest ||
      fetched.record.storageState !== "available" ||
      (fetched.json === undefined && fetched.text === undefined)
    )
      reject("Input snapshot or evidence manifest custody is missing or changed");
  }
}

export async function finishContentLedger(
  dependencies: LedgerDependencies,
  input: FinishInput,
): Promise<ContentLinkReceipt> {
  validateIntent(input.intent, input.plan.intentDigest);
  Plan.parse(input.plan);
  validateOperations(input.intent, input.plan.operations);
  validateOperations(input.intent, input.operations);
  validateFinalOutcomes(input.plan, input.operations);
  validateHead(input.intent, input.operations, input.head);
  if (
    input.plan.expectedKnowledgeHead !== input.intent.expectedKnowledgeHead ||
    input.head.before !== input.intent.expectedKnowledgeHead ||
    input.head.after < input.head.before
  )
    reject("Plan or receipt knowledge head differs from the intent");
  const row = (
    await dependencies.client.query<Row>(
      `select payload,preconditions,schema_version,tenant_id,proposed_by_attempt,mission_id,approval_state,policy_decision from orchestration.operation_intent
    where tenant_id=$1 and id=$2 and intent_type='content_link'`,
      [input.intent.context.tenantId, input.ids.operationIntentId],
    )
  ).rows[0];
  validateStoredIntent(row, {
    intent: input.intent,
    intentDigest: input.plan.intentDigest,
    executorVersion: input.executorVersion,
  });
  await verifyInputs(dependencies.artifacts, input.intent);
  const intentArtifact = await put(dependencies, {
    intent: input.intent,
    type: "content_link_intent",
    value: input.intent,
  });
  const planArtifact = await put(dependencies, { intent: input.intent, type: "content_link_plan", value: input.plan });
  const receipt: ContentLinkReceipt = {
    schemaVersion: "content-link-receipt.v1",
    receiptId: input.ids.receiptId,
    operationIntentId: input.ids.operationIntentId,
    tenantId: input.intent.context.tenantId,
    intentId: input.intent.intentId,
    intentDigest: input.plan.intentDigest,
    outcome: outcome(input.operations),
    head: input.head,
    operations: input.operations,
    intent: input.intent,
    artifacts: {
      intentId: intentArtifact.artifactId,
      planId: planArtifact.artifactId,
      receiptId: input.ids.receiptArtifactId,
    },
    duplicateOf: null,
    executedAt: new Date().toISOString(),
    executorVersion: input.executorVersion,
  };
  Receipt.parse(receipt);
  const receiptArtifact = await put(dependencies, {
    intent: input.intent,
    type: "content_link_receipt",
    value: receipt,
    id: input.ids.receiptArtifactId,
  });
  const summary = {
    intentDigest: input.plan.intentDigest,
    receiptArtifactId: receiptArtifact.artifactId,
    artifacts: { intent: intentArtifact, plan: planArtifact, receipt: receiptArtifact },
    head: input.head,
    operations: input.operations,
  };
  await dependencies.client.query(
    `insert into orchestration.operation_receipt
    (id,intent_id,executor_version,precondition_results,outcome,changes_summary,affected_refs)
    values($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7::jsonb)`,
    [
      receipt.receiptId,
      receipt.operationIntentId,
      input.executorVersion,
      json({ expectedKnowledgeHead: input.intent.expectedKnowledgeHead }),
      receipt.outcome,
      json(summary),
      json(input.operations.flatMap((operation) => operation.canonicalRefs)),
    ],
  );
  for (const edge of edges(receipt))
    if ((await dependencies.artifacts.link(dependencies.client, edge)) !== "written")
      reject("Required artifact lineage write was denied");
  await verifyEdges(dependencies.client, receipt);
  return receipt;
}

async function readArtifact(
  dependencies: LedgerDependencies,
  input: { tenantId: string; id: string; type: string; digest: string },
): Promise<unknown> {
  const fetched = await dependencies.artifacts.get(input.tenantId, input.id);
  validateStored(fetched.record, { id: input.id, type: input.type, digest: input.digest });
  if (fetched.json === undefined || digest(fetched.json) !== input.digest)
    reject("Registered artifact bytes are missing or changed");
  return fetched.json;
}

function validateReceiptRow(
  row: Row,
  receipt: ContentLinkReceipt,
  input: { tenantId: string; receiptId: string },
): void {
  const summary = row.changes_summary as ReceiptSummary;
  if (!summary.artifacts) reject("Receipt has no artifact custody census");
  const { intent: intentRecord, plan: planRecord, receipt: receiptRecord } = summary.artifacts;
  if (
    receipt.receiptId !== input.receiptId ||
    receipt.operationIntentId !== row.intent_id ||
    receipt.tenantId !== input.tenantId ||
    receipt.intentId !== receipt.intent.intentId ||
    receipt.intent.context.tenantId !== input.tenantId ||
    receipt.outcome !== row.outcome ||
    receipt.outcome !== outcome(receipt.operations) ||
    receipt.executorVersion !== row.executor_version ||
    receipt.intentDigest !== summary.intentDigest ||
    receipt.artifacts.receiptId !== receiptRecord.artifactId ||
    summary.receiptArtifactId !== receiptRecord.artifactId ||
    receipt.artifacts.intentId !== intentRecord.artifactId ||
    receipt.artifacts.planId !== planRecord.artifactId ||
    !equal(row.precondition_results ?? null, { expectedKnowledgeHead: receipt.intent.expectedKnowledgeHead }) ||
    !equal(receipt.head, summary.head) ||
    !equal(receipt.operations, summary.operations) ||
    !equal(
      receipt.operations.flatMap((operation) => operation.canonicalRefs),
      row.affected_refs,
    )
  )
    reject("Receipt row and immutable bytes disagree");
  validateStoredIntent(row, {
    intent: receipt.intent,
    intentDigest: receipt.intentDigest,
    executorVersion: receipt.executorVersion,
  });
}

async function validateRetainedDependencies(
  dependencies: LedgerDependencies,
  receipt: ContentLinkReceipt,
  records: { intent: ArtifactRecord; plan: ArtifactRecord },
): Promise<void> {
  const { intent: intentRecord, plan: planRecord } = records;
  const retainedIntent = await readArtifact(dependencies, {
    tenantId: receipt.tenantId,
    id: intentRecord.artifactId,
    type: "content_link_intent",
    digest: intentRecord.digest,
  });
  const retainedPlan = Plan.parse(
    await readArtifact(dependencies, {
      tenantId: receipt.tenantId,
      id: planRecord.artifactId,
      type: "content_link_plan",
      digest: planRecord.digest,
    }),
  ) as ContentLinkPlan;
  if (
    !equal(retainedIntent, receipt.intent) ||
    retainedPlan.intentDigest !== receipt.intentDigest ||
    retainedPlan.expectedKnowledgeHead !== receipt.head.before
  )
    reject("Receipt dependency content differs from its intent or head");
  validateOperations(receipt.intent, retainedPlan.operations);
  validateFinalOutcomes(retainedPlan, receipt.operations);
}

export async function reconcileContentLedger(
  dependencies: ReconciliationDependencies,
  input: { tenantId: string; receiptId: string },
): Promise<ContentLinkReceipt> {
  const row = (
    await dependencies.client.query<Row>(
      `select r.*,i.payload,i.preconditions,i.tenant_id,i.schema_version,i.proposed_by_attempt,i.mission_id,i.approval_state,i.policy_decision from orchestration.operation_receipt r
    join orchestration.operation_intent i on i.id=r.intent_id where i.tenant_id=$1 and r.id=$2 and i.intent_type='content_link'`,
      [input.tenantId, input.receiptId],
    )
  ).rows[0];
  if (!row) reject("Content receipt is missing for this tenant and intent type");
  const summary = row.changes_summary as ReceiptSummary;
  if (!summary.artifacts) reject("Receipt has no artifact custody census");
  const { receipt: receiptRecord } = summary.artifacts;
  const fetched = await readArtifact(dependencies, {
    tenantId: input.tenantId,
    id: receiptRecord.artifactId,
    type: "content_link_receipt",
    digest: receiptRecord.digest,
  });
  const receipt = Receipt.parse(fetched) as ContentLinkReceipt;
  validateIntent(receipt.intent, receipt.intentDigest);
  validateOperations(receipt.intent, receipt.operations);
  validateHead(receipt.intent, receipt.operations, receipt.head);
  validateReceiptRow(row, receipt, input);
  await validateRetainedDependencies(dependencies, receipt, summary.artifacts);
  await verifyInputs(dependencies.artifacts, receipt.intent);
  await verifyEdges(dependencies.client, receipt);
  await dependencies.reconcileRows(receipt);
  return receipt;
}

export async function findContentLedger(
  dependencies: ReconciliationDependencies,
  input: { intent: ContentLinkIntent; intentDigest: string; idempotencyKey: string },
): Promise<ContentLinkReceipt | undefined> {
  validateIntent(input.intent, input.intentDigest);
  const rows = (
    await dependencies.client.query<Row>(
      `select i.id,i.payload,i.intent_type,r.id receipt_id from orchestration.operation_intent i
    left join orchestration.operation_receipt r on r.intent_id=i.id where i.tenant_id=$1 and i.idempotency_key=$2`,
      [input.intent.context.tenantId, key(input.idempotencyKey)],
    )
  ).rows;
  if (!rows.length) return undefined;
  if (
    rows.length !== 1 ||
    rows[0]!.intent_type !== "content_link" ||
    !equal(rows[0]!.payload, input.intent) ||
    !rows[0]!.receipt_id
  )
    reject("Idempotency key is incomplete or belongs to another full intent");
  const receipt = await reconcileContentLedger(dependencies, {
    tenantId: input.intent.context.tenantId,
    receiptId: String(rows[0]!.receipt_id),
  });
  if (receipt.intentDigest !== input.intentDigest) reject("Duplicate receipt intent digest differs");
  return { ...receipt, duplicateOf: receipt.receiptId };
}
