// The Knowledge Services operation catalog (FINAL-LAYOUT §4.5), classified per transport.
// operation-catalog.test.ts derives the operation list from the production catalogs
// (operations/surface.ts, the verification catalogs, API routes, MCP registrations, the `ks`
// command table in apps/cli/src/ks-commands.ts and the executor registry) and requires every
// operation here to be exposed on API, MCP and CLI or excluded with a reason. CLI bindings are
// `ks` command names without the binary (`knowledge store create`, `verify citations`).
//
// admission (server profile):
//   admitted — a production worker or API-owned kind, or a read/control host composes whenever the
//              server profile has its database;
//   gated    — executable only when host composes an optional port; `requires` names it (verification
//              admission and read flags, Storage custody, operator reconciliation authority, the internal
//              drift queue, callback signing keys, the demo bundle port);
//   declared — contract vocabulary only; every bound surface fails closed with CAPABILITY_NOT_ADMITTED;
//   executor — served by the verification executor (its own MCP/CLI and store mode), not by the ks api or mcp;
//              the verification intent-pipeline rows also name the `ks` command that runs them on the local
//              profile (5C, `executor.ks`).
// Parity never promotes a declared operation: declared rows may only use `failsClosed` bindings.
// transportState() derives the per-profile, per-transport state: executable, executable when composed,
// declared (fails closed), excluded, executor only, server only, or local profile. The local host profile
// composes only the verification intent pipeline over the executor's file store, so every platform row is
// server only there; the 16 intent-pipeline rows run through `ks` on the local profile and stay executor only
// on ks api/mcp until 5D3; the registry rows stay executor only until 5D1/5D2. Host derives local
// admission from its capability matrix.
import type { OperationKind } from "@aiengineer/knowledge-contracts";

export type Group = "operations" | "knowledge" | "verify" | "db" | "system";
export type Admission = "admitted" | "gated" | "declared" | "executor";
export type Binding =
  | { readonly on: readonly string[] }
  | { readonly failsClosed: readonly string[] }
  | { readonly excluded: string };

export interface CatalogOperation {
  readonly id: string;
  readonly group: Group;
  readonly effect: "mutation" | "read" | "control";
  readonly kind?: OperationKind;
  readonly admission: Admission;
  readonly api: Binding;
  readonly mcp: Binding;
  readonly cli: Binding;
  /** Optional configuration or authority host must compose before the operation is executable. */
  readonly requires?: string;
  /**
   * Executor surfaces: tool name on the executor MCP server and executor CLI command; for the verification intent
   * pipeline, the `ks` command that runs it on the local host profile (5C).
   */
  readonly executor?: { readonly mcp: string; readonly cli?: string; readonly ks?: string };
}

const on = (...names: string[]): Binding => ({ on: names });
const failsClosed = (...names: string[]): Binding => ({ failsClosed: names });
const excluded = (reason: string): Binding => ({ excluded: reason });

const NO_CLI = excluded("no CLI command yet; recorded for the Unit 5 `ks` CLI");
const NO_MCP = excluded("no MCP tool yet; recorded for the Unit 5 MCP tool groups");
const DECISION_AUTHORITY = excluded("reviewer decision; agents propose and reviewers decide over HTTP or the CLI");
const PUBLICATION_AUTHORITY = excluded(
  "publication changes are operator actions; FORBIDDEN_MCP_CAPABILITIES excludes publication.publish and publication.approve",
);
const BY_ID = excluded("agents read resources by id; tenant-wide listings are an HTTP operator surface");
const DECLARED_API = (route: string) => failsClosed(route);
const EXECUTOR = "executor-only surface; Unit 5 folds the verification executor into ks api/mcp/cli";

// ── Durable knowledge operations (operations/surface.ts kinds) ──────────────────────────
const knowledgeMutations: readonly CatalogOperation[] = [
  {
    id: "knowledge.source_discovery",
    group: "knowledge",
    effect: "mutation",
    kind: "source_discovery",
    admission: "admitted",
    api: on("POST /v1/:sourceAction"),
    mcp: on("knowledge_source_discover"),
    cli: on("knowledge source discover"),
  },
  {
    id: "knowledge.source_resolution",
    group: "knowledge",
    effect: "mutation",
    kind: "source_resolution",
    admission: "admitted",
    api: on("POST /v1/:sourceAction"),
    mcp: on("knowledge_source_resolve"),
    cli: NO_CLI,
  },
  {
    id: "knowledge.capture",
    group: "knowledge",
    effect: "mutation",
    kind: "capture",
    admission: "admitted",
    api: on("POST /v1/captures"),
    mcp: on("knowledge_source_fetch"),
    cli: on("knowledge source fetch"),
  },
  {
    id: "knowledge.capture_inspection",
    group: "knowledge",
    effect: "mutation",
    kind: "capture_inspection",
    admission: "declared",
    api: DECLARED_API("POST /v1/captures/:target"),
    mcp: failsClosed("knowledge_source_inspect_capture"),
    cli: failsClosed("knowledge source inspect"),
  },
  {
    id: "knowledge.capture_comparison",
    group: "knowledge",
    effect: "mutation",
    kind: "capture_comparison",
    admission: "declared",
    api: DECLARED_API("POST /v1/captures/:target"),
    mcp: failsClosed("knowledge_source_compare_captures"),
    cli: excluded("declared only; no CLI binding"),
  },
  {
    id: "knowledge.source_vetting",
    group: "knowledge",
    effect: "mutation",
    kind: "source_vetting",
    admission: "admitted",
    api: on("POST /v1/captures/:target"),
    mcp: on("knowledge_source_vet"),
    cli: on("knowledge source vet"),
  },
  {
    id: "knowledge.vector_store_create",
    group: "knowledge",
    effect: "mutation",
    kind: "vector_store_create",
    admission: "admitted",
    api: on("POST /v1/vector-stores"),
    mcp: on("knowledge_store_create"),
    cli: on("knowledge store create"),
  },
  {
    id: "knowledge.vector_store_documents",
    group: "knowledge",
    effect: "mutation",
    kind: "vector_store_documents",
    admission: "admitted",
    api: on("POST /v1/vector-stores/:id/documents"),
    mcp: on("knowledge_store_add_documents"),
    cli: on("knowledge store add-documents"),
  },
  {
    id: "knowledge.vector_store_ingestion",
    group: "knowledge",
    effect: "mutation",
    kind: "vector_store_ingestion",
    admission: "admitted",
    api: on("POST /v1/vector-stores/:id/ingestion-jobs", "POST /v1/a2a/tasks"),
    mcp: excluded("ingestion jobs start over HTTP or A2A; MCP reads their status (knowledge_store_status)"),
    cli: NO_CLI,
  },
  {
    id: "knowledge.vector_store_search",
    group: "knowledge",
    effect: "mutation",
    kind: "vector_store_search",
    admission: "declared",
    api: DECLARED_API("POST /v1/vector-stores/:target"),
    mcp: failsClosed("knowledge_store_search"),
    cli: failsClosed("knowledge store search"),
  },
  {
    id: "knowledge.vector_store_evaluation",
    group: "knowledge",
    effect: "mutation",
    kind: "vector_store_evaluation",
    admission: "admitted",
    api: on("POST /v1/vector-stores/:target"),
    mcp: on("knowledge_store_evaluate"),
    cli: on("knowledge store evaluate"),
  },
  {
    id: "knowledge.document",
    group: "knowledge",
    effect: "mutation",
    kind: "document",
    admission: "declared",
    api: DECLARED_API("POST /v1/documents"),
    mcp: excluded("declared only; no MCP binding"),
    cli: excluded("declared only; no CLI binding"),
  },
  {
    id: "knowledge.document_version",
    group: "knowledge",
    effect: "mutation",
    kind: "document_version",
    admission: "declared",
    api: DECLARED_API("POST /v1/document-versions"),
    mcp: excluded("declared only; no MCP binding"),
    cli: excluded("declared only; no CLI binding"),
  },
  {
    id: "knowledge.representation",
    group: "knowledge",
    effect: "mutation",
    kind: "representation",
    admission: "declared",
    api: DECLARED_API("POST /v1/representations"),
    mcp: excluded("declared only; no MCP binding"),
    cli: excluded("declared only; no CLI binding"),
  },
  {
    id: "knowledge.transformation",
    group: "knowledge",
    effect: "mutation",
    kind: "transformation",
    admission: "admitted",
    api: on("POST /v1/transformations", "POST /v1/a2a/tasks"),
    mcp: on("knowledge_document_convert"),
    cli: on("knowledge document convert"),
  },
  {
    id: "knowledge.representation_inspection",
    group: "knowledge",
    effect: "mutation",
    kind: "representation_inspection",
    admission: "declared",
    api: DECLARED_API("POST /v1/representations/:target"),
    mcp: failsClosed("knowledge_document_inspect"),
    cli: failsClosed("knowledge document inspect"),
  },
  {
    id: "knowledge.representation_comparison",
    group: "knowledge",
    effect: "mutation",
    kind: "representation_comparison",
    admission: "admitted",
    api: on("POST /v1/representations/:target"),
    mcp: on("knowledge_document_compare"),
    cli: on("knowledge document compare"),
  },
  {
    id: "knowledge.representation_decision",
    group: "knowledge",
    effect: "mutation",
    kind: "representation_decision",
    admission: "admitted",
    api: on("POST /v1/representations/:target"),
    mcp: DECISION_AUTHORITY,
    cli: NO_CLI,
  },
  {
    id: "knowledge.chunk_preview",
    group: "knowledge",
    effect: "mutation",
    kind: "chunk_preview",
    admission: "admitted",
    api: on("POST /v1/chunk-previews"),
    mcp: on("knowledge_chunk_preview"),
    cli: on("knowledge chunk preview"),
  },
  {
    id: "knowledge.chunk_comparison",
    group: "knowledge",
    effect: "mutation",
    kind: "chunk_comparison",
    admission: "admitted",
    api: on("POST /v1/chunk-comparisons"),
    mcp: on("knowledge_chunk_compare"),
    cli: NO_CLI,
  },
  {
    id: "knowledge.chunk_set",
    group: "knowledge",
    effect: "mutation",
    kind: "chunk_set",
    admission: "admitted",
    api: on("POST /v1/chunk-sets"),
    mcp: on("knowledge_chunk_build"),
    cli: on("knowledge chunk build"),
  },
  {
    id: "knowledge.chunk_set_inspection",
    group: "knowledge",
    effect: "mutation",
    kind: "chunk_set_inspection",
    admission: "declared",
    api: DECLARED_API("POST /v1/chunk-sets/:target"),
    mcp: failsClosed("knowledge_chunk_inspect"),
    cli: failsClosed("knowledge chunk inspect"),
  },
  {
    id: "knowledge.promotion_proposal",
    group: "knowledge",
    effect: "mutation",
    kind: "promotion_proposal",
    admission: "admitted",
    api: on("POST /v1/promotion-proposals"),
    mcp: on(
      "knowledge_promotion_propose",
      "knowledge_promotion_propose_domain_mapping",
      "knowledge_promotion_propose_claims",
      "knowledge_promotion_propose_entity_links",
    ),
    cli: on("knowledge promotion propose"),
  },
  {
    id: "knowledge.promotion_decision",
    group: "knowledge",
    effect: "mutation",
    kind: "promotion_decision",
    admission: "admitted",
    api: on("POST /v1/promotion-decisions"),
    mcp: DECISION_AUTHORITY,
    cli: on("knowledge promotion review"),
  },
  {
    id: "knowledge.embedding_run",
    group: "knowledge",
    effect: "mutation",
    kind: "embedding_run",
    admission: "admitted",
    api: on("POST /v1/embedding-runs"),
    mcp: on("knowledge_embed_run"),
    cli: on("knowledge embed run"),
  },
  {
    id: "knowledge.space_publication",
    group: "knowledge",
    effect: "mutation",
    kind: "space_publication",
    admission: "admitted",
    api: on("POST /v1/space-publications"),
    mcp: PUBLICATION_AUTHORITY,
    cli: on("knowledge space publish"),
  },
  {
    id: "knowledge.publication_verification",
    group: "knowledge",
    effect: "mutation",
    kind: "publication_verification",
    admission: "admitted",
    api: on("POST /v1/space-publications/:target"),
    mcp: PUBLICATION_AUTHORITY,
    cli: on("knowledge embed verify"),
  },
  {
    id: "knowledge.publication_rollback",
    group: "knowledge",
    effect: "mutation",
    kind: "publication_rollback",
    admission: "admitted",
    api: on("POST /v1/space-publications/:target"),
    mcp: PUBLICATION_AUTHORITY,
    cli: on("knowledge space rollback"),
  },
  {
    id: "knowledge.retrieval_run",
    group: "knowledge",
    effect: "mutation",
    kind: "retrieval_run",
    admission: "admitted",
    api: on("POST /v1/retrieval-runs", "POST /v1/a2a/tasks"),
    mcp: on("knowledge_retrieve_search"),
    cli: on("knowledge retrieve search"),
    requires: "AI Gateway embedding configuration for the canonical retrieval executor",
  },
  {
    id: "knowledge.evidence_packet",
    group: "knowledge",
    effect: "mutation",
    kind: "evidence_packet",
    admission: "admitted",
    api: on("POST /v1/a2a/tasks"),
    mcp: on("knowledge_retrieve_build_packet"),
    cli: NO_CLI,
  },
  {
    id: "knowledge.evaluation_dataset",
    group: "knowledge",
    effect: "mutation",
    kind: "evaluation_dataset",
    admission: "admitted",
    api: on("POST /v1/eval-datasets"),
    mcp: on("knowledge_eval_generate"),
    cli: on("knowledge eval generate"),
  },
  {
    id: "knowledge.experiment",
    group: "knowledge",
    effect: "mutation",
    kind: "experiment",
    admission: "admitted",
    api: on("POST /v1/experiments"),
    mcp: on("knowledge_eval_compare"),
    cli: on("knowledge eval compare"),
  },
  {
    id: "knowledge.evaluation_run",
    group: "knowledge",
    effect: "mutation",
    kind: "evaluation_run",
    admission: "admitted",
    api: on("POST /v1/eval-runs"),
    mcp: on("knowledge_eval_run"),
    cli: on("knowledge eval run"),
  },
  {
    id: "knowledge.review",
    group: "knowledge",
    effect: "mutation",
    kind: "review",
    admission: "declared",
    api: DECLARED_API("POST /v1/reviews"),
    mcp: failsClosed("knowledge_document_request_review"),
    cli: excluded("declared only; no CLI binding"),
  },
  {
    id: "knowledge.review_decision",
    group: "knowledge",
    effect: "mutation",
    kind: "review_decision",
    admission: "admitted",
    api: on("POST /v1/review-decisions"),
    mcp: DECISION_AUTHORITY,
    cli: NO_CLI,
  },
];

// ── Verification mutations (the `verify` group; verificationOwnedOperationKinds) ─────────
const verifyMutation = (kind: OperationKind, route: string, tool: string, command: string): CatalogOperation => ({
  id: `verify.${kind.replace(/^verification_/u, "")}`,
  group: "verify",
  effect: "mutation",
  kind,
  admission: "gated",
  api: on(route),
  mcp: on(tool),
  cli: on(command),
  requires: "verification configured and its request admission gate",
});
const verifyMutations: readonly CatalogOperation[] = [
  {
    ...verifyMutation(
      "verification_capture",
      "POST /v1/verification/captures",
      "verify_benchmark_capture",
      "verify benchmark capture",
    ),
    api: on("POST /v1/verification/captures", "POST /v1/verification/benchmark-capture-profiles/:profileName/captures"),
  },
  verifyMutation(
    "verification_parse_artifact",
    "POST /v1/verification/artifacts::parse",
    "verify_artifact_parse",
    "verify artifact parse",
  ),
  verifyMutation(
    "verification_extraction",
    "POST /v1/verification/extractions::verify",
    "verify_extract",
    "verify extract",
  ),
  verifyMutation(
    "verification_structured_extraction",
    "POST /v1/verification/extractions",
    "verify_extraction_run",
    "verify extraction run",
  ),
  verifyMutation(
    "verification_replay",
    "POST /v1/verification/runs/:runId(^[^:]+)::replay",
    "verify_bundle_replay",
    "verify bundle replay",
  ),
  verifyMutation(
    "verification_benchmark",
    "POST /v1/verification/benchmarks::run",
    "verify_benchmark_run",
    "verify benchmark run",
  ),
  verifyMutation(
    "verification_benchmark_compare",
    "POST /v1/verification/benchmarks::compare",
    "verify_benchmark_compare",
    "verify benchmark compare",
  ),
];

// ── Reads, controls and non-kind mutations ────────────────────────────────────────────
const read = (
  id: string,
  group: Group,
  api: Binding,
  mcp: Binding,
  cli: Binding,
  admission: Admission = "admitted",
  requires?: string,
): CatalogOperation => ({ id, group, effect: "read", admission, api, mcp, cli, ...(requires ? { requires } : {}) });
const VERIFICATION_RESULT_READS = "the corresponding verification result read service configured";

const operationsSurface: readonly CatalogOperation[] = [
  {
    id: "operations.submit",
    group: "operations",
    effect: "mutation",
    admission: "admitted",
    api: on("POST /v1/operations"),
    mcp: excluded("MCP exposes one tool per operation, not a generic submit"),
    cli: excluded("the CLI binds one command per operation, not a generic submit"),
  },
  {
    id: "operations.a2a_task",
    group: "operations",
    effect: "mutation",
    admission: "admitted",
    api: on("POST /v1/a2a/tasks"),
    mcp: excluded("A2A is an HTTP binding for Mission Control"),
    cli: excluded("A2A is an HTTP binding for Mission Control"),
  },
  {
    id: "operations.a2a_callback",
    group: "operations",
    effect: "control",
    admission: "gated",
    api: on("POST /v1/a2a/callbacks"),
    mcp: excluded("signed callback receipt from Mission Control; HTTP only"),
    cli: excluded("signed callback receipt from Mission Control; HTTP only"),
    requires: "callback signing keys (KNOWLEDGE_CALLBACK_SIGNING_KEYS)",
  },
  read("operations.list", "operations", on("GET /v1/operations"), BY_ID, BY_ID),
  read(
    "operations.status",
    "operations",
    on("GET /v1/operations/:id"),
    on("knowledge_embed_status", "knowledge_promotion_status"),
    on("knowledge operation status", "knowledge promotion status", "knowledge embed status"),
  ),
  read(
    "operations.events",
    "operations",
    on("GET /v1/operations/:id/events"),
    excluded("event pages are an HTTP polling surface; MCP polls status"),
    on("knowledge operation events"),
  ),
  {
    id: "operations.control",
    group: "operations",
    effect: "control",
    admission: "admitted",
    api: on("POST /v1/operations/:target"),
    mcp: excluded("operation cancel/retry/reconcile belong to Mission Control and operators, not agents"),
    cli: on("knowledge operation retry", "knowledge operation reconcile"),
  },
  read("operations.receipt", "operations", on("GET /v1/receipts/:id"), NO_MCP, NO_CLI),
  read("operations.artifact", "operations", on("GET /v1/artifacts/:id"), NO_MCP, NO_CLI),
];

const knowledgeReads: readonly CatalogOperation[] = [
  read(
    "knowledge.list_by_collection",
    "knowledge",
    on(
      "GET /v1/vector-stores",
      "GET /v1/captures",
      "GET /v1/documents",
      "GET /v1/document-versions",
      "GET /v1/representations",
      "GET /v1/promotion-proposals",
      "GET /v1/promotion-decisions",
      "GET /v1/embedding-runs",
      "GET /v1/space-publications",
      "GET /v1/eval-datasets",
      "GET /v1/experiments",
      "GET /v1/eval-runs",
      "GET /v1/reviews",
      "GET /v1/review-decisions",
      "GET /v1/retrieval-runs",
    ),
    BY_ID,
    BY_ID,
  ),
  read("knowledge.vector_store", "knowledge", on("GET /v1/vector-stores/:id"), NO_MCP, on("knowledge store show")),
  read(
    "knowledge.vector_store_operation",
    "knowledge",
    on("GET /v1/vector-stores/:id/operations/:operationId"),
    on("knowledge_store_status"),
    on("knowledge store status"),
  ),
  read(
    "knowledge.retrieval_plan_validation",
    "knowledge",
    on("POST /v1/retrieval-plans:validate"),
    on("knowledge_retrieve_plan"),
    on("knowledge retrieve plan"),
  ),
  read(
    "knowledge.get_retrieval_run",
    "knowledge",
    on("GET /v1/retrieval-runs/:id"),
    on("knowledge_retrieve_run"),
    on("knowledge retrieve run"),
  ),
  read(
    "knowledge.retrieval_explanation",
    "knowledge",
    on("GET /v1/retrieval-runs/:id/explanation"),
    on("knowledge_retrieve_explain"),
    on("knowledge retrieve explain"),
  ),
  read(
    "knowledge.get_evidence_packet",
    "knowledge",
    on("GET /v1/evidence-packets/:id"),
    on("knowledge_retrieve_packet"),
    on("knowledge retrieve packet"),
  ),
  read(
    "knowledge.citation_replay",
    "knowledge",
    on("GET /v1/evidence-packets/:id/citations"),
    on("knowledge_retrieve_citations"),
    on("knowledge retrieve citations"),
    "gated",
    "Supabase Storage for citation custody",
  ),
  read(
    "knowledge.evaluation_failures",
    "knowledge",
    on("GET /v1/eval-runs/:id/failures"),
    on("knowledge_eval_failures"),
    on("knowledge eval failures"),
  ),
  read("knowledge.evaluation_report", "knowledge", on("GET /v1/eval-runs/:id/report"), NO_MCP, NO_CLI),
  read(
    "knowledge.chunking_procedures",
    "knowledge",
    on("GET /v1/chunking-procedures"),
    on("knowledge_chunk_strategies"),
    NO_CLI,
  ),
  read(
    "knowledge.embedding_models",
    "knowledge",
    excluded("declared only; no route"),
    failsClosed("knowledge_embed_models"),
    excluded("declared only; no CLI binding"),
    "declared",
  ),
  read(
    "knowledge.embedding_estimate",
    "knowledge",
    excluded("declared only; no route"),
    failsClosed("knowledge_embed_estimate"),
    excluded("declared only; no CLI binding"),
    "declared",
  ),
  {
    id: "knowledge.demo_evaluation",
    group: "knowledge",
    effect: "mutation",
    admission: "gated",
    api: on("POST /v1/demo/evaluations"),
    mcp: excluded("in-memory exploratory demo; composed only with the demo bundle port"),
    cli: excluded("in-memory exploratory demo; composed only with the demo bundle port"),
    requires: "the demo bundle port (loadDemoEvaluationBundles)",
  },
  {
    id: "knowledge.space_rebuild",
    group: "knowledge",
    effect: "mutation",
    admission: "declared",
    api: excluded("declared only; no route"),
    mcp: excluded("declared only; no MCP binding"),
    cli: failsClosed("knowledge space rebuild"),
  },
];

const verifyReads: readonly CatalogOperation[] = [
  read(
    "verify.operation",
    "verify",
    on("GET /v1/verification/operations/:id"),
    on("verify_status"),
    on("verify status"),
  ),
  read(
    "verify.get_structured_extraction",
    "verify",
    on("GET /v1/verification/extractions/:operationId"),
    on("verify_extraction_show"),
    on("verify extraction show"),
    "gated",
    VERIFICATION_RESULT_READS,
  ),
  read(
    "verify.benchmark_run",
    "verify",
    on("GET /v1/verification/benchmarks/:runId"),
    on("verify_benchmark_show"),
    on("verify benchmark show"),
    "gated",
    VERIFICATION_RESULT_READS,
  ),
  read(
    "verify.benchmark_manifest",
    "verify",
    on("GET /v1/verification/benchmarks/:runId/manifest"),
    on("verify_benchmark_manifest"),
    on("verify benchmark manifest"),
    "gated",
    VERIFICATION_RESULT_READS,
  ),
  read(
    "verify.benchmark_comparison",
    "verify",
    on("GET /v1/verification/benchmarks/comparisons/:comparisonId"),
    on("verify_benchmark_comparison"),
    on("verify benchmark comparison"),
    "gated",
    VERIFICATION_RESULT_READS,
  ),
  read(
    "verify.capture_result",
    "verify",
    on("GET /v1/verification/captures/:operationId"),
    NO_MCP,
    NO_CLI,
    "gated",
    VERIFICATION_RESULT_READS,
  ),
  read(
    "verify.provider_reconciliation",
    "verify",
    on("GET /v1/verification/extractions/:operationId/provider-attempts/:providerAttemptId/reconciliation"),
    on("verify_reconciliation_show"),
    on("verify reconciliation show"),
    "gated",
    "operator provider reconciliation authority",
  ),
  {
    id: "verify.apply_provider_reconciliation",
    group: "verify",
    effect: "control",
    admission: "gated",
    api: on("POST /v1/verification/extractions/:operationId/provider-attempts/:providerAttemptId/reconciliation"),
    mcp: on("verify_reconciliation_apply"),
    cli: on("verify reconciliation apply"),
    requires: "operator provider reconciliation authority",
  },
];

// ── Offline workflows named by the CLI and system probes ──────────────────────────────
const offline = (id: string, command: string): CatalogOperation => ({
  id,
  group: "db",
  effect: "control",
  admission: "declared",
  api: excluded("offline operator/build workflow; never served"),
  mcp: excluded("offline operator/build workflow; never served"),
  cli: failsClosed(command),
});
const offlineWorkflows: readonly CatalogOperation[] = [
  offline("db.maintenance_verify", "db verify"),
  offline("db.types_generate", "db types"),
  offline("db.rls_test", "db rls-test"),
  offline("db.fixture_load", "db fixture load"),
  offline("db.fixture_reset", "db fixture reset"),
];
const system: readonly CatalogOperation[] = [
  read(
    "system.health",
    "system",
    on("GET /health", "GET /readiness"),
    excluded("process probe; the MCP app serves its own /health"),
    excluded("process probe"),
  ),
  read(
    "system.status",
    "system",
    on("GET /v1/system"),
    excluded("operator status read"),
    excluded("operator status read"),
  ),
];

// ── Verification executor registry (folds into ks in Unit 5) ─────────────────────────
const executorOperation = (
  group: Group,
  effect: CatalogOperation["effect"],
  name: string,
  cli: string | undefined,
  note?: string,
): CatalogOperation => ({
  id: `executor.${name}`,
  group,
  effect,
  admission: "executor",
  api: excluded(note ? `${EXECUTOR}; ${note}` : EXECUTOR),
  mcp: excluded(EXECUTOR),
  cli: excluded(EXECUTOR),
  executor: cli ? { mcp: name, cli } : { mcp: name },
});
const INGESTION =
  "ingestion keeps its own transaction and receipt semantics; no durable operation kind is added for parity";
const executorKnowledge: readonly CatalogOperation[] = [
  ...(
    [
      "schema_search:schema search",
      "schema_get:schema get",
      "schema_manifest:schema manifest",
      "schema_materialize:schema materialize",
      "db_head:db head",
      "db_read_intent:db read-intent",
      "db_sql_readonly:db sql",
      "db_explain:db explain",
    ] as const
  ).map((entry) => {
    const [name, cli] = entry.split(":");
    return executorOperation("db", "read", name!, cli);
  }),
  executorOperation("db", "read", "ingest_plan", "ingest plan", INGESTION),
  executorOperation("db", "mutation", "ingest_apply", "ingest apply", INGESTION),
  executorOperation("db", "read", "ingest_receipt", "ingest receipt", INGESTION),
  executorOperation("db", "read", "artifact_get", "artifact get"),
  ...(
    [
      "source_discover:source discover:mutation",
      "source_import:source import:mutation",
      "source_attempt:source attempt:read",
      "source_reconcile:source reconcile:control",
      "source_select:source select:mutation",
      "source_prepare_captured:source prepare-captured:mutation",
      "checkpoint_harness:checkpoint harness:mutation",
      "checkpoint_commit:checkpoint commit:mutation",
      "checkpoint_head:checkpoint head:read",
      "checkpoint_read:checkpoint read:read",
      "checkpoint_restore:checkpoint restore:read",
      "checkpoint_tombstone:checkpoint tombstone:mutation",
    ] as const
  ).map((entry) => {
    const [name, cli, effect] = entry.split(":");
    return executorOperation("knowledge", effect as CatalogOperation["effect"], name!, cli);
  }),
];
// The intent pipeline: executor MCP tool and the `ks` command that runs it on the local host profile. The server
// profile serves none of them until 5D3, so their ks cli binding stays excluded for the server.
const LOCAL_PROFILE_ONLY =
  "runs through the `ks` command in executor.ks on the local profile only; the server profile serves it after 5D3";
const executorVerify: readonly CatalogOperation[] = (
  [
    "verify_capture_source:mutation:verify capture source",
    "verify_capture_file:mutation:verify capture file",
    "verify_supported_media_types:read:verify capture media-types",
    "verify_list_captures:read:verify capture list",
    "verify_read_capture:read:verify capture read",
    "verify_search_capture:read:verify capture search",
    "verify_locate_quote:read:verify capture locate",
    "verify_register_artifact:mutation:verify artifact register",
    "verify_get_artifact:read:verify artifact get",
  ] as const
).map((entry) => {
  const [name, effect, ks] = entry.split(":");
  return {
    ...executorOperation("verify", effect as CatalogOperation["effect"], name!, undefined),
    cli: excluded(`${EXECUTOR}; ${LOCAL_PROFILE_ONLY}`),
    executor: { mcp: name!, ks: ks! },
  };
});
// Executor tools that need durable artifact custody. They run in the executor's serve mode only: the file-backed local
// profile cannot hold that custody, so they have no `ks` command. verify_capture_fragment preserves the capture,
// representation and provenance artifacts it exports (report-source capture).
const SERVER_ONLY_CUSTODY = "needs durable artifact custody; executor serve mode only, no local `ks` command";
const executorServerOnlyVerify: readonly CatalogOperation[] = [
  executorOperation("verify", "mutation", "verify_capture_fragment", undefined, SERVER_ONLY_CUSTODY),
];

export type Profile = "server" | "local";
export type TransportState =
  | "executable"
  | "executable when composed"
  | "declared (fails closed)"
  | "excluded"
  | "executor only"
  | "server only"
  | "local profile";

/** The declared/admitted/executable state of one operation on one transport under one host profile. */
export function transportState(
  operation: CatalogOperation,
  profile: Profile,
  transport: "api" | "mcp" | "cli",
): TransportState {
  if (profile === "local" && transport === "cli" && operation.executor?.ks) return "local profile";
  if (operation.admission === "executor") return "executor only";
  if (profile === "local") return "server only";
  const binding = operation[transport];
  if ("excluded" in binding) return "excluded";
  if ("failsClosed" in binding) return "declared (fails closed)";
  return operation.admission === "gated" ? "executable when composed" : "executable";
}

export const operationCatalog: readonly CatalogOperation[] = [
  ...operationsSurface,
  ...knowledgeMutations,
  ...knowledgeReads,
  ...verifyMutations,
  ...verifyReads,
  ...offlineWorkflows,
  ...system,
  ...executorKnowledge,
  ...executorVerify,
  ...executorServerOnlyVerify,
];

/** Concrete requests for the declared kinds' API routes, used to prove they fail closed. */
export const declaredApiRequests: Readonly<Partial<Record<OperationKind, string>>> = {
  capture_inspection: "/v1/captures/{id}:inspect",
  capture_comparison: "/v1/captures/{id}:compare",
  vector_store_search: "/v1/vector-stores/{id}:search",
  document: "/v1/documents",
  document_version: "/v1/document-versions",
  representation: "/v1/representations",
  representation_inspection: "/v1/representations/{id}:inspect",
  chunk_set_inspection: "/v1/chunk-sets/{id}:inspect",
  review: "/v1/reviews",
};
