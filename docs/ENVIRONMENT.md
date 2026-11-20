# Environment (database scope)

Values: `BellLabs/.secrets/aieng-db.env` and `biotech-db.env` (add the `KS_` prefix). Registry: [`config/env.registry.yaml`](../config/env.registry.yaml) (one entry per database variable; checked against the code by `packages/host/src/config/database.test.ts`). Names only here; values live in the owner's `.env`/secret store and are never committed or logged. Non-database variables (Neo4j, vendor keys, ports, `KS_BIOTECH_EXECUTOR_*`, `SUPABASE_STORAGE_BUCKET`, `CANONICAL_LOCAL_ONLY`, `VERIFICATION_*`) are out of scope of this document and unchanged.

## Plane selection

Names are `KS_{AIENG,BIOTECH}_DB_<ROLE>`. The plane is the application of the binding or operation, or of the process (`KS_APPLICATION`): `ai-engineer` -> `AIENG`, `biotech` -> `BIOTECH`.

**Local by default (SPEC-03 K3, 2026-11-18).** A process that names no application (`KS_APPLICATION` unset, which is how the API, MCP, worker, knowledge executor and CLI start unless their host sets it) uses `AIENG` restricted to loopback: every URL/DSN it reads must point at `localhost`, `127.x.x.x`, `::1` or a Unix socket, and a remote value is refused at load with `KS_DB_REMOTE_REQUIRES_APPLICATION: <name> points at a remote host ...`. It never reaches the remote silently. Set `KS_APPLICATION=ai-engineer` (or `biotech`) only in a process meant to reach that remote plane: the AWS worker task sets it ([infra/aws](../infra/aws/README.md)), and a Mission Control-generated executor environment that carries remote DSNs must set it too. A binding that names its `databaseUrlEnv` (`KS_AIENG_DB_COMPONENT_DSN` / `KS_BIOTECH_DB_COMPONENT_DSN`) names its application explicitly and so may reach that plane. Only the other plane's `COMPONENT_DSN` is read by a binding whose application is `biotech`. There are no aliases and no fallback to earlier names (`POSTGRES_URL`, `KNOWLEDGE_DB_URL`, `SUPABASE_*`, `KS_AI_ENGINEER_COMPONENT_DSN` and the rest are not read).

The only reader is `packages/host/src/config/database.ts` (`loadKsDatabaseConfig(env, application?)`, where `application` defaults to `KS_APPLICATION`; `resolveComponentDsn(env, variable, application?)`, exported from `@aiengineer/knowledge-host/config`). Callers use the resolved object. At load it validates shape and, when `KS_<PLANE>_DB_PROJECT_REF` is set, refuses (`KS_DB_PROJECT_REF_MISMATCH`) unless the ref appears in the host or user of every present URL/DSN. It logs one `ks.database.selected` line with only plane, ref and host(s) (silent when `NODE_ENV=test`). With no ref set (a disposable loopback database) the check is skipped.

## Names

Each role exists for both planes (`KS_AIENG_DB_*`, `KS_BIOTECH_DB_*`); `KS_APPLICATION` is one per process.

| Role | Secret | Read by | What breaks if unset |
| --- | --- | --- | --- |
| `KS_APPLICATION` (process-wide, not per plane) | no | the config module | the process is loopback-only; remote values are refused `KS_DB_REMOTE_REQUIRES_APPLICATION` |
| `PROJECT_REF` | no | startup check in the config module | nothing; the ref-consistency check is skipped |
| `URL` | no | worker artifact stores (`packages/host/src/server/worker.ts`), citation replay and verification read runtimes (`packages/host/src/server/knowledge.ts`, `packages/host/src/verification/api/*-runtime.ts`), knowledge executor storage (`apps/verification-executor/src/knowledge/context.ts`) | worker refuses `<name>_REQUIRED`; citation replay and verification reads stay disabled/refuse their `*_STORAGE_REQUIRED`; executor with `KNOWLEDGE_ARTIFACT_STORAGE=supabase` refuses `REMOTE_ARTIFACT_STORAGE_CONFIGURATION_REQUIRED` |
| `SECRET_KEY` | yes | same sites as `URL` | same as `URL` |
| `RUNTIME_DSN` | yes | API (`server/api.ts`), MCP (`server/mcp.ts`), worker, knowledge executor (`context.ts`) | MCP and worker refuse `<name>_REQUIRED`; API refuses in production and runs without persistence otherwise; the executor serves capture/artifact tools only |
| `ADMIN_DSN` | yes | disposable-database integration tests, `scripts/experiments/sprint-v/run.ts`, the jev course scripts, CI (`.github/workflows/verify.yml`), `turbo.json` env passthrough. No deployed process | those tests/scripts skip or refuse |
| `COMPONENT_DSN` | yes | binding factories through `bindingConnectionString` (`packages/host/src/knowledge-operation/backends.ts`) and `knowledge-verify grant-reviewer` | a binding that names it refuses `KNOWLEDGE_BINDING_DATABASE_REQUIRED`; `grant-reviewer` refuses `DATABASE_URL_MISSING` |
| `AIENG_DB_RELEASE_CHECK` (AIENG plane only, no `KS_` prefix: the contract's name) | no | the config module (`releaseCheck` on the resolved plane object); applied by `packages/host/src/config/database-release.ts` | nothing: the mode is `enforce`. See [release check](#release-check) |

A binding in `KS_KNOWLEDGE_BINDINGS_JSON` sets `databaseUrlEnv` to `KS_AIENG_DB_COMPONENT_DSN` or `KS_BIOTECH_DB_COMPONENT_DSN` (no other value validates). `grant-reviewer --database-url-env` takes the same two names.

<a id="release-check"></a>
## Release check

Every process that opens the AI Engineer database asks it for its release (`api.database_release()`) before it starts and refuses a release it was not built for (VER-S1; rule, processes and reporting: [database release check](../features/database-release-check.md#database-release-check)). `AIENG_DB_RELEASE_CHECK` sets the mode: `enforce` (default) refuses, `warn` starts and logs the verdict, `off` does not ask. Any other word, an empty value included, fails the load with `AIENG_DB_RELEASE_CHECK must be enforce, warn or off`. The range is the version of the vendored `@aiengineer/database-contract`; it is not a variable. The AI Engineer service and Mission Control read the same variable with the same meaning. A process on the `BIOTECH` plane never reads it. A disposable database that holds only the verification component states no release: point a process at it only with `AIENG_DB_RELEASE_CHECK=off`.

## Cloud deployment

Set exactly these names in the host environment (for AWS, the secret JSON keys in `infra/aws`: `DatabaseSecretArn` -> `KS_AIENG_DB_RUNTIME_DSN`; `WorkerRuntimeSecretArn` -> `KS_AIENG_DB_URL`, `KS_AIENG_DB_SECRET_KEY`). Remove the earlier names from the host; they are ignored. The AWS template does not set `AIENG_DB_RELEASE_CHECK`, so a deployed process enforces the [release check](#release-check). Mission Control's generated executor env must emit `KS_AIENG_DB_COMPONENT_DSN` / `KS_BIOTECH_DB_COMPONENT_DSN` and matching `databaseUrlEnv` values.

## Test-only variables (unchanged, fake loopback values)

`KS_TEST_*`, `WI05_*`, `KS_REQUIRE_*`. Integration tests and the Sprint V proof script that create databases read `KS_AIENG_DB_ADMIN_DSN` only through `disposableAdminDsn()` (`packages/knowledge-db-contract/src/disposable-admin.ts`): unset, the suites skip; loopback, they run; a remote value fails the suite with `DISPOSABLE_ADMIN_DSN_REMOTE_REFUSED` before any connection. The fixture hosts keep their own `requireLoopback` guard; the `RUN_LOCAL_PERSISTENCE_TESTS` suites open `PostgresCanonicalRepository` with `localOnly: true`.
