# Unit 2 specification: shared host composition

Status: reference. Implemented on `refactor/ks-unit-2-host-composition` and integrated locally on 2026-09-27; the delivery record, exact validation and remaining seams are in the [ledger](./workspace/PROGRESS.md) and [delivered seams](#delivered-composition-and-remaining-seams) below. The next unit is [Unit 3](./UNIT-3-APPLICATION-AND-MCP.md). Original specification follows, prepared during Unit 1. Parent: [FINAL-LAYOUT.md](./FINAL-LAYOUT.md), unit 2. Progress and entry evidence: [workspace/PROGRESS.md](./workspace/PROGRESS.md).

## Scope and entry gate

Create `refactor/ks-unit-2-host-composition` from integrated main, or inspect and safely resume it if it already exists. Absorb `packages/config` into `packages/host` and extract construction and resource ownership from API, MCP and worker bootstraps. Preserve externally observable routes, tool names, CLI commands, authorization, admission, defaults and operation execution. This is composition work, not the executor fold or a new operation catalog.

Before editing, inspect the Unit 1 evidence and rerun the registered-replay test to reassess the missing original judge receipt. Unit 1's exception is not automatically an exception for Unit 2. Record the outcome and make an explicit continuation decision before acceptance; no new failure, fabricated receipt or weakened test is permitted. Unit 0 still cannot be described as green while the original receipt is absent.

Record current source and dependency graph, bootstrap behavior and runtime configuration errors. Keep one unit branch and cohesive commits; integrate only after the acceptance gates below. Do not load operator environment files or touch `.jev` state.

## Composition interface and dependency direction

`@aiengineer/knowledge-host` owns configuration, construction and cleanup. It imports application, persistence, contracts and the required algorithm/adaptor packages; application and persistence must never import host. Move `packages/config/src/{index,auth}.ts` under `host/src/config/`, preserving its exported types, schemas, defaults and identity behavior. Remove the old config package after updating its consumers and lockfile.

Expose a typed `createHost(options)` factory with explicit `profile`, `role` and supplied environment. Initially support `profile: server` for roles `api`, `mcp` and `worker`. Use a discriminated return type so consumers see the services their role actually constructs. Group constructed services under `knowledge`, `verify` and `operations`, plus worker execution dependencies and lifecycle methods where applicable. Do not expose a pretend `db` or `jev` implementation merely to complete the target shape. Do not return an untyped container or let transports reach arbitrary pools through it.

Unit 2 must not introduce `host → apps/*`. Keep transport-specific request/reply types, listeners, response mappings and credential extraction in apps. If a current API-owned factory is needed before Unit 3 moves its use case, pass a narrow, typed factory into composition; it may receive only the already-required ports. Specify its type in host, implement it in the current owner, and identify it explicitly as a Unit 3 seam. Do not copy a use case into host or add an application dependency on host to avoid this decision.

The interim factory seams are for existing retrieval/read/adjudication behavior, not authorization bypasses. They must preserve the trusted ownership context and existing `is*RequestAdmitted` factories. A tenant field from a request never becomes authority.

## Source move map and ownership

| Current source | Unit 2 destination/action |
| --- | --- |
| `packages/config/src/index.ts`, `auth.ts` | `packages/host/src/config/`; preserve config and identity exports. |
| `packages/persistence/src/verification-host-runtime.ts` | `packages/host/src/verification/host-runtime.ts`; retain the existing implementation and application factories, update imports and remove the persistence export. |
| `apps/api/src/index.ts:createApiRuntime` | Extract construction into `host/src/server/api.ts`; keep `buildServer`, request bridge, public-origin validation, callbacks, listeners and transport singleton in API. |
| `apps/mcp/src/index.ts:createMcpRuntime` | Extract common database/service construction into `host/src/server/mcp.ts`; keep MCP schemas/tools, HTTP lifecycle, credential handling and the temporary HTTP shim in MCP. |
| `apps/worker/src/index.ts:startWorker` | Extract adapter/service construction into `host/src/server/worker.ts`. Keep the process entry and signal/listener ownership in worker; retain explicit poll/start/stop behavior. |
| Worker `verification-*-runtime.ts` construction helpers | Move construction-only helpers under `host/src/verification/worker/`, preserving helper filenames and targeted tests. Keep activity algorithms in their existing owner until the application work explicitly moves them. |
| API `verification-*-runtime.ts` helpers and `verification-benchmark-capture-profile.ts` | Classify each helper before moving: construction goes under `host/src/verification/api/`; SQL reads, policy decisions and use cases stay owned by their existing implementation through typed factory seams until Unit 3. Record the exact classification in the ledger. |
| `apps/api/src/retrieval-executor.ts` | Keep implementation in API for Unit 3; inject its construction through a typed factory. Do not import API from host. |
| Worker `activity-registry.ts`, `canonical-worker.ts`, `worker.ts` | Preserve activity dispatch, leases, heartbeat, receipt and retry algorithms; host wires their dependencies through typed factories until their designated extraction. |

Update every config consumer, including API `auth.ts`, `a2a-http.ts`, provider/semantic reconciliation runtimes, benchmark capture profiles and MCP tests, not just the bootstraps. Search tracked source/manifests and regenerate the lockfile. Update literal moved-source paths in live proofs such as `scripts/verification-reads-runtime-proof.ts` and `scripts/prove-verification-structured-extraction-transports.ts`; retain historical receipts unchanged.

The current shared host is already called by API and MCP. Move it once, retaining its dynamic/static ownership rules, feature toggles, configured-kind lists and extra adjudication admission. Do not create a new admission resolver. Keep the serverless singleton in each transport; importing host must not open a pool, start a timer, launch children or read provider credentials.

## Profiles and lifecycle

| Execution context | Unit 2 contract | Later consolidation |
| --- | --- | --- |
| Server API/MCP/worker | Construct only the dependencies and capabilities enabled by the current role/configuration. Keep current required-config failures and optional development endpoints. | Unit 3 removes remaining API-local use cases and MCP HTTP shims. |
| Worker memory mode | Preserve the existing explicit development/test-only gate and behavior; never call this the offline file-backed profile. | Worker activity reorganization remains in the designated later units. |
| Local offline | Reserved and explicitly unavailable from the new factory until supported file-backed services are extracted. No network or database fallback. Existing CLI offline commands remain functional through their current route. | Unit 5 implements file-backed local operations and maps online capture/judging separately. |
| Remote CLI | Continue to use `KnowledgeClient`; do not import or instantiate host on remote execution or help. | Unit 5 unifies the CLI and sandbox packaging. |
| Dedicated Jev host | Retain current application entrypoint, config and one owner per queue. | See Jev consolidation below. |

Host owns an idempotent `close()` promise. Release resources in reverse construction order, even when one close fails, and clean up all resources acquired before a startup exception. A failed construction must leave no pool, timer or worker child behind. Transports close listeners before releasing the host; worker shutdown first stops scheduling and awaits the active run before closing persistence. Preserve reconciliation-before-scheduling, lease heartbeat, cancellation and retry classification. Concurrent close calls await the same cleanup; partial-start failure and a later close must not double-close resources.

Keep `WorkerHostDependencies.promotionSelection` fail-closed. Do not replace it with a default selector, infer authority from configuration presence, or silently enable production work in development memory mode.

## Jev preservation and later host consolidation

Keep `packages/jev` and `apps/jev` intact in Unit 2. Preserve `contracts/jev`, `application/jev`, `@aiengineer/knowledge-client/jev` (currently `packages/client-typescript/src/jev.ts`), `KnowledgeClient.jev`, the current CLI, six MCP tools and registered skill. Importing the consolidated host must not start Jev. Its current constructor opens SQLite, `start()` acquires queue ownership and launches children, and shutdown releases ownership; those semantics must remain explicit.

Coordinator sequencing decision for the later specification: Unit 5 must adapt Jev's dedicated transport into the shared API/MCP/CLI while retaining one service instance for a given SQLite database. HTTP and MCP in the same owner process share that instance; another process must use the published client rather than opening a competing supervisor. Unit 5 must define the owner process/start command and reject dual ownership, preserve recovery/cancellation/retry and authentication, then update the skills in Unit 6. Do not remove `apps/jev` before those equivalent public surfaces and lifecycle proofs pass.

`packages/jev` currently builds with `tsc --rootDir src --outDir dist`. Its child process resolves `worker.js` beside the compiled service; preserve that physical file and its dependencies. A single-file host bundle is insufficient proof. Use temporary queues and the existing fake/recorded provider tests for validation, never the operator's `.jev` files or paid experiments.

## Bounded implementation sequence

1. Capture config/host exports and bootstrap acceptance behavior; move config and shared verification host with consumers and manifest changes. Validate and commit.
2. Extract API/MCP construction using existing factories. Preserve protocol code and Unit 3 seams. Validate shared admission and transport bootstrap tests, then commit.
3. Extract worker construction and lifecycle. Preserve execution algorithms and promotion authority; add focused lifecycle failure-injection tests, validate and commit.
4. Update authored architecture/navigation and generate docs. Review imports, resource ownership, manifests and the explicit remaining Unit 3 seams. Write the bounded Unit 3 specification before local integration.

## Acceptance evidence

- Frozen install, full typecheck and build pass; dependency graph remains acyclic. Config/public types survive through the new host exports. API, MCP and worker composition no longer imports config or constructs shared verification host from persistence. No host source imports an app.
- Preserve the existing API `src/tests/bootstrap.test.ts`, `auth.test.ts`, `verification-ownership.test.ts`, retrieval executor and runtime suites; MCP `src/tests/{index,verification-tools,verification-surface-inventory,verification-operation-read,catalog}.test.ts`; worker `worker.test.ts`, `activity-registry.test.ts` and runtime suites; persistence host/wiring tests. Move tests with construction only where appropriate and retain test identities.
- Add meaningful tests for partial construction failure, concurrent/idempotent close, listener-before-host close, active-run drain and capability absence. Verify importing host and running remote CLI help opens no database/provider connection or local store. An unsupported local profile fails explicitly without reaching the network.
- Jev real-child process tests (`packages/jev/src/service.test.ts`), HTTP/MCP tests (`apps/jev/src/http.test.ts`) and client tests pass. Confirm the built child worker exists and is executed in tests; distinct PIDs, cancellation, retry, recovery and exclusive ownership remain covered.
- Run the entire test graph sequentially with bounded Vitest workers; list all failures and skips, and separately record the reassessment of the original missing fixture. Do not treat a failed `verify` as green or let it suppress downstream build/example checks.
- Run preparation/retrieval and verification examples, skill conformance, executor sandbox pack and fresh installed offline CLI smoke. Current executor packaging remains supported until Unit 5.
- Update `.agent-docs` authored inputs and live concepts, generate and check navigation; `git diff --check` passes. Preserve dated reviews and stored receipts. No shared database changes, provider calls, deployment or remote publication.
- Update the ledger with exact checks, remaining Unit 3/5 seams and Unit 3 specification. Merge this unit with a local merge commit only after its evidence has been reviewed, then return to main.

## Delivered composition and remaining seams

Recorded at Unit 2 exit. Code is authoritative; this section names what later units must retire.

- `@aiengineer/knowledge-host` exposes `createHost` with `profile: "server"` and roles `api`, `mcp` and `worker`; the return type follows the role. `profile: "local"` throws `HostProfileUnavailableError` (`HOST_PROFILE_UNAVAILABLE`) before any construction (superseded by Unit 5 slice 5B, which implements the local profile; the error remains for profiles host does not compose). `@aiengineer/knowledge-host/config` carries only the former config/identity exports.
- `HostResources` releases in reverse order, attempts every release, and shares one close across callers; `constructWithResources` releases partial construction. API/MCP runtimes expose an idempotent `close()` that closes the listener before the host. The worker's `stop()` stops scheduling, awaits the active run, then releases the host, and concurrent calls share it.
- Multi-fault ordering: pure configuration checks keep their previous order. Two intentional differences: MCP validates `KNOWLEDGE_API_URL` before constructing the repository (the pool is no longer leaked on that error), and API/MCP/worker now release the pool on any failure after it opened.
- Unit 3 seams (`apps/api/src/composition.ts`): `createCanonicalRetrievalExecutor`, `createVerificationDriftRevalidation`, and `createVerificationUseCases` (provider/semantic reconciliation, structured-extraction/audit-inspection/claims-report/capture/adjudication reads, benchmark capture profiles, adjudication decisions). MCP's `createApiClient` HTTP shim remains.
- Classification of API helpers: construction-only `verification-reads-runtime`, `verification-benchmark-reads-runtime` and `verification-benchmark-comparison-reads-runtime` moved to `host/src/verification/api/`; helpers with read authorization, ownership, actor matching, signature policy or use cases stayed in the API behind the seams above.
- Worker: host builds persistence, artifact stores, acquisition, conversion providers and the lazily credentialed embedding adapter, then reconciles before returning. The worker supplies a two-phase `WorkerExecutionFactory`: configuration checks before resources, then verification handlers, registry and `CanonicalDurableKnowledgeWorker`. Only `verification-audit-signing-runtime` was construction-only and moved to `host/src/verification/worker/`; the other `verification-*-runtime.ts` helpers bind activity handlers and remain until worker activity extraction.
- Unit 5 seams: local offline profile, remote CLI host exclusion (the CLI does not depend on host), executor fold and Jev transport consolidation. Jev is unchanged.
