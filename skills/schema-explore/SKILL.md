---
name: schema-explore
description: >-
  Use when you need to know what the shared knowledge database contains or how something is
  stored: which table/view/function holds a concept, how entities, relationships, two-clock
  temporal facts, evidence and claims relate, which named query answers a question, or what an
  ingestion proposal must contain. Navigates the pinned schema workspace (progressive
  disclosure) instead of guessing table names. Does not query the database; use knowledge-db.
allowed-tools:
  - Bash(rg *)
  - Bash(jq *)
  - Bash(cat *)
  - Bash(knowledge schema *)
---

# schema-explore — find the right table, query, or proposal shape

The workspace is a generated tree (`START_HERE.md`, `INDEX.md`, `domains/`, `relations/`,
`functions/`, `tasks/`, `vocabularies/`, `queries/catalog.json`, `rules/ingestion-rules.v1.json`,
`search/index.json`). Locally it is at `references/workspace/` when a scoped bundle was
materialized for you; otherwise `knowledge schema *` reads the executor's copy for you.
Blocks marked `> curated` are human guidance validated against the catalog; everything else is
mechanically extracted from the database.

## The navigation rule (overrides browsing habits)

1. **Search, then read.** Never list or read the tree. `knowledge schema search "<words>"`
   (ranked: exact alias > name > tokens) or `rg -n -i "<word>" references/workspace/search/index.json`.
2. **Domain before relation.** `knowledge schema get dom:<slug>` before any `rel:` page.
3. **Task pages are shortcuts.** A `task:` hit names the exact named query or proposal kind.
4. **Relation pages last** (`knowledge schema get rel:<schema>.<name>`), only for what you will query or write.
5. **≤ 4 page reads per question.** More means you are browsing; search again with better words.
6. **Only `enforced` is a guarantee.** `curated` guidance can be stale; the relation page's
   Constraints section wins. Note conflicts in `01-schema-notes.md`.
7. **Omission is not permission or prohibition.** A relation missing from a scoped bundle may
   still exist; the executor and database roles decide what you can do.

## Sequence

| # | stage | command | quality gate | file |
|---|---|---|---|---|
| 1 | orient | `knowledge schema manifest` (once) | `headMatches: true`; note `workspaceHead` and fingerprint | `01-schema-notes.md` header |
| 2 | search | `knowledge schema search "<words>" --limit 10` | ≥ 1 hit with a `domain` | append hit ids |
| 3 | domain | `knowledge schema get dom:<slug>` | you can name the read path and the write path | append 2–3 lines |
| 4 | task or relation | `knowledge schema get task:<slug>` / `rel:<schema>.<name>` / `fn:<schema>.<name>` | you can write the named query + params, or the proposal kind + fields | append the answer |
| 5 | record | — | every id consulted + workspace fingerprint listed | `01-schema-notes.md` |

`knowledge schema search|get|manifest` cost no database time (`manifest` reads one head row).
Pages are capped (`--max-bytes`, default 24 KB); `truncated: true` means read the `.details.md` sibling.

### Typical questions → where the answer is

| question | search words | you will end at |
|---|---|---|
| Does the DB know entity X? | `resolve alias identifier` | `task:what-do-we-know-about-entity` → `entity.resolve`, `entity.card` |
| What is true about X now / on date D / at head K? | `as of point in time` | `dom:temporal-facts` → `entity.at`, `entity.timeline` |
| How are prices stored? Which units are allowed? | `price unit currency` | `voc:temporal.stream_kind` (`model_offering_price` row), `rules/README.md#prices` |
| How do I say "A is offered as B" / "P works at O"? | `offered_as` / `employed_by` | `dom:relationships` → proposal `relationship.assert` |
| What must an ingestion intent contain? | `ingestion intent proposal` | `task:compose-ingestion-intent`; then the knowledge-ingest skill |
| How is a report organized, supported, or incomplete? | `report structure` / `report gaps` | `dom:research` → `task:navigate-report` → `reports.sections`, `reports.assertions`, `reports.questions` |
| Why VOCABULARY_VIOLATION? | the field named in the error | the vocabulary page for that `stream_kind` / `relationship_kind` |
| Where did this search result come from? | `source attempt receipt` | `dom:research` → source attempt/selection rows; read one with `knowledge source attempt <attemptId>` |

Report registration and assessment, content-link close-out and durable recovery cases were retired in SV-17; claims, runs and seals go through ks.knowledge_operation.v2 (K01) on the knowledge_verification component.

## Boundaries the workspace does not move

A discovery or search receipt is preserved provenance, not evidence: rows that record a provider
attempt or a lead selection explain how a source was found and never support a fact. Identity rows
(entities, aliases, identifiers) and staged candidates are research staging; they create identities
without admitting knowledge. Admission and publication are separate typed
paths with their own receipts, and a structural report seal is custody rather than admission or
verification.

## What not to do

Report navigation is included in the db-aware-research and ingestion-author scopes. The
`reports.*` catalog reads are bounded slices; read retained bytes with
`knowledge artifact get <artifactId>`. Read the knowledge-db skill before executing catalog
queries. A version without a package can be a legacy report. A structural seal or claim
binding alone does not establish verification or admission.

- Do not read `schema-ir.json`, `search/index.json`, or `relations.txt` whole.
- Do not infer columns from TypeScript types when a relation page exists.
- Do not write SQL for facts. Reads are named queries (`knowledge db read-intent`); writes are proposals (`knowledge ingest`).
  `knowledge db sql` exists for bounded read-only exploration only and is never evidence.

## Exit codes

`knowledge schema search|get`: 0 found; 1 not found (`PAGE_NOT_FOUND`; the JSON lists `suggestions`/`hint`); 2 bundle missing or corrupt (`WORKSPACE_MISSING`, `WORKSPACE_CORRUPT`) — stop and report.
`knowledge schema manifest`: 1 on `HEAD_MISMATCH` (workspace head ≠ database head) — stop and report; nothing you do fixes it.

## MCP equivalents

`schema_search`, `schema_get`, `schema_manifest`, `schema_materialize` on the executor's `/mcp`.
