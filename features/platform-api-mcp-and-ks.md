# Platform API, MCP and ks

**What it does.** The platform surfaces expose one operation catalog (`packages/application/src/operations/catalog.ts`)
three ways: the HTTP API (`@aiengineer/knowledge-api`, `apps/api`), the platform MCP server
(`@aiengineer/knowledge-mcp`, `apps/mcp`, server name `ai-engineer-knowledge-services`) and the `ks` CLI
(`@aiengineer/knowledge-cli`, `apps/cli`). The API and MCP call `packages/application` in process; MCP has no API
client. Mutations come back as accepted operations, which the durable worker (`@aiengineer/knowledge-worker`,
`apps/worker`) executes; the worker has no routes or tools of its own. Concepts: [service
boundaries](../knowledge/service-boundaries.md#purpose), [durable execution](../knowledge/durable-execution-and-recovery.md#durable-execution-and-recovery).

**Code.** `apps/api/src/routes/{system,operationReads,operationMutations,retrieval,knowledge,verification}.ts`;
`apps/mcp/src/index.ts`, `src/tools/register.ts`, `src/tools/{system,knowledge,verify,operations}.ts`;
`apps/cli/src/ks-commands.ts` (`KS_COMMANDS`), `src/io.ts`; `apps/worker/src/`.

**Tests.** `apps/mcp/src/tests/catalog.test.ts`; `apps/api/src/tests/openapi-parity.test.ts`, `guide.test.ts`;
`apps/cli/src/tests/commands.test.ts`; `apps/worker/src/activity-registry.test.ts`. `apps/cli/src/tests/ks.test.ts`
and `remote-profile.test.ts` need the built `dist`; the worker's "process restart" suite skips unless
`RUN_LOCAL_PERSISTENCE_TESTS=1`.

**Reach it.**
- MCP tools (names come from the catalog): `knowledge_source_discover|resolve|fetch|vet`,
  `knowledge_store_create|add_documents|evaluate|status`, `knowledge_document_convert|compare`,
  `knowledge_chunk_preview|compare|build|strategies`, `knowledge_promotion_propose|status`, `knowledge_embed_run`, the
  `knowledge_retrieve_*` and `knowledge_eval_*` tools, `knowledge_operation_result`, `knowledge_guide`,
  `knowledge_describe`, and the platform `verify_*` tools.
- HTTP: `/health`, `/readiness`, `/v1/system`, `/v1/describe`, `/v1/guide[/*]`, `/v1/operations[...]`,
  `/v1/a2a/tasks|callbacks`, and the knowledge, retrieval and verification routes. Start with `corepack pnpm dev:api`
  (MCP: `corepack pnpm dev:mcp`, worker: `corepack pnpm dev:worker`); both servers read `PORT` (default 4100).
- `ks` profiles: utility (`guide`, `describe`, the attestation and benchmark-diff commands), remote (every other
  `knowledge ...` and `verify ...`; needs `KNOWLEDGE_API_URL`, `KNOWLEDGE_API_TOKEN`) and local (the `verify capture` and
  `verify artifact` commands; `KNOWLEDGE_LOCAL_*`).

**Prove it.** `./dev test mcp src/tests/catalog.test.ts` (the registered tools equal the catalog). Also
`./dev test api src/tests/openapi-parity.test.ts` and `./dev test cli src/tests/commands.test.ts`.

**Gotchas.**
- `createKnowledgeMcpServer` throws `MCP_TOOL_CATALOG_MISMATCH` when registered tools and the catalog differ.
- Decision and publication tools are deliberately not on MCP (`DECISION_AUTHORITY`, `PUBLICATION_AUTHORITY`).
- Invalid input is `INVALID_CONTRACT`; an absent capability is `CAPABILITY_NOT_ADMITTED`.
- `ks` exits 0 ok, 1 gate failed, 2 error; refusals are JSON with `UNKNOWN_COMMAND`, `USAGE` or `CLI_ERROR`.
- MCP and the worker refuse to start without the plane's runtime DSN (`KS_AIENG_DB_RUNTIME_DSN_REQUIRED`); the API runs
  without persistence outside production. A remote DSN also needs `KS_APPLICATION`
  ([ENVIRONMENT](../docs/ENVIRONMENT.md#plane-selection)); the AWS worker task sets it.
