# Database release check

**What it does.** Knowledge Services knows which AI Engineer database release it was built for, asks the database it
connects to which release it is before it starts, refuses to start on any other, and reports the release it runs on
(VER-S1, decision D-117, 2026-11-20). One release number covers the whole AI Engineer database: the contract version.
The database states it through `api.database_release()` (contract 0.12.0): `release`, a `state` word and what was
stamped and observed. The AI Engineer service and Mission Control apply the identical rule; all three run the cases
the contract package ships as `release-check.cases.json`. It applies to the AI Engineer database only, never to the
Biotech database.

| The database answers | Verdict | In `enforce` mode |
| --- | --- | --- |
| nothing (no function, another format, or it cannot be asked) | `unknown` | refuses to start |
| `release` is null | `unstamped` | refuses |
| a release outside this service's range | `incompatible` | refuses |
| in range, state `inconsistent` | `inconsistent` | refuses |
| in range, state `ahead`, `component_drift` or `unverifiable` | `ok` with a warning | starts and logs the warning |
| in range, state `current` | `ok` | starts |

**The range** is the `version` in `contract.version.json` of the vendored `@aiengineer/database-contract` package,
read from the installed package at run time (`serviceReleaseRange()`); no version number is written in this
repository's source. Until contract 1.0.0 a range is that exact version; `>=A.B.C <D.E.F` is the other form the rule
reads. Moving the pin (`vendor/`, the three manifests, the lockfile) moves the range.

**The mode** is `AIENG_DB_RELEASE_CHECK`: `enforce` (the default), `warn` (always start, log the verdict) or `off` (do
not ask the database). Any other word, an empty value included, is refused when the configuration loads. The name is
the contract's, shared by the three services, so it has no `KS_` prefix. It is read only by
`packages/host/src/config/database.ts` ([ENVIRONMENT](../docs/ENVIRONMENT.md#release-check)).

**Code.** The rule, the range, the read and the startup decision:
`packages/persistence/src/database-release.ts` (`inRange`, `releaseVerdict`, `checkMode`, `readDatabaseRelease`,
`serviceReleaseRange`, `checkDatabaseRelease`, `DatabaseReleaseRefused`), a port of the contract repository's
`scripts/database-release.mjs`. The pools ask without a tenant: `PostgresCanonicalRepository.databaseRelease()`
(`postgres.ts`) and `TenantPostgres.databaseRelease()` (`role-transaction.ts`). Where a process applies it:
`packages/host/src/config/database-release.ts` (`startOnAiEngineerDatabase` for an open pool,
`startOnAiEngineerDatabaseAt` for a DSN).

**Which processes check, and when.**

| Process | Where | When |
| --- | --- | --- |
| API (`apps/api`) | `createApiHost`, `packages/host/src/server/api.ts` | after composition, before the server listens; only with persistence |
| Platform MCP (`apps/mcp`) | `createMcpHost`, `server/mcp.ts` | after composition, before the app is built |
| Worker (`apps/worker`) | `createWorkerHost`, `server/worker.ts` | before the execution is built or anything is reconciled |
| Executor: `knowledge serve`, `knowledge-verify serve` and `mcp-stdio`, the `knowledge` CLI in local mode, the scoped custody host | `openKnowledgeServices`, `apps/verification-executor/src/knowledge/context.ts` | when the knowledge pool opens |
| Executor `ks.knowledge_operation.v2` with a binding on `KS_AIENG_DB_COMPONENT_DSN` | `createKnowledgeOperationSurfaceFromEnv`, `packages/host/src/knowledge-operation/config.ts` | once, before any backend opens its store |
| `knowledge-verify grant-reviewer --database-url-env KS_AIENG_DB_COMPONENT_DSN` | `provisionReviewerGrant`, `apps/verification-executor/src/reviewer-grant.ts` | before the grant is written |

A refusal is one error, `AIENG_DB_RELEASE_REFUSED`, that names the verdict and its reason, the database's release, its
state, this service's range and the variable that changes the mode. Every pool opened to ask is closed again.

**Where the release is reported.** Each surface carries `check`, `range`, `release`, `state`, `verdict`, `warning`
and `checkedAt`; the database is asked once, at startup.
- API: `databaseRelease` on `GET /readiness` and `GET /v1/system` (`ServiceStatus` in `packages/contracts/src/service.ts`).
- Platform MCP: `databaseRelease` on `GET /health`.
- Worker: `databaseRelease` on its `knowledge.worker.started` line.
- Executor: `knowledge.databaseRelease` on `GET /health` and in the line `serve` prints at startup.
- Every process: one `ks.database.release` JSON line on stderr with the reason (silent when `NODE_ENV=test`).
- `./dev status`: `contract.database_release` (the range, the mode in this shell). It asks no database;
  `./dev db query --plane <plane> --sql "select api.database_release()"` reads one read-only.

**Tests.** `packages/persistence/src/database-release.test.ts` (every shared case, the range, the read, the three
modes); `packages/persistence/src/role-transaction.test.ts` (the pool probe);
`packages/host/src/config/database.test.ts` (the variable, the registry and `.env.example`);
`packages/host/src/config/database-release.test.ts`; `packages/host/src/tests/composition.test.ts` (API, MCP and
worker refuse, warn and skip; Biotech is never asked);
`packages/host/src/tests/conformance/backends/backends.test.ts` (a binding on the component login);
`apps/verification-executor/src/database-release.test.ts` and `reviewer-grant.test.ts`;
`apps/api/src/tests/server.test.ts`; `apps/mcp/src/tests/host-lifecycle.test.ts`.

**Prove it.** `./dev test persistence src/database-release.test.ts` (offline: the shared cases from the vendored
package, the range read from its `contract.version.json`). Startup refusal with the repository's persistence double:
`./dev test host src/tests/composition.test.ts`.

**Gotchas.**
- A database that holds only the Knowledge Services verification component (a disposable PostgreSQL the component
  installer filled) has no `api.database_release()`: a process pointed at it through `KS_AIENG_DB_RUNTIME_DSN`, or a
  binding on `KS_AIENG_DB_COMPONENT_DSN`, refuses with verdict `unknown`. Set `AIENG_DB_RELEASE_CHECK=off` for such a
  target. Tests that construct `createAiEngineerPostgresBackend` or `createKnowledgeServices` directly are not asked.
- A lab built from drafts must be stamped before a service starts on it
  (`node scripts/database-release.mjs stamp --workdir <dir>` in the contract repository). Migrations applied after the
  stamp give state `ahead`: the service starts and warns.
- A database that cannot be reached at startup is verdict `unknown`: in `enforce` mode the process no longer starts
  with a lazy pool and fails later; it refuses at once.
- The check runs when the process starts, not on every request. A database that changes release under a running
  process is seen at the next start; the reported `checkedAt` says when it was asked.
- The login must be able to execute `api.database_release()`; the contract grants it to `app_reader`,
  `authenticated`, `pipeline_agent`, `verifier_agent`, `control_plane`, `executor_service` and `service_role`, never to
  `anon` or `PUBLIC`. A login without it is verdict `unknown` and the reason carries the database's error.
- Execution receipts do not carry the release: receipts are written by several executors with strict, digest-compared
  bodies and there is no single place that stamps environment facts on all of them.
