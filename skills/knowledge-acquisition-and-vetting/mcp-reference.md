# Acquisition MCP reference

## Executor MCP (`apps/verification-executor`)

Tools that produce or read sealed capture bytes:

- `verify_capture_source`
- `verify_capture_file`
- `verify_read_capture` — excerpt handle (`offset`, `length`, `text`, `hasMore`). Never a locator.
- `verify_search_capture` — display hits with offsets. Never a selector.

Discovery tools stay on the executor `knowledge` surface (`source_discover`, `source_import`, `source_select`, `source_attempt`, `source_reconcile`).

## Platform MCP (`apps/mcp`)

- `knowledge_source_discover` → platform discovery (caller-supplied candidates)
- `knowledge_source_fetch` → `capture`
- `knowledge_source_vet` → platform vetting

Firecrawl and Tavily MCP servers are attached by the **agent host**, not nested inside `@aiengineer/knowledge-mcp`. After an external scrape, `source import` a self-reported receipt. Do not treat provider markdown as sealed evidence.
