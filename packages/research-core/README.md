# @aiengineer/knowledge-research-core (K02/K03)

The pure research domain for Sprint V and its port interfaces. It owns the immutable records (verification task,
assertion version, occurrence, evidence fragment, support set, observation, report revision, run, run manifest, use
decision), strict qualifier profiles, the support algebra, deterministic report rendering and final census, report
derivation, run sealing, post-observation aggregation, exact-use admission and invalidation closure.

Accepted contract: `platform/mission-control/docs/specs/provider-consolidation-2026-10/SPRINT-V-DESIGN.md` §2-§9.

## Boundaries

- Depends only on `@aiengineer/knowledge-operation-protocol` (K01) and `zod`. It reuses K01 `Ref`, digests, canonical
  JSON, `Origin`, `EvaluatorIdentity` and primitives; it never redefines them.
- No HTTP, SQL, Neo4j, model calls, orchestration SDK, filesystem or clock access. Every timestamp is an input.
- Ports (`src/ports`) take an `AuthScope` that services build from the host-authenticated invocation. Domain code never
  constructs it.
- Records carry `schemaVersion`, `id`, `tenant` and `binding`, never their own ref: `recordRef(kind, record)` derives
  the K01 `Ref` from the canonical bytes of the whole record.

## Consumers

Mission Control and Biotech Knowledge Services consume K01 wire schemas and Knowledge Services endpoints, never these
TypeScript internals. Inside Knowledge Services, `packages/application` (K04) composes these rules with bindings
(K05/K06) that implement the ports.

## Checks

From this directory: `corepack pnpm typecheck`, `corepack pnpm exec vitest run`, `corepack pnpm build`.
