# Preparation MCP reference

## Executor MCP (`apps/verification-executor`)

- `source_prepare_captured` — registers an executor capture (text, Markdown, HTML, JSON) as an evidence capture with quotable content units for the verification chain; it does not chunk, embed or promote. See the `knowledge-research` verification reference.

## Platform MCP (`apps/mcp`)

- `knowledge_document_convert` → `transformation`
- `knowledge_chunk_preview` → `chunk_preview`
- `knowledge_chunk_build` → `chunk_set`
- `knowledge_promotion_propose` / `knowledge_promotion_status`
- `knowledge_embed_run` → `embedding_run`

## From one step to the next

Each submission returns an accepted operation, not its output. Poll `knowledge_promotion_status` with the
`operationId` until `state` is `succeeded` (it polls every `knowledge_*` submission, not only proposals), then call
`knowledge_operation_result` with the same `operationId`. Its `ids` hold what the next call takes:

| After | Read from `ids` | For |
|---|---|---|
| `knowledge_document_convert` | `representationId` | `knowledge_chunk_build` |
| `knowledge_chunk_build` | `chunkSetId` | `knowledge_promotion_propose` |
| `knowledge_promotion_propose` | `proposalId`, `reviewSubjectId` | the reviewer's decision |
| `knowledge_promotion_propose` | `projectionIds` | `knowledge_embed_run`, with the id of the reviewer's decision |

The result carries identifiers, digests, counts and state names only. Text and storage locations are never in it.
On the command line: `ks knowledge operation status` and `ks knowledge operation result`.

Unstructured Transform MCP and Firecrawl MCP are attached by the **agent host**, not nested inside `@aiengineer/knowledge-mcp`. After those skills run, import a receipt and convert stored bytes.
