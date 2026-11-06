import { z } from "zod";
import {
  ManagedSourceDiscoveryRequestSchema,
  ImportedSourceDiscoveryReceiptSchema,
  SourceDiscoveryAttemptSchema,
  SourceDiscoveryAttemptReadSchema,
  SourceDiscoverySelectionRequestSchema,
  SourceDiscoverySelectionReceiptSchema,
} from "@aiengineer/knowledge-contracts";
import { getPage, materializeScope, searchWorkspace } from "@aiengineer/knowledge-db";
import { defineOperation, OperationRegistry, type OperationDefinition } from "../operations/define.js";
import type { KnowledgeServices } from "./context.js";
import {
  CheckpointCommitRequestSchema,
  CheckpointRestoreRequestSchema,
  CheckpointScopeSchema,
  CheckpointReceiptSchema,
  CheckpointRestoreResultSchema,
  CheckpointTombstoneRequestSchema,
} from "@aiengineer/knowledge-contracts";
import { KnowledgeCheckpointHarnessRequestSchema } from "./checkpoints-harness.js";

const defineKnowledgeOperation = <TInput extends z.ZodObject, TOutput extends z.ZodType>(
  definition: OperationDefinition<TInput, TOutput, KnowledgeServices>,
) => defineOperation(definition);

/**
 * The knowledge executor's operation catalog: schema_* read the pinned workspace, db_* read the
 * database under bounded roles, ingest_* run the deterministic ingestion executor, artifact_get
 * serves ledger artifacts. Descriptions carry the START_HERE navigation rule for MCP clients.
 */
const NAVIGATE = "Search before reading; read the domain page before a relation page; ≤4 reads to an operation.";
const tenantId = z.string().uuid().optional().describe("Tenant; defaults to the executor's configured tenant.");
const Any = z.unknown();
const tenantOf = (services: KnowledgeServices, requested: string | undefined): string => {
  if (requested !== undefined && requested !== services.config.defaultTenantId)
    throw new Error("EVIDENCE_NOT_AUTHORIZED");
  return services.config.defaultTenantId;
};
const authorizeIntent = (services: KnowledgeServices, intent: Record<string, unknown>): Record<string, unknown> => {
  const context = intent.context as { tenantId?: unknown } | undefined;
  if (context?.tenantId !== services.config.defaultTenantId) throw new Error("EVIDENCE_NOT_AUTHORIZED");
  return intent;
};

export const schemaSearch = defineKnowledgeOperation({
  name: "schema_search",
  title: "Search the schema workspace",
  description: `Find tables, functions, domains, tasks, queries, and terms in the pinned schema workspace. Ranked: exact alias > name > tokens. ${NAVIGATE}`,
  input: z.object({
    query: z.string().min(1).max(200),
    kinds: z.array(z.string()).optional(),
    domain: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  output: Any,
  cli: { command: ["schema", "search"], positional: ["query"] },
  run: async (input, services) =>
    searchWorkspace(services.workspace, input.query, {
      ...(input.kinds ? { kinds: input.kinds } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    }),
});

export const schemaGet = defineKnowledgeOperation({
  name: "schema_get",
  title: "Read one workspace page",
  description: `Return a workspace page by id (rel:<schema>.<name>, dom:<slug>, task:<slug>, fn:<schema>.<name>) or relative path, capped in size. ${NAVIGATE}`,
  input: z.object({ id: z.string().min(1).max(300), maxBytes: z.number().int().min(256).max(256_000).optional() }),
  output: Any,
  cli: { command: ["schema", "get"], positional: ["id"] },
  run: async (input, services) =>
    getPage(services.workspace, input.id, input.maxBytes ? { maxBytes: input.maxBytes } : {}),
});

export const schemaManifest = defineKnowledgeOperation({
  name: "schema_manifest",
  title: "Workspace manifest and head check",
  description:
    "Return the workspace manifest (fingerprint, migration head, scope) plus the connected database's migration head and whether they match.",
  input: z.object({}),
  output: Any,
  cli: { command: ["schema", "manifest"] },
  gate: (output) =>
    (output as { headMatches: boolean }).headMatches
      ? undefined
      : "workspace migration head ≠ database head (HEAD_MISMATCH)",
  run: async (_input, services) => {
    const databaseHead = await services.reads.databaseHead();
    return {
      manifest: services.workspace.manifest,
      workspaceDir: services.workspace.dir,
      workspaceHead: services.workspace.migrationHead,
      databaseHead,
      headMatches: databaseHead === services.workspace.migrationHead,
      catalogEntries:
        services.workspace.catalog?.entries.map((entry) => ({
          name: entry.name,
          role: entry.role,
          cost: entry.cost_class,
          params: entry.paramOrder,
        })) ?? [],
    };
  },
});

export const schemaMaterialize = defineKnowledgeOperation({
  name: "schema_materialize",
  title: "Materialize a scoped workspace bundle",
  description:
    "Copy a scoped workspace bundle (workspace-scopes/<scope>.json) into an empty directory, via the db-contract CLI when present, else an in-process filter.",
  input: z.object({ scope: z.string().min(1).max(120), outDir: z.string().min(1).max(1000) }),
  output: Any,
  cli: { command: ["schema", "materialize"], positional: ["scope", "outDir"] },
  run: async (input, services) => materializeScope(services.workspace, input),
});

export const dbHead = defineKnowledgeOperation({
  name: "db_head",
  title: "Tenant knowledge head",
  description:
    "Return the tenant's knowledge_seq (the head every snapshot and ingestion intent cites) and the database migration head.",
  input: z.object({ tenantId }),
  output: Any,
  cli: { command: ["db", "head"] },
  run: async (input, services) => ({
    tenantId: tenantOf(services, input.tenantId),
    knowledgeHead: await services.reads.head(tenantOf(services, input.tenantId)),
    migrationHead: await services.reads.databaseHead(),
    workspaceHead: services.workspace.migrationHead,
  }),
});

export const dbReadIntent = defineKnowledgeOperation({
  name: "db_read_intent",
  title: "Run a knowledge-read-intent.v1",
  description:
    "Execute named catalog queries in one read-only transaction at one knowledge head and return a knowledge-read-snapshot.v1 with per-op and snapshot digests. persist:true stores intent+snapshot as artifacts.",
  input: z.object({ intent: z.record(z.string(), z.unknown()), persist: z.boolean().default(false) }),
  output: Any,
  cli: { command: ["db", "read-intent"], positional: ["intent"], jsonFiles: ["intent"] },
  gate: (output) => {
    const ops = (output as { operations: { status: string; opId: string }[] }).operations;
    const failed = ops.filter((op) => op.status === "error");
    return failed.length ? `operations failed: ${failed.map((op) => op.opId).join(", ")}` : undefined;
  },
  run: async (input, services) =>
    services.reads.runIntent(authorizeIntent(services, input.intent), { persist: input.persist }),
});

export const dbSqlReadonly = defineKnowledgeOperation({
  name: "db_sql_readonly",
  title: "Guarded read-only SQL",
  description:
    "Run ONE SELECT/WITH statement as pipeline_agent in a read-only transaction with a statement timeout and row cap. No writes, no set_config. Prefer catalog queries (db_read_intent) when one fits.",
  input: z.object({
    sql: z.string().min(1).max(20_000),
    params: z.array(z.unknown()).max(32).optional(),
    limit: z.number().int().min(1).max(2000).optional(),
    statementTimeoutMs: z.number().int().min(100).max(60_000).optional(),
    tenantId,
  }),
  output: Any,
  cli: { command: ["db", "sql"], positional: ["sql"] },
  run: async (input, services) =>
    services.reads.sqlReadonly({
      tenantId: tenantOf(services, input.tenantId),
      sql: input.sql,
      ...(input.params ? { params: input.params } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
      ...(input.statementTimeoutMs ? { statementTimeoutMs: input.statementTimeoutMs } : {}),
    }),
});

export const dbExplain = defineKnowledgeOperation({
  name: "db_explain",
  title: "EXPLAIN a read-only statement",
  description:
    "Return the JSON query plan (no ANALYZE) for one SELECT/WITH statement as pipeline_agent. Use it to check cost before running a heavy read.",
  input: z.object({ sql: z.string().min(1).max(20_000), params: z.array(z.unknown()).max(32).optional(), tenantId }),
  output: Any,
  cli: { command: ["db", "explain"], positional: ["sql"] },
  run: async (input, services) =>
    services.reads.explain({
      tenantId: tenantOf(services, input.tenantId),
      sql: input.sql,
      ...(input.params ? { params: input.params } : {}),
    }),
});

const expectedHead = z.number().int().nonnegative().optional().describe("Overrides intent.expectedKnowledgeHead.");
const planGate = (output: unknown): string | undefined => {
  const plan = output as { plannedOutcome: string; errors: { code: string; message: string }[] };
  return plan.plannedOutcome === "rejected"
    ? `plan rejected: ${plan.errors.map((error) => `${error.code} ${error.message}`).join("; ")}`
    : undefined;
};

export const ingestPlan = defineKnowledgeOperation({
  name: "ingest_plan",
  title: "Plan an ingestion intent (dry run)",
  description:
    "Validate a knowledge-ingestion-intent.v1 against vocabularies, rules, evidence, and the current head; return a knowledge-ingestion-plan.v1 with per-proposal outcomes. Writes nothing.",
  input: z.object({ intent: z.record(z.string(), z.unknown()), expectedHead }),
  output: Any,
  cli: { command: ["ingest", "plan"], positional: ["intent"], jsonFiles: ["intent"] },
  gate: planGate,
  run: async (input, services) =>
    services.ingestion.plan(
      authorizeIntent(services, input.intent),
      input.expectedHead === undefined ? {} : { expectedHead: input.expectedHead },
    ),
});

export const ingestApply = defineKnowledgeOperation({
  name: "ingest_apply",
  title: "Apply an ingestion intent",
  description:
    "Plan, then apply admitted proposals in one transaction as executor_service via temporal.begin_batch/assert_*/commit_batch; return a knowledge-ingestion-receipt.v1. Same bytes ⇒ same receipt (duplicateOf). REBASE_REQUIRED when the head moved.",
  input: z.object({ intent: z.record(z.string(), z.unknown()), expectedHead }),
  output: Any,
  cli: { command: ["ingest", "apply"], positional: ["intent"], jsonFiles: ["intent"] },
  gate: (output) => ((output as { outcome: string }).outcome === "rejected" ? "receipt outcome rejected" : undefined),
  run: async (input, services) =>
    services.ingestion.apply(
      authorizeIntent(services, input.intent),
      input.expectedHead === undefined ? {} : { expectedHead: input.expectedHead },
    ),
});

export const ingestReceipt = defineKnowledgeOperation({
  name: "ingest_receipt",
  title: "Fetch an ingestion receipt",
  description: "Return the stored knowledge-ingestion-receipt.v1 for a receiptId (orchestration.operation_receipt.id).",
  input: z.object({ receiptId: z.string().uuid(), tenantId }),
  output: Any,
  cli: { command: ["ingest", "receipt"], positional: ["receiptId"] },
  run: async (input, services) => services.ingestion.receipt(input.receiptId, tenantOf(services, input.tenantId)),
});

export const artifactGet = defineKnowledgeOperation({
  name: "artifact_get",
  title: "Fetch a ledger artifact",
  description:
    "Return an orchestration.artifact row (intent, snapshot, plan, receipt, report) with its JSON or text body when the bytes are available.",
  input: z.object({ artifactId: z.string().uuid(), tenantId }),
  output: Any,
  cli: { command: ["artifact", "get"], positional: ["artifactId"] },
  run: async (input, services) => services.artifacts.get(tenantOf(services, input.tenantId), input.artifactId),
});

export const sourceDiscover = defineKnowledgeOperation({
  name: "source_discover",
  title: "Discover sources with durable provider accounting",
  description:
    "Dispatch a configured search provider after durable request registration; preserve output before returning its receipt. Snippets remain untrusted discovery material. Reuse the idempotency key to recover the original attempt.",
  input: z.object({ request: ManagedSourceDiscoveryRequestSchema, tenantId }),
  output: SourceDiscoveryAttemptSchema,
  cli: { command: ["source", "discover"], positional: ["request"], jsonFiles: ["request"] },
  run: async (input, services) => {
    const tenant = tenantOf(services, input.tenantId);
    if (!services.sourceDiscovery) throw new Error("SOURCE_DISCOVERY_REMOTE_CUSTODY_REQUIRED");
    return services.sourceDiscovery.discoverManaged(tenant, input.request);
  },
});

export const sourceImport = defineKnowledgeOperation({
  name: "source_import",
  title: "Preserve an external discovery receipt",
  description:
    "Account for externally executed provider attempts using already preserved receipt artifacts. Imported metadata is self-reported and never gains managed-provider authority.",
  input: z.object({ receipt: ImportedSourceDiscoveryReceiptSchema, tenantId }),
  output: SourceDiscoveryAttemptSchema,
  cli: { command: ["source", "import"], positional: ["receipt"], jsonFiles: ["receipt"] },
  run: async (input, services) => {
    const tenant = tenantOf(services, input.tenantId);
    if (!services.sourceDiscovery) throw new Error("SOURCE_DISCOVERY_REMOTE_CUSTODY_REQUIRED");
    return services.sourceDiscovery.importExternal(tenant, input.receipt);
  },
});

export const sourceAttempt = defineKnowledgeOperation({
  name: "source_attempt",
  title: "Read a source discovery attempt",
  description:
    "Read the original source attempt and its provenance trust. Terminal leads require verified remote receipt custody. An unfinished attempt returns no leads and must be reconciled before any new provider dispatch.",
  input: z.object({
    attemptId: z.uuid(),
    tenantId,
    offset: z.int().nonnegative().optional(),
    limit: z.int().min(1).max(200).optional(),
  }),
  output: SourceDiscoveryAttemptReadSchema,
  cli: { command: ["source", "attempt"], positional: ["attemptId"] },
  run: async (input, services) => {
    const tenant = tenantOf(services, input.tenantId);
    if (!services.sourceDiscovery) throw new Error("SOURCE_DISCOVERY_REMOTE_CUSTODY_REQUIRED");
    return services.sourceDiscovery.readAttempt(tenant, input.attemptId, {
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  },
});

export const sourceReconcile = defineKnowledgeOperation({
  name: "source_reconcile",
  title: "Reconcile an interrupted source attempt",
  description:
    "Recover an original managed attempt from verified completion custody under a fresh fence. Does not call the provider again. Refuses a live dispatch lease; missing completion custody yields an explicit uncertain outcome.",
  input: z.object({ attemptId: z.uuid(), tenantId }),
  output: SourceDiscoveryAttemptSchema,
  cli: { command: ["source", "reconcile"], positional: ["attemptId"] },
  run: async (input, services) => {
    const tenant = tenantOf(services, input.tenantId);
    if (!services.sourceDiscovery) throw new Error("SOURCE_DISCOVERY_REMOTE_CUSTODY_REQUIRED");
    return services.sourceDiscovery.reconcileManaged(tenant, input.attemptId);
  },
});

export const sourceSelect = defineKnowledgeOperation({
  name: "source_select",
  title: "Record source lead selections",
  description:
    "Preserve explicit selected, omitted or duplicate lead decisions and reasons in an immutable selection receipt. Does not rewrite provider output, admit evidence or authorize publication.",
  input: z.object({ request: SourceDiscoverySelectionRequestSchema, tenantId }),
  output: SourceDiscoverySelectionReceiptSchema,
  cli: { command: ["source", "select"], positional: ["request"], jsonFiles: ["request"] },
  run: async (input, services) => {
    const tenant = tenantOf(services, input.tenantId);
    if (!services.sourceDiscovery) throw new Error("SOURCE_DISCOVERY_REMOTE_CUSTODY_REQUIRED");
    return services.sourceDiscovery.selectResults(tenant, input.request);
  },
});

function checkpoints(services: KnowledgeServices) {
  if (!services.checkpoints) throw new Error("CHECKPOINT_REMOTE_CUSTODY_REQUIRED");
  return services.checkpoints;
}
export const checkpointOperations = [
  defineKnowledgeOperation({
    name: "checkpoint_harness",
    title: "Persist or restore scoped harness work",
    description:
      "Host adapter for approved files, executor state and tool observations. Returns a verified durable receipt; continuation remains blocked on unresolved owner work.",
    input: z.object({ request: KnowledgeCheckpointHarnessRequestSchema }),
    output: Any,
    cli: { command: ["checkpoint", "harness"], positional: ["request"], jsonFiles: ["request"] },
    run: async (input, services) => {
      if (!services.checkpointHarness) throw new Error("CHECKPOINT_REMOTE_CUSTODY_REQUIRED");
      return services.checkpointHarness.run(input.request);
    },
  }),
  defineKnowledgeOperation({
    name: "checkpoint_commit",
    title: "Commit an immutable scoped checkpoint",
    description: "Verify complete remote artifact closure and atomically advance the expected scoped checkpoint head.",
    input: z.object({ request: CheckpointCommitRequestSchema, tenantId }),
    output: CheckpointReceiptSchema,
    cli: { command: ["checkpoint", "commit"], positional: ["request"], jsonFiles: ["request"] },
    run: async (input, services) => checkpoints(services).commit(tenantOf(services, input.tenantId), input.request),
  }),
  defineKnowledgeOperation({
    name: "checkpoint_head",
    title: "Read the scoped checkpoint head",
    description: "Read the latest committed receipt for an exact standalone session scope.",
    input: z.object({ scope: CheckpointScopeSchema, tenantId }),
    output: CheckpointReceiptSchema.nullable(),
    cli: { command: ["checkpoint", "head"], positional: ["scope"], jsonFiles: ["scope"] },
    run: async (input, services) =>
      (await checkpoints(services).head(tenantOf(services, input.tenantId), input.scope)) ?? null,
  }),
  ...(["read", "restore"] as const).map((action) =>
    defineKnowledgeOperation({
      name: `checkpoint_${action}`,
      title: `${action === "read" ? "Read" : "Restore"} a checkpoint`,
      description:
        action === "read"
          ? "Verify archived bytes and manifest without resuming work."
          : "Verify checkpoint closure and reconcile pending work through its existing owner before continuation.",
      input: z.object({ request: CheckpointRestoreRequestSchema, tenantId }),
      output: CheckpointRestoreResultSchema,
      cli: { command: ["checkpoint", action], positional: ["request"], jsonFiles: ["request"] },
      run: async (input, services) => checkpoints(services)[action](tenantOf(services, input.tenantId), input.request),
    }),
  ),
  defineKnowledgeOperation({
    name: "checkpoint_tombstone",
    title: "Retire an unreferenced artifact",
    description:
      "Apply reference-aware retirement after the canonical minimum orphan age; referenced artifacts cannot be retired.",
    input: z.object({ request: CheckpointTombstoneRequestSchema, tenantId }),
    output: Any,
    cli: { command: ["checkpoint", "tombstone"], positional: ["request"], jsonFiles: ["request"] },
    run: async (input, services) => {
      await checkpoints(services).tombstone(tenantOf(services, input.tenantId), input.request);
      return { retired: true };
    },
  }),
];

export const knowledgeOperations = new OperationRegistry<KnowledgeServices>([
  defineKnowledgeOperation({
    name: "source_prepare_captured",
    title: "Prepare a retained source",
    description:
      "Convert and chunk exact remotely retained native text captures through durable preparation. Requires a trusted preparation host. Returns canonical receipts and pending independent review; does not publish.",
    input: z.strictObject({
      captureId: z.string().min(1).max(255),
      title: z.string().min(1).max(500),
      version: z.string().min(1).max(100),
    }),
    output: Any,
    cli: { command: ["source", "prepare-captured"], positional: ["captureId"] },
    run: async (input, services) => {
      if (!services.prepareCapturedSource) throw new Error("PREPARATION_HOST_REQUIRED");
      return services.prepareCapturedSource(input);
    },
  }),
  ...checkpointOperations,
  schemaSearch,
  schemaGet,
  schemaManifest,
  schemaMaterialize,
  dbHead,
  dbReadIntent,
  dbSqlReadonly,
  dbExplain,
  ingestPlan,
  ingestApply,
  ingestReceipt,
  artifactGet,
  sourceDiscover,
  sourceImport,
  sourceAttempt,
  sourceReconcile,
  sourceSelect,
]);
