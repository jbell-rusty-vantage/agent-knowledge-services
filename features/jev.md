# Jev decisions

**What it does.** Jev runs closed-choice decision jobs: each job asks a model to pick among declared answers, with
explicit uncertainty. A local SQLite queue (`node:sqlite`) feeds bounded worker processes that call the model provider.
The service (`@aiengineer/knowledge-jev-service`, `apps/jev`) serves HTTP, Streamable HTTP MCP and stdio MCP; the library
is `@aiengineer/knowledge-jev` (`packages/jev`); `KnowledgeJevClient` lives in `@aiengineer/knowledge-client/jev`.
Concept: [Jev decisions and workers](../knowledge/jev-decisions-and-workers.md#closed-answers-with-explicit-uncertainty).

**Code.** `apps/jev/src/{index,config,http,mcp,errors}.ts`; `packages/jev/src/{service,store,worker,provider,inputs,contracts}.ts`;
`packages/client/src/jev.ts`.

**Tests.** `apps/jev/src/http.test.ts`; `packages/jev/src/service.test.ts` (a fake provider on a loopback server,
real child processes); `packages/client/src/jev.test.ts`.

**Reach it.**
- `jev serve`, `mcp-stdio`, `submit <task.json>`, `batch <tasks.json>`, `get <id>`, `cancel <id>`, `list`, `workers`
  (`--wait`, `--out`, `--timeout`).
- MCP: `jev_submit`, `jev_batch`, `jev_get`, `jev_list`, `jev_cancel`, `jev_workers` (`apps/jev/src/mcp.ts`).
- HTTP (`apps/jev/src/http.ts`): `/mcp`, `GET /v1/jev/health`, `GET|POST /v1/jev/jobs`, `POST /v1/jev/batches`,
  `GET /v1/jev/jobs/:id`, `POST /v1/jev/jobs/:id/cancel`.
- Root scripts: `corepack pnpm jev:build`, `corepack pnpm jev <command>`, `corepack pnpm jev:serve`,
  `corepack pnpm jev:test`.

**Prove it.** `./dev test apps/jev src/http.test.ts`. Also `./dev test packages/jev src/service.test.ts`.

**Gotchas.**
- `JEV_SERVICE_TOKEN` is required when the service binds outside loopback; the client defaults to
  `JEV_SERVICE_URL=http://127.0.0.1:4318`.
- Host settings: `JEV_PORT`, `JEV_WORKERS` (default 4), `JEV_DATABASE_PATH` (default `.jev/jobs.sqlite`, git-ignored),
  `JEV_ALLOWED_ROOTS`, `JEV_REMOTE_ORIGINS`, `JEV_PROVIDER` (gateway or direct) with `AI_GATEWAY_API_KEY` or
  `JEV_API_KEY`. A real job is a paid model call.
- `jev` and `jev:serve` need `jev:build` first; `jev:serve` loads the owner-managed `.env`.
- Binary documents go through Knowledge Services capture first ([capture](capture-and-registration.md#capture-and-registration)).
- Errors include `IDEMPOTENCY_CONFLICT` and `WORKER_BOOT_FAILED`; the CLI exits 1 when a job failed or was cancelled,
  2 on error.
