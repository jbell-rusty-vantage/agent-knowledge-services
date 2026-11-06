# ADR 0004: Transport call graph

Status: accepted

This specializes [ADR 0001](./0001-runtime-and-deployment.md): API, MCP, CLI, and workers share application packages; MCP does not call a sibling HTTP endpoint; cross-repository calls use the versioned HTTP contract.

Numbering is 0004 because [0003](./0003-embedding-retrieval-evaluation.md) already records embedding, retrieval, and evaluation.

## Decision

**In-process Knowledge Services servers call `packages/application`. Out-of-process callers call the HTTP API through `KnowledgeClient`.**

The API always calls application. CLI and MCP expose similar verbs; they do not share one runtime.

```text
Out of process                          In-process KS servers
----------------                        ---------------------
Laptop CLI remote  --KnowledgeClient--> apps/api ----+
Eve / Mission Control / other repos ---KnowledgeClient-->    |
                                                    apps/mcp ----+--> packages/application
                                                    workers  ----+

Laptop offline (no API)
-----------------------
CLI demo / attestation / benchmark diff --> application / verification (frozen files)
```

| Surface | Where it runs | What it calls | What it must not call |
| --- | --- | --- | --- |
| API | KS server with Postgres | application use cases, then persistence | `KnowledgeClient` (no self-HTTP) |
| MCP | KS server with Postgres | the same application functions the API uses | `KnowledgeClient` / the sibling API (the temporary shim was removed in cleanup unit 3) |
| Workers | KS server | application | HTTP API for their own use cases |
| CLI remote | Operator laptop, no DB | `KnowledgeClient` → HTTP API | application persistence, `POSTGRES_URL` |
| CLI local (`demo`, `attestation-*`, `benchmark diff`) | Laptop, offline | application / verification on frozen files | HTTP, tokens, the remote catalog |
| Eve / Mission Control / other repos | Another process | `KnowledgeClient` → HTTP API | KS internal packages |

`@aiengineer/knowledge-client` is the out-of-process SDK only. It is not MCP’s long-term seam, not the API, and not workers.

`packages/application` is the in-process use-case module. API route handlers and MCP tool handlers are thin adapters over the same functions.

Do not publish a verification-only client package. Split `client.ts` later as file hygiene, not as a second runtime.

## Freeze

- New MCP tools must not add `apiClient` / `KnowledgeClient` methods.
- New remote CLI commands may use `KnowledgeClient`.
- New API and MCP behavior goes through application first; HTTP and MCP both call it.
- The MCP verification HTTP loop (`createApiClient` in `apps/mcp`) was a temporary shim while ownership and some admission lived in API HTTP handlers. Cleanup unit 3 removed it (2026-09-27): MCP has no API client, and an API/MCP parity test covers every former shim row.

A dated inventory of later refactors is [transport-call-graph-refactor-snapshot-20260916.md](./transport-call-graph-refactor-snapshot-20260916.md). That file is a snapshot and will go stale.

## Addendum 2026-09-27: enforcement through `packages/host`

Status: accepted. Details and sequencing: [`docs/operations/package-cleanup/FINAL-LAYOUT.md`](../operations/package-cleanup/FINAL-LAYOUT.md) §4.

The rule above is unchanged. What was missing is one place that builds application with its adapters, so each app wired its own runtime and logic collected in whichever app did the wiring (API-local ownership and admission gates, the API-local retrieval executor, duplicated `*-runtime.ts` files in API and worker, worker imports of algorithm packages, and the MCP `createApiClient` shim that depends on them).

- `packages/host` (absorbs `packages/config`) exposes `createHost(profile)` with profiles `server` (Postgres + Supabase) and `local` (file store, offline). It returns application services grouped by tool group (`knowledge`, `verify`, `db`, `operations`) and the worker activity registry.
- API, MCP, and worker import only `host` and `contracts`. CLI offline commands and MCP stdio use the `local` profile. CLI remote and every out-of-process caller keep using `KnowledgeClient`.
- Handlers parse with `contracts`, build an `OperationContext`, call one application function, and map the result. Error codes live in `contracts`; handlers contain no SQL or authorization logic.
- Durable work goes through `operations.submit`; the worker is a lease loop over the activity registry.
- The MCP `createApiClient` shim is removed once ownership, admission, and retrieval execution are application ports (FINAL-LAYOUT unit 3). Done in unit 3; the `local` profile and CLI/MCP stdio remain unit 5.
