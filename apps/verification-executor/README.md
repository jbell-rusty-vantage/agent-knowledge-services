# @aiengineer/knowledge-verification-executor

Sandbox capture and artifact executor, the knowledge executor (schema, bounded reads, ingestion, source discovery,
checkpoints) and the `ks.knowledge_operation.v2` (K01) server. One process exposes the same operations on several
surfaces:

| Surface | Entry | Use |
|---|---|---|
| CLI, local | `knowledge-verify <command>` (`dist/index.js`) | Operators, tests; runs against `VERIFY_STORE_DIR` in-process |
| CLI, remote | same commands with `VERIFY_EXECUTOR_URL=http://host:4310` | **Agent skills inside sandboxes.** Forwards every command to a `serve` process; the store never enters the sandbox |
| MCP (Streamable HTTP) | `knowledge-verify serve` → `POST /mcp` | Eve / any MCP client; capture tools named `verify_*`, knowledge operations, `knowledge_operation_*` |
| MCP (stdio) | `knowledge-verify mcp-stdio` | Local harnesses (Cursor, Claude Code) |
| HTTP | `/artifacts` (POST bytes → handle, GET by id/digest), `/captures` (POST document bytes → capture; GET list), `/media-types`, `/health`, `/knowledge/<operation>`, `/knowledge-operation/v2/*` | Sandbox → store handoff, knowledge operations, K01 |

**SV-17.** The file-store verifier chain (`verify-claims`, `verify-extraction`, `judge`, `policy`, `seal`,
`check-report`, `status`, the `/runs/:runId` route and their MCP tools), the legacy intent files, the evidence oracle
over sealed file-store runs and the report, recovery and content-link operations were retired. Verification runs,
claims and seals are owned by the `knowledge_verification` component and reached through `ks.knowledge_operation.v2`
(see the [integration guide](../../docs/verification/INTEGRATION-GUIDE.md#knowledge-operation-protocol-v2)). The
retired commands exit `2` with `retired (SV-17)`; retired settings are refused at startup with
`EXECUTOR_RETIRED_CONFIGURATION:<NAME>` (`VERIFY_JUDGE_MODEL`, `VERIFY_CROSS_FAMILY_JUDGE_MODEL`,
`VERIFY_PRINCIPAL_SALT`, `KNOWLEDGE_EVIDENCE_ORACLE`, `KNOWLEDGE_EVIDENCE_POLICY_VERSION`,
`KNOWLEDGE_EVIDENCE_POLICY_DIGEST`, `KNOWLEDGE_RECOVERY_CONFIG_JSON`, `KNOWLEDGE_REPORT_ASSESSMENT_PINS_JSON`,
`KNOWLEDGE_CONTENT_LINKS_ENABLED`).

The agent-facing procedure for the CLI surface is the packaged skill in
[`skills/knowledge-verify/`](skills/knowledge-verify/SKILL.md). `pnpm pack:sandbox` bundles the CLI **and** that skill
into `dist/sandbox/knowledge-verify-<version>.tgz` for `npm i -g` inside a sandbox image.

### Exit codes (CLI)

`0` command succeeded and its gate passed · `1` succeeded but the gate failed (`locate` not resolved) · `2` usage /
network / auth / executor error, and every retired command. Every command prints one JSON document to stdout;
`--out <file>` writes it to a file and prints a compact summary instead.

## Operations (one tool / command each)

| Stage | CLI | MCP tool | Produces |
|---|---|---|---|
| Capture | `capture <url> --run R --capture-id C` | `verify_capture_source` | immutable capture (content artifact + capture record). URLs ending in `.pdf/.docx/.xlsx/.pptx/.odt/.rtf/.epub` are downloaded and parsed to text (Firecrawl `/v2/parse`); original bytes kept as `originalArtifact` |
| Capture file | `capture-file <path> --run R --capture-id C` | `verify_capture_file` (base64/text) · `POST /captures` | same, for files the agent already holds (sandbox downloads, uploads) |
| Media types | `media-types` | `verify_supported_media_types` | which extensions/media types capture accepts and how each is handled |
| List | `captures` | `verify_list_captures` | the captures of the store |
| Inspect | `read C`, `search C <query>` | `verify_read_capture`, `verify_search_capture` | windows / matches of the captured text |
| Locate | `locate C <quote>` | `verify_locate_quote` | resolved / ambiguous / not_found + suggestions |
| Register | `register <file> --label L --run R` | `verify_register_artifact` · `POST /artifacts` | `{ artifactId, digest }` for files the agent wrote |
| Artifact | `artifact <id> [--as text]` | `verify_get_artifact` | the registered bytes, re-verified against their digest |

Quotes must be exact substrings of the capture and occur exactly once (`text_quote`, normalization `none`).

## Store

`VERIFY_STORE_DIR` (default `.verification-store`) is a content-addressed filesystem
store: `artifacts/<sha256>` bytes + `artifacts/<sha256>[.<lineage16>].handle.json`,
`captures/<captureId>.json` and a small per-run index `runs/<runId>/state.json` (`{runId, createdAt, updatedAt,
captureIds}`). The store is a **non-authoritative capture cache**: it holds no verification runs, findings, verdicts
or seals, and nothing reads a verification result from it. Artifact identity is
**bytes + lineage**: parentless artifacts (captures, registered files) are keyed by digest alone
and re-putting them is idempotent; derived artifacts are keyed by
digest + sorted parents + transformation, so the same bytes re-derived from new parents get a
new handle. A `captureId` is immutable: identical bytes
under an existing id return the original record (`reused: true`), different bytes raise
`CAPTURE_ID_CONFLICT`. Reads re-hash and fail on mismatch. Swapping the directory for a bucket
changes only `store.ts`.

## Environment

`VERIFY_PORT` `VERIFY_HOST` `VERIFY_STORE_DIR` `VERIFY_EXECUTOR_TOKEN` (legacy static bearer for the retained
capture, artifact and `/knowledge/*` routes; the K01 routes never accept it)
`VERIFY_TENANT_ID` `VERIFY_PRODUCER_DEPLOYMENT_ID` `VERIFY_VERIFIER_DEPLOYMENT_ID`
`FIRECRAWL_API_KEY` (capture; falls back to HTTPS GET). K01 settings (`KS_KNOWLEDGE_*`) are listed in the
[integration guide](../../docs/verification/INTEGRATION-GUIDE.md#authentication-k07).

## Knowledge executor (`knowledge` bin)

The same process also hosts the schema-workspace, bounded-read, and ingestion surfaces
(spec: `ai-engineer-db-contract/docs/SCHEMA_WORKSPACE_MATERIALIZATION_SPEC.md` §5–§7). They are
generated from one operation registry (`src/knowledge/operations.ts`, `defineOperation`) into:

| surface | shape |
|---|---|
| CLI | `knowledge schema search\|get\|manifest\|materialize`, `knowledge db head\|read-intent\|sql\|explain`, `knowledge ingest plan\|apply\|receipt`, `knowledge artifact get`, `knowledge source discover\|import\|attempt\|reconcile\|select\|prepare-captured`, `knowledge checkpoint harness\|commit\|head\|read\|restore\|tombstone` (`knowledge help`). The `report`, `content` and `recovery` groups were retired in SV-17 |
| HTTP | `POST /knowledge/<operation>` (JSON in/out), `GET /knowledge/operations`, `/health` reports workspace and database heads |
| MCP | every operation of the registry under its own name, beside the `verify_*` tools on `/mcp` |

`knowledge ops` prints the complete catalog (tool name, CLI shape, title); `knowledge ops --schemas`
adds each operation's JSON Schema input and its file-valued arguments. That output is the catalog
source for skill conformance (`node skills/check.mjs`) and for generating a child's scoped tool
catalog — never hand-write an operation list.

Library: `packages/knowledge-db`, with three internal submodules:
`schema-workspace` (load/search/pages/head check/materialize), `db-read` (catalog-driven
`knowledge-read-intent.v1` → snapshot, guarded SQL, artifact ledger), and `ingestion`
(`knowledge-ingestion-intent.v1` → plan → apply as `executor_service` → receipt).
Skills: the canonical tree is `../../skills` (`schema-explore`, `knowledge-db`, `knowledge-ingest` ship in the
sandbox tarball; the recovery skill was retired in SV-17); `skills/knowledge-verify` is canonical
here. `pack:sandbox` fails when a required skill directory is missing or unregistered in
`skills/manifest.json` instead of quietly staging a thinner tarball.

Exit lattice for `knowledge`: 0 ok · 1 domain outcome (`PARAMS_INVALID`, `VOCABULARY_VIOLATION`, `REBASE_REQUIRED`, plan rejected, …) · 2 infrastructure (`WORKSPACE_MISSING`, `HEAD_MISMATCH`, `DB_UNAVAILABLE`, usage).

### Environment (knowledge)

`KS_AIENG_DB_RUNTIME_DSN` (enables the knowledge tools; the pool connects as the login user and `set local role` switches to
`pipeline_agent`/`app_reader` for reads and `executor_service` for ingestion inside each transaction)
`SCHEMA_WORKSPACE_DIR` (default: the pinned `@aiengineer/database-contract` `workspace/`)
`KNOWLEDGE_TENANT_ID` (default tenant for CLI/MCP calls) `KNOWLEDGE_ARTIFACT_DIR` (default `.knowledge-artifacts`; ledger rows are `storage_state='pending'` until bucket upload)
`KNOWLEDGE_ARTIFACT_STORAGE=supabase` + `KS_AIENG_DB_URL` + `KS_AIENG_DB_SECRET_KEY` (upload to `research-ingestion-intents`)
`KNOWLEDGE_ALLOW_STALE=1` (experiments only: run when workspace head ≠ database head)
`KNOWLEDGE_USE_CLASSES_FILE` (the K08 use-class registry; default the repository's `catalog/research/use-classes.json`). Ingestion admits a cited run only through an `exactUse` binding (`exactUseEvidenceOracle`); an official or consequential use without it is `REVIEW_REQUIRED`. The co-hosted capture store must serve the same tenant (`KNOWLEDGE_TENANT_MISMATCH`). See [verification and admission](../../knowledge/verification-and-admission.md).
`KNOWLEDGE_EXECUTOR_URL` / `KNOWLEDGE_EXECUTOR_TOKEN` (remote mode for the `knowledge` CLI; `VERIFY_EXECUTOR_URL` is honoured too).

## Build

```sh
pnpm --filter @aiengineer/knowledge-verification-executor build   # dist/index.js + dist/knowledge.js, workspace deps inlined
node apps/verification-executor/dist/index.js serve --port 4310     # or: node dist/knowledge.js serve --port 4310
```

`dist/index.js` + `dist/knowledge.js` plus `@modelcontextprotocol/sdk`, `zod`, and `pg` is everything a sandbox needs
(`pnpm --filter @aiengineer/knowledge-verification-executor pack:sandbox` stages both bins plus
`knowledge-verify` and the three required canonical skills, and exits 2 when one is absent).

## Reviewed examples and capability coverage

The packaged [offline example](skills/knowledge-verify/examples/offline.mjs) exercises capture, quote ambiguity, registration, artifact reads and the retired-command refusals without credentials. See the [library capability matrix](../../packages/verification/CAPABILITIES.md), [acquisition capabilities](examples/CAPABILITIES-ACQUISITION.md) and [review record](../../docs/operations/reviews/verification-executor.md). Extraction fields accept explicit allowed values, normalization rules, decimal bounds, identifier kinds and checksum options; the distributed skill documents when each is required.
