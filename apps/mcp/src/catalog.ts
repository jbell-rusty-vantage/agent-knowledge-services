import type { OperationKind } from "@aiengineer/knowledge-contracts";

export const MCP_TOOL_CATALOG = Object.freeze({
  knowledge_source_discover: "source_discovery",
  knowledge_source_resolve: "source_resolution",
  knowledge_source_fetch: "capture",
  knowledge_source_vet: "source_vetting",
  knowledge_store_create: "vector_store_create",
  knowledge_store_add_documents: "vector_store_documents",
  knowledge_store_status: "vector_store_ingestion",
  knowledge_store_evaluate: "vector_store_evaluation",
  knowledge_document_convert: "transformation",
  knowledge_document_compare: "representation_comparison",
  knowledge_chunk_strategies: "chunk_preview",
  knowledge_chunk_preview: "chunk_preview",
  knowledge_chunk_compare: "chunk_comparison",
  knowledge_chunk_build: "chunk_set",
  knowledge_embed_run: "embedding_run",
  knowledge_retrieve_plan: "retrieval_run",
  knowledge_retrieve_search: "retrieval_run",
  knowledge_retrieve_explain: "retrieval_run",
  knowledge_retrieve_run: "retrieval_run",
  knowledge_retrieve_packet: "evidence_packet",
  knowledge_retrieve_citations: "evidence_packet",
  knowledge_retrieve_build_packet: "evidence_packet",
  knowledge_eval_generate: "evaluation_dataset",
  knowledge_eval_run: "evaluation_run",
  knowledge_eval_compare: "experiment",
  knowledge_eval_failures: "evaluation_run",
  knowledge_promotion_propose: "promotion_proposal",
  knowledge_promotion_status: "promotion_proposal",
  // A read of any operation of the tenant; like the status read it names a kind only to fit this table.
  knowledge_operation_result: "promotion_proposal",
} satisfies Record<string, OperationKind>);

export type McpToolName = keyof typeof MCP_TOOL_CATALOG;
export const VERIFICATION_MCP_TOOL_NAMES = Object.freeze([
  "verify_extraction_run",
  "verify_benchmark_capture",
  "verify_artifact_parse",
  "verify_extract",
  "verify_bundle_replay",
  "verify_benchmark_run",
  "verify_benchmark_compare",
] as const);
/**
 * Tools that read no tenant data: `knowledge_guide` returns the guidance pages (the start page, each skill and each
 * reference) and `knowledge_describe` explains every other tool, operation and skill.
 */
export const SYSTEM_MCP_TOOL_NAMES = Object.freeze(["knowledge_guide", "knowledge_describe"] as const);
export const FORBIDDEN_MCP_CAPABILITIES = Object.freeze([
  "raw_sql",
  "secret.read",
  "storage.list",
  "publication.approve",
  "publication.publish",
  "capability.admit",
]);
