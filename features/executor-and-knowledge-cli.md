# Verification executor and the knowledge CLI

**What it does.** `@aiengineer/knowledge-verification-executor` (`apps/verification-executor`) is the process Mission
Control and agents call for the AI Engineer knowledge database: the schema workspace, bounded reads, deterministic
ingestion, the governed chain, source discovery and scoped checkpoints, plus the capture tools. It ships two binaries,
`knowledge` (`dist/knowledge.js`) and `knowledge-verify` (`dist/index.js`), and serves the same operations over MCP and
HTTP. Concepts: [schema, reads and ingestion](../knowledge/schema-read-and-ingestion.md#use-this-playbook),
[execution profiles](../knowledge/execution-profiles-and-transports.md#choose-an-execution-profile).

**Code.** `apps/verification-executor/src/knowledge/cli.ts` (`runKnowledgeCli`, the help text),
`src/knowledge/operations.ts` (the operation registry), `src/knowledge/context.ts` (configuration), `src/mcp.ts`,
`src/tool-catalog.ts`, `src/http.ts`, `src/knowledge-operation/http.ts`; the database surfaces in
`packages/knowledge-db`.

**Tests.** `apps/verification-executor/src/knowledge/cli.test.ts`, `src/tool-list.test.ts`, `src/serve.test.ts`,
`src/scoped-host.test.ts`. Run single files: `report-source-foundation.integration.test.ts` fails, never skips, without a
loopback `KS_AIENG_DB_ADMIN_DSN`, so the package's whole `test` script fails on a machine without the disposable
database.

**Reach it.**
- `knowledge guide [topic]`, `serve [--port 4310] [--host 127.0.0.1]`, `health`, `ops [--schemas]`, and the registry
  groups: `schema search|get|manifest|materialize`, `db head|read-intent|sql|explain`, `ingest plan|apply|receipt`,
  `artifact get`, `chain write`, `evidence units`, `source discover|import|attempt|reconcile|select|prepare-captured`,
  `checkpoint harness|commit|head|read|restore|tombstone`.
- Local mode (default) needs `KS_AIENG_DB_RUNTIME_DSN`; remote mode forwards to `KNOWLEDGE_EXECUTOR_URL` (or
  `--remote <url>`, with `--token` / `KNOWLEDGE_EXECUTOR_TOKEN`).
- `knowledge-verify serve`, `mcp-stdio`, `health`, the capture commands and `grant-reviewer`.
- HTTP: `GET /health`, `/mcp`, `POST /scoped/invoke`, `POST /scoped/catalog`, `/artifacts`, `/captures`,
  `GET /media-types`, `GET /knowledge/operations`, `POST /knowledge/:operation`, `/knowledge-operation/v2/*`.
- MCP server `knowledge-verification-executor`: always `knowledge_guide`, `knowledge_describe` and the ten `verify_*`
  capture tools; the knowledge operations only when a database is configured; the `knowledge_operation_*` tools only
  when K01 is configured.

**Prove it.** `./dev test verification-executor src/knowledge/cli.test.ts src/tool-list.test.ts`. Offline by hand:
`node apps/verification-executor/dist/knowledge.js ops` lists every operation with its CLI shape and MCP tool name.

**Gotchas.**
- Exit codes: 0 success (skipped read operations included), 1 domain or gate outcome, 2 infrastructure or usage.
- The help text still lists `report`, `content` and `recovery` groups that the registry does not have: each answers
  `unknown command` (checked 2026-11-18); `source prepare-captured` exists but is missing from the help text.
- Without a database, `/knowledge/*` returns 503 `KNOWLEDGE_UNAVAILABLE` and the executor serves capture and artifact
  tools only.
- Since 2026-11-18 a remote runtime DSN is refused unless `KS_APPLICATION` names the plane
  (`KS_DB_REMOTE_REQUIRES_APPLICATION`, [ENVIRONMENT](../docs/ENVIRONMENT.md#plane-selection)); a Mission
  Control-generated executor environment that carries remote DSNs must set it.
- Bearer auth (`--token`) protects everything except `/health` and the K01 routes.
- `corepack pnpm --filter @aiengineer/knowledge-verification-executor examples` runs the offline skill example against
  `dist/index.js`, so build first.
