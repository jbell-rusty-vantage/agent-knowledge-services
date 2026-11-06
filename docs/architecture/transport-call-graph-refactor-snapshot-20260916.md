# SNAPSHOT: transport call-graph later refactors

Verification mutation, operation/status, and `retrieval.plan_validate` unwind has started; this snapshot is not current implementation truth.

**This is a snapshot dated 2026-09-16. It will go stale.** Do not treat it as current implementation truth after further edits. The accepted rule is [0004-transport-call-graph.md](./0004-transport-call-graph.md). This file only records what a later refactor must move, as inspected that day.

Five explore passes produced the inventory. They are not a substitute for re-reading the code.

## Already adheres (do not undo)

- **API production** never constructs `KnowledgeClient`. Verification writes already call `VerificationOperationApplicationService.submit*` in `packages/application/src/verification/operations/verification-service.ts`.
- **KS worker** and **verification-executor** call application in-process. No client import.
- **CLI remote** constructs `KnowledgeClient` and talks HTTP. No `POSTGRES_URL`, no persistence.
- **CLI local** (`demo`, `attestation-*`, `benchmark diff`) stays on application/verification over frozen files.
- **Mission Control worker** and **mission-kernel** use `KnowledgeClient` against `KNOWLEDGE_API_URL`. Correct out-of-process.
- **MCP pipeline writes** (`source.discover`, `vector_store.create`, promotions, and other admitted catalog kinds) already call `operationService.submit` in-process.
- **Eve host** (`research_ingestion_systems_agent/tools/team/t14-platform-host.mjs`) wiring MCP `createApiClient` to the API is an out-of-process host, not a KS server bug.

## Later refactor — MCP (the real unwind)

MCP is the only in-process KS production server that uses `KnowledgeClient`. `apps/mcp/src/index.ts` `createMcpRuntime` always builds `createApiClient`.

**Unwind when application is already there (wire, do not invent):**

- 13 verification mutation tools → existing `submitCaptureSource`, `submitParseArtifact`, `submitVerifyClaims`, and the other `VerificationOperationApplicationService.submit*` methods. MCP never injects that service or a verification-admitted operation port.
- Most verification reads → existing `*ReadService` classes. MCP needs the same ownership authorizer the API runtimes already compose.
- `knowledge_get_verification_operation`, `embedding.run_status`, `promotion.status` → `operationService.get` already on MCP. HTTP is a wasteful hop.
- `retrieval.plan_validate` → `RetrievalPlanSchema.parse` / `validateRetrievalPlan` (schema-only on the API).

**Blocked until something is lifted out of API-local files:**

- `verificationContext()`, `apps/api/src/verification-ownership.ts`, and `is*RequestAdmitted` SQL gates in `apps/api/src/index.ts`. Without these as application ports, MCP cannot call `submit*` safely.
- Decision read and provider-reconciliation apply/get: composition lives in `apps/api/src/verification-adjudication-decision-runtime.ts` and `verification-provider-reconciliation-runtime.ts`. Application has admission/prep only.
- `retrieval.search` → `CanonicalRetrievalExecutor` is API-local (`apps/api/src/retrieval-executor.ts`).
- Retrieval/evidence/eval reads (`getRetrievalRun`, `getEvidencePacket`, citation replay, evaluation failures) → persistence wrapped only in API handlers; no application read port.

`createApiClient` stays until those seams exist. New MCP tools must not add more `apiClient` methods.

## Later refactor — CLI (hygiene; graph already right)

- Delete `CliKnowledgeClient` (hand-copied methods, all `Promise<unknown>`) in `apps/cli/src/commands.ts`. Use `KnowledgeClient` or a `KnowledgeClientPort` from the client package.
- Split catalog vs dispatch; make dispatch a table.
- `index.ts` local/mixed commands are argv special-cases, not catalog entries. Keep them outside `CLI_COMMANDS`. Lazy-import so remote invocations do not load demo/attestation/application.
- `benchmark capture` is two commands: catalog `captureSource` vs `diagnostics-companies` mixed HTTP plus local proposal. Do not fold the mixed path into `dispatchCliCommand`.
- Optional later: route pipeline `submit` kinds through existing typed client path methods (`discoverSources`, `startEmbeddingRun`, …) instead of `submitOperation` → `/v1/operations`.

## Later refactor — client (file hygiene, not a second runtime)

- Keep one `KnowledgeClient` class. Extract `http.ts`, optionally export `KnowledgeClientPort`, split files by cluster. Do not change URLs, bodies, or header names in that pass.
- `#request` emits `x-eve-session/turn/tool-call-id`. `#verificationHeaders` emits `x-external-*`. The API reads `x-external-*` only. Unifying that is a behavior change, not a rename.
- `ScopedKnowledgeClient` covers older methods; only `aiengineerapp` acceptance called `.scoped()` on the snapshot date. Finish it or stop advertising it.
- Pipeline wrappers CLI never calls are not automatically dead; dedicated API routes still exist. Delete or route CLI through them in a later decision, not silently.

## Out of scope for any adhere pass

- KS proof scripts that construct `KnowledgeClient` against a listened API.
- Mission Control vendored client plus cancel/receipt poll.
- API integration test `apps/api/src/tests/consumer-transports.integration.test.ts`.
- Profile-capture (`captureVerificationSourceWithProfile`): CLI mixed command only; MCP has no tool for it.
