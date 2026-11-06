# Final layout implementation review

Status: reference. Reviewed 2026-09-27 against `90844286c2653480bb48ac83bbe79a62a815db5e`.

Developer clarification after review: no live consumers use these services. Eve is the test consumer and future integration, and will be adapted directly to the new services and skills. The review's consumer inventory is integration work, not a production compatibility requirement. Run pre–Mission Control testing after cleanup and adaptation; no legacy adapters are required.

## Recommendation

Proceed with the accepted 14-package, four-app layout. The package merges follow existing dependency clusters, and a shared host can remove duplicated composition without moving transport concerns into application. Keep the seven-unit sequence, with a baseline task before unit 1 and a dependency-inversion prerequisite inside unit 5. Do not expand this cleanup into new research, Jev, parser-unification, or database-schema work.

The target is sound; several statements about current implementation and compatibility need qualification. The findings below are implementation gates, not evidence that the target has already been delivered. [The execution workspace](./workspace/README.md) records progress; `FINAL-LAYOUT.md` remains the target authority.

## Findings and required considerations

### R1. Break the database dependency cycle before the executor fold

Current manifests declare `ingestion/db-read → persistence → application`. Unit 1 preserves this valid graph as `knowledge-db → persistence → application`. Moving executor use cases into application and adding `application → knowledge-db` would create a cycle. Type-only imports still matter to declaration generation and the workspace build graph. There are also real runtime imports: `ingestion/src/content-links/{sources,summary-preparation}.ts` call persistence functions.

Evidence: [ingestion manifest](../../../packages/ingestion/package.json), [read manifest](../../../packages/db-read/package.json), [application manifest](../../../packages/application/package.json), [persistence manifest](../../../packages/persistence/package.json), [summary preparation](../../../packages/ingestion/src/content-links/summary-preparation.ts), [executor composition](../../../apps/verification-executor/src/knowledge/context.ts).

**Unit 5 entry gate:** specify narrow database/transaction and content-admission/persistence interfaces owned by the consuming module; implement their adapters in persistence and inject them through host. Remove the production `knowledge-db → persistence` dependency before adding `application → knowledge-db`. Test adapters separately if integration-test dependencies would recreate a workspace build cycle. Do not move the Postgres pool into core, make application import host, or add a new package solely to avoid deciding ownership. Preserve transaction scope, bounded roles, custody, and atomic receipt semantics. This is a separate, behavior-preserving prerequisite commit within unit 5, not part of unit 1's codemod.

### R2. Build on the shared verification host already present

The layout's survey overstates API-local ownership/admission. Both API and MCP already call `createVerificationHostRuntime` in persistence, which imports ownership/admission factories from application. `CanonicalRetrievalExecutor` is still API-local and MCP still has HTTP client shims.

Evidence: [shared host](../../../packages/persistence/src/verification-host-runtime.ts), [API composition](../../../apps/api/src/index.ts), [MCP composition](../../../apps/mcp/src/index.ts), [current service explanation](../../../knowledge/service-boundaries.md).

**Units 2–3:** relocate and reuse the existing host; inventory remaining shims and checks individually. Do not create competing ownership resolvers or move working application logic a second time. A transport-supplied tenant ID is input, not authenticated authority. HTTP/MCP retain credential extraction and protocol handling; application enforces tenant ownership, capabilities, and admission on every entry path, including local and worker calls.

### R3. Tool groups are not permission to rename existing protocols

Existing MCP names include `knowledge_*`, dotted pipeline names, executor `verify_*`, and `schema_*`, `db_*`, `ingest_*`, `artifact_get`. The target's uniform prefixes conflict with its promise to preserve tool names if interpreted as an immediate rename. Likewise, `application/src/verification` and the logical group `verify` deliberately differ.

Evidence: [main MCP](../../../apps/mcp/src/index.ts), [executor MCP](../../../apps/verification-executor/src/mcp.ts), [executor knowledge catalog](../../../apps/verification-executor/src/knowledge/operations.ts).

**Units 3–6:** map existing names to the target groups and handlers and update Eve and skills to intentional new contracts. Do not infer authorization from a prefix. No compatibility aliases are required for the old test setup. Keep mechanical package moves behavior-preserving; surface changes belong in their own unit specifications and tests. Keep the existing internal `verification` folder unless its rename earns its own change; package counts do not depend on that spelling.

### R4. Adapt Eve's existing test integration to the new services

The executor exports `root-host/v1`, `scoped-host/v1`, and `evidence-reader/v1`. The sibling research agent actively resolves `scoped-host/v1`; its scripts build/pack/serve the executor, its sandbox installs `knowledge-verify`, and its skill sync reads the executor's skill home. A `private: true` manifest is not proof of no local consumer. These are current integration facts, even where they differ from the desired client-only architecture.

Evidence: [executor exports](../../../apps/verification-executor/package.json); sibling `research_ingestion_systems_agent/package.json`, `tools/team/host-bootstrap.mjs`, `tools/team/catalog-sync.mjs`, `tools/team/public-host.integration.test.mjs`, `tools/skill-pack-sync/sync.mjs`, and `agents/verified-research/agent/sandbox/sandbox.ts` (read-only inspection).

**Units 5–6 integration work:** inventory all three exported entrypoints, both current `knowledge` binaries, `knowledge-verify`, URLs/env names, tarball lookup, skill paths, and configured process startup. Adapt Eve directly to the new services, packaging, skills and capability profiles, and remove obsolete executor interfaces. Validate the resulting integration with smoke checks. No forwarding adapters, dual-running services, production migration, or legacy compatibility gate are required. After the cleanup completes, run pre–Mission Control testing using the new integration and updated skills.

### R5. Local storage and offline execution are different capabilities

The executor's filesystem store coexists with remote capture, semantic-provider configuration, and optional database services. `VERIFY_STORE_DIR` therefore does not mean that every executor operation is offline. `loadKnowledgeConfig` omits database services without a configured database. The remote sandbox bundle currently has its own dependency and required-skill checks.

Evidence: [executor config](../../../apps/verification-executor/src/executor.ts), [knowledge config](../../../apps/verification-executor/src/knowledge/context.ts), [sandbox packer](../../../apps/verification-executor/scripts/pack-sandbox.mjs), [CLI manifest](../../../apps/cli/package.json).

**Units 2 and 5:** specify a profile/capability matrix: server, offline file-backed local, and remote CLI. Offline commands must work without database/provider credentials or network calls. Server-only operations fail explicitly when unavailable; no silent local fallback after remote authorization/network errors. Decide explicitly how existing file-backed online capture/judging callers migrate. Give host a lifecycle (`close`, partial-startup cleanup, cancellation/drain); use lazy construction so a remote command or `--help` does not instantiate local persistence. Test the installed remote tarball outside the monorepo, with no database secrets or workspace resolution available.

### R6. Catalog parity needs more than the durable operation vocabulary

`application/src/operations/surface.ts` currently defines operation steps and deliberately separates worker-admitted from synchronous API-owned kinds. It is not a complete read/CLI/MCP/executor catalog. The executor has a separate schema-backed registry. Advertising every contract kind would expose operations that intentionally are not executable.

Evidence: [operation surface](../../../packages/application/src/operations/surface.ts), [executor registry](../../../apps/verification-executor/src/knowledge/operations.ts), [durability explanation](../../../knowledge/durable-execution-and-recovery.md).

**Unit 4:** define descriptors with group, operation/schema, authorization requirement, execution mode, profile availability, transport bindings, and explicit exclusions with reasons. Keep protocol bindings handwritten. Cover reads as well as mutations; preserve the distinction between declared, admitted, and executable operations. Do not wrap canonical ingestion in a second durable ledger just to fit `operations.submit`. Worker extraction must preserve fenced leases, heartbeat, cancellation, retry classification, idempotent receipts, and restart recovery.

### R7. Establish a reproducible baseline before mechanical changes

The merged PR's docs check passed, but its Verify run failed five tests because `embedding-bundle-seed-2026-09-01` was unavailable. The pre-PR main run failed earlier during typechecking; it does not prove these exact tests were previously green. A local sibling fixture can hide this checkout-isolation problem.

Evidence: [PR Verify run](https://github.com/Overton77/ai-engineer-knowledge-services/actions/runs/36285046974), [pre-PR main run](https://github.com/Overton77/ai-engineer-knowledge-services/actions/runs/36209322903), [fixture resolver](../../../packages/testkit/src/embedding-bundles.ts).

**Before unit 1:** complete [unit 0](./UNIT-0-BASELINE.md). Record test identities and pass/fail/skip totals, runtime exports, and compiler-resolved public type exports. Raw textual comparison of `index.d.ts` cannot follow `export *`; raw test counts cannot detect replacing one test with another. Keep evidence tied to the source SHA and runtime. Do not disable the failing tests or silently accept a red baseline. Preserve unavailable integration checks as explicit limitations.

### R8. Keep the mechanical unit genuinely mechanical

The four proposed merge groups have compatible ownership. I independently checked their declared dependency unions; the new graph is acyclic at unit 1. The original global-source export-name scan is not an exhaustive public export proof: use compiler-resolved barrels and built runtime exports at implementation time. There are 23 package manifests, 11 root manifest skills plus the executor skill; eight is a target, including a planned coordination skill.

**Unit 1:** preserve dependency sections, file-relative fixtures, examples, asset copying, script filters, packaged paths, and persisted procedure identities. Search explicitly scoped source paths; the original broad `rg` commands are not safe workspace-wide audit commands. Run preparation/retrieval example checks explicitly because root `verify` only runs verification examples. Keep historical receipts immutable. Do not make runtime identity changes while moving files.

**Units 6–7:** eight skill directories alone are not acceptance: preserve procedures, references, failure/recovery guidance, and manifest operation coverage. `knowledge-research` must compose existing capabilities and accurately describe gaps; it does not authorize implementing deferred F6 features. Classify runnable scripts before moving them; distinguish package build tooling from proof entrypoints and preserve deployed/startup references before archiving anything.

## Scope of this review

This is an architecture and implementation-readiness review, supported by selected manifests, code, tests, consumer entrypoints, and a local verification attempt recorded in the ledger. It is not a deployment audit, exhaustive security review, fresh-database proof, or certification that every export and test has already been preserved. No sibling repository or application behavior is changed by this preparation pass.
