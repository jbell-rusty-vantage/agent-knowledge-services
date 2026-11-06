# Unit 3 specification: application use cases and MCP without HTTP shims

Status: reference. Implemented on `refactor/ks-unit-3-application-and-mcp` and integrated locally on 2026-09-27; the delivery record and exact validation are in the [ledger](./workspace/PROGRESS.md), and what was delivered, the recorded decisions and the carried items are in [delivered use cases and decisions](#delivered-use-cases-and-decisions) below. The next unit is [Unit 4](./UNIT-4-APPLICATION-ORDER-AND-CATALOG.md). Original specification follows, prepared at the end of Unit 2. Parent: [FINAL-LAYOUT.md](./FINAL-LAYOUT.md), unit 3. Previous unit and its seams: [UNIT-2-HOST-COMPOSITION.md](./UNIT-2-HOST-COMPOSITION.md). Progress: [workspace/PROGRESS.md](./workspace/PROGRESS.md).

## Scope and entry gate

Create `refactor/ks-unit-3-application-and-mcp` from integrated main, or inspect and safely resume it. Move the API-owned use cases that Unit 2 injects through typed seams into `packages/application`, compose them in host, and make MCP call application instead of the API over HTTP. Delete MCP `createApiClient`/`apiClient` and its `KnowledgeClient` runtime dependency. This unit changes MCP's internal call path, not its tool names, schemas or authorization outcomes.

Before editing, rerun the registered-replay test and record the missing historical judge receipt outcome. The Unit 1/2 exception does not carry forward automatically: make and record an explicit continuation decision; no new failure, substitute receipt or weakened assertion is permitted.

Out of scope: application folder regrouping, naming pass and catalog parity (Unit 4); executor fold, CLI/local profile, Eve adaptation and Jev transport consolidation (Unit 5); skills (Unit 6); proofs (Unit 7); worker activity extraction. Do not build the pre–Mission Control experiment runner here.

## Seams to retire

Unit 2 left these explicit seams. Each moves once, with its tests, into application (use case/port) and host (wiring).

| Current owner | Seam | Unit 3 destination |
| --- | --- | --- |
| `apps/api/src/retrieval-executor.ts` | `createCanonicalRetrievalExecutor` | Application retrieval use case over a retrieval repository port; host injects `PostgresCanonicalRepository` and the embedding adapter. Keep `RetrievalUnsupportedError`, reranker validation and failure recording semantics. |
| `apps/api/src/verification-drift-revalidation-runtime.ts` | `createVerificationDriftRevalidation` | Application service-only drift queue; host supplies outbox and component ports. Service-identity allowlist remains the authority. |
| API `verification-{provider,semantic}-reconciliation-runtime.ts`, `verification-{structured-extraction,audit-inspection,claims-report,capture,adjudication}-reads-runtime.ts`, `verification-adjudication-decision-runtime.ts`, `verification-benchmark-capture-profile.ts` | `createVerificationUseCases` | Application read/decision/reconciliation services using the existing `createVerificationOperationReadAuthorizer`, ownership resolver and `actorsMatch`/`isAuthorized` rules. SQL stays in persistence; construction in host. |
| `apps/api/src/verification-ownership.ts` | Eve binding adapter | Host wiring of `resolveEveVerificationBinding` into the application ownership resolver. `isVerifiedEveRuntimeRetry` is imported from application by the API. |

Preserve every configuration failure code and its single-fault behavior (for example `VERIFICATION_BENCHMARK_CAPTURE_PROFILE_CONFIGURATION_REQUIRED`, `VERIFICATION_ADJUDICATION_DECISION_OWNERSHIP_REQUIRED`). Move tests with their implementation and retain identities, as Unit 2's inventory did.

## MCP HTTP shims to replace

Inventory at Unit 2 exit (`apps/mcp/src/index.ts`). Every row needs an in-process application call with the same tenant, actor-binding and admission failures that the API route applies today.

| MCP tool(s) | Current HTTP call(s) | In-process target |
| --- | --- | --- |
| `retrieval.search`, `retrieval.explain_run`, `retrieval.read_run` | `createRetrievalRun`, `getRetrievalExplanation`, `getRetrievalRun` | Retrieval use case (above) and run reads through `operationService`/resource reader. Synchronous `retrieval_run` stays API-owned kind semantics. |
| `retrieval.read_evidence_packet`, `retrieval.replay_citations` | `getEvidencePacket`, `replayEvidencePacketCitations` | Host `knowledge.getEvidencePacket` / `replayEvidencePacketCitations`; citation replay stays remote object custody. |
| `evaluation.inspect_failures`, `vector_store.ingestion_status` | `getEvaluationFailures`, `getVectorStoreOperation` | Resource-read application functions over `ResourceReadRepository`. |
| Provider reconciliation apply/get | `applyProviderReconciliation`, `getProviderReconciliation` | Provider reconciliation application service. |
| Verification reads (structured extraction, audit inspection, claims/report results, adjudication subject/decision, benchmark run/manifest/comparison, run/manifest/cases/case/evidence) | `get*` client methods | Application read services already composed for the API (Unit 2 host `verify.*` plus retired seams). |
| Twelve verification mutations when in-process admission is absent, and record-decision without `isAdjudicationDecisionAdmitted` | `verifyClaims` … `replayVerificationRun`, `recordAdjudicationDecision` | Remove the HTTP fallback. When in-process capability is not configured, return the existing `CAPABILITY_NOT_ADMITTED` tool error. |

The API route is the behavioral reference for each row. Build a table-driven parity test that invokes the API route and the MCP tool with identical fixtures for success, wrong tenant, actor mismatch, missing capability and not found. A tenant field from a request never becomes authority. `retrieval.plan_validate`, `chunk.strategy_list` and operation status tools are already in-process; keep them unchanged.

## Host and transport contract

- Host `createHost({ role: "mcp" })` returns the same `knowledge`, `verify` and `operations` groups the API role composes, minus transport-only pieces. Do not expose a raw pool.
- MCP keeps credential extraction, bearer-to-identity resolution, schemas, tool registration and error mapping. It no longer needs `KNOWLEDGE_API_URL` for tool execution; keep `apiPublicOrigin` only where the protocol still advertises the API origin (for example operation poll URLs), and record the decision.
- Remove `@aiengineer/knowledge-client` from MCP runtime dependencies once unused. `KnowledgeClient` remains the out-of-process contract for Eve, Mission Control and remote CLI.
- The API's `composition.ts` seams disappear; `apiServerOptions` maps host services only.

## Bounded implementation sequence

1. Record entry evidence: seam list above, MCP shim inventory (tool → client method), test identities for API/MCP/host/application/persistence, and the fixture reassessment.
2. Move retrieval execution and resource reads into application; wire in host; switch API and MCP retrieval/evaluation/vector-store tools. Validate and commit.
3. Move verification read, reconciliation, decision and drift use cases; wire in host; switch MCP verification reads and remove mutation HTTP fallbacks. Validate and commit.
4. Delete `createApiClient`/`apiClient`, remove the client dependency from MCP, update authored navigation, generate docs, write the bounded Unit 4 specification and update the ledger before local integration.

## Acceptance evidence

- Frozen install, typecheck and build pass; declared graph acyclic; host never imports apps; application/persistence never import host. MCP runtime source imports no `@aiengineer/knowledge-client`.
- No MCP tool issues an HTTP request to the API. Prove with a test that runs the MCP app with a fetch trap and exercises every former shim row.
- API/MCP parity tests cover success and each authority failure per row. Existing API, MCP, host, application and persistence suites keep their identities (moved tests mapped explicitly).
- Jev packages, app, client, CLI, six MCP tools and skill remain unchanged and their tests pass.
- Entire test graph sequentially with bounded workers; every failure and skip listed; fixture reassessment recorded separately. Examples, skill conformance, sandbox pack and installed offline CLI smoke pass.
- Update `.agent-docs` authored inputs and live concepts; generate and check navigation; `git diff --check` passes. Merge locally only after reviewed evidence.

## Pre–Mission Control experiment dependency

The bounded stage-graph experiment recorded in [NEXT-PACKAGE-CLEANUP.md](./NEXT-PACKAGE-CLEANUP.md) needs a fresh consumer to retrieve and replay citations through published MCP/CLI contracts. Unit 3's in-process MCP retrieval, evidence-packet and citation-replay tools are one of its service prerequisites. Unit 3 does not build or run the experiment.

## Delivered use cases and decisions

Recorded at Unit 3 exit. Code is authoritative; this section names what changed, the deliberate differences and what later units carry.

- **Application.** `access/api-access.ts` owns `isAuthorized`, `actorsMatch` and the role/action rules (host configuration keeps identity resolution and re-exports them). `retrieval/` owns `CanonicalRetrievalExecutor` over a `CanonicalRetrievalRepository` port (persistence re-exports the port shapes and `RETRIEVAL_SUPPORT_LIMITS` under their historical names), `submitCanonicalRetrievalRun` and `retrievalExecutionProblem`. `reads/` owns `createKnowledgeResourceReads`, `createVerificationResourceReads` and the shared read result (reason, status, code). `verification-context-binding.ts` binds a resolved context to the authenticated submission; `isAdjudicationDecisionReviewerActor`, the drift revalidation queue (over an outbox port) and the benchmark capture-profile policy moved from the API. `transportProblem` mirrors the API error handler's codes. Application's duplicate `actorsMatch` was removed.
- **Host.** `composeKnowledgeServices` and `composeVerificationServices` are shared by the API and MCP roles; `verification/api/` holds the read, reconciliation, decision, ownership (Eve binding), capture-profile and drift construction moved from `apps/api`, with their tests. The API seams (`ApiCompositionSeams`, `createVerificationUseCases`, the retrieval factory) are gone; construction order and configuration failure codes are unchanged. The MCP role composes the same `knowledge`, `verify` and `operations` groups minus callback replay, the service-only drift queue and API public-origin handling.
- **API.** `composition.ts` only maps host services onto `buildServer` options. Routes call the shared use cases and keep their statuses, problem codes, titles, content types and validation order.
- **MCP.** No API client: `createApiClient`/`apiClient` are deleted and `@aiengineer/knowledge-client` is a test-only dependency. Every former shim row runs in process; with its capability absent a tool returns `CAPABILITY_NOT_ADMITTED`, never an HTTP fallback. Decision: `KNOWLEDGE_API_URL` stays required only because accepted-operation poll links are rooted at the public API origin; MCP never calls it.
- **Tests.** `apps/mcp/src/tests/api-mcp-parity.test.ts` runs the API route and the MCP tool over identical fixtures for every former shim row (success, wrong tenant, actor authority, missing capability, not found), plus retrieval search, verification mutations and failure classification. `no-http-shims.test.ts` drives every former shim tool through the real MCP HTTP app with a fetch trap. Moved and renamed test identities are mapped in `workspace/evidence/unit3-inventory.mjs`.

Deliberate observable differences (recorded, not regressions):

1. MCP now applies the API route's trusted-context binding (tenant, correlation, idempotency key, actor, ownership hints, external execution) and reviewer rule before submission. Before, the in-process path rejected only a missing resolved context, and a non-reviewer service could reach decision admission.
2. MCP failures carry the API problem code as `{"code": …}` tool errors, instead of the API problem title relayed by the HTTP client. Uncaught failures are sanitized through `transportProblem` (for example `INTERNAL_ERROR`), so no internal message reaches the caller.
3. Missing capabilities: the API keeps its 503 codes (`INTERNAL_ERROR` for the resource store, citation custody and retrieval executor; `CAPABILITY_NOT_ADMITTED` for verification); MCP answers `CAPABILITY_NOT_ADMITTED`. An evidence packet without packet custody is `NOT_FOUND` on both.
4. Catalog tools carry a caller-asserted context actor that MCP rejects with `ACTOR_MISMATCH`; API GET routes have no asserted actor, and `POST /v1/retrieval-runs` rejects a mismatched envelope actor with 403 `FORBIDDEN`.
5. MCP startup now composes the verification read, reconciliation, decision and capture-profile services and the knowledge services, so it needs the API's verification read, Storage and gateway configuration for those tools and fails with the same configuration codes (for example `VERIFICATION_BENCHMARK_CAPTURE_PROFILE_CONFIGURATION_REQUIRED`). With decisions enabled it admits `verification_adjudication_decision` in process. [Deployment](../../verification/DEPLOYMENT.md) records this.
6. Tool descriptions that named the HTTP client were reworded; tool names and schemas are unchanged. `retrieval.search` submits the envelope the public client used to build (`expectedVersions` `{ api: "v1", retrieval: "v1" }`).

Carried to later units:

- **Unit 4:** the per-service ownership gates still live inside host `verification/api/*-runtime.ts` construction closures; extract them into application ports only with their tests. One error-code set in `contracts` (FINAL-LAYOUT §4.2) should replace `transportProblem` mapping in both transports.
- **Unit 5 (Eve):** `research_ingestion_systems_agent/tools/team/t14-platform-host.mjs` builds the MCP app with `createApiClient`; it must pass the in-process `knowledge` services instead (it already needed Unit 1's `packages/runtime` adaptation).
- **Unit 7:** transport proofs now compose MCP in process through `scripts/mcp-in-process-options.ts`; proofs remain outside `verify`, and their pre-existing type errors need the shared proof tsconfig.
- **Build hygiene:** Turbo can restore stale compiled `packages/acquisition/dist/*.test.js` from an old cache entry (Units 1–3); the acquisition build does not clean `dist`.
