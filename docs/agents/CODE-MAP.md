<!-- BEGIN GENERATED: semantic-map -->
# Semantic code map

Generated from reviewed module descriptions and current selected source files. Package dependencies/exports/script names are extracted from manifests; relationships and ownership are authored. This is not a complete import graph or proof that a designed capability is implemented.

Paths below are repository-relative. Use the task routes, then search the module heading. Follow accepted architecture docs for decisions; proposed/reference/deprecated documents retain those labels.

## Task routes

- Change an HTTP/MCP/CLI verification surface: [contracts](#contracts) → [application](#application) → [api](#api) → [mcp](#mcp) → [cli](#cli)
- Change locator or evidence verification: [verification](#verification) → [verification-evidence-selection](#verification-evidence-selection) → [verification-deterministic](#verification-deterministic) → [verification-semantic](#verification-semantic)
- Debug worker retry or persistence: [worker](#worker) → [core](#core) → [persistence](#persistence)
- Change parsing and conversion: [preparation](#preparation) → [parser](#parser) → [docling](#docling)
- Change retrieval or embedding: [retrieval](#retrieval) → [policy](#policy)
- Find experiment commands: [script-experiments](#script-experiments)
- Change schema workspace, knowledge read, or ingestion: [knowledge-db](#knowledge-db) → [verification-executor](#verification-executor)
- Change the Sprint V verification core, component or binding: [knowledge-operation-protocol](#knowledge-operation-protocol) → [research-core](#research-core) → [knowledge-db-contract](#knowledge-db-contract) → [binding-aiengineer-postgres](#binding-aiengineer-postgres) → [binding-biotech-graph](#binding-biotech-graph)

## Modules

| Module | Source | Responsibility | State |
|---|---|---|---|
| [api](#api) | apps/api | Fastify HTTP transport. createApiRuntime composes through createHost (role api) and maps host services onto buildServer. | implemented |
| [cli](#cli) | apps/cli | The ks binary: remote knowledge/verify/db commands call KnowledgeClient over HTTP; the verification intent pipeline runs on host's local file-store profile, loaded lazily; offline demo, attestation and benchmark utilities use application or verification on frozen files. pack:sandbox builds the installable ks tarball. | implemented |
| [mcp](#mcp) | apps/mcp | In-process Streamable HTTP MCP tools. createMcpRuntime composes through createHost (role mcp), which supplies the same knowledge, verify and operations groups as the API role; MCP never calls the API. | implemented |
| [verification-executor](#verification-executor) | apps/verification-executor | Sandbox verification executor that also hosts schema, bounded-read, and ingestion operations on CLI, MCP, and HTTP, and serves ks.knowledge_operation.v2 (K01 over the Sprint V application services: register, assess, read, derive, apply, verify, status, cancel, receipt) with K07 issuer-credential validation and durable single-use credentials. | implemented |
| [worker](#worker) | apps/worker | Durable knowledge-operation execution and activity dispatch over host-composed adapters; verification runtime wiring stays in the worker execution factory. | implemented |
| [sources](#sources) | packages/sources | Source acquisition and inspection (folder renamed from packages/acquisition; npm name @aiengineer/knowledge-acquisition unchanged): HTTP and local-upload acquisition wired; inspect library for sealed bytes; repository, Firecrawl scrape, and paper execute remain unwired. | implemented |
| [application](#application) | packages/application | Composes knowledge use cases, capability admission, preparation, retrieval execution, shared resource reads, and verification surfaces, including tenant access rules, ownership and transport admission ports. | implemented |
| [preparation](#preparation) | packages/preparation | Artifact conversion, immutable document nodes, admitted chunk profiles and reconstructable-span quality checks. | implemented |
| [client](#client) | packages/client | Out-of-process typed HTTP SDK (@aiengineer/knowledge-client, folder packages/client) for the Knowledge Services contract. Laptop CLI, Eve, Mission Control, and other repos. Not the long-term seam for API, MCP, or workers. | implemented |
| [host](#host) | packages/host | Composition root: configuration and identity resolution, shared knowledge and verification composition, createHost for the server roles (API, MCP, worker) and the file-backed local profile, with owned lifecycle and the server/local/remote-CLI capability matrix; and the ks.knowledge_operation.v2 composition (./knowledge-operation: K01 service with the WI-03 trusted assessment transport observe/seal/decide/review/resolve, K07 issuer-credential validation with durable single use, the KnowledgeOperationBackend port with declared capabilities, the BackendRegistry the executable composes, the in-memory backend and env composition; ./knowledge-operation/conformance: the backend conformance suite). | implemented |
| [contracts](#contracts) | packages/contracts | Versioned Zod schemas and types shared by transports, application composition, and clients. | implemented |
| [knowledge-db](#knowledge-db) | packages/knowledge-db | Pinned schema workspace navigation, bounded read snapshots and deterministic ingestion through canonical temporal helpers. | implemented |
| [core](#core) | packages/core | Shared identity, digest, authority and state primitives; artifact custody, operation lifecycle and in-memory telemetry. | implemented |
| [retrieval](#retrieval) | packages/retrieval | Policy-scoped search, evidence-bound projections, embedding routes and receipts, and vector publication and rollback. | implemented |
| [evaluation](#evaluation) | packages/evaluation | Retrieval evaluations, benchmark statistics/comparisons, and human review structures. | implemented |
| [persistence](#persistence) | packages/persistence | Postgres, storage, operation ledger, verification records, and runtime wiring adapters. | implemented |
| [policy](#policy) | packages/policy | Authorization, capability, retrieval, promotion, selection-eligibility, and verification admission decisions. | implemented |
| [testkit](#testkit) | packages/testkit | Curated evaluation corpora, embedding bundles, retrieval fixtures, and operational test assets. | implemented |
| [verification](#verification) | packages/verification | Evidence verification algorithms: canonical primitives, staged deterministic bundle engine, selector resolution, extraction, report gates, evidence-closed semantic judging, providers, and provenance seal/replay. | implemented |
| [verification-canonical](#verification-canonical) | packages/verification/src/canonical | RFC 8785 canonical JSON and prefixed SHA-256 digests shared by every stage. | implemented |
| [verification-decimal](#verification-decimal) | packages/verification/src/decimal | Exact rational-decimal parsing, replay, tolerance, and rounding. | implemented |
| [verification-deterministic](#verification-deterministic) | packages/verification/src/deterministic | Staged mechanical bundle engine: index → capture integrity → runtime separation → evidence edges → assertions → metric graph → result. | implemented |
| [verification-evidence-selection](#verification-evidence-selection) | packages/verification/src/evidence-selection | Locates the evidence a VerificationSelector points at inside captured bytes: core text/JSON locators, projection-backed locators, and verification of resolver claims. | implemented |
| [verification-extraction](#verification-extraction) | packages/verification/src/extraction | Bounded schema admission and staged field, cross-field, and duplicate verification against immutable representation bytes. | implemented |
| [verification-provenance](#verification-provenance) | packages/verification/src/provenance | Audit-bundle seal/inspect/replay, recorded policy inputs, detached-seal benchmark publications, and DSSE/SLSA attestations. | implemented |
| [verification-report](#verification-report) | packages/verification/src/report | Claim decomposition acceptance and report-wide mechanical gates. | implemented |
| [verification-authority](#verification-authority) | packages/verification/src/authority | Source authority and corroboration assessments. | implemented |
| [verification-semantic](#verification-semantic) | packages/verification/src/semantic | Evidence-closed semantic verification: closure, authorization, judge ports, output lattice validation, cross-family reconciliation, drift, rescue, attribution. | implemented |
| [verification-providers](#verification-providers) | packages/verification/src/providers | Provider port, HTTP bounds, one bounded dispatch procedure, Gateway/Interfaze adapters, recorded/NLI judges, and conformance registry. | implemented |
| [docling](#docling) | services/docling | Pinned Docling Serve conversion deployment boundary. | implemented |
| [parser](#parser) | services/parser | Isolated native PDF geometry and HTML DOM parser (folder renamed from services/verification-parser; image tags unchanged); separate from Docling and OCR. | implemented |
| [script-experiments](#script-experiments) | scripts/experiments | Curated model-card verification experiments; run results are not canonical architecture. | partial |
| [skill-schema-explore](#skill-schema-explore) | skills/schema-explore | Progressive-disclosure procedure for navigating the pinned schema workspace without querying the database. | implemented |
| [skill-knowledge-db](#skill-knowledge-db) | skills/knowledge-db | Procedure for catalog reads and reproducible knowledge-read snapshots that an ingestion intent can cite. | implemented |
| [skill-knowledge-ingest](#skill-knowledge-ingest) | skills/knowledge-ingest | Procedure for composing, planning, applying, and verifying knowledge-ingestion intents through the executor. | implemented |
| [skill-knowledge-verification](#skill-knowledge-verification) | skills/knowledge-verification | Platform verification procedure with assertion/media routing, admitted operations, held outcomes and audit limits. | implemented |
| [skill-knowledge-acquisition-and-vetting](#skill-knowledge-acquisition-and-vetting) | skills/knowledge-acquisition-and-vetting | Source discovery, acquisition, sealed-byte inspection and vetting-proposal procedure across executor and platform surfaces; a fetch, seal or inspection is never admission. | implemented |
| [skill-knowledge-preparation-and-promotion](#skill-knowledge-preparation-and-promotion) | skills/knowledge-preparation-and-promotion | Conversion route, node inspection, admitted chunk-profile preview, content linking, embedding and promotion-proposal procedure over already stored bytes; a routing receipt or chunk preview is not admission. | implemented |
| [skill-knowledge-retrieval-and-evidence](#skill-knowledge-retrieval-and-evidence) | skills/knowledge-retrieval-and-evidence | Scoped retrieval planning, search, per-stage explanation, immutable evidence-packet reads and citation replay through the platform CLI and MCP. | implemented |
| [skill-knowledge-evaluation](#skill-knowledge-evaluation) | skills/knowledge-evaluation | Frozen-version evaluation procedure: reviewed retrieval cases, experiment runs, comparisons and failure diagnosis that recommend, never execute, a knowledge release. | implemented |
| [skill-vector-store-management](#skill-vector-store-management) | skills/vector-store-management | Store-class-explicit vector-store creation, document addition, evaluation, status, and guarded space publish/rollback submissions through the platform CLI. | implemented |
| [skill-verification-executor](#skill-verification-executor) | apps/verification-executor/skills/knowledge-verify | Executor capture, quote, claim, extraction, policy and report procedure with a shipped offline CLI scaffold. | implemented |
| [verification-internal](#verification-internal) | packages/verification/src/internal | Package-private helpers: deep freeze, plain-record guards, and the allocation-bounded JSON walker shared by extraction, semantic, and provider preflights. | implemented |
| [verification-prototype-compat](#verification-prototype-compat) | packages/verification/src/prototype-compat | Frozen legacy prototype locator, hash, JSON-pointer, arithmetic, and bundle translation shapes. | implemented |
| [jev](#jev) | packages/jev | Jev decision provider adapters, captured input snapshots, local SQLite queue and bounded OS worker processes. | implemented |
| [jev-service](#jev-service) | apps/jev | Dedicated Jev HTTP/Streamable HTTP MCP and stdio host, plus HTTP CLI through the public client. | implemented |
| [skill-jev-system-one](#skill-jev-system-one) | skills/jev-system-one | Agent procedure for closed-choice tasks, captured input references, process workers, uncertainty handling and LLM composition. | implemented |
| [agent-maintenance](#agent-maintenance) | tools/maintenance | Git and Cursor hook-driven review queue with Grok 4.7, bounded context and isolated proposals; GitHub dispatch handles remote work. | implemented |
| [knowledge-operation-protocol](#knowledge-operation-protocol) | packages/knowledge-operation-protocol | K01 Knowledge Operation Protocol ks.knowledge_operation.v2: origin, effect identity (effect-scoped recovery grant for a new attempt), envelope, status, receipt, capability descriptor, the WI-02 selected read (selected-report-read.v2 request, research-report-package.v2 manifest, typed refusal reasons), the WI-03 trusted assessment contracts (credential evaluation grant, report-observation/seal/use/review and decision-resolve requests, use-decision-resolution.v1), kop-canonical-json.v1 digests (lone surrogates refused), published JSON Schemas and golden vectors mirrored byte-for-byte into Mission Control. | implemented |
| [research-core](#research-core) | packages/research-core | K02/K03 pure research domain: content-addressed records, qualifier profiles, support algebra, deterministic render/ledger/census, sealing, post-observation aggregation, WI-03 governed judgment policies (typed judgment basis, review required, never entailment), exact-use admissibility, invalidation, ports. | implemented |
| [knowledge-db-contract](#knowledge-db-contract) | packages/knowledge-db-contract | K09 common verification SQL component knowledge_verification 2.5.0 (migrations 0001..0008: records, signed seal with pinned keys, admission with normalized values and scoped review, outbox enqueue/ack/settle, durable operations, report kind pin, report assessment, single-use credential nonces and K01 protocol receipts, server-clock credential use and a required normalized-values digest on admission, the WI-05 dispatch journal and native commit stamp; capability roles) with its fail-closed installer and knowledge-db CLI; installed before each application's domain bindings. | implemented |
| [binding-aiengineer-postgres](#binding-aiengineer-postgres) | packages/bindings/aiengineer-postgres | K05 AI Engineer PostgreSQL binding over the component: tenant-scoped role-bounded transactions, record stores, custody, K07 seal verification on seal and load, reviewer grants and adjudications, correction closure, and the ResearchBinding the application coordinator drives; exact-use admission delegates to the knowledge-db admission module; its K01 backend: BACKEND (registry id aiengineer-postgres), the component backend both PostgreSQL bindings compose from, and the injected ingestion apply port (knowledge-ingestion-intent/v1). | implemented |
| [binding-biotech-graph](#binding-biotech-graph) | packages/bindings/biotech-graph | K06 Biotech graph binding: K02 records in the knowledge_verification component (installation biotech), exact-use admission plus enqueue_dispatch in one PostgreSQL transaction, BKS executor HTTP client (consume, v3 official reads, marker), verified acknowledgment, the binding descriptor and its K01 backend: BACKEND (registry id biotech-graph; apply port biotech-knowledge-apply/v1, outbox delivery reader, research store reused from aiengineer-postgres); no Neo4j driver. | implemented |
| [bindings](#bindings) | packages/bindings | Store bindings that implement the research-core ports: aiengineer-postgres (K05) and biotech-graph (K06, through the BKS executor; PostgreSQL decision/outbox plus verified graph acknowledgment). | implemented |

## api

**apps/api** · app · implemented

Fastify HTTP transport. createApiRuntime composes through createHost (role api) and maps host services onto buildServer.

**Enter:** [`apps/api/src/index.ts`](../../apps/api/src/index.ts), [`apps/api/src/composition.ts`](../../apps/api/src/composition.ts), [`apps/api/src/server.ts`](../../apps/api/src/server.ts), [`apps/api/src/http/context.ts`](../../apps/api/src/http/context.ts), [`apps/api/src/http/route.ts`](../../apps/api/src/http/route.ts), [`apps/api/src/routes/verification.ts`](../../apps/api/src/routes/verification.ts), [`apps/api/src/routes/retrieval.ts`](../../apps/api/src/routes/retrieval.ts), [`apps/api/src/a2a-adapter.ts`](../../apps/api/src/a2a-adapter.ts)
**Interface:** Versioned HTTP endpoints over application use cases. Host composes persistence, operation ports, knowledge services and the shared verify group; composition.ts only maps host services onto buildServer options. server.ts composes route registrars; http/context.ts assembles shared services; routes/{system,operationReads,verification,operationMutations,retrieval,knowledge}.ts own handlers; plugins/{correlation,auth,problem}.ts and http/{route,admission,problem-map,read-map}.ts share transport policy. Routes keep their historical problem titles over shared application reads, submitCanonicalRetrievalRun and bindResolvedVerificationContext. A2A retrieval uses the canonical submission path. The A2A task binding (a2a-adapter.ts) lives here; callback signing and replay protection stay in application. The demo evaluation route loads bundles only through the optional loadDemoEvaluationBundles port (demo-evaluation-bundles.ts lazily imports the test kit, a devDependency).
**Package:** @aiengineer/knowledge-api ([`apps/api/package.json`](../../apps/api/package.json))
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [application](#application), [contracts](#contracts), [core](#core), [host](#host), [persistence](#persistence), [retrieval](#retrieval)
**Other runtime dependencies:** fastify, zod
**Reviewed runtime/data relationships:** [host](#host), [persistence](#persistence)
**Checks:** [`apps/api/src/tests/server.test.ts`](../../apps/api/src/tests/server.test.ts), [`apps/api/src/tests/bootstrap.test.ts`](../../apps/api/src/tests/bootstrap.test.ts), [`apps/api/src/tests/host-lifecycle.test.ts`](../../apps/api/src/tests/host-lifecycle.test.ts), [`apps/api/src/tests/resource-reads.test.ts`](../../apps/api/src/tests/resource-reads.test.ts), [`apps/api/src/tests/a2a-adapter.test.ts`](../../apps/api/src/tests/a2a-adapter.test.ts), [`apps/api/src/tests/golden-errors.test.ts`](../../apps/api/src/tests/golden-errors.test.ts), [`apps/api/src/tests/verification-benchmark-reads.test.ts`](../../apps/api/src/tests/verification-benchmark-reads.test.ts) Package script names: build, dev, start, test, typecheck.
- The API route is the behavioral reference for MCP parity (apps/mcp/src/tests/api-mcp-parity.test.ts). Public-origin validation, credential resolution, callbacks, listeners, drift consumer routes and the serverless singleton stay in the API; close the server before the host. Unexpected 500 logs carry correlation and a sanitized error name. Persistence integration tests opt in with RUN_LOCAL_PERSISTENCE_TESTS=1 and use only the checked KS_TEST_DATABASE_URL disposable project; storage suites also require its checked storage configuration.

**Architecture and detailed docs:**

- [proposed] [`docs/operations/package-cleanup/UNIT-5-SLICES.md`](../../docs/operations/package-cleanup/UNIT-5-SLICES.md) — Remaining cleanup: 5D folds, Jev and executor retirement
- [reference] [`docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md`](../../docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md) — Unit 4 folders, names, catalog
- [proposed] [`docs/operations/internal-fallbacks-and-application-order.md`](../../docs/operations/internal-fallbacks-and-application-order.md) — Internal fallbacks and application folder order
- [reference] [`knowledge/service-boundaries.md`](../../knowledge/service-boundaries.md) — Choose a transport and the owning module
- [reference] [`knowledge/retrieval-and-evidence.md`](../../knowledge/retrieval-and-evidence.md) — Retrieve supported results and replay citations
- [reference] [`README.md`](../../README.md) — Service boundaries, startup, and transferable use of HTTP/MCP/CLI/skills
- [accepted] [`docs/architecture/0001-runtime-and-deployment.md`](../../docs/architecture/0001-runtime-and-deployment.md) — Runtime, transport, and deployment changes
- [accepted] [`docs/architecture/0004-transport-call-graph.md`](../../docs/architecture/0004-transport-call-graph.md) — In-process servers call application; out-of-process callers use KnowledgeClient HTTP
- [reference] [`docs/architecture/transport-call-graph-refactor-snapshot-20260916.md`](../../docs/architecture/transport-call-graph-refactor-snapshot-20260916.md) — Dated snapshot of later transport-call-graph refactors; will go stale
- [reference] [`docs/verification/INTEGRATION-GUIDE.md`](../../docs/verification/INTEGRATION-GUIDE.md) — Cross-service verification integration
- [reference] [`docs/verification/DEPLOYMENT.md`](../../docs/verification/DEPLOYMENT.md) — Verification deployment and rollback
- [reference] [`knowledge/execution-profiles-and-transports.md`](../../knowledge/execution-profiles-and-transports.md) — Choose server, local or remote CLI execution
- [reference] [`docs/architecture/current-state.md`](../../docs/architecture/current-state.md) — Current implementation, ownership and remaining cleanup

## cli

**apps/cli** · app · implemented

The ks binary: remote knowledge/verify/db commands call KnowledgeClient over HTTP; the verification intent pipeline runs on host's local file-store profile, loaded lazily; offline demo, attestation and benchmark utilities use application or verification on frozen files. pack:sandbox builds the installable ks tarball.

**Enter:** [`apps/cli/src/index.ts`](../../apps/cli/src/index.ts), [`apps/cli/src/ks.ts`](../../apps/cli/src/ks.ts), [`apps/cli/src/ks-commands.ts`](../../apps/cli/src/ks-commands.ts), [`apps/cli/src/commands.ts`](../../apps/cli/src/commands.ts), [`apps/cli/src/local/offline.ts`](../../apps/cli/src/local/offline.ts)
**Interface:** ks <group> <command…>: KS_COMMANDS names every command and its one profile (remote, local, offline utility). Remote commands need an API URL and bearer and dispatch through KnowledgeClient (dispatchCliCommand); local commands map flags and KNOWLEDGE_LOCAL_* variables onto the local host's explicit identity and providers (no VERIFY_* names). Exit 0 success, 1 gate failed, 2 usage/auth/network/executor error, never a fallback. jev is reserved until 5F.
**Package:** @aiengineer/knowledge-cli ([`apps/cli/package.json`](../../apps/cli/package.json))
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [application](#application), [client](#client), [contracts](#contracts), [host](#host), [verification](#verification), [verification-executor](#verification-executor)
**Other runtime dependencies:** zod
**Reviewed runtime/data relationships:** [host](#host), [verification-executor](#verification-executor)
**Checks:** [`apps/cli/src/tests/ks.test.ts`](../../apps/cli/src/tests/ks.test.ts), [`apps/cli/src/tests/remote-profile.test.ts`](../../apps/cli/src/tests/remote-profile.test.ts), [`apps/cli/src/tests/commands.test.ts`](../../apps/cli/src/tests/commands.test.ts) Package script names: build, dev, pack:sandbox, test, typecheck.
- --help and remote commands must not load host, the executor seam, persistence or pg (bundle module-graph test). Do not fold local or mixed commands into dispatchCliCommand. The executor seam import (./local-verification) is transitional and goes with 5D3.

**Architecture and detailed docs:**

- [proposed] [`docs/operations/package-cleanup/UNIT-5-SLICES.md`](../../docs/operations/package-cleanup/UNIT-5-SLICES.md) — Remaining cleanup: 5D folds, Jev and executor retirement
- [reference] [`docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md`](../../docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md) — Unit 4 folders, names, catalog
- [proposed] [`docs/operations/internal-fallbacks-and-application-order.md`](../../docs/operations/internal-fallbacks-and-application-order.md) — Internal fallbacks and application folder order
- [reference] [`knowledge/service-boundaries.md`](../../knowledge/service-boundaries.md) — Choose a transport and the owning module
- [reference] [`README.md`](../../README.md) — Service boundaries, startup, and transferable use of HTTP/MCP/CLI/skills
- [accepted] [`docs/architecture/0004-transport-call-graph.md`](../../docs/architecture/0004-transport-call-graph.md) — In-process servers call application; out-of-process callers use KnowledgeClient HTTP
- [reference] [`docs/architecture/transport-call-graph-refactor-snapshot-20260916.md`](../../docs/architecture/transport-call-graph-refactor-snapshot-20260916.md) — Dated snapshot of later transport-call-graph refactors; will go stale
- [reference] [`docs/verification/INTEGRATION-GUIDE.md`](../../docs/verification/INTEGRATION-GUIDE.md) — Cross-service verification integration
- [reference] [`knowledge/execution-profiles-and-transports.md`](../../knowledge/execution-profiles-and-transports.md) — Choose server, local or remote CLI execution
- [reference] [`knowledge/agent-skills-and-consumer-readiness.md`](../../knowledge/agent-skills-and-consumer-readiness.md) — Skill selection, packaging and DeepAgents readiness

## mcp

**apps/mcp** · app · implemented

In-process Streamable HTTP MCP tools. createMcpRuntime composes through createHost (role mcp), which supplies the same knowledge, verify and operations groups as the API role; MCP never calls the API.

**Enter:** [`apps/mcp/src/index.ts`](../../apps/mcp/src/index.ts), [`apps/mcp/src/catalog.ts`](../../apps/mcp/src/catalog.ts), [`apps/mcp/src/tools/definition.ts`](../../apps/mcp/src/tools/definition.ts), [`apps/mcp/src/tools/errors.ts`](../../apps/mcp/src/tools/errors.ts), [`apps/mcp/src/tools/register.ts`](../../apps/mcp/src/tools/register.ts), [`apps/mcp/src/tools/executors.ts`](../../apps/mcp/src/tools/executors.ts), [`apps/mcp/src/server/http.ts`](../../apps/mcp/src/server/http.ts), [`apps/mcp/src/server/vercel.ts`](../../apps/mcp/src/server/vercel.ts)
**Interface:** MCP tool definitions are grouped under tools/ and checked against the application catalog at registration. Public names use the knowledge_* and verify_* command-group prefixes with no old aliases. index.ts composes the entrypoint; server/http.ts hosts Streamable HTTP and server/vercel.ts adapts the serverless request. Retrieval, evidence packet, citation replay, evaluation, vector-store status and every verification read/reconciliation tool call shared application reads; knowledge_retrieve_search calls submitCanonicalRetrievalRun. Verification mutations call VerificationOperationApplicationService.submit* after bindResolvedVerificationContext and the shared admission gates. Failures carry the API problem code; an absent capability is CAPABILITY_NOT_ADMITTED.
**Package:** @aiengineer/knowledge-mcp ([`apps/mcp/package.json`](../../apps/mcp/package.json))
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [application](#application), [contracts](#contracts), [host](#host), [persistence](#persistence)
**Other runtime dependencies:** @modelcontextprotocol/sdk, fastify, zod
**Reviewed runtime/data relationships:** [application](#application), [host](#host)
**Checks:** [`apps/mcp/src/tests/api-mcp-parity.test.ts`](../../apps/mcp/src/tests/api-mcp-parity.test.ts), [`apps/mcp/src/tests/no-http-shims.test.ts`](../../apps/mcp/src/tests/no-http-shims.test.ts), [`apps/mcp/src/tests/operation-catalog.test.ts`](../../apps/mcp/src/tests/operation-catalog.test.ts), [`apps/mcp/src/tests/verification-surface-inventory.test.ts`](../../apps/mcp/src/tests/verification-surface-inventory.test.ts) Package script names: build, dev, start, test, typecheck.
- No API client: MCP issues no HTTP request to the API and has no runtime @aiengineer/knowledge-client dependency. New tools call application use cases composed by host; keep tool names, schemas and authority outcomes in parity with the API route. KNOWLEDGE_API_URL only roots accepted-operation poll links. Every operation is classified in application operations/catalog.ts: exposed on API, MCP and CLI or excluded with a reason; declared kinds stay fail-closed.

**Architecture and detailed docs:**

- [proposed] [`docs/operations/package-cleanup/UNIT-5-SLICES.md`](../../docs/operations/package-cleanup/UNIT-5-SLICES.md) — Remaining cleanup: 5D folds, Jev and executor retirement
- [reference] [`docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md`](../../docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md) — Unit 4 folders, names, catalog
- [proposed] [`docs/operations/internal-fallbacks-and-application-order.md`](../../docs/operations/internal-fallbacks-and-application-order.md) — Internal fallbacks and application folder order
- [reference] [`knowledge/service-boundaries.md`](../../knowledge/service-boundaries.md) — Choose a transport and the owning module
- [reference] [`README.md`](../../README.md) — Service boundaries, startup, and transferable use of HTTP/MCP/CLI/skills
- [accepted] [`docs/architecture/0001-runtime-and-deployment.md`](../../docs/architecture/0001-runtime-and-deployment.md) — Runtime, transport, and deployment changes
- [accepted] [`docs/architecture/0004-transport-call-graph.md`](../../docs/architecture/0004-transport-call-graph.md) — In-process servers call application; out-of-process callers use KnowledgeClient HTTP
- [reference] [`docs/architecture/transport-call-graph-refactor-snapshot-20260916.md`](../../docs/architecture/transport-call-graph-refactor-snapshot-20260916.md) — Dated snapshot of later transport-call-graph refactors; will go stale
- [reference] [`docs/verification/INTEGRATION-GUIDE.md`](../../docs/verification/INTEGRATION-GUIDE.md) — Cross-service verification integration
- [reference] [`knowledge/execution-profiles-and-transports.md`](../../knowledge/execution-profiles-and-transports.md) — Choose server, local or remote CLI execution
- [reference] [`docs/architecture/current-state.md`](../../docs/architecture/current-state.md) — Current implementation, ownership and remaining cleanup

## verification-executor

**apps/verification-executor** · app · implemented

Sandbox verification executor that also hosts schema, bounded-read, and ingestion operations on CLI, MCP, and HTTP, and serves ks.knowledge_operation.v2 (K01 over the Sprint V application services: register, assess, read, derive, apply, verify, status, cancel, receipt) with K07 issuer-credential validation and durable single-use credentials.

**Enter:** [`apps/verification-executor/src/index.ts`](../../apps/verification-executor/src/index.ts), [`apps/verification-executor/src/executor.ts`](../../apps/verification-executor/src/executor.ts), [`apps/verification-executor/src/knowledge/operations.ts`](../../apps/verification-executor/src/knowledge/operations.ts), [`apps/verification-executor/src/knowledge/cli.ts`](../../apps/verification-executor/src/knowledge/cli.ts), [`apps/verification-executor/src/knowledge/context.ts`](../../apps/verification-executor/src/knowledge/context.ts), [`apps/verification-executor/src/operations/define.ts`](../../apps/verification-executor/src/operations/define.ts), [`apps/verification-executor/src/knowledge-operation/http.ts`](../../apps/verification-executor/src/knowledge-operation/http.ts), [`apps/verification-executor/src/serve.ts`](../../apps/verification-executor/src/serve.ts)
**Interface:** knowledge-verify plus knowledge schema_*/db_*/ingest_*/artifact_get; one OperationDefinition feeds CLI, POST /knowledge/<name>, and MCP. ./local-verification publishes the 5B file-backed seam for ks until 5D3., /knowledge-operation/v2/{invoke,operations/:id,operations/:id/cancel,receipts/:key,describe,artifacts/:id} HTTP and MCP knowledge_operation_* adapters over @aiengineer/knowledge-host/knowledge-operation (service, K07 credentials); serve.ts composes KNOWLEDGE_BACKENDS from the binding packages' BACKEND registrations and the host in-memory one.
**Package:** @aiengineer/knowledge-verification-executor ([`apps/verification-executor/package.json`](../../apps/verification-executor/package.json))
**Export subpaths:** ./local-verification, ./scoped-host/v1. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [application](#application), [binding-aiengineer-postgres](#binding-aiengineer-postgres), [binding-biotech-graph](#binding-biotech-graph), [contracts](#contracts), [core](#core), [knowledge-db](#knowledge-db), [host](#host), [knowledge-operation-protocol](#knowledge-operation-protocol), [persistence](#persistence), [policy](#policy), [research-core](#research-core), [verification](#verification)
**Other runtime dependencies:** @aiengineer/database-contract, @modelcontextprotocol/sdk, pg, zod
**Reviewed runtime/data relationships:** [knowledge-db](#knowledge-db), [application](#application), [host](#host)
**Checks:** [`apps/verification-executor/src/knowledge/cli.test.ts`](../../apps/verification-executor/src/knowledge/cli.test.ts), [`apps/verification-executor/src/locate.test.ts`](../../apps/verification-executor/src/locate.test.ts), [`apps/verification-executor/src/knowledge-operation/conformance.test.ts`](../../apps/verification-executor/src/knowledge-operation/conformance.test.ts), [`apps/verification-executor/src/knowledge-operation/postgres.integration.test.ts`](../../apps/verification-executor/src/knowledge-operation/postgres.integration.test.ts), [`apps/verification-executor/src/knowledge-operation/biotech.integration.test.ts`](../../apps/verification-executor/src/knowledge-operation/biotech.integration.test.ts), [`apps/verification-executor/src/knowledge-operation/aidb-apply.integration.test.ts`](../../apps/verification-executor/src/knowledge-operation/aidb-apply.integration.test.ts), [`apps/verification-executor/src/knowledge-operation/backend-conformance.test.ts`](../../apps/verification-executor/src/knowledge-operation/backend-conformance.test.ts) Package script names: build, dev, dev:knowledge, examples, pack:sandbox, test, typecheck.
- Distinct from apps/api's durable service transport; preserve the explicit sandbox capability model. Knowledge services are absent when no database URL is configured.
- Agent claim/extraction intents select exact text quotes; native projection selector support in the library does not imply executor media admission.
- The knowledge-operation routes never accept the legacy static bearer; every refusal is protocol-error.v2 with the HTTP status mirrored from its code.

**Architecture and detailed docs:**

- [proposed] [`docs/operations/package-cleanup/UNIT-5-SLICES.md`](../../docs/operations/package-cleanup/UNIT-5-SLICES.md) — Remaining cleanup: 5D folds, Jev and executor retirement
- [proposed] [`docs/operations/internal-fallbacks-and-application-order.md`](../../docs/operations/internal-fallbacks-and-application-order.md) — Internal fallbacks and application folder order
- [reference] [`knowledge/service-boundaries.md`](../../knowledge/service-boundaries.md) — Choose a transport and the owning module
- [reference] [`knowledge/schema-read-and-ingestion.md`](../../knowledge/schema-read-and-ingestion.md) — Read a bounded knowledge snapshot or apply evidence-backed changes
- [reference] [`knowledge/verification-and-admission.md`](../../knowledge/verification-and-admission.md) — Verify claims and admit exact downstream effects
- [reference] [`knowledge/durable-execution-and-recovery.md`](../../knowledge/durable-execution-and-recovery.md) — Understand fenced worker execution and bounded recovery
- [reference] [`README.md`](../../README.md) — Service boundaries, startup, and transferable use of HTTP/MCP/CLI/skills
- [reference] [`docs/operations/reviews/verification-executor.md`](../../docs/operations/reviews/verification-executor.md) — Verification executor intent, skill, example and consumer pin review
- [reference] [`apps/verification-executor/examples/CAPABILITIES-ACQUISITION.md`](../../apps/verification-executor/examples/CAPABILITIES-ACQUISITION.md) — Executor acquisition, capture catalog, intent-expressible selectors and public-surface limits
- [reference] [`knowledge/execution-profiles-and-transports.md`](../../knowledge/execution-profiles-and-transports.md) — Choose server, local or remote CLI execution
- [reference] [`knowledge/agent-skills-and-consumer-readiness.md`](../../knowledge/agent-skills-and-consumer-readiness.md) — Skill selection, packaging and DeepAgents readiness
- [reference] [`docs/architecture/current-state.md`](../../docs/architecture/current-state.md) — Current implementation, ownership and remaining cleanup

## worker

**apps/worker** · app · implemented

Durable knowledge-operation execution and activity dispatch over host-composed adapters; verification runtime wiring stays in the worker execution factory.

**Enter:** [`apps/worker/src/index.ts`](../../apps/worker/src/index.ts), [`apps/worker/src/worker.ts`](../../apps/worker/src/worker.ts), [`apps/worker/src/activity-registry.ts`](../../apps/worker/src/activity-registry.ts)
**Interface:** startWorker composes through createHost (role worker): host builds adapters, reconciles before scheduling and owns release; the worker supplies activity execution, leases and receipts. Preserve lease ownership and idempotent terminal receipts.
**Package:** @aiengineer/knowledge-worker ([`apps/worker/package.json`](../../apps/worker/package.json))
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [sources](#sources), [application](#application), [contracts](#contracts), [core](#core), [evaluation](#evaluation), [host](#host), [persistence](#persistence), [policy](#policy), [preparation](#preparation), [retrieval](#retrieval), [verification](#verification)
**Other runtime dependencies:** zod
**Reviewed runtime/data relationships:** [host](#host)
**Checks:** [`apps/worker/src/worker.test.ts`](../../apps/worker/src/worker.test.ts), [`apps/worker/src/activity-registry.test.ts`](../../apps/worker/src/activity-registry.test.ts) Package script names: build, dev, start, test, typecheck.
- WorkerHostDependencies.promotionSelection stays fail-closed; memory mode is development/test-only and is not the offline profile.

**Architecture and detailed docs:**

- [proposed] [`docs/operations/internal-fallbacks-and-application-order.md`](../../docs/operations/internal-fallbacks-and-application-order.md) — Internal fallbacks and application folder order
- [accepted] [`docs/operations/reviews/acquisition.md`](../../docs/operations/reviews/acquisition.md) — Acquisition HTTP, upload, and sealed-byte inspection review record
- [reference] [`docs/operations/reviews/conversion.md`](../../docs/operations/reviews/conversion.md) — Conversion route (text, Docling, gated Unstructured) and receipt review record
- [reference] [`knowledge/durable-execution-and-recovery.md`](../../knowledge/durable-execution-and-recovery.md) — Understand fenced worker execution and bounded recovery
- [reference] [`README.md`](../../README.md) — Service boundaries, startup, and transferable use of HTTP/MCP/CLI/skills
- [accepted] [`docs/architecture/0001-runtime-and-deployment.md`](../../docs/architecture/0001-runtime-and-deployment.md) — Runtime, transport, and deployment changes
- [accepted] [`docs/architecture/0004-transport-call-graph.md`](../../docs/architecture/0004-transport-call-graph.md) — In-process servers call application; out-of-process callers use KnowledgeClient HTTP
- [reference] [`docs/verification/OPERATOR-RUNBOOK.md`](../../docs/verification/OPERATOR-RUNBOOK.md) — Verification recovery and operator actions
- [reference] [`docs/verification/DEPLOYMENT.md`](../../docs/verification/DEPLOYMENT.md) — Verification deployment and rollback
- [reference] [`docs/operations/runbooks.md`](../../docs/operations/runbooks.md) — Worker restart, leases, callbacks, incidents
- [reference] [`docs/architecture/current-state.md`](../../docs/architecture/current-state.md) — Current implementation, ownership and remaining cleanup

## sources

**packages/sources** · package · implemented

Source acquisition and inspection (folder renamed from packages/acquisition; npm name @aiengineer/knowledge-acquisition unchanged): HTTP and local-upload acquisition wired; inspect library for sealed bytes; repository, Firecrawl scrape, and paper execute remain unwired.

**Enter:** [`packages/sources/src/index.ts`](../../packages/sources/src/index.ts)
**Interface:** Acquisition request/result types, routed HTTP/upload adapters, and sealed-byte inspection.
**Package:** @aiengineer/knowledge-acquisition ([`packages/sources/package.json`](../../packages/sources/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [core](#core)
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/sources/src/http/adapter.test.ts`](../../packages/sources/src/http/adapter.test.ts), [`packages/sources/src/http/deadline.test.ts`](../../packages/sources/src/http/deadline.test.ts), [`packages/sources/src/route.test.ts`](../../packages/sources/src/route.test.ts), [`packages/sources/src/inspect/inspect.test.ts`](../../packages/sources/src/inspect/inspect.test.ts), [`packages/sources/examples/examples.test.ts`](../../packages/sources/examples/examples.test.ts) Package script names: build, examples, test, typecheck.

**Architecture and detailed docs:**

- [reference] [`docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md`](../../docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md) — Unit 4 folders, names, catalog
- [proposed] [`docs/operations/internal-fallbacks-and-application-order.md`](../../docs/operations/internal-fallbacks-and-application-order.md) — Internal fallbacks and application folder order
- [accepted] [`docs/operations/reviews/acquisition.md`](../../docs/operations/reviews/acquisition.md) — Acquisition HTTP, upload, and sealed-byte inspection review record
- [accepted] [`docs/architecture/0002-deterministic-preparation.md`](../../docs/architecture/0002-deterministic-preparation.md) — Preparation pipeline
- [reference] [`knowledge/capture-conversion-and-custody.md`](../../knowledge/capture-conversion-and-custody.md) — Acquire source bytes and preserve conversion custody

## application

**packages/application** · package · implemented

Composes knowledge use cases, capability admission, preparation, retrieval execution, shared resource reads, and verification surfaces, including tenant access rules, ownership and transport admission ports.

**Enter:** [`packages/application/src/index.ts`](../../packages/application/src/index.ts), [`packages/application/src/access/api-access.ts`](../../packages/application/src/access/api-access.ts), [`packages/application/src/operations/surface.ts`](../../packages/application/src/operations/surface.ts), [`packages/application/src/operations/catalog.ts`](../../packages/application/src/operations/catalog.ts), [`packages/application/src/knowledge/retrieval/canonical-retrieval-executor.ts`](../../packages/application/src/knowledge/retrieval/canonical-retrieval-executor.ts), [`packages/application/src/verification/reads/verification-resource-reads.ts`](../../packages/application/src/verification/reads/verification-resource-reads.ts), [`packages/application/src/verification/operations/verification-transport.ts`](../../packages/application/src/verification/operations/verification-transport.ts)
**Interface:** Application service facades and use-case functions grouped by tool group: operations/ (durable operation surface, transport catalog, admission, A2A callback signing and replay protection), knowledge/ (preparation, source discovery, checkpoints, promotion selection, canonical retrieval, knowledge resource reads), verification/ (admission, operations, benchmark, recovery, source acquisition, verification resource reads) and quarantined diagnostics/ re-exported only by the barrel. access/api-access.ts owns isAuthorized/actorsMatch; reads/resource-read-result.ts is the shared read result; verification-context-binding.ts binds a resolved context to the authenticated submission.
**Package:** @aiengineer/knowledge-application ([`packages/application/package.json`](../../packages/application/package.json))
**Export subpaths:** ., ./jev, ./testing. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [sources](#sources), [contracts](#contracts), [core](#core), [evaluation](#evaluation), [jev](#jev), [knowledge-operation-protocol](#knowledge-operation-protocol), [policy](#policy), [preparation](#preparation), [research-core](#research-core), [retrieval](#retrieval), [verification](#verification)
**Other runtime dependencies:** zod
**Reviewed runtime/data relationships:** [knowledge-operation-protocol](#knowledge-operation-protocol), [research-core](#research-core)
**Checks:** [`packages/application/src/operations/capability-admission.test.ts`](../../packages/application/src/operations/capability-admission.test.ts), [`packages/application/src/operations/a2a-callbacks.test.ts`](../../packages/application/src/operations/a2a-callbacks.test.ts), [`packages/application/src/knowledge/retrieval/canonical-retrieval-executor.test.ts`](../../packages/application/src/knowledge/retrieval/canonical-retrieval-executor.test.ts), [`packages/application/src/diagnostics/verification-diagnostics-quarantine.test.ts`](../../packages/application/src/diagnostics/verification-diagnostics-quarantine.test.ts) Package script names: build, test, typecheck.
- Transports compose these ports; they are not algorithm authority. Application never imports host or persistence; persistence implements its ports.

**Architecture and detailed docs:**

- [proposed] [`docs/operations/package-cleanup/UNIT-5-SLICES.md`](../../docs/operations/package-cleanup/UNIT-5-SLICES.md) — Remaining cleanup: 5D folds, Jev and executor retirement
- [reference] [`docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md`](../../docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md) — Unit 4 folders, names, catalog
- [proposed] [`docs/operations/internal-fallbacks-and-application-order.md`](../../docs/operations/internal-fallbacks-and-application-order.md) — Internal fallbacks and application folder order
- [proposed] [`docs/operations/conversion-and-chunking.md`](../../docs/operations/conversion-and-chunking.md) — Conversion route and admitted chunk profiles; vendor MCP import; no session-local splitters
- [reference] [`knowledge/service-boundaries.md`](../../knowledge/service-boundaries.md) — Choose a transport and the owning module
- [reference] [`knowledge/preparation-and-publication.md`](../../knowledge/preparation-and-publication.md) — Prepare source material and publish a retrieval version
- [reference] [`knowledge/verification-and-admission.md`](../../knowledge/verification-and-admission.md) — Verify claims and admit exact downstream effects
- [reference] [`knowledge/durable-execution-and-recovery.md`](../../knowledge/durable-execution-and-recovery.md) — Understand fenced worker execution and bounded recovery
- [reference] [`README.md`](../../README.md) — Service boundaries, startup, and transferable use of HTTP/MCP/CLI/skills
- [accepted] [`docs/architecture/0002-deterministic-preparation.md`](../../docs/architecture/0002-deterministic-preparation.md) — Preparation pipeline
- [accepted] [`docs/architecture/0004-transport-call-graph.md`](../../docs/architecture/0004-transport-call-graph.md) — In-process servers call application; out-of-process callers use KnowledgeClient HTTP
- [reference] [`docs/architecture/transport-call-graph-refactor-snapshot-20260916.md`](../../docs/architecture/transport-call-graph-refactor-snapshot-20260916.md) — Dated snapshot of later transport-call-graph refactors; will go stale
- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants
- [reference] [`docs/architecture/modules/jev.md`](../../docs/architecture/modules/jev.md) — Jev processes, API, MCP, CLI and research
- [reference] [`knowledge/execution-profiles-and-transports.md`](../../knowledge/execution-profiles-and-transports.md) — Choose server, local or remote CLI execution
- [reference] [`docs/architecture/current-state.md`](../../docs/architecture/current-state.md) — Current implementation, ownership and remaining cleanup

## preparation

**packages/preparation** · package · implemented

Artifact conversion, immutable document nodes, admitted chunk profiles and reconstructable-span quality checks.

**Enter:** [`packages/preparation/src/index.ts`](../../packages/preparation/src/index.ts), [`packages/preparation/src/documents/index.ts`](../../packages/preparation/src/documents/index.ts), [`packages/preparation/src/documents/nodes/structural-document.ts`](../../packages/preparation/src/documents/nodes/structural-document.ts), [`packages/preparation/src/documents/locators/source-locator.ts`](../../packages/preparation/src/documents/locators/source-locator.ts), [`packages/preparation/src/chunking/index.ts`](../../packages/preparation/src/chunking/index.ts), [`packages/preparation/src/chunking/profiles/definitions.ts`](../../packages/preparation/src/chunking/profiles/definitions.ts), [`packages/preparation/src/chunking/chunker/chunk-document.ts`](../../packages/preparation/src/chunking/chunker/chunk-document.ts), [`packages/preparation/src/chunking/qa/validate-chunks.ts`](../../packages/preparation/src/chunking/qa/validate-chunks.ts), [`packages/preparation/src/conversion/index.ts`](../../packages/preparation/src/conversion/index.ts), [`packages/preparation/src/conversion/route.ts`](../../packages/preparation/src/conversion/route.ts)
**Interface:** convertStructuralDocument, normalizeDocumentText, createSourceLocator, reconstructNodeSpan, verifyNodeLocators, and the document-specific one-argument deterministicUuid; core retains its distinct two-argument helper., ChunkProfileRegistry over CHUNK_PROFILE_TABLE (forSpace, forSpaceAndNodeKinds), chunkDocument, tokenize, reconstructChunk, validateChunks; ChunkProfile comes from contracts., ConversionRouter (text → Docling → gated Unstructured), providers, HTTP clients, and SandboxedVerificationParser.
**Package:** @aiengineer/knowledge-preparation ([`packages/preparation/package.json`](../../packages/preparation/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [contracts](#contracts), [core](#core)
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/preparation/src/documents/nodes/structural-document.test.ts`](../../packages/preparation/src/documents/nodes/structural-document.test.ts), [`packages/preparation/src/documents/locators/source-locator.test.ts`](../../packages/preparation/src/documents/locators/source-locator.test.ts), [`packages/preparation/src/documents/identity/deterministic-uuid.test.ts`](../../packages/preparation/src/documents/identity/deterministic-uuid.test.ts), [`packages/preparation/examples/documents/01-build-nodes-and-verify-locators.test.ts`](../../packages/preparation/examples/documents/01-build-nodes-and-verify-locators.test.ts), [`packages/preparation/src/chunking/profiles/registry.test.ts`](../../packages/preparation/src/chunking/profiles/registry.test.ts), [`packages/preparation/src/chunking/chunker/chunk-document.test.ts`](../../packages/preparation/src/chunking/chunker/chunk-document.test.ts), [`packages/preparation/src/chunking/qa/validate-chunks.test.ts`](../../packages/preparation/src/chunking/qa/validate-chunks.test.ts), [`packages/preparation/examples/chunking/02-chunk-and-reconstruct.test.ts`](../../packages/preparation/examples/chunking/02-chunk-and-reconstruct.test.ts), [`packages/preparation/examples/chunking/03-qa-failure-next-profile.test.ts`](../../packages/preparation/examples/chunking/03-qa-failure-next-profile.test.ts), [`packages/preparation/src/conversion/conversion.test.ts`](../../packages/preparation/src/conversion/conversion.test.ts), [`packages/preparation/src/conversion/verification-parser.test.ts`](../../packages/preparation/src/conversion/verification-parser.test.ts), [`packages/preparation/examples/conversion/examples.test.ts`](../../packages/preparation/examples/conversion/examples.test.ts) Package script names: build, examples, test, typecheck.

**Architecture and detailed docs:**

- [proposed] [`docs/operations/internal-fallbacks-and-application-order.md`](../../docs/operations/internal-fallbacks-and-application-order.md) — Internal fallbacks and application folder order
- [reference] [`docs/operations/reviews/conversion.md`](../../docs/operations/reviews/conversion.md) — Conversion route (text, Docling, gated Unstructured) and receipt review record
- [proposed] [`docs/operations/conversion-and-chunking.md`](../../docs/operations/conversion-and-chunking.md) — Conversion route and admitted chunk profiles; vendor MCP import; no session-local splitters
- [accepted] [`docs/architecture/0002-deterministic-preparation.md`](../../docs/architecture/0002-deterministic-preparation.md) — Preparation pipeline
- [reference] [`knowledge/capture-conversion-and-custody.md`](../../knowledge/capture-conversion-and-custody.md) — Acquire source bytes and preserve conversion custody

## client

**packages/client** · package · implemented

Out-of-process typed HTTP SDK (@aiengineer/knowledge-client, folder packages/client) for the Knowledge Services contract. Laptop CLI, Eve, Mission Control, and other repos. Not the long-term seam for API, MCP, or workers.

**Enter:** [`packages/client/src/index.ts`](../../packages/client/src/index.ts)
**Interface:** KnowledgeClient methods plus public contract types. Callers construct HTTP; they do not import application.
**Package:** @aiengineer/knowledge-client ([`packages/client/package.json`](../../packages/client/package.json))
**Export subpaths:** ., ./jev. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [contracts](#contracts)
**Other runtime dependencies:** zod
**Reviewed runtime/data relationships:** none declared
**Checks:** No specific test anchor registered. Package script names: build, test, typecheck.
- Do not use from in-process KS servers; API, MCP and workers call application.

**Architecture and detailed docs:**

- [reference] [`docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md`](../../docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md) — Unit 4 folders, names, catalog
- [accepted] [`docs/architecture/0004-transport-call-graph.md`](../../docs/architecture/0004-transport-call-graph.md) — In-process servers call application; out-of-process callers use KnowledgeClient HTTP
- [reference] [`docs/architecture/transport-call-graph-refactor-snapshot-20260916.md`](../../docs/architecture/transport-call-graph-refactor-snapshot-20260916.md) — Dated snapshot of later transport-call-graph refactors; will go stale
- [reference] [`docs/verification/INTEGRATION-GUIDE.md`](../../docs/verification/INTEGRATION-GUIDE.md) — Cross-service verification integration
- [reference] [`docs/architecture/modules/jev.md`](../../docs/architecture/modules/jev.md) — Jev processes, API, MCP, CLI and research

## host

**packages/host** · package · implemented

Composition root: configuration and identity resolution, shared knowledge and verification composition, createHost for the server roles (API, MCP, worker) and the file-backed local profile, with owned lifecycle and the server/local/remote-CLI capability matrix; and the ks.knowledge_operation.v2 composition (./knowledge-operation: K01 service with the WI-03 trusted assessment transport observe/seal/decide/review/resolve, K07 issuer-credential validation with durable single use, the KnowledgeOperationBackend port with declared capabilities, the BackendRegistry the executable composes, the in-memory backend and env composition; ./knowledge-operation/conformance: the backend conformance suite).

**Enter:** [`packages/host/src/index.ts`](../../packages/host/src/index.ts), [`packages/host/src/create-host.ts`](../../packages/host/src/create-host.ts), [`packages/host/src/server/verification.ts`](../../packages/host/src/server/verification.ts), [`packages/host/src/local/local-host.ts`](../../packages/host/src/local/local-host.ts), [`packages/host/src/local/capabilities.ts`](../../packages/host/src/local/capabilities.ts), [`packages/host/src/verification/host-runtime.ts`](../../packages/host/src/verification/host-runtime.ts), [`packages/host/src/knowledge-operation/index.ts`](../../packages/host/src/knowledge-operation/index.ts), [`packages/host/src/knowledge-operation/registry.ts`](../../packages/host/src/knowledge-operation/registry.ts)
**Interface:** createHost({ profile: "server", role: api, mcp or worker }) returns role-typed services grouped as knowledge, verify and operations plus close(); createHost({ profile: "local", storeDir, providers?, verification }) composes the verification intent pipeline lazily over a file store: offline operations need no network, database or credentials; online capture, document conversion and semantic judging need explicit providers, else CAPABILITY_NOT_ADMITTED; other operations are server-only (profileAvailability). The verification seam is supplied by the executor until 5D3. composeKnowledgeServices and composeVerificationServices are shared by the API and MCP roles; verification/api/ holds read, reconciliation, decision, capture-profile and drift construction. @aiengineer/knowledge-host/config exposes configuration and identity; @aiengineer/knowledge-host/local exposes the local profile and capability matrix without the server composition (what ks loads); access rules are re-exported from application.
**Package:** @aiengineer/knowledge-host ([`packages/host/package.json`](../../packages/host/package.json))
**Export subpaths:** ., ./config, ./knowledge-operation, ./knowledge-operation/conformance, ./local. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [sources](#sources), [application](#application), [contracts](#contracts), [core](#core), [knowledge-db](#knowledge-db), [knowledge-operation-protocol](#knowledge-operation-protocol), [persistence](#persistence), [preparation](#preparation), [research-core](#research-core), [retrieval](#retrieval), [verification](#verification)
**Other runtime dependencies:** zod
**Reviewed runtime/data relationships:** [application](#application), [persistence](#persistence), [knowledge-operation-protocol](#knowledge-operation-protocol), [research-core](#research-core), [knowledge-db](#knowledge-db)
**Checks:** [`packages/host/src/tests/composition.test.ts`](../../packages/host/src/tests/composition.test.ts), [`packages/host/src/tests/lifecycle.test.ts`](../../packages/host/src/tests/lifecycle.test.ts), [`packages/host/src/tests/local-profile.test.ts`](../../packages/host/src/tests/local-profile.test.ts), [`packages/host/src/tests/capability-matrix.test.ts`](../../packages/host/src/tests/capability-matrix.test.ts), [`packages/host/src/tests/conformance/backends/backends.test.ts`](../../packages/host/src/tests/conformance/backends/backends.test.ts) Package script names: build, test, typecheck.
- Never import apps; application and persistence never import host. Importing host opens no pool, timer or child process. Do not read or emit environment secrets in docs.

**Architecture and detailed docs:**

- [proposed] [`docs/operations/package-cleanup/UNIT-5-SLICES.md`](../../docs/operations/package-cleanup/UNIT-5-SLICES.md) — Remaining cleanup: 5D folds, Jev and executor retirement
- [accepted] [`docs/architecture/0001-runtime-and-deployment.md`](../../docs/architecture/0001-runtime-and-deployment.md) — Runtime, transport, and deployment changes
- [reference] [`docs/security.md`](../../docs/security.md) — Authentication, capability admission, parser isolation
- [reference] [`knowledge/execution-profiles-and-transports.md`](../../knowledge/execution-profiles-and-transports.md) — Choose server, local or remote CLI execution
- [reference] [`docs/architecture/current-state.md`](../../docs/architecture/current-state.md) — Current implementation, ownership and remaining cleanup
- [reference] [`docs/architecture/technology-stack.md`](../../docs/architecture/technology-stack.md) — Pinned technology stack and runtime definitions

## contracts

**packages/contracts** · package · implemented

Versioned Zod schemas and types shared by transports, application composition, and clients.

**Enter:** [`packages/contracts/src/index.ts`](../../packages/contracts/src/index.ts)
**Interface:** Public request/result and verification contract schemas.
**Package:** @aiengineer/knowledge-contracts ([`packages/contracts/package.json`](../../packages/contracts/package.json))
**Export subpaths:** ., ./jev. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** zod
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/contracts/src/contracts.test.ts`](../../packages/contracts/src/contracts.test.ts), [`packages/contracts/src/deployment.test.ts`](../../packages/contracts/src/deployment.test.ts) Package script names: build, generate, test, typecheck.

**Architecture and detailed docs:**

- [reference] [`knowledge/retrieval-and-evidence.md`](../../knowledge/retrieval-and-evidence.md) — Retrieve supported results and replay citations
- [reference] [`docs/verification/INTEGRATION-GUIDE.md`](../../docs/verification/INTEGRATION-GUIDE.md) — Cross-service verification integration
- [reference] [`docs/architecture/modules/jev.md`](../../docs/architecture/modules/jev.md) — Jev processes, API, MCP, CLI and research
- [reference] [`docs/architecture/technology-stack.md`](../../docs/architecture/technology-stack.md) — Pinned technology stack and runtime definitions

## knowledge-db

**packages/knowledge-db** · package · implemented

Pinned schema workspace navigation, bounded read snapshots and deterministic ingestion through canonical temporal helpers.

**Enter:** [`packages/knowledge-db/src/index.ts`](../../packages/knowledge-db/src/index.ts), [`packages/knowledge-db/src/ports.ts`](../../packages/knowledge-db/src/ports.ts), [`packages/knowledge-db/src/schema-workspace/index.ts`](../../packages/knowledge-db/src/schema-workspace/index.ts), [`packages/knowledge-db/src/db-read/index.ts`](../../packages/knowledge-db/src/db-read/index.ts), [`packages/knowledge-db/src/db-read/read-executor.ts`](../../packages/knowledge-db/src/db-read/read-executor.ts), [`packages/knowledge-db/src/db-read/sql-guard.ts`](../../packages/knowledge-db/src/db-read/sql-guard.ts), [`packages/knowledge-db/src/db-read/space-manifest.ts`](../../packages/knowledge-db/src/db-read/space-manifest.ts), [`packages/knowledge-db/src/ingestion/index.ts`](../../packages/knowledge-db/src/ingestion/index.ts), [`packages/knowledge-db/src/ingestion/plan.ts`](../../packages/knowledge-db/src/ingestion/plan.ts), [`packages/knowledge-db/src/ingestion/apply.ts`](../../packages/knowledge-db/src/ingestion/apply.ts), [`packages/knowledge-db/src/ingestion/executor.ts`](../../packages/knowledge-db/src/ingestion/executor.ts), [`packages/knowledge-db/src/ingestion/duplicate.ts`](../../packages/knowledge-db/src/ingestion/duplicate.ts)
**Interface:** Owns its ports (ports.ts): KnowledgeSqlClient, KnowledgeTransactions/KnowledgeDatabase, KnowledgeTransactionScope, KnowledgeRole and ContentAdmission; persistence implements them (TenantPostgres, postgresContentAdmission) and the composition root injects them., loadWorkspace, searchWorkspace, getPage, compareHeads/assertHeadMatches, materializeScope; locate via SCHEMA_WORKSPACE_DIR or the pinned contract workspace/., ReadExecutor.validateIntent/runIntent/sqlReadonly/explain/head; ArtifactLedger persist of intent+snapshot; assertSingleReadStatement admits one SELECT/WITH., buildSpaceManifest is pure and generic in the space type; readSpaceManifest reads only the catalog queries that exist and records the rest in unavailable[]., IngestionExecutor.plan/apply/receipt; buildPlan; applyPlan inside temporal.begin_batch/assert_*/commit_batch; same idempotency key returns duplicateOf.
**Package:** @aiengineer/knowledge-db ([`packages/knowledge-db/package.json`](../../packages/knowledge-db/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [contracts](#contracts), [core](#core), [knowledge-operation-protocol](#knowledge-operation-protocol)
**Other runtime dependencies:** @aiengineer/database-contract, zod
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/knowledge-db/src/schema-workspace/schema-workspace.test.ts`](../../packages/knowledge-db/src/schema-workspace/schema-workspace.test.ts), [`packages/knowledge-db/src/db-read/db-read.test.ts`](../../packages/knowledge-db/src/db-read/db-read.test.ts), [`packages/knowledge-db/src/db-read/read-executor.integration.test.ts`](../../packages/knowledge-db/src/db-read/read-executor.integration.test.ts), [`packages/knowledge-db/src/db-read/space-manifest.test.ts`](../../packages/knowledge-db/src/db-read/space-manifest.test.ts), [`packages/knowledge-db/src/ingestion/tests/plan.test.ts`](../../packages/knowledge-db/src/ingestion/tests/plan.test.ts), [`packages/knowledge-db/src/ingestion/tests/duplicate.test.ts`](../../packages/knowledge-db/src/ingestion/tests/duplicate.test.ts), [`packages/knowledge-db/src/ingestion/tests/executor.integration.test.ts`](../../packages/knowledge-db/src/ingestion/tests/executor.integration.test.ts) Package script names: build, test, typecheck.
- No production dependency on persistence (R1); persistence remains a devDependency for database integration tests and fixtures.
- Consumes the committed workspace tree; it does not regenerate IR from the live database at request time.
- Retrieval operations are skipped (RETRIEVAL_UNAVAILABLE). Named queries and artifact ops run.
- space_manifest reports only its static half today: contract 0.4.16 has no space, store, version or publication catalog query, and no per-space budget exists at all. No executor operation is registered yet (Track K, after G3).
- Writes orchestration.operation_intent/receipt; does not write a knowledge_service.operation row.

**Architecture and detailed docs:**

- [proposed] [`docs/operations/package-cleanup/UNIT-5-SLICES.md`](../../docs/operations/package-cleanup/UNIT-5-SLICES.md) — Remaining cleanup: 5D folds, Jev and executor retirement
- [reference] [`docs/operations/reviews/db-read.md`](../../docs/operations/reviews/db-read.md) — Bounded read executor and space manifest review record
- [reference] [`knowledge/schema-read-and-ingestion.md`](../../knowledge/schema-read-and-ingestion.md) — Read a bounded knowledge snapshot or apply evidence-backed changes
- [reference] [`knowledge/preparation-and-publication.md`](../../knowledge/preparation-and-publication.md) — Prepare source material and publish a retrieval version
- [reference] [`knowledge/verification-and-admission.md`](../../knowledge/verification-and-admission.md) — Verify claims and admit exact downstream effects
- [reference] [`README.md`](../../README.md) — Service boundaries, startup, and transferable use of HTTP/MCP/CLI/skills

## core

**packages/core** · package · implemented

Shared identity, digest, authority and state primitives; artifact custody, operation lifecycle and in-memory telemetry.

**Enter:** [`packages/core/src/index.ts`](../../packages/core/src/index.ts), [`packages/core/src/domain/index.ts`](../../packages/core/src/domain/index.ts), [`packages/core/src/runtime/index.ts`](../../packages/core/src/runtime/index.ts), [`packages/core/src/observability/index.ts`](../../packages/core/src/observability/index.ts)
**Interface:** Small pure invariants and value helpers., Artifact stores and ledger interfaces; in-memory implementations are not deployment authority., InMemoryTelemetry and reconcileManifests; not a full external telemetry deployment.
**Package:** @aiengineer/knowledge-core ([`packages/core/package.json`](../../packages/core/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [contracts](#contracts)
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/core/src/domain/domain.test.ts`](../../packages/core/src/domain/domain.test.ts), [`packages/core/src/runtime/runtime.test.ts`](../../packages/core/src/runtime/runtime.test.ts), [`packages/core/src/observability/index.test.ts`](../../packages/core/src/observability/index.test.ts) Package script names: build, test, typecheck.

**Architecture and detailed docs:**

- [reference] [`knowledge/durable-execution-and-recovery.md`](../../knowledge/durable-execution-and-recovery.md) — Understand fenced worker execution and bounded recovery
- [accepted] [`docs/architecture/0002-deterministic-preparation.md`](../../docs/architecture/0002-deterministic-preparation.md) — Preparation pipeline
- [accepted] [`docs/architecture/0003-embedding-retrieval-evaluation.md`](../../docs/architecture/0003-embedding-retrieval-evaluation.md) — Embedding, retrieval, evaluation
- [reference] [`docs/operations/runbooks.md`](../../docs/operations/runbooks.md) — Worker restart, leases, callbacks, incidents

## retrieval

**packages/retrieval** · package · implemented

Policy-scoped search, evidence-bound projections, embedding routes and receipts, and vector publication and rollback.

**Enter:** [`packages/retrieval/src/index.ts`](../../packages/retrieval/src/index.ts), [`packages/retrieval/src/vector-backends/backends/in-memory-exact.ts`](../../packages/retrieval/src/vector-backends/backends/in-memory-exact.ts), [`packages/retrieval/src/vector-backends/backends/postgres.ts`](../../packages/retrieval/src/vector-backends/backends/postgres.ts), [`packages/retrieval/src/vector-backends/publication/coordinator.ts`](../../packages/retrieval/src/vector-backends/publication/coordinator.ts), [`packages/retrieval/src/vector-backends/spaces/link.ts`](../../packages/retrieval/src/vector-backends/spaces/link.ts), [`packages/retrieval/src/search/retrieve.ts`](../../packages/retrieval/src/search/retrieve.ts), [`packages/retrieval/src/search/plan/build-plan.ts`](../../packages/retrieval/src/search/plan/build-plan.ts), [`packages/retrieval/src/search/spaces/admission.ts`](../../packages/retrieval/src/search/spaces/admission.ts), [`packages/retrieval/src/embeddings/gateway.ts`](../../packages/retrieval/src/embeddings/gateway.ts), [`packages/retrieval/src/projections/validation/evidence-support.ts`](../../packages/retrieval/src/projections/validation/evidence-support.ts), [`packages/retrieval/src/projections/projection/create-projection.ts`](../../packages/retrieval/src/projections/projection/create-projection.ts), [`packages/retrieval/src/projections/classification/disposition-spaces.ts`](../../packages/retrieval/src/projections/classification/disposition-spaces.ts)
**Interface:** Backend types, in-memory exact adapter, Postgres adapter, ExploratoryPublicationCoordinator (publish, rollback, reconcile), and the VectorItemEntityLink shape with validateVectorItemEntityLink., The search submodule exports buildRetrievalPlan and retrieve; its plan, space-admission, lexical, semantic, graph and rerank stages remain internal. The package root also exports the preserved projection, embedding and vector-backend interfaces., EmbeddingAdapter with discoverModel, embedOne, and embedMany; VercelAiGatewayEmbeddingAdapter and DeterministicFakeEmbeddingAdapter implement it; validateVector and vectorDigest bound output., validateEvidenceSupport over EvidenceSupport, createProjection into the contract DomainProjection union, and classifyProjectionSpaces mapping dispositions to spaces.
**Package:** @aiengineer/knowledge-retrieval ([`packages/retrieval/package.json`](../../packages/retrieval/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [contracts](#contracts), [core](#core), [preparation](#preparation)
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/retrieval/src/vector-backends/backends/postgres.test.ts`](../../packages/retrieval/src/vector-backends/backends/postgres.test.ts), [`packages/retrieval/src/vector-backends/publication/coordinator.test.ts`](../../packages/retrieval/src/vector-backends/publication/coordinator.test.ts), [`packages/retrieval/src/vector-backends/publication/verification.test.ts`](../../packages/retrieval/src/vector-backends/publication/verification.test.ts), [`packages/retrieval/src/vector-backends/spaces/link.test.ts`](../../packages/retrieval/src/vector-backends/spaces/link.test.ts), [`packages/retrieval/src/search/retrieve.test.ts`](../../packages/retrieval/src/search/retrieve.test.ts), [`packages/retrieval/src/search/plan/build-plan.test.ts`](../../packages/retrieval/src/search/plan/build-plan.test.ts), [`packages/retrieval/src/search/spaces/admission.test.ts`](../../packages/retrieval/src/search/spaces/admission.test.ts), [`packages/retrieval/src/embeddings/vectors.test.ts`](../../packages/retrieval/src/embeddings/vectors.test.ts), [`packages/retrieval/src/embeddings/gateway.test.ts`](../../packages/retrieval/src/embeddings/gateway.test.ts), [`packages/retrieval/src/projections/validation/evidence-support.test.ts`](../../packages/retrieval/src/projections/validation/evidence-support.test.ts), [`packages/retrieval/src/projections/projection/create-projection.test.ts`](../../packages/retrieval/src/projections/projection/create-projection.test.ts), [`packages/retrieval/src/projections/classification/disposition-spaces.test.ts`](../../packages/retrieval/src/projections/classification/disposition-spaces.test.ts) Package script names: build, examples, test, typecheck.
- src/vector-backends/spaces/link.ts is a shape only: no relational row binds a vector item to its projection target and admission in database contract 0.4.16. It has no caller until the S2 publication host.
- Not on the canonical HTTP retrieval path: apps/api serves retrieval through packages/persistence. The search submodule backs the in-memory exploratory index and evaluation corpora.

**Architecture and detailed docs:**

- [reference] [`docs/operations/reviews/retrieval.md`](../../docs/operations/reviews/retrieval.md) — Retrieval package review record
- [reference] [`docs/operations/reviews/vector-backends.md`](../../docs/operations/reviews/vector-backends.md) — Vector-backends package review record
- [reference] [`docs/operations/reviews/projections.md`](../../docs/operations/reviews/projections.md) — Projections package review record
- [reference] [`docs/operations/reviews/embeddings.md`](../../docs/operations/reviews/embeddings.md) — Embeddings package review record
- [reference] [`knowledge/preparation-and-publication.md`](../../knowledge/preparation-and-publication.md) — Prepare source material and publish a retrieval version
- [reference] [`knowledge/retrieval-and-evidence.md`](../../knowledge/retrieval-and-evidence.md) — Retrieve supported results and replay citations
- [accepted] [`docs/architecture/0002-deterministic-preparation.md`](../../docs/architecture/0002-deterministic-preparation.md) — Preparation pipeline
- [accepted] [`docs/architecture/0003-embedding-retrieval-evaluation.md`](../../docs/architecture/0003-embedding-retrieval-evaluation.md) — Embedding, retrieval, evaluation
- [reference] [`knowledge/evaluation-and-publication-gates.md`](../../knowledge/evaluation-and-publication-gates.md) — Evaluate, admit publication and verify rollback

## evaluation

**packages/evaluation** · package · implemented

Retrieval evaluations, benchmark statistics/comparisons, and human review structures.

**Enter:** [`packages/evaluation/src/index.ts`](../../packages/evaluation/src/index.ts)
**Interface:** Evaluation cases and benchmark/review functions.
**Package:** @aiengineer/knowledge-evaluation ([`packages/evaluation/package.json`](../../packages/evaluation/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [contracts](#contracts), [core](#core), [verification](#verification)
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/evaluation/src/index.test.ts`](../../packages/evaluation/src/index.test.ts), [`packages/evaluation/src/verification-benchmark-run-comparison.test.ts`](../../packages/evaluation/src/verification-benchmark-run-comparison.test.ts) Package script names: build, test, typecheck.

**Architecture and detailed docs:**

- [accepted] [`docs/architecture/0003-embedding-retrieval-evaluation.md`](../../docs/architecture/0003-embedding-retrieval-evaluation.md) — Embedding, retrieval, evaluation
- [reference] [`knowledge/evaluation-and-publication-gates.md`](../../knowledge/evaluation-and-publication-gates.md) — Evaluate, admit publication and verify rollback

## persistence

**packages/persistence** · package · implemented

Postgres, storage, operation ledger, verification records, and runtime wiring adapters.

**Enter:** [`packages/persistence/src/index.ts`](../../packages/persistence/src/index.ts), [`packages/persistence/src/wiring.ts`](../../packages/persistence/src/wiring.ts)
**Interface:** Persistence implementations; schema migrations remain in the database-contract repository. Host composition (packages/host) constructs these adapters; persistence never imports host.
**Package:** @aiengineer/knowledge-persistence ([`packages/persistence/package.json`](../../packages/persistence/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [application](#application), [contracts](#contracts), [core](#core), [verification](#verification)
**Other runtime dependencies:** @aiengineer/database-contract, pg, zod
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/persistence/src/operation-service.test.ts`](../../packages/persistence/src/operation-service.test.ts), [`packages/persistence/src/role-transaction.test.ts`](../../packages/persistence/src/role-transaction.test.ts) Package script names: build, test, typecheck.

**Architecture and detailed docs:**

- [reference] [`knowledge/service-boundaries.md`](../../knowledge/service-boundaries.md) — Choose a transport and the owning module
- [reference] [`knowledge/preparation-and-publication.md`](../../knowledge/preparation-and-publication.md) — Prepare source material and publish a retrieval version
- [reference] [`knowledge/retrieval-and-evidence.md`](../../knowledge/retrieval-and-evidence.md) — Retrieve supported results and replay citations
- [reference] [`knowledge/verification-and-admission.md`](../../knowledge/verification-and-admission.md) — Verify claims and admit exact downstream effects
- [reference] [`knowledge/durable-execution-and-recovery.md`](../../knowledge/durable-execution-and-recovery.md) — Understand fenced worker execution and bounded recovery
- [accepted] [`docs/architecture/0004-transport-call-graph.md`](../../docs/architecture/0004-transport-call-graph.md) — In-process servers call application; out-of-process callers use KnowledgeClient HTTP
- [reference] [`docs/verification/OPERATOR-RUNBOOK.md`](../../docs/verification/OPERATOR-RUNBOOK.md) — Verification recovery and operator actions
- [reference] [`docs/operations/runbooks.md`](../../docs/operations/runbooks.md) — Worker restart, leases, callbacks, incidents
- [reference] [`knowledge/capture-conversion-and-custody.md`](../../knowledge/capture-conversion-and-custody.md) — Acquire source bytes and preserve conversion custody
- [reference] [`knowledge/evaluation-and-publication-gates.md`](../../knowledge/evaluation-and-publication-gates.md) — Evaluate, admit publication and verify rollback
- [reference] [`docs/architecture/technology-stack.md`](../../docs/architecture/technology-stack.md) — Pinned technology stack and runtime definitions

## policy

**packages/policy** · package · implemented

Authorization, capability, retrieval, promotion, selection-eligibility, and verification admission decisions.

**Enter:** [`packages/policy/src/index.ts`](../../packages/policy/src/index.ts), [`packages/policy/src/selection-eligibility.ts`](../../packages/policy/src/selection-eligibility.ts), [`packages/policy/src/verification-policy.ts`](../../packages/policy/src/verification-policy.ts)
**Interface:** Policy functions; successful execution alone does not authorize publication., evaluateSelectionEligibility is a pure representation-eligibility read returning reasons, diversity group and per-space budget effect; it never enforces membership or budget.
**Package:** @aiengineer/knowledge-policy ([`packages/policy/package.json`](../../packages/policy/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [contracts](#contracts), [core](#core), [verification](#verification)
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/policy/src/policy.test.ts`](../../packages/policy/src/policy.test.ts), [`packages/policy/src/verification-policy.test.ts`](../../packages/policy/src/verification-policy.test.ts), [`packages/policy/src/selection-eligibility.test.ts`](../../packages/policy/src/selection-eligibility.test.ts) Package script names: build, test, typecheck.
- Selection eligibility has no caller until S2; membership, budget and authority enforcement stays in packages/persistence/src/promotion-selection.ts.

**Architecture and detailed docs:**

- [reference] [`docs/operations/reviews/policy.md`](../../docs/operations/reviews/policy.md) — Policy package review record, including selection eligibility
- [reference] [`knowledge/preparation-and-publication.md`](../../knowledge/preparation-and-publication.md) — Prepare source material and publish a retrieval version
- [reference] [`knowledge/retrieval-and-evidence.md`](../../knowledge/retrieval-and-evidence.md) — Retrieve supported results and replay citations
- [reference] [`knowledge/verification-and-admission.md`](../../knowledge/verification-and-admission.md) — Verify claims and admit exact downstream effects
- [accepted] [`docs/architecture/0003-embedding-retrieval-evaluation.md`](../../docs/architecture/0003-embedding-retrieval-evaluation.md) — Embedding, retrieval, evaluation
- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants
- [reference] [`docs/security.md`](../../docs/security.md) — Authentication, capability admission, parser isolation
- [reference] [`knowledge/evaluation-and-publication-gates.md`](../../knowledge/evaluation-and-publication-gates.md) — Evaluate, admit publication and verify rollback

## testkit

**packages/testkit** · package · implemented

Curated evaluation corpora, embedding bundles, retrieval fixtures, and operational test assets.

**Enter:** [`packages/testkit/src/index.ts`](../../packages/testkit/src/index.ts)
**Interface:** Fixture loaders and test helpers; some bundle sources are sibling-repository inputs.
**Package:** @aiengineer/knowledge-testkit ([`packages/testkit/package.json`](../../packages/testkit/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [core](#core), [evaluation](#evaluation), [retrieval](#retrieval)
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/testkit/src/broad-evaluation-corpus.test.ts`](../../packages/testkit/src/broad-evaluation-corpus.test.ts), [`packages/testkit/src/embedding-bundles.test.ts`](../../packages/testkit/src/embedding-bundles.test.ts) Package script names: build, test, typecheck.

**Architecture and detailed docs:**

- [accepted] [`docs/architecture/0003-embedding-retrieval-evaluation.md`](../../docs/architecture/0003-embedding-retrieval-evaluation.md) — Embedding, retrieval, evaluation

## verification

**packages/verification** · package · implemented

Evidence verification algorithms: canonical primitives, staged deterministic bundle engine, selector resolution, extraction, report gates, evidence-closed semantic judging, providers, and provenance seal/replay.

**Enter:** [`packages/verification/src/index.ts`](../../packages/verification/src/index.ts), [`packages/verification/src/prototype-compat/index.ts`](../../packages/verification/src/prototype-compat/index.ts)
**Interface:** Explicit named exports from src/index.ts consumed inside Knowledge Services; legacy prototype shapes via the ./prototype-compat subpath export; external callers use public service surfaces.
**Package:** @aiengineer/knowledge-verification ([`packages/verification/package.json`](../../packages/verification/package.json))
**Export subpaths:** ., ./prototype-compat. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [contracts](#contracts)
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/verification/src/prototype-compat/prototype-compat.test.ts`](../../packages/verification/src/prototype-compat/prototype-compat.test.ts), [`packages/verification/examples/02-resolve-selectors.test.ts`](../../packages/verification/examples/02-resolve-selectors.test.ts), [`packages/verification/examples/03-deterministic-bundle.test.ts`](../../packages/verification/examples/03-deterministic-bundle.test.ts), [`packages/verification/examples/06-seal-inspect-replay.test.ts`](../../packages/verification/examples/06-seal-inspect-replay.test.ts) Package script names: build, examples, test, typecheck.

**Architecture and detailed docs:**

- [reference] [`knowledge/verification-and-admission.md`](../../knowledge/verification-and-admission.md) — Verify claims and admit exact downstream effects
- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants
- [reference] [`docs/operations/reviews/verification.md`](../../docs/operations/reviews/verification.md) — Verification package quality review and executable media locator examples
- [reference] [`packages/verification/CAPABILITIES.md`](../../packages/verification/CAPABILITIES.md) — Verification library capability matrix: selectors, deterministic diversity, semantic scope, linked to examples

## verification-canonical

**packages/verification/src/canonical** · algorithm module · implemented

RFC 8785 canonical JSON and prefixed SHA-256 digests shared by every stage.

**Enter:** [`packages/verification/src/canonical/index.ts`](../../packages/verification/src/canonical/index.ts)
**Interface:** canonicalizeJson, digestCanonicalJson, sha256Digest, isSha256Digest, ZERO_SHA256_DIGEST, prototype digest conversions.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/verification/src/deterministic/deterministic.test.ts`](../../packages/verification/src/deterministic/deterministic.test.ts), [`packages/verification/examples/01-canonical-digest.test.ts`](../../packages/verification/examples/01-canonical-digest.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.
- Output participates in digests and signatures; never vary by deployment.

**Architecture and detailed docs:**

- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants

## verification-decimal

**packages/verification/src/decimal** · algorithm module · implemented

Exact rational-decimal parsing, replay, tolerance, and rounding.

**Enter:** [`packages/verification/src/decimal/index.ts`](../../packages/verification/src/decimal/index.ts)
**Interface:** parseDecimal, replayDecimalOperation, compareFractions, withinTolerance, formatRoundedDecimal.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/verification/src/deterministic/deterministic.test.ts`](../../packages/verification/src/deterministic/deterministic.test.ts), [`packages/verification/src/extraction/extraction.test.ts`](../../packages/verification/src/extraction/extraction.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.

**Architecture and detailed docs:**

- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants

## verification-deterministic

**packages/verification/src/deterministic** · algorithm module · implemented

Staged mechanical bundle engine: index → capture integrity → runtime separation → evidence edges → assertions → metric graph → result.

**Enter:** [`packages/verification/src/deterministic/bundle-verification.ts`](../../packages/verification/src/deterministic/bundle-verification.ts)
**Interface:** verifyDeterministicBundle(input, options) returns checks and semanticEligibility; check codes are registered in deterministic/checks.ts. Canonical JSON and decimal helpers moved to verification-canonical and verification-decimal.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [verification-canonical](#verification-canonical), [verification-decimal](#verification-decimal), [verification-evidence-selection](#verification-evidence-selection)
**Checks:** [`packages/verification/src/deterministic/deterministic.test.ts`](../../packages/verification/src/deterministic/deterministic.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.

**Architecture and detailed docs:**

- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants
- [reference] [`docs/operations/reviews/verification.md`](../../docs/operations/reviews/verification.md) — Verification package quality review and executable media locator examples

## verification-evidence-selection

**packages/verification/src/evidence-selection** · algorithm module · implemented

Locates the evidence a VerificationSelector points at inside captured bytes: core text/JSON locators, projection-backed locators, and verification of resolver claims.

**Enter:** [`packages/verification/src/evidence-selection/resolve-evidence-selector.ts`](../../packages/verification/src/evidence-selection/resolve-evidence-selector.ts)
**Interface:** resolveEvidenceSelector(request, resolvers?) is the single entry; undefined means no resolver owns the selector kind, a non-resolved status means the locate failed., EvidenceSelectorResolver is the port for non-core kinds; projectionSelectorResolver dispatches to one parser+resolver per media kind under projections/.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [verification-canonical](#verification-canonical)
**Checks:** [`packages/verification/src/evidence-selection/resolve-evidence-selector.test.ts`](../../packages/verification/src/evidence-selection/resolve-evidence-selector.test.ts), [`packages/verification/src/evidence-selection/core-resolver.test.ts`](../../packages/verification/src/evidence-selection/core-resolver.test.ts), [`packages/verification/src/evidence-selection/projection-resolver.test.ts`](../../packages/verification/src/evidence-selection/projection-resolver.test.ts), [`packages/verification/src/evidence-selection/html-fallback-normalization.test.ts`](../../packages/verification/src/evidence-selection/html-fallback-normalization.test.ts), [`packages/verification/src/evidence-selection/text-offsets.test.ts`](../../packages/verification/src/evidence-selection/text-offsets.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.
- Canonical projections require admitted acquisition/parser lineage; geometry and transcript selectors do not perform OCR or transcription.

**Architecture and detailed docs:**

- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants
- [reference] [`docs/operations/reviews/verification.md`](../../docs/operations/reviews/verification.md) — Verification package quality review and executable media locator examples

## verification-extraction

**packages/verification/src/extraction** · algorithm module · implemented

Bounded schema admission and staged field, cross-field, and duplicate verification against immutable representation bytes.

**Enter:** [`packages/verification/src/extraction/field-verification.ts`](../../packages/verification/src/extraction/field-verification.ts), [`packages/verification/src/extraction/schema.ts`](../../packages/verification/src/extraction/schema.ts)
**Interface:** admitExtractionSchema, validateExtractionCandidate, verifyExtractionFields, verifyExtractionFieldsWithEvidence; comparators per FieldComparison kind in field-comparators.ts.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [verification-canonical](#verification-canonical), [verification-decimal](#verification-decimal), [verification-evidence-selection](#verification-evidence-selection)
**Checks:** [`packages/verification/src/extraction/extraction.test.ts`](../../packages/verification/src/extraction/extraction.test.ts), [`packages/verification/src/extraction/candidate-preflight.test.ts`](../../packages/verification/src/extraction/candidate-preflight.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.

**Architecture and detailed docs:**

- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants
- [reference] [`docs/operations/reviews/verification.md`](../../docs/operations/reviews/verification.md) — Verification package quality review and executable media locator examples

## verification-provenance

**packages/verification/src/provenance** · algorithm module · implemented

Audit-bundle seal/inspect/replay, recorded policy inputs, detached-seal benchmark publications, and DSSE/SLSA attestations.

**Enter:** [`packages/verification/src/provenance/seal.ts`](../../packages/verification/src/provenance/seal.ts), [`packages/verification/src/provenance/replay.ts`](../../packages/verification/src/provenance/replay.ts)
**Interface:** sealAuditBundle → inspectAuditBundle → replayAuditBundle over immutable lineage; replay.ts is the top of the package dependency graph.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [verification-deterministic](#verification-deterministic), [verification-report](#verification-report), [verification-semantic](#verification-semantic)
**Checks:** [`packages/verification/src/provenance/provenance.test.ts`](../../packages/verification/src/provenance/provenance.test.ts), [`packages/verification/src/provenance/attestation.test.ts`](../../packages/verification/src/provenance/attestation.test.ts), [`packages/verification/src/provenance/benchmark-publication.test.ts`](../../packages/verification/src/provenance/benchmark-publication.test.ts), [`packages/verification/src/provenance/benchmark-comparison-publication.test.ts`](../../packages/verification/src/provenance/benchmark-comparison-publication.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.

**Architecture and detailed docs:**

- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants

## verification-report

**packages/verification/src/report** · algorithm module · implemented

Claim decomposition acceptance and report-wide mechanical gates.

**Enter:** [`packages/verification/src/report/report-wide.ts`](../../packages/verification/src/report/report-wide.ts), [`packages/verification/src/report/decomposition.ts`](../../packages/verification/src/report/decomposition.ts)
**Interface:** acceptClaimDecomposition, evaluateDecompositionProposal; verifyReportWide, verifyReportWideFromLedger, applyReportWideMechanicalGates (may only add failures).
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/verification/src/report/decomposition.test.ts`](../../packages/verification/src/report/decomposition.test.ts), [`packages/verification/src/report/report-wide.test.ts`](../../packages/verification/src/report/report-wide.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.

**Architecture and detailed docs:**

- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants

## verification-authority

**packages/verification/src/authority** · algorithm module · implemented

Source authority and corroboration assessments.

**Enter:** [`packages/verification/src/authority/assessment.ts`](../../packages/verification/src/authority/assessment.ts)
**Interface:** assessSourceAuthority(assessments) returns an AuthorityDecision.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/verification/src/authority/assessment.test.ts`](../../packages/verification/src/authority/assessment.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.

**Architecture and detailed docs:**

- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants

## verification-semantic

**packages/verification/src/semantic** · algorithm module · implemented

Evidence-closed semantic verification: closure, authorization, judge ports, output lattice validation, cross-family reconciliation, drift, rescue, attribution.

**Enter:** [`packages/verification/src/semantic/closure.ts`](../../packages/verification/src/semantic/closure.ts), [`packages/verification/src/semantic/authorize.ts`](../../packages/verification/src/semantic/authorize.ts), [`packages/verification/src/semantic/verify-case.ts`](../../packages/verification/src/semantic/verify-case.ts)
**Interface:** verifyAssertionSemantics = mechanicalSemanticClosure → authorizeSemanticCase({ bundle, deterministicResult, assertionId, selectedFragments }) → verifySemanticCase; no reversal of deterministic failure.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [verification-deterministic](#verification-deterministic), [verification-canonical](#verification-canonical)
**Checks:** [`packages/verification/src/semantic/authorize.test.ts`](../../packages/verification/src/semantic/authorize.test.ts), [`packages/verification/src/semantic/verification.test.ts`](../../packages/verification/src/semantic/verification.test.ts), [`packages/verification/src/semantic/judge-output.test.ts`](../../packages/verification/src/semantic/judge-output.test.ts), [`packages/verification/src/semantic/diagnostics.test.ts`](../../packages/verification/src/semantic/diagnostics.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.

**Architecture and detailed docs:**

- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants

## verification-providers

**packages/verification/src/providers** · algorithm module · implemented

Provider port, HTTP bounds, one bounded dispatch procedure, Gateway/Interfaze adapters, recorded/NLI judges, and conformance registry.

**Enter:** [`packages/verification/src/providers/dispatch.ts`](../../packages/verification/src/providers/dispatch.ts), [`packages/verification/src/providers/gateway.ts`](../../packages/verification/src/providers/gateway.ts), [`packages/verification/src/providers/interfaze.ts`](../../packages/verification/src/providers/interfaze.ts)
**Interface:** dispatchBoundedCompletion enforces admission → persist request → fetch → persist response → interpret; adapters raise ProviderFailure with code and retryable flag and never retry.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [verification-semantic](#verification-semantic), [verification-extraction](#verification-extraction)
**Checks:** [`packages/verification/src/providers/providers.test.ts`](../../packages/verification/src/providers/providers.test.ts), [`packages/verification/src/providers/gateway-semantic-observation.test.ts`](../../packages/verification/src/providers/gateway-semantic-observation.test.ts), [`packages/verification/src/providers/semantic-judge.test.ts`](../../packages/verification/src/providers/semantic-judge.test.ts), [`packages/verification/src/providers/preflight-json.test.ts`](../../packages/verification/src/providers/preflight-json.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.

**Architecture and detailed docs:**

- [reference] [`docs/verification/README.md`](../../docs/verification/README.md) — Verification behavior and invariants
- [reference] [`docs/security.md`](../../docs/security.md) — Authentication, capability admission, parser isolation

## docling

**services/docling** · service · implemented

Pinned Docling Serve conversion deployment boundary.

**Enter:** [`services/docling/compose.yaml`](../../services/docling/compose.yaml), [`services/docling/README.md`](../../services/docling/README.md)
**Interface:** Conversion HTTP service behind the TypeScript adapter.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [preparation](#preparation)
**Checks:** No specific test anchor registered.
- Docling is not orchestration or publication authority.

**Architecture and detailed docs:**

- [proposed] [`docs/operations/internal-fallbacks-and-application-order.md`](../../docs/operations/internal-fallbacks-and-application-order.md) — Internal fallbacks and application folder order
- [proposed] [`docs/operations/conversion-and-chunking.md`](../../docs/operations/conversion-and-chunking.md) — Conversion route and admitted chunk profiles; vendor MCP import; no session-local splitters
- [accepted] [`docs/architecture/0001-runtime-and-deployment.md`](../../docs/architecture/0001-runtime-and-deployment.md) — Runtime, transport, and deployment changes
- [reference] [`docs/verification/DEPLOYMENT.md`](../../docs/verification/DEPLOYMENT.md) — Verification deployment and rollback
- [reference] [`knowledge/capture-conversion-and-custody.md`](../../knowledge/capture-conversion-and-custody.md) — Acquire source bytes and preserve conversion custody
- [reference] [`docs/architecture/technology-stack.md`](../../docs/architecture/technology-stack.md) — Pinned technology stack and runtime definitions

## parser

**services/parser** · service · implemented

Isolated native PDF geometry and HTML DOM parser (folder renamed from services/verification-parser; image tags unchanged); separate from Docling and OCR.

**Enter:** [`services/parser/parser.py`](../../services/parser/parser.py), [`services/parser/Dockerfile`](../../services/parser/Dockerfile)
**Interface:** Bounded stdin/stdout parser job invoked by SandboxedVerificationParser.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [preparation](#preparation)
**Checks:** No specific test anchor registered.
- Selectors never start processes. Deployment configuration, not request input, selects the admitted image.

**Architecture and detailed docs:**

- [reference] [`docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md`](../../docs/operations/package-cleanup/UNIT-4-APPLICATION-ORDER-AND-CATALOG.md) — Unit 4 folders, names, catalog
- [reference] [`docs/verification/DEPLOYMENT.md`](../../docs/verification/DEPLOYMENT.md) — Verification deployment and rollback
- [reference] [`docs/security.md`](../../docs/security.md) — Authentication, capability admission, parser isolation
- [reference] [`knowledge/capture-conversion-and-custody.md`](../../knowledge/capture-conversion-and-custody.md) — Acquire source bytes and preserve conversion custody
- [reference] [`docs/architecture/technology-stack.md`](../../docs/architecture/technology-stack.md) — Pinned technology stack and runtime definitions

## script-experiments

**scripts/experiments** · experiment · partial

Curated model-card verification experiments; run results are not canonical architecture.

**Enter:** [`scripts/experiments/model-card-verification/README.md`](../../scripts/experiments/model-card-verification/README.md)
**Interface:** Experiment-specific instructions and selected entry points; outputs stay excluded.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [verification](#verification)
**Checks:** No specific test anchor registered.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## skill-schema-explore

**skills/schema-explore** · skill · implemented

Progressive-disclosure procedure for navigating the pinned schema workspace without querying the database.

**Enter:** [`skills/schema-explore/SKILL.md`](../../skills/schema-explore/SKILL.md)
**Interface:** schema-explore skill: knowledge schema search/get/manifest/materialize; MCP schema_* equivalents.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [knowledge-db](#knowledge-db), [verification-executor](#verification-executor)
**Checks:** No specific test anchor registered.
- Does not query the database; use knowledge-db.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## skill-knowledge-db

**skills/knowledge-db** · skill · implemented

Procedure for catalog reads and reproducible knowledge-read snapshots that an ingestion intent can cite.

**Enter:** [`skills/knowledge-db/SKILL.md`](../../skills/knowledge-db/SKILL.md)
**Interface:** knowledge-db skill: knowledge db head/read-intent/sql/explain and artifact get; MCP db_* / artifact_get.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [knowledge-db](#knowledge-db), [verification-executor](#verification-executor)
**Checks:** No specific test anchor registered.
- Never writes; catalog queries are evidence, ad-hoc SQL is not.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## skill-knowledge-ingest

**skills/knowledge-ingest** · skill · implemented

Procedure for composing, planning, applying, and verifying knowledge-ingestion intents through the executor.

**Enter:** [`skills/knowledge-ingest/SKILL.md`](../../skills/knowledge-ingest/SKILL.md)
**Interface:** knowledge-ingest skill: knowledge ingest plan/apply/receipt; MCP ingest_* / artifact_get.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [knowledge-db](#knowledge-db), [verification-executor](#verification-executor)
**Checks:** No specific test anchor registered.
- The agent never writes SQL; the executor writes as executor_service.

**Architecture and detailed docs:**

- [proposed] [`docs/operations/internal-fallbacks-and-application-order.md`](../../docs/operations/internal-fallbacks-and-application-order.md) — Internal fallbacks and application folder order

## skill-knowledge-verification

**skills/knowledge-verification** · agent skill · implemented

Platform verification procedure with assertion/media routing, admitted operations, held outcomes and audit limits.

**Enter:** [`skills/knowledge-verification/SKILL.md`](../../skills/knowledge-verification/SKILL.md), [`skills/knowledge-verification/capabilities.md`](../../skills/knowledge-verification/capabilities.md)
**Interface:** Versioned platform CLI/MCP procedure; complete directory content participates in skill conformance and consumer pins.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [verification](#verification), [application](#application), [verification-executor](#verification-executor)
**Checks:** No specific test anchor registered.
- Instructions describe public contracts; a seal or mechanical pass is not semantic admission.

**Architecture and detailed docs:**

- [reference] [`docs/operations/reviews/verification.md`](../../docs/operations/reviews/verification.md) — Verification package quality review and executable media locator examples

## skill-knowledge-acquisition-and-vetting

**skills/knowledge-acquisition-and-vetting** · agent skill · implemented

Source discovery, acquisition, sealed-byte inspection and vetting-proposal procedure across executor and platform surfaces; a fetch, seal or inspection is never admission.

**Enter:** [`skills/knowledge-acquisition-and-vetting/SKILL.md`](../../skills/knowledge-acquisition-and-vetting/SKILL.md), [`skills/knowledge-acquisition-and-vetting/cli-reference.md`](../../skills/knowledge-acquisition-and-vetting/cli-reference.md), [`skills/knowledge-acquisition-and-vetting/mcp-reference.md`](../../skills/knowledge-acquisition-and-vetting/mcp-reference.md), [`skills/knowledge-acquisition-and-vetting/examples.md`](../../skills/knowledge-acquisition-and-vetting/examples.md)
**Interface:** knowledge-acquisition-and-vetting skill 1.2.0: executor source discover/import/attempt/reconcile/select, verify_capture_source/verify_capture_file, verify_read_capture/verify_search_capture; platform source discover/fetch/vet.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [sources](#sources), [verification-executor](#verification-executor), [cli](#cli)
**Checks:** No specific test anchor registered.
- No source_resolve_identity operation; identity is resolved from captured bytes. Firecrawl/Tavily MCP stay in the agent environment and are imported as self-reported receipts.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## skill-knowledge-preparation-and-promotion

**skills/knowledge-preparation-and-promotion** · agent skill · implemented

Conversion route, node inspection, admitted chunk-profile preview, content linking, embedding and promotion-proposal procedure over already stored bytes; a routing receipt or chunk preview is not admission.

**Enter:** [`skills/knowledge-preparation-and-promotion/SKILL.md`](../../skills/knowledge-preparation-and-promotion/SKILL.md), [`skills/knowledge-preparation-and-promotion/cli-reference.md`](../../skills/knowledge-preparation-and-promotion/cli-reference.md), [`skills/knowledge-preparation-and-promotion/mcp-reference.md`](../../skills/knowledge-preparation-and-promotion/mcp-reference.md), [`skills/knowledge-preparation-and-promotion/examples.md`](../../skills/knowledge-preparation-and-promotion/examples.md)
**Interface:** knowledge-preparation-and-promotion skill 1.4.0: executor source_prepare_captured, content_link_plan/apply/receipt, content_summary_prepare; platform document convert/compare, chunk preview/build, promotion propose/review/status, embed run/verify/status; platform MCP equivalents.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [preparation](#preparation), [application](#application), [verification-executor](#verification-executor), [cli](#cli), [mcp](#mcp)
**Checks:** No specific test anchor registered.
- Converts stored artifacts only and never fetches a URL; no session-local splitter; promotion_selection_select and promotion select are absent operations.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## skill-knowledge-retrieval-and-evidence

**skills/knowledge-retrieval-and-evidence** · agent skill · implemented

Scoped retrieval planning, search, per-stage explanation, immutable evidence-packet reads and citation replay through the platform CLI and MCP.

**Enter:** [`skills/knowledge-retrieval-and-evidence/SKILL.md`](../../skills/knowledge-retrieval-and-evidence/SKILL.md)
**Interface:** knowledge-retrieval-and-evidence skill 1.2.0: ks knowledge retrieve plan/search/explain/run/packet/citations; MCP knowledge_retrieve_plan/search/explain/run/packet/citations.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [retrieval](#retrieval), [cli](#cli), [mcp](#mcp)
**Checks:** No specific test anchor registered.
- Context-only neighbors are never proof; revoked support is omitted or abstained; a retrieval result never becomes a publication decision.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## skill-knowledge-evaluation

**skills/knowledge-evaluation** · agent skill · implemented

Frozen-version evaluation procedure: reviewed retrieval cases, experiment runs, comparisons and failure diagnosis that recommend, never execute, a knowledge release.

**Enter:** [`skills/knowledge-evaluation/SKILL.md`](../../skills/knowledge-evaluation/SKILL.md)
**Interface:** knowledge-evaluation skill 1.1.0: platform eval generate/run/compare/failures and benchmark compare/comparison; MCP evaluation.generate_query_candidates/run_experiment/compare_experiments/inspect_failures.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [evaluation](#evaluation), [cli](#cli)
**Checks:** No specific test anchor registered.
- An evaluation report is a recommendation and evidence binding; it never switches an official pointer, revokes support, or weakens a failed hard gate.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## skill-vector-store-management

**skills/vector-store-management** · agent skill · implemented

Store-class-explicit vector-store creation, document addition, evaluation, status, and guarded space publish/rollback submissions through the platform CLI.

**Enter:** [`skills/vector-store-management/SKILL.md`](../../skills/vector-store-management/SKILL.md)
**Interface:** vector-store-management skill 1.1.0: platform store create/show/add-documents/evaluate/status, space publish/rollback, operation status/reconcile.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [retrieval](#retrieval), [application](#application), [cli](#cli)
**Checks:** No specific test anchor registered.
- Submissions grant no activation or rollback authority; store search and space rebuild are absent; the platform MCP catalog has no publication or space activation tool.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## skill-verification-executor

**apps/verification-executor/skills/knowledge-verify** · agent skill · implemented

Executor capture, quote, claim, extraction, policy and report procedure with a shipped offline CLI scaffold.

**Enter:** [`apps/verification-executor/skills/knowledge-verify/SKILL.md`](../../apps/verification-executor/skills/knowledge-verify/SKILL.md), [`apps/verification-executor/skills/knowledge-verify/examples/offline.mjs`](../../apps/verification-executor/skills/knowledge-verify/examples/offline.mjs)
**Interface:** Versioned executor CLI procedure; templates and references ship in the sandbox tarball and complete-content consumer pins.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [verification-executor](#verification-executor), [verification](#verification), [verification-extraction](#verification-extraction)
**Checks:** No specific test anchor registered.
- Requires a matching executor build for optional comparison rules; host recovery governs production retries.

**Architecture and detailed docs:**

- [reference] [`docs/operations/reviews/verification-executor.md`](../../docs/operations/reviews/verification-executor.md) — Verification executor intent, skill, example and consumer pin review

## verification-internal

**packages/verification/src/internal** · support module · implemented

Package-private helpers: deep freeze, plain-record guards, and the allocation-bounded JSON walker shared by extraction, semantic, and provider preflights.

**Enter:** [`packages/verification/src/internal/bounded-json.ts`](../../packages/verification/src/internal/bounded-json.ts), [`packages/verification/src/internal/deep-freeze.ts`](../../packages/verification/src/internal/deep-freeze.ts), [`packages/verification/src/internal/guards.ts`](../../packages/verification/src/internal/guards.ts)
**Interface:** Not exported from the package facade; callers keep their own error codes and byte-versus-character accounting.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/verification/src/extraction/candidate-preflight.test.ts`](../../packages/verification/src/extraction/candidate-preflight.test.ts), [`packages/verification/src/semantic/judge-output.test.ts`](../../packages/verification/src/semantic/judge-output.test.ts), [`packages/verification/src/providers/preflight-json.test.ts`](../../packages/verification/src/providers/preflight-json.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## verification-prototype-compat

**packages/verification/src/prototype-compat** · compatibility module · implemented

Frozen legacy prototype locator, hash, JSON-pointer, arithmetic, and bundle translation shapes.

**Enter:** [`packages/verification/src/prototype-compat/index.ts`](../../packages/verification/src/prototype-compat/index.ts)
**Interface:** Subpath export @aiengineer/knowledge-verification/prototype-compat; not on the root facade.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [verification-canonical](#verification-canonical), [verification-evidence-selection](#verification-evidence-selection)
**Checks:** [`packages/verification/src/prototype-compat/prototype-compat.test.ts`](../../packages/verification/src/prototype-compat/prototype-compat.test.ts)
- Internal verification seam; do not expose it as a cross-repository import contract.
- Legacy behavior is frozen: no algorithm changes, no new callers.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## jev

**packages/jev** · package · implemented

Jev decision provider adapters, captured input snapshots, local SQLite queue and bounded OS worker processes.

**Enter:** [`packages/jev/src/index.ts`](../../packages/jev/src/index.ts), [`packages/jev/src/service.ts`](../../packages/jev/src/service.ts), [`packages/jev/src/provider.ts`](../../packages/jev/src/provider.ts)
**Interface:** Private application implementation; public contracts are packages/contracts /jev. One supervisor per local database; at-least-once provider execution.
**Package:** @aiengineer/knowledge-jev ([`packages/jev/package.json`](../../packages/jev/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [contracts](#contracts)
**Other runtime dependencies:** zod
**Reviewed runtime/data relationships:** [contracts](#contracts)
**Checks:** [`packages/jev/src/service.test.ts`](../../packages/jev/src/service.test.ts) Package script names: build, test, typecheck.
- Single-host operator trust domain; no shared Supabase changes or distributed tenant guarantees.

**Architecture and detailed docs:**

- [reference] [`docs/architecture/modules/jev.md`](../../docs/architecture/modules/jev.md) — Jev processes, API, MCP, CLI and research
- [reference] [`knowledge/jev-decisions-and-workers.md`](../../knowledge/jev-decisions-and-workers.md) — Closed-choice decisions and Jev worker lifecycle

## jev-service

**apps/jev** · app · implemented

Dedicated Jev HTTP/Streamable HTTP MCP and stdio host, plus HTTP CLI through the public client.

**Enter:** [`apps/jev/src/index.ts`](../../apps/jev/src/index.ts), [`apps/jev/src/http.ts`](../../apps/jev/src/http.ts), [`apps/jev/src/mcp.ts`](../../apps/jev/src/mcp.ts)
**Interface:** jev serve/mcp-stdio; /v1/jev/jobs, batches, health and /mcp; jev_submit/batch/get/list/cancel/workers.
**Package:** @aiengineer/knowledge-jev-service ([`apps/jev/package.json`](../../apps/jev/package.json))
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [application](#application), [client](#client), [contracts](#contracts)
**Other runtime dependencies:** @modelcontextprotocol/sdk, zod
**Reviewed runtime/data relationships:** [application](#application), [client](#client), [contracts](#contracts), [jev](#jev)
**Checks:** [`apps/jev/src/http.test.ts`](../../apps/jev/src/http.test.ts) Package script names: build, test, typecheck.
- HTTP/MCP call application /jev; CLI uses KnowledgeJevClient. Dedicated service is user-authorized; broader ks CLI consolidation remains separate.

**Architecture and detailed docs:**

- [reference] [`docs/architecture/modules/jev.md`](../../docs/architecture/modules/jev.md) — Jev processes, API, MCP, CLI and research
- [reference] [`knowledge/jev-decisions-and-workers.md`](../../knowledge/jev-decisions-and-workers.md) — Closed-choice decisions and Jev worker lifecycle
- [reference] [`docs/architecture/current-state.md`](../../docs/architecture/current-state.md) — Current implementation, ownership and remaining cleanup

## skill-jev-system-one

**skills/jev-system-one** · skill · implemented

Agent procedure for closed-choice tasks, captured input references, process workers, uncertainty handling and LLM composition.

**Enter:** [`skills/jev-system-one/SKILL.md`](../../skills/jev-system-one/SKILL.md)
**Interface:** jev CLI, HTTP/MCP job contracts, provider primitives and caller-orchestrated taxonomy/reranking recipes.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** [jev-service](#jev-service)
**Checks:** No specific test anchor registered.
- Research recommendations and historical results are not production calibration.

**Architecture and detailed docs:**

- [reference] [`docs/architecture/modules/jev.md`](../../docs/architecture/modules/jev.md) — Jev processes, API, MCP, CLI and research

## agent-maintenance

**tools/maintenance** · tooling · implemented

Git and Cursor hook-driven review queue with Grok 4.7, bounded context and isolated proposals; GitHub dispatch handles remote work.

**Enter:** [`tools/maintenance/cli.mjs`](../../tools/maintenance/cli.mjs), [`tools/maintenance/engine.mjs`](../../tools/maintenance/engine.mjs), [`tools/maintenance/cursor-hooks.mjs`](../../tools/maintenance/cursor-hooks.mjs), [`tools/maintenance/context.mjs`](../../tools/maintenance/context.mjs), [`tools/maintenance/install-watcher.ps1`](../../tools/maintenance/install-watcher.ps1), [`tools/maintenance/policy.json`](../../tools/maintenance/policy.json), [`.github/maintenance/dispatch.mjs`](../../.github/maintenance/dispatch.mjs), [`.github/maintenance/cursor-run.mjs`](../../.github/maintenance/cursor-run.mjs)
**Interface:** Node CLI enqueue/reconcile/run/watch/status/pause/resume; Git hooks; Cursor prompt/edit/shell/stop hooks; explicit /agent provider task commands.
**Package:** not a standalone package
**Export subpaths:** none declared. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** none declared
**Reviewed runtime/data relationships:** none declared
**Checks:** [`tools/maintenance/maintenance.test.mjs`](../../tools/maintenance/maintenance.test.mjs), [`tools/maintenance/watcher.test.mjs`](../../tools/maintenance/watcher.test.mjs), [`.github/maintenance/dispatch.test.mjs`](../../.github/maintenance/dispatch.test.mjs), [`.github/maintenance/proposal.test.mjs`](../../.github/maintenance/proposal.test.mjs), [`.github/maintenance/cursor-run.test.mjs`](../../.github/maintenance/cursor-run.test.mjs), [`.github/maintenance/workflow.test.mjs`](../../.github/maintenance/workflow.test.mjs), [`tools/maintenance/cursor-hooks.test.mjs`](../../tools/maintenance/cursor-hooks.test.mjs), [`tools/maintenance/context.test.mjs`](../../tools/maintenance/context.test.mjs)
- A proposal is not merge approval. Remote activation needs published workflows and provider credentials. Full application verification retains its documented missing historical receipt.

**Architecture and detailed docs:**

- [reference] [`docs/operations/agent-maintenance.md`](../../docs/operations/agent-maintenance.md) — Git-driven maintenance, provider setup and test evidence

## knowledge-operation-protocol

**packages/knowledge-operation-protocol** · package · implemented

K01 Knowledge Operation Protocol ks.knowledge_operation.v2: origin, effect identity (effect-scoped recovery grant for a new attempt), envelope, status, receipt, capability descriptor, the WI-02 selected read (selected-report-read.v2 request, research-report-package.v2 manifest, typed refusal reasons), the WI-03 trusted assessment contracts (credential evaluation grant, report-observation/seal/use/review and decision-resolve requests, use-decision-resolution.v1), kop-canonical-json.v1 digests (lone surrogates refused), published JSON Schemas and golden vectors mirrored byte-for-byte into Mission Control.

**Enter:** [`packages/knowledge-operation-protocol/src/index.ts`](../../packages/knowledge-operation-protocol/src/index.ts)
**Interface:** none declared
**Package:** @aiengineer/knowledge-operation-protocol ([`packages/knowledge-operation-protocol/package.json`](../../packages/knowledge-operation-protocol/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** zod
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/knowledge-operation-protocol/src/golden.test.ts`](../../packages/knowledge-operation-protocol/src/golden.test.ts), [`packages/knowledge-operation-protocol/src/selected-read.test.ts`](../../packages/knowledge-operation-protocol/src/selected-read.test.ts) Package script names: build, generate, test, typecheck.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## research-core

**packages/research-core** · package · implemented

K02/K03 pure research domain: content-addressed records, qualifier profiles, support algebra, deterministic render/ledger/census, sealing, post-observation aggregation, WI-03 governed judgment policies (typed judgment basis, review required, never entailment), exact-use admissibility, invalidation, ports.

**Enter:** [`packages/research-core/src/index.ts`](../../packages/research-core/src/index.ts)
**Interface:** none declared
**Package:** @aiengineer/knowledge-research-core ([`packages/research-core/package.json`](../../packages/research-core/package.json))
**Export subpaths:** ., ./testing. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [knowledge-operation-protocol](#knowledge-operation-protocol)
**Other runtime dependencies:** zod
**Reviewed runtime/data relationships:** [knowledge-operation-protocol](#knowledge-operation-protocol)
**Checks:** [`packages/research-core/src/support/support-sets.test.ts`](../../packages/research-core/src/support/support-sets.test.ts) Package script names: build, test, typecheck.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## knowledge-db-contract

**packages/knowledge-db-contract** · package · implemented

K09 common verification SQL component knowledge_verification 2.5.0 (migrations 0001..0008: records, signed seal with pinned keys, admission with normalized values and scoped review, outbox enqueue/ack/settle, durable operations, report kind pin, report assessment, single-use credential nonces and K01 protocol receipts, server-clock credential use and a required normalized-values digest on admission, the WI-05 dispatch journal and native commit stamp; capability roles) with its fail-closed installer and knowledge-db CLI; installed before each application's domain bindings.

**Enter:** [`packages/knowledge-db-contract/src/installer.ts`](../../packages/knowledge-db-contract/src/installer.ts)
**Interface:** none declared
**Package:** @aiengineer/knowledge-db-contract ([`packages/knowledge-db-contract/package.json`](../../packages/knowledge-db-contract/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** none declared
**Other runtime dependencies:** pg
**Reviewed runtime/data relationships:** none declared
**Checks:** [`packages/knowledge-db-contract/src/installer.integration.test.ts`](../../packages/knowledge-db-contract/src/installer.integration.test.ts) Package script names: build, manifest, test, typecheck.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## binding-aiengineer-postgres

**packages/bindings/aiengineer-postgres** · package · implemented

K05 AI Engineer PostgreSQL binding over the component: tenant-scoped role-bounded transactions, record stores, custody, K07 seal verification on seal and load, reviewer grants and adjudications, correction closure, and the ResearchBinding the application coordinator drives; exact-use admission delegates to the knowledge-db admission module; its K01 backend: BACKEND (registry id aiengineer-postgres), the component backend both PostgreSQL bindings compose from, and the injected ingestion apply port (knowledge-ingestion-intent/v1).

**Enter:** [`packages/bindings/aiengineer-postgres/src/research-binding.ts`](../../packages/bindings/aiengineer-postgres/src/research-binding.ts), [`packages/bindings/aiengineer-postgres/src/backend.ts`](../../packages/bindings/aiengineer-postgres/src/backend.ts)
**Interface:** none declared
**Package:** @aiengineer/knowledge-binding-aiengineer-postgres ([`packages/bindings/aiengineer-postgres/package.json`](../../packages/bindings/aiengineer-postgres/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [application](#application), [knowledge-db](#knowledge-db), [host](#host), [knowledge-operation-protocol](#knowledge-operation-protocol), [research-core](#research-core)
**Other runtime dependencies:** pg, zod
**Reviewed runtime/data relationships:** [knowledge-operation-protocol](#knowledge-operation-protocol), [research-core](#research-core), [knowledge-db-contract](#knowledge-db-contract), [application](#application), [host](#host)
**Checks:** [`packages/bindings/aiengineer-postgres/src/research.integration.test.ts`](../../packages/bindings/aiengineer-postgres/src/research.integration.test.ts), [`packages/bindings/aiengineer-postgres/src/backend.test.ts`](../../packages/bindings/aiengineer-postgres/src/backend.test.ts) Package script names: build, test, typecheck.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## binding-biotech-graph

**packages/bindings/biotech-graph** · package · implemented

K06 Biotech graph binding: K02 records in the knowledge_verification component (installation biotech), exact-use admission plus enqueue_dispatch in one PostgreSQL transaction, BKS executor HTTP client (consume, v3 official reads, marker), verified acknowledgment, the binding descriptor and its K01 backend: BACKEND (registry id biotech-graph; apply port biotech-knowledge-apply/v1, outbox delivery reader, research store reused from aiengineer-postgres); no Neo4j driver.

**Enter:** [`packages/bindings/biotech-graph/src/index.ts`](../../packages/bindings/biotech-graph/src/index.ts), [`packages/bindings/biotech-graph/src/backend.ts`](../../packages/bindings/biotech-graph/src/backend.ts)
**Interface:** none declared
**Package:** @aiengineer/knowledge-binding-biotech-graph ([`packages/bindings/biotech-graph/package.json`](../../packages/bindings/biotech-graph/package.json))
**Export subpaths:** ., ./testing. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [application](#application), [binding-aiengineer-postgres](#binding-aiengineer-postgres), [knowledge-db](#knowledge-db), [host](#host), [knowledge-operation-protocol](#knowledge-operation-protocol), [research-core](#research-core)
**Other runtime dependencies:** zod
**Reviewed runtime/data relationships:** [knowledge-operation-protocol](#knowledge-operation-protocol), [research-core](#research-core), [application](#application), [binding-aiengineer-postgres](#binding-aiengineer-postgres), [host](#host)
**Checks:** [`packages/bindings/biotech-graph/src/biotech-graph.test.ts`](../../packages/bindings/biotech-graph/src/biotech-graph.test.ts), [`packages/bindings/biotech-graph/src/biotech-graph.integration.test.ts`](../../packages/bindings/biotech-graph/src/biotech-graph.integration.test.ts) Package script names: build, test, typecheck.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.

## bindings

**packages/bindings** · package · implemented

Store bindings that implement the research-core ports: aiengineer-postgres (K05) and biotech-graph (K06, through the BKS executor; PostgreSQL decision/outbox plus verified graph acknowledgment).

**Enter:** [`packages/bindings/aiengineer-postgres/src/index.ts`](../../packages/bindings/aiengineer-postgres/src/index.ts)
**Interface:** none declared
**Package:** @aiengineer/knowledge-binding-aiengineer-postgres ([`packages/bindings/aiengineer-postgres/package.json`](../../packages/bindings/aiengineer-postgres/package.json))
**Export subpaths:** .. Declared metadata; build outputs are not read.
**Declared internal package dependencies:** [application](#application), [knowledge-db](#knowledge-db), [host](#host), [knowledge-operation-protocol](#knowledge-operation-protocol), [research-core](#research-core)
**Other runtime dependencies:** pg, zod
**Reviewed runtime/data relationships:** [binding-aiengineer-postgres](#binding-aiengineer-postgres), [binding-biotech-graph](#binding-biotech-graph)
**Checks:** No specific test anchor registered. Package script names: build, test, typecheck.

**Architecture and detailed docs:**

No module-specific architecture document registered. Do not infer a design decision from the folder name.
<!-- END GENERATED: semantic-map -->
