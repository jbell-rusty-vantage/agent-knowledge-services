# Preparation MCP reference

## Executor MCP (`apps/verification-executor`)

- `source_prepare_captured` — pinned convert + chunk on an existing text/Markdown capture

Hosts without `source_prepare_captured` reject it. Do not substitute a local converter.

## Platform MCP (`apps/mcp`)

- `knowledge_document_convert` → `transformation`
- `knowledge_chunk_preview` → `chunk_preview`
- `knowledge_chunk_build` → `chunk_set`
- `knowledge_promotion_propose` / `knowledge_promotion_status`

Unstructured Transform MCP and Firecrawl MCP are attached by the **agent host**, not nested inside `@aiengineer/knowledge-mcp`. After those skills run, import a receipt and convert stored bytes.
