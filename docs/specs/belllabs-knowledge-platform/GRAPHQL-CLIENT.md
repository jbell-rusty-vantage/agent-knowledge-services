# Biotech GraphQL optimization and application client

Revision: 2026-10-10. Research-backed implementation direction; schema adoption and selected product operations remain gated by [clarifications](CLARIFICATIONS.md). Target consumers are TypeScript web and React Native/Expo. Agents do not use this API in this release.

## What exists, and what does not follow from it

The service is at `biotech/biotech-knowledge-services/apps/graphql-api`, deployed at `https://bks-biotech-graphql-api.fly.dev`. A read-only health observation in this planning session returned `ok: true`, mutations disabled, vector enabled and limits 25/default, 100/max, depth 10, cost 25,000. The reported source SDL digest is `sha256:8313a6f83a2429fffdc9ce6cbdb03cc2808c7b06022040a1e4f36cd2720ae3eb`, matching the original pinned proposal. The selected v2 review candidate digest is `c7cf1235dba876b26460c54a6510028d2dcfc65989787eacd5b446f9034b4793`.

This proves the health endpoint's reported connectivity/settings. It does not prove accepted graph schema, migrated data, installed indexes, corpus coverage, user authorization, phrase-search success or production performance. The owner explicitly states that the proposed schema has not been implemented. Candidate v2 remains unaccepted; “deployed options” in its size reports describes a build recipe, not evidence that Fly serves v2.

The prescribed Fly wrapper failed because `flyctl` is unavailable in this environment. Actual Machine count, image/release, deployed dependency versions, memory/CPU, topology and Aura version/index/plugin state were not inspected. G00 requires that read-back before implementation uses configuration as production truth.

| Layer | Observed repository/configuration | Limit of evidence |
| --- | --- | --- |
| API | Apollo Server 5.5.1, Neo4j GraphQL 7.6.3, graphql-js 16.14.2, driver 6.2.0, Node 22 image | Local lock/source versions, not read-back of deployed image |
| Schema | Original pin loaded and transformed at startup; `/schema.graphql` returns source SDL | Source SDL is not the generated executable client schema |
| Fly | `iad`, shared 2 CPUs, 4 GB RAM, 3 GB Node heap; one minimum Machine; concurrency 50/100; 120 s startup grace | Desired configuration, not new live resource measurements |
| Read protection | Body/token/depth/cost/transaction limits and optional service API key | Not proof of per-user or per-field authorization; cost estimate has known gaps |
| Vector | Three original entity indexes declared; phrase provider configuration enabled | No proof that indexes, vectors or provider calls work; v2 has different index design |

## Goals and explicit non-goals

Deliver a bounded, authorized product entity/evidence read API, a small versioned typed client package, compatibility checks and measured Fly capacity. Use applicable Neo4j GraphQL features deliberately; enabling every feature would increase schema size, generated inputs and query cost. Preserve graph meaning and required product queries while disabling unused generated surfaces.

Do not rewrite the server framework, introduce federation, replace Fly with an Aura Data API, expose canonical graph mutations, or make GraphQL an agent dependency without a separate demonstrated need. Do not resize production based only on schema-file size. No deployment changes, generated-schema benchmarks or application fixtures are executed by this planning delivery; the read-only deployed health observation is recorded separately.

## Schema projection and build optimization

Keep four versioned objects: upstream domain schema; approved product read projection; generated executable schema; supported operation registry/client release. Add migrated graph/index compatibility as a separate release attestation. Every transformation must have a reviewed manifest and deterministic output. A product projection may select fewer fields/operations while preserving required graph mapping; it must not become a second ontology authority.

The current middleware denies mutations but still generates their schema families. The existing v2 report provides a promising reduction: original 57,908,325 bytes/38,034 inputs/530 mutation fields versus candidate 1,743,672 bytes/960 inputs/zero mutation fields. These are historical reported measurements, not newly reproduced or accepted production results. v2 still has unresolved owner decisions and planner/migration gaps.

Build an applicability matrix against the exact installed library:

| Lever | Proposed use | Compatibility/evidence requirement |
| --- | --- | --- |
| `@query` | Retain only needed root reads/connections/aggregates | Validate shipped operations; root switches have separate semantics |
| `@mutation` and relationship nested operations | Remove unused generated write families from product schema | Verify no Mutation root/canonical write route; middleware alone does not shrink schema |
| `@selectable` | Restrict unwanted read/aggregate exposure | Selection controls are not filter authorization |
| `@filterable` / `@sortable` | Keep only useful, index-supported filters/sorts | Check relationship aggregate filters separately and preserve necessary app queries |
| `@relationship(aggregate: false)` | Remove unneeded returned aggregate data | Does not alone disable aggregation filter input families |
| `features.excludeDeprecatedFields` | Explicit reviewed flags for unused compatibility surfaces | Current `{}` excludes nothing; test old operation compatibility before enabling flags |
| `@limit` | Default/max bounds where supported | Union-target fields need additional handling; no blanket boundedness claim |
| `@cypher` / `@customResolver` | Only measured product gaps that generated queries cannot serve well | Preserve auth/limits and batching; custom resolvers can reintroduce N+1 calls |
| `@fulltext` / `@vector` | Only approved search use cases and installed compatible indexes | Generation is not index creation, population, coverage or verification |

The five deprecated-field flags in the installed library are `mutationOperations`, `aggregationFilters`, `aggregationFiltersOutsideConnection`, `relationshipFilters`, and `attributeFilters`. The candidate report says enabling all five reduced its print to 732,065 bytes while retaining 960 inputs; this is a compatibility choice to remeasure, not a promise of corresponding heap savings. Splitting SDL files without reducing the combined generated surface does not solve schema growth. See the official [type controls](https://neo4j.com/docs/graphql/current/directives/schema-configuration/type-configuration/) and [field controls](https://neo4j.com/docs/graphql/current/directives/schema-configuration/field-configuration/).

G01 exports the executable product schema and feature manifest offline from the same builder/configuration as runtime. It must not require production secrets or invoke an embedding provider just to generate types. Pin source/projection/executable digests, dependencies and generation options. G06 measures build time, executable bytes/type counts and actual process heap/RSS, separately from full container startup.

## Operation admission and authorization

G02 supports a small reviewed set of real product queries first: entity card and paginated evidence/relationships selected by Q04. Give each stable ordering/tie-breakers, bounded variables and response semantics. Extend coverage in similarly reviewed slices.

Installed Neo4j GraphQL 7.6.3 excludes union-target relationships from the ordinary `@limit` handling. Current response-shape estimation nevertheless assumes capped list cardinality. The fix must derive admission from executable field metadata and actual library behavior: enforce compatible limits on those fields or exclude unsafe shapes from the supported operation set. Do not merely lower the global numeric threshold.

Measure and bound root aliases, repeated fragments, recursive input filters, input-array size, variable defaults and supplied values, offsets, nested relationship fanout, aggregate/count work, scalar-list/embedding payloads, response bytes and introspection. A row-count heuristic is not a bound on database work. Parser token limits do not bound nested JSON variables. Match executor limits with admission rather than charging for a fictitious cap. Unknown/expensive operations reject before database/provider work.

Use a trusted persisted-operation manifest if selected at Q04, with operation hash, variables policy and release compatibility. Hash lookup must be implemented on the server; code generation alone does not enforce it. Automatic persisted query caching reduces upload size but is not a safelist. Runtime variable bounds, authorization and timeouts remain necessary for trusted documents. See [Apollo APQ](https://www.apollographql.com/docs/apollo-server/performance/apq) and [operation safelisting](https://www.apollographql.com/docs/graphos/platform/security/persisted-queries).

G03 implements the selected user access path. Never embed the service `GRAPHQL_API_KEY` in browser bundles or Expo binaries. Choose verified short-lived user tokens at GraphQL or a product BFF that retains service credentials server-side. Passing `context.token` is not token verification. Enforce audience/issuer/application/actor and field/relationship visibility, including inference via filters, sorting, counts and aggregates. CORS is not authorization. Public graph data and actor-private saved research have distinct owners; no private account graph is inferred. See [JWT configuration](https://neo4j.com/docs/graphql/current/security/configuration/), [authorization](https://neo4j.com/docs/graphql/current/security/authorization/), and [authentication limitations](https://neo4j.com/docs/graphql/current/security/authentication/).

Canonical verification current-use rules also apply to product reads. G03 must define how approved publication/admission eligibility is enforced for official statements, including PostgreSQL authority linkage where required by ADR 0012. A raw generated traversal must not bypass revocation by reading a physically present stale projection. General research navigation may display qualified historical/held material only under its explicit product policy.

## Database execution and vector capability

For each selected operation, capture generated Cypher and non-secret plan evidence, establish index/constraint requirements, and compare latency/database work at representative cardinality. Do not log provider tokens or private query parameters. Range/text/fulltext/vector indexes must match actual predicates, labels, properties and version compatibility. `EXPLAIN` validates planning; isolated `PROFILE` measures executed work. Avoid speculative indexes and irreversible legacy-index replacement.

Use stable ordered pagination and test ties, deletions, filtered connections and mobile repeat loads. Connection syntax alone does not prove efficient keyset execution; inspect actual plans and offset behavior. Use a shared long-lived driver per process, close sessions, bound acquisition/retry/transaction time and total HTTP deadline. Cancellation at the client does not automatically prove cancellation of database work. Custom resolver batching is relevant only when custom resolvers exist; adding DataLoader to the generated path is not automatically an optimization. See [pagination behavior](https://neo4j.com/docs/graphql/current/queries-aggregations/pagination/) and [driver performance](https://neo4j.com/docs/javascript-manual/current/performance/).

G08 reports vector capability truth. Separate supplied-vector querying, provider-backed phrase embedding, physical index readiness and corpus coverage. Current code couples vector exposure to OpenAI phrase configuration; preserve compatibility while deciding whether to separate them. Phrase encoding does not populate stored vectors. The health flag is configuration only. v2 currently omits `@vector`; its native chunk/index design cannot be assumed to appear in GraphQL automatically.

Q03/Q04 decide whether product vector search ships at all and which accepted model/index it uses. If excluded, the endpoint/client reports unsupported and no provider call occurs. If included, require exact index label/property/name, dimensions/similarity, ONLINE state, model lineage, eligibility filters, coverage, provider budgets and measured behavior. A name collision with a legacy same-label/property index must be resolved by a reviewed migration, never by startup auto-drop. Keep DDL out of request/startup paths in the qualified release. See [Neo4j GraphQL index directives](https://neo4j.com/docs/graphql/current/directives/indexes-and-constraints/).

## Real client package

G04 delivers a domain-owned TypeScript package generated from the executable product schema and approved operation documents using GraphQL Code Generator's client preset. Export operation-specific `TypedDocumentNode` documents, variable/result types, exact scalar mappings, fragments and compatibility metadata. Enable strict scalar handling; DateTime remains its declared wire value until intentionally converted. This prevents inventing types from the authoring SDL. The [Codegen client preset](https://the-guild.dev/graphql/codegen/plugins/presets/preset-client) supports typed operations, fragment masking and optional persisted document manifests.

The runtime core accepts injected transport, endpoint, credential supplier, abort signal/deadline and request metadata. Return typed transport, authorization, validation, GraphQL partial-data and domain errors; do not turn partial GraphQL errors into a successful empty result. Retry only eligible idempotent reads with bounded policy. Keep schema exports/build tools separate from runtime exports. Ship ESM/type declarations and an explicit supported package contract, with no Neo4j driver, server library, filesystem, dotenv, Node-only crypto, private key or enormous schema snapshot in web/native bundles. Verify the packed artifact outside the monorepo.

G05 proves the same small operation set in one web and one Expo consumer. Use a thin optional Apollo/urql/fetch-query adapter chosen by Q04, rather than coupling the core package to a UI framework. For a normalized cache, define `__typename` plus the accepted entity UID field (currently `uid`, qualified by Q01/Q04) as identity, possible abstract types, argument-sensitive pagination merge, auth/logout cache clearing and schema-release compatibility. Mobile handles token refresh, foreground/reconnect, cancellation and explicit offline age. Offline data is not freshly verified evidence; canonical mutations are absent. Apollo documents [cache identity](https://www.apollographql.com/docs/react/caching/cache-configuration) and [React Native integration](https://www.apollographql.com/docs/react/integrations/react-native).

CI generates deterministic artifacts, validates operation documents, checks packed web/Expo consumption and compares executable schema changes. A schema diff catches structural breaking changes; behavioral/auth/index changes need their own conformance checks. Maintain supported older mobile operation manifests during staged server rollout. See [GraphQL Inspector diff](https://the-guild.dev/graphql/inspector/docs/commands/diff). This package is distinct from the existing Python executor client and from AI Engineer's custom API client.

## Fly measurement, capacity and rollout

Retain the configured 4 GB/3 GB heap starting point until measured evidence supports a change. G06 separates schema build, parse/validation, translation, pool wait, database execution, provider work, serialization, response size, event-loop delay, RSS/heap, CPU throttling and cold/warm latency. Freeze representative approved operations, dataset scale and expected concurrent demand before setting acceptance thresholds. Measure p50/p95/p99 plus timeout/error rate and total application/database/provider cost.

G07 compares memory sizes, shared versus performance CPU and replica counts under that workload. Shared CPU burst behavior can differ from sustained demand. More Machines multiply both executable-schema memory and connection pools; coordinate with Aura limits. Place compute with measured database locality. `min_machines_running=1` applies to the primary region and does not prove high availability. Separate process liveness, traffic readiness and expensive dependency checks; calibrate health grace and graceful termination against actual cold boot/in-flight requests. See [Fly CPU behavior](https://docs.fly.io/machines/cpu-performance) and [Fly configuration](https://docs.fly.io/reference/configuration).

Release separately pins container image, library versions, source/projection/executable schema, accepted native schema/index migration, auth policy, operation registry and SDK compatibility. Use staged readiness and bounded product smoke checks, then a canary and observed rollback/forward-repair plan. Rolling back an image does not undo graph migrations. Keep graph schema administration outside ordinary API startup. These targeted checks do not run the final two application workflows; F99 remains blocked until the entire program is ready.

## Delivery and evidence

G00 inventories current deployment; G01 exports the accepted read projection; G02 bounds admitted operations; G03 implements product authorization; G04 ships typed core; G05 proves web/Expo consumption; G06 measures selected queries and indexes; G07 qualifies Fly capacity and release; G08 qualifies vector capability or explicit exclusion. [Q01/Q03/Q04](CLARIFICATIONS.md) prevent premature schema, corpus or consumer decisions. Existing P02/D07/D10/F99 consume these results.

Source inspection: Biotech `apps/graphql-api/src/server.ts`, `limits.ts`, `print-schema.ts`, package/lock/Docker/Fly configuration; installed Neo4j GraphQL 7.6.3 generation/translation code; schema PIN; v2 summary/size/decision/migration reports. Official documentation was checked during this session; dependency capabilities must be revalidated against the exact release selected for implementation. Historical candidate measurements are not this session's performance results.

## Linked implementation issues

- [G00: Reconcile the deployed GraphQL service with schema and Fly configuration](issues/19-g00.md)
- [G01: Export a reviewed executable GraphQL read contract for one product slice](issues/24-g01.md)
- [G02: Bound the first product GraphQL operations using actual schema semantics](issues/25-g02.md)
- [G03: Serve an authorized product entity and evidence view through GraphQL](issues/42-g03.md)
- [G04: Ship a transport-neutral typed GraphQL client for the approved operations](issues/43-g04.md)
- [G05: Consume one entity and evidence page in web and Expo](issues/44-g05.md)
- [G06: Optimize selected GraphQL reads against measured plans and indexes](issues/45-g06.md)
- [G08: Report truthful GraphQL vector capability and qualified search availability](issues/54-g08.md)
- [G07: Qualify Fly capacity and compatible product API rollout](issues/55-g07.md)
