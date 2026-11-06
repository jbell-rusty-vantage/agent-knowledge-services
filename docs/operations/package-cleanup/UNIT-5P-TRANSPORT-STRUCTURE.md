# Slice 5P — transport structure before the folds

Status: delivered and validated, 2026-10-01. Coordinator specification for slice 5P of the [quality plan](./APP-AND-SKILL-QUALITY.md#5p--transport-structure-before-the-folds-new-slice-before-5d1). Branch `refactor/ks-unit-5p-transport-structure` from local `main` `d7f55e4` (5C and Q0 merged). Rules: [UNIT-5-SLICES.md](./UNIT-5-SLICES.md#rules-for-every-slice). Progress: [ledger](./workspace/PROGRESS.md).

Structure only. Every API route, MCP tool behavior, CLI command, status code, problem code and message stays the same, except for the two recorded fixes (§6) and the MCP tool names (§4). The Q0 gates (format, lint ratchet, boundaries) may only improve.

## Tasks, in order

One implementation worker at a time. Each task is committed before the next starts, and each ends with the targeted suites of the packages it touched plus `pnpm format:check`, `pnpm lint` and, after a build, `pnpm boundaries`.

| Task | Result | Main paths |
| --- | --- | --- |
| T1 | Golden error-mapping tests, recorded against today's behavior before any move | `apps/api/src/tests/golden-errors.test.ts`, `apps/mcp/src/tests/golden-errors.test.ts` |
| T2 | Catalog as an application module | `packages/application/src/operations/catalog.ts`, `packages/host/src/local/`, `apps/mcp/src/tests/operation-catalog*.ts` |
| T3 | MCP tool table and the `index.ts` split (names unchanged) | `apps/mcp/src/**` |
| T4 | MCP group-prefix names (§4), no aliases | `apps/mcp/src/**`, catalog, parity/inventory tests, `skills/`, docs |
| T5 | API route modules, plugins, the route helper and deduplicated guards | `apps/api/src/**` except tests |
| T6 | API test support and moves | `apps/api/src/tests/**`, `apps/api/src/auth.ts` |
| T7 | The two recorded fixes, each with its own test | `apps/api/src/a2a-http.ts`, the 500 path |

## 1. Golden error-mapping tests (T1)

Pin today's error behavior so the moves in T3–T6 cannot change it silently. For the API: for each route group (operations, knowledge reads/mutations, retrieval, vector stores, verification mutations, verification reads, adjudication, benchmark, A2A, demo, system), at least one case each for missing/invalid credentials, forbidden actor/tenant, invalid body or query (schema failure), unknown resource, a capability that is not admitted or not composed (503 vs `CAPABILITY_NOT_ADMITTED`, as each route does today), and an unexpected internal error. Assert status, `content-type`, `code` and the exact `detail`/message text and correlation echo. Where today's behavior is inconsistent (the quality review lists some), pin it as is and name it in the test title; do not fix it in 5P. For MCP: the same classes through an in-process client — `isError`, the structured error payload and message — for at least one tool per current name group. The tests reference MCP tools through one lookup table so T4 changes names in one place.

## 2. Catalog module (T2)

- Move the data, types and `transportState` from `apps/mcp/src/tests/operation-catalog.ts` to `packages/application/src/operations/catalog.ts`, exported from the application barrel (`operationCatalog`, `CatalogOperation`, `Binding`, `Group`, `Admission`, `Profile`, `TransportState`, `transportState`, `declaredApiRequests`).
- `localProfileState` depends on host's capability matrix, and application must not import host. It moves to `packages/host/src/local/` (exported from host's root and `./local` entries) and takes a `CatalogOperation`.
- `operation-catalog.test.ts` stays a test in `apps/mcp/src/tests/`. Its relative imports of other apps' `src/` are recorded Q0 boundary violations; T2 must not add any. Removing them needs the executor and CLI surfaces to be importable through packages, which is 5D/5H work; record what remains.
- Update references in `UNIT-5-SLICES.md`, `DEEPAGENTS-READINESS.md` (DR2), CODE-MAP sources (`.agent-docs/modules.json`, coordinator-owned) and the inventory scripts' snapshot path.

## 3. MCP tool table and split (T3)

- `ToolDefinition { name, group, operation, inputSchema, authority, description, run }` in `apps/mcp/src/tools/definition.ts`; groups in `tools/{knowledge,verify,operations,system}.ts` (`db` is created by 5D1); one shared context schema; one error mapper in `errors.ts`; the Fastify and Vercel hosts in `server/{http,vercel}.ts`. `index.ts` keeps composition only.
- The name-based if/else dispatch becomes table lookup. A test checks the registered tool set against the catalog's MCP bindings (both directions: every registered tool has a row; every `on`/`failsClosed` MCP binding is registered) so drift fails.
- Descriptions: keep today's text in T3 (it is behavior agents see); T4 may replace the templated "Bounded … workflow" descriptions with the operation's real purpose, recorded in the name table.

## 4. MCP tool names (T4) — decided table

Developer decision (2026-09-29): group prefixes `knowledge_*`, `verify_*`, `db_*`, `jev_*`, no aliases. Coordinator rule for the per-tool table: **the MCP name is the `ks` command path joined with underscores** (`ks knowledge retrieve search` → `knowledge_retrieve_search`), so the `ks` table in `apps/cli/src/ks-commands.ts` is the one naming source. Tools with no `ks` command follow the same pattern from their operation. The prefix is the `ks` group, not the catalog group (the two `operations.status` tools are read through `ks knowledge …`). No resulting name equals an executor tool name that 5D3 folds (`verify_claims`, `verify_extraction`, `verify_check_report`, `verify_run_status`, …); 5D3 records its own table.

| Old | New |
| --- | --- |
| `source.discover` | `knowledge_source_discover` |
| `source.resolve_identity` | `knowledge_source_resolve` |
| `source.fetch` | `knowledge_source_fetch` |
| `source.inspect_capture` (declared) | `knowledge_source_inspect_capture` |
| `source.compare_captures` (declared) | `knowledge_source_compare_captures` |
| `source.propose_vetting` | `knowledge_source_vet` |
| `document.convert` | `knowledge_document_convert` |
| `document.inspect_representation` (declared) | `knowledge_document_inspect` |
| `document.compare_representations` | `knowledge_document_compare` |
| `document.request_manual_review` (declared) | `knowledge_document_request_review` |
| `chunk.strategy_list` | `knowledge_chunk_strategies` |
| `chunk.preview` | `knowledge_chunk_preview` |
| `chunk.compare` | `knowledge_chunk_compare` |
| `chunk.inspect` (declared) | `knowledge_chunk_inspect` |
| `chunk.create_intent` | `knowledge_chunk_build` |
| `embedding.model_list` (declared) | `knowledge_embed_models` |
| `embedding.estimate` (declared) | `knowledge_embed_estimate` |
| `embedding.create_intent` | `knowledge_embed_run` |
| `embedding.run_status` | `knowledge_embed_status` |
| `promotion.submit` | `knowledge_promotion_propose` |
| `knowledge.propose_domain_mapping` | `knowledge_promotion_propose_domain_mapping` |
| `knowledge.propose_claims` | `knowledge_promotion_propose_claims` |
| `knowledge.propose_entity_links` | `knowledge_promotion_propose_entity_links` |
| `promotion.status` | `knowledge_promotion_status` |
| `retrieval.search` | `knowledge_retrieve_search` |
| `retrieval.plan_validate` | `knowledge_retrieve_plan` |
| `retrieval.explain_run` | `knowledge_retrieve_explain` |
| `retrieval.read_run` | `knowledge_retrieve_run` |
| `retrieval.build_evidence_packet` | `knowledge_retrieve_build_packet` |
| `retrieval.read_evidence_packet` | `knowledge_retrieve_packet` |
| `retrieval.replay_citations` | `knowledge_retrieve_citations` |
| `vector_store.create` | `knowledge_store_create` |
| `vector_store.add_documents` | `knowledge_store_add_documents` |
| `vector_store.ingestion_status` | `knowledge_store_status` |
| `vector_store.search` (declared) | `knowledge_store_search` |
| `vector_store.evaluate` | `knowledge_store_evaluate` |
| `evaluation.generate_query_candidates` | `knowledge_eval_generate` |
| `evaluation.run_experiment` | `knowledge_eval_run` |
| `evaluation.compare_experiments` | `knowledge_eval_compare` |
| `evaluation.inspect_failures` | `knowledge_eval_failures` |
| `knowledge_verify_claims` | `verify_citations` |
| `knowledge_verify_extraction` | `verify_extract` |
| `knowledge_verify_metric` | `verify_metric` |
| `knowledge_verify_report` | `verify_report` |
| `knowledge_get_verification_operation` | `verify_status` |
| `knowledge_get_verification_run` | `verify_run` |
| `knowledge_get_verification_manifest` | `verify_manifest` |
| `knowledge_list_verification_cases` | `verify_cases` |
| `knowledge_get_verification_case` | `verify_case` |
| `knowledge_get_verification_evidence` | `verify_evidence` |
| `knowledge_get_verification_claims_result` | `verify_claims_result` |
| `knowledge_get_verification_report_result` | `verify_report_result` |
| `knowledge_parse_artifact` | `verify_artifact_parse` |
| `knowledge_extract_structured_data` | `verify_extraction_run` |
| `knowledge_get_structured_extraction` | `verify_extraction_show` |
| `knowledge_request_adjudication` | `verify_adjudication_request` |
| `knowledge_get_adjudication` | `verify_adjudication_get` |
| `knowledge_record_adjudication_decision` | `verify_adjudication_decision` |
| `knowledge_get_adjudication_decision` | `verify_adjudication_get_decision` |
| `knowledge_inspect_audit_bundle` | `verify_bundle_inspect` |
| `knowledge_get_audit_inspection` | `verify_bundle_show` |
| `knowledge_replay_run` | `verify_bundle_replay` |
| `knowledge_run_benchmark` | `verify_benchmark_run` |
| `knowledge_get_benchmark_run` | `verify_benchmark_show` |
| `knowledge_get_benchmark_manifest` | `verify_benchmark_manifest` |
| `knowledge_compare_benchmark_runs` | `verify_benchmark_compare` |
| `knowledge_get_benchmark_comparison` | `verify_benchmark_comparison` |
| `knowledge_capture_source` | `verify_benchmark_capture` |
| `knowledge_apply_provider_reconciliation` | `verify_reconciliation_apply` |
| `knowledge_get_provider_reconciliation` | `verify_reconciliation_show` |

The six `jev_*` tools (Jev's own server) and the executor's tools (its own server until 5D) are unchanged here. If a `ks` name differs from this table when T4 starts, the `ks` name wins and the difference is recorded. Update the catalog rows, parity rows, the golden tests' lookup, inventories, `skills/` and the platform-cli skill references, DR2 notes and the README surface lists in the same task; `node skills/check.mjs` must pass.

## 5. API structure (T5, T6)

- `plugins/{correlation,auth,problem}.ts`; `http/{route,problem-map,read-map}.ts`; `routes/<group>/*.ts`, each exporting `register(server, services)`. `server.ts` keeps `buildServer` as composition: it creates Fastify, installs the plugins and calls each group's `register`.
- `ServerOptions` becomes the intersection of per-group dependency interfaces declared next to their routes (`RetrievalRouteServices`, …); `apiServerOptions(host)` keeps assembling it from host. Tests keep constructing `buildServer` with partial services. Behavior preserved, including today's in-memory defaults (flagged "do not carry over" for 5D; not changed here).
- A declarative `route({ method, url, access, params, query, body, call, map })` helper replaces the repeated `requireAccess` and empty-query parsing; one `sendProblem` sets `application/problem+json`. Where a route today replies without that content type, the golden test pins the current header, and T5 records whether the single `sendProblem` changes it; any change is listed as a behavior change in the ledger, not hidden.
- One tenant/actor/correlation guard and one admission helper replace the repeated blocks in place (moving the policy into application is 5D work). The profile-capture route uses the shared bearer path.
- T6: `apps/api/src/tests/support/` for identities, tokens and DB fixtures; one DB gate variable for the API suites (`RUN_LOCAL_PERSISTENCE_TESTS` and the `DATABASE_URL`+storage gate unified; record the choice); move `src/verification-benchmark-reads.test.ts` into `src/tests/`; move the ten `auth.ts` shim imports to `@aiengineer/knowledge-host/config` and delete the shim. Every moved test identity is recorded in the slice inventory.

## 6. Recorded fixes (T7)

1. **A2A retrieval validation.** A2A retrieval tasks go through `submitCanonicalRetrievalRun`, so they get the HTTP route's `RetrievalRunInputSchema` validation and `retrieval: "v1"` check. Test: an A2A retrieval task with an input the HTTP route rejects is rejected the same way (status/code as A2A reports failures today — record it).
2. **Logged 500s.** The API's unexpected-error branch logs the error with its correlation id through a logger (not Fastify's request logging; no secrets, no request bodies) while the client response stays the same `INTERNAL_ERROR` problem. Test: an injected failing service produces one log record carrying the correlation id and error, and the unchanged response.

## Exit

- `server.ts` and MCP `index.ts` are composition-only; no route/tool/command lost; catalog, API/MCP parity, no-HTTP-shim and golden error tests pass unchanged apart from the recorded name table and fixes.
- Inventory (`unit5p-inventory.mjs`): moved/renamed tests listed, no missing identities; catalog rows differ only by the MCP names in §4.
- The full sequential graph with only the retained replay failure; examples; `node skills/check.mjs`; installed `ks` smoke; format/lint/boundaries not worse; docs check.

## Delivered structure and decisions

The canonical operation table now lives in `packages/application/src/operations/catalog.ts`; host owns local-profile state. MCP registers typed tool definitions from `tools/` and composes its transports through a short `index.ts`. All 70 platform MCP tools use the approved group-prefix names, with no old-name aliases; the 95 `ks` command names are unchanged. The API's `server.ts` composes route-group registrars. Shared auth, correlation, problem mapping, admission, read mapping and declarative route registration live under `plugins/` and `http/`. Group service interfaces compose `ServerOptions`, while the host still assembles optional services, so partial test servers and the existing in-memory defaults remain valid until 5D.

API tests now live under `src/tests/`, with shared identity, token-header and disposable persistence support. The benchmark-read test moved there; test imports use `@aiengineer/knowledge-host/config` and the deprecated `auth.ts` shim is removed. `RUN_LOCAL_PERSISTENCE_TESTS=1` is the single opt-in gate; all enabled database suites use `KS_TEST_DATABASE_URL` after the disposable-project identity check. Storage suites additionally require checked `KS_TEST_SUPABASE_URL` and `KS_TEST_SUPABASE_SECRET_KEY`. No shared database is an allowed test target.

The two intentional behavior fixes are isolated: A2A retrieval uses `submitCanonicalRetrievalRun`, so invalid retrieval input and a non-v1 retrieval version fail before submission; unexpected API 500s emit a sanitized error-name record with the correlation id, while the client receives the same `INTERNAL_ERROR` problem. Golden error tests pin the other historical status, content-type, title, detail and correlation mappings. The route helper leaves response mapping to each group, including the historical replies that do not use `application/problem+json`; the shared `sendProblem` applies where a route already used that type.

The [inventory comparison](./workspace/evidence/unit5p-comparison.json) normalizes only the 70 recorded MCP renames and the benchmark test's path move. It finds no missing tests, changed outcomes, lost exports, route/command/catalog rows or cycles. The [validation record](./workspace/evidence/unit5p-validation.json) documents the single retained replay failure and passing quality and installed-package checks.
