# Domain surfaces, agent guidance and product contracts

Status: implementation direction, amended 2026-10-10 with the explicit owner decision gates in CLARIFICATIONS.md. Source inspection is evidence of the current working tree, not deployment qualification. This annex defines the domain and client behavior required by the BellLabs Knowledge Platform specification. Names marked proposed identify unimplemented contracts. Consumer routing is settled, while schema adoption, native read representation, corpus/index design and first-client access remain explicitly gated decisions.

## 1. Product distinction and authority

AI Engineer teaches people to learn, build and operate real systems. Its agent-native content is courses, challenges and projects; notes, knowledge retrieval, real project testing and progress handshakes with external coding agents belong in the product contract. Biotech helps people inspect research, public protocols, reports, articles and timelines with source-bound applicability, context and uncertainty. Domain skills encode these judgments and procedures. They are product differentiation: a generic search endpoint plus cosmetic domain prompts does not meet this requirement.

Three authorities remain separate:

| Authority | AI Engineer | Biotech | Boundary |
| --- | --- | --- | --- |
| Knowledge | Existing PostgreSQL/Supabase contract owned by `aiengineer/ai-engineer-db-contract` | Biotech owns graph/schema authority; the deployed original-pin GraphQL service, current graph data and unaccepted v2 proposal are separate evidence states | Identity, assertions, time, provenance, admission and canonical effects belong to the domain backend. |
| Product and user | Application-owned learner profile, preferences, progress, notes, authored content and entitlements, extending the existing app contract | Application-owned profile, saved research, notes, authored reports/protocol views and entitlements in its app PostgreSQL contract; public graph remains separate | A bookmark, note, generated lesson or accepted user edit never becomes canonical knowledge implicitly. Private-personal data never enters the shared Biotech graph. |
| Execution and capability | AI Engineer's existing Mission Control catalog and mission records in its application PostgreSQL database | Biotech's existing Mission Control catalog and mission records in its separate application PostgreSQL database | The same common Mission Control schema/runtime is reused; neither catalog is hosted in Neo4j or a new shared third database. |

The User API owns actor state. The Product API owns content, interactions and user-visible task projections. Knowledge Services owns evidence and knowledge algorithms. Mission Control owns durable mission lifecycle and scheduling. The client-facing Deep Agent owns conversation, choosing domain procedures and bounded interaction with these APIs. Long-running research, ingestion, coding and verification hand off to Mission Control; the client agent does not become a second durable scheduler.

Evidence: AI Engineer [north-star path](../../../../../aiengineer/ai-engineer-meta/docs/product/11-north-star-path.md), [workspace ownership](../../../../../aiengineer/AGENTS.md); Mission Control [application binding ADR](../../../../mission-control/docs/adr/0002-one-service-two-applications-schema-per-app-database.md); Biotech [domain sidecars](../../../../../biotech/biotech-knowledge-services/schema/sidecars/domains.yaml).

## 2. Select modules and configure a domain explicitly

The shared foundation exposes use cases through published HTTP/client, MCP and CLI contracts. Cross-repository consumers must not import internal algorithm packages. In-process transports call the shared application layer. A domain installation selects modules through a versioned, validated manifest and composes only their declared ports. It does not copy the platform or rename all existing packages to imply neutrality.

Proposed `knowledge.domain-profile/v1` fields:

```yaml
schemaVersion: knowledge.domain-profile/v1
profileId: biotech-public-research
profileVersion: 1.0.0
applicationId: biotech
knowledgeAdapter:
  kind: neo4j
  contractRef: <published Biotech contract version and schema digest>
modules:
  schema: { adapter: biotech-schema-workspace, version: <pin> }
  read: { adapter: biotech-bounded-read, version: <pin> }
  ingest: { adapter: biotech-intent-executor, version: <pin> }
  retrieval: { adapter: biotech-evidence-retrieval, version: <pin> }
  acquisition: { service: <admitted service contract> }
  preparation: { service: <admitted service contract> }
  verification: { service: <admitted service contract> }
  evaluation: { service: <admitted service contract> }
  decision: { service: jev, version: <admitted contract> }
capabilityCatalogBinding: <operator-managed Mission Control application binding>
skillPins: [<exact domain skill pins>]
retrievalPolicyRef: <version and digest>
contentPolicyRef: <version and digest>
decisionRecipeRefs: [<version and digest>]
providerBindings: [<external provider capability pins>]
```

This example is illustrative desired composition; adapter names and exact bindings are not frozen before the Q01–Q03 decisions, and the Biotech evidence retrieval adapter does not ship today. It does not prescribe a query AST or GraphQL route for agents. AI Engineer selects its existing PostgreSQL schema/read/ingestion/retrieval adapters instead. Credentials and database endpoints are server-side binding references, never profile values sent to a client. Configuration validation requires:

1. Exact application binding, domain profile/version and schema contract digest; one request cannot select another application's credentials.
2. Module dependency closure and port compatibility. Retrieval requires scoped reads, support resolution and evidence access; activation requires evaluation and policy admission. No module becomes executable because a manifest lists it.
3. Required and optional capabilities, bounds and deployment availability. Required unsupported features fail before provider work; optional omissions appear in the result and route explanation.
4. Exact capability pins and host support for the selected execution lane. A skill that calls an unavailable MCP tool fails admission; prose cannot authorize a fallback shell command.
5. Immutable normalized manifest digest recorded on operations, evidence packets, content versions and evaluations. Changes produce a new profile version; old evidence remains interpretable under its original profile.
6. Domain identifiers remain typed: PostgreSQL UUID/record references and Biotech `hu:<token>:<opaque>` UIDs are opaque to the common facade. A new shared envelope must preserve backend kind, record kind, identifier and contract version; it must not coerce Biotech UIDs into the current UUID retrieval plan.

The Knowledge Services operation catalog is an executable surface/transport map. Mission Control's capability catalog is the app's admitted, versioned inventory for agent composition. Neither is a second authority for the other's definitions. Publish capability rows that reference service contracts and tested operations; do not make the Mission Control catalog store knowledge records.

## 3. User and Product APIs for web, mobile and agents

Common domain outcomes and authority serve web, mobile and agent consumers through distinct contracts. Biotech application entity clients use Neo4j GraphQL; AI Engineer entity clients use a custom PostgreSQL API. Existing Biotech agents and the planned client Deep Agent use native Neo4j skills or schema-workspace/read/ingest operations, never GraphQL in this release. Shared authorization does not require one query protocol or a new read DSL. These proposed logical operations need typed HTTP/client bindings before a web-only implementation:

| Surface | Proposed logical operations | Authority and required result |
| --- | --- | --- |
| User API | `user.profile.get/update`, `user.preferences.get/update`, `user.entitlements.get`, `user.saved-content.list/add/remove`, `user.notes.get/create/update` | Actor-scoped state, explicit revision, authorization and privacy class. A note links evidence IDs while retaining user authorship. |
| Product API | `product.content.list/get`, `product.content.create/fork/revise`, `product.content.submit-review`, `product.content.publish`, `product.content.withdraw` | Domain kind, immutable version and dependency pins; publish requires the product's existing reviewer/operator authority. |
| Learning API within Product | `product.learning.enroll`, `product.progress.read/record`, `product.challenge.attempt/submit`, `product.project.test.request/status` | Versioned lesson/rubric/test definition, attempt identity, external evidence/artifact references and idempotent progress receipt. A model's positive assessment alone cannot pass a deterministic project test. |
| Research API within Product | `product.research.question`, `product.protocol.edition.get/compare`, `product.timeline.get`, `product.report.draft/revise`, `product.article.draft/revise` | Declared context and clocks, evidence packet or scoped snapshot, unsupported claims, source fidelity and approval state. Protocol retrieval does not assert personal suitability. |
| Conversation API | `product.conversation.create/turn/read`, `product.agent.action.preview/submit`, `product.task.get/cancel` | Conversation and task identity, typed tool results, route explanation, capability pins, budget and cancellation state; server projects long-running Mission Control state. |
| External-agent handshake | `product.handshake.issue/consume`, `product.progress.receipt.submit/get` | Short-lived actor/content/attempt scope, audience and one-use or idempotency policy; bound submitted artifact/test evidence and review state. No bearer credential inside lesson or prompt text. |
| Knowledge facade | `knowledge.question.plan/execute/get`, `knowledge.evidence.get/replay` | Authenticated scope, domain contract, selected route and immutable evidence. These proposed names adapt existing retrieval and bounded-read services; they do not pretend they exist today. |

The table names logical operations, not identical grants on every transport. In this release, ordinary agent MCP surfaces support drafts and submit-review; official publish/withdraw require reviewer-authorized HTTP/CLI and return an explicit exclusion on ordinary MCP. Existing vector-store publication exclusions remain. Any later reviewer-bound product MCP publication capability requires its own versioned admission contract.

The initial project-testing path includes real `product.project.test.request/status` execution through an admitted workspace capability and a supported external editor/workspace handoff. It binds exact content, test/rubric and result artifacts. A full embedded IDE is deferred; a simulated editor or untrusted agent assertion cannot replace the runnable workspace path.

For mutable product/user operations, require expected revision and idempotency key; distinguish accepted, running, succeeded, failed and cancelled task states. A retry after a lost response reads the same receipt/task rather than creating another attempt or mission. Web/mobile reconnect uses a cursor to fetch missed events and the authoritative task snapshot. Mobile reconnect does not replay side-effecting tool calls from conversation text. Synchronize offline notes by revisions with an explicit conflict result; offline cached evidence must retain its age and cannot be presented as newly checked.

Authentication resolves installation/application/tenant/actor on the server. Entitlements govern product actions and views; knowledge authorization governs evidence access independently. Ownership of a course containing an evidence link does not grant access to its source. Hosted/product agents receive scoped tool permissions and sanitized results. Directly configured Neo4j skills can use separately provisioned trusted principals under Q02; credentials never enter skill bundles, client packages or artifacts. No agent route uses generated GraphQL mutations.

Existing API gap: the AI Engineer learner app is absent in this checkout. Biotech's Fly health endpoint reports the original pinned SDL, vector enabled and mutations off; its native executor separately exposes graph operations. The proposed database schema has not been implemented, and the newer v2 is only the selected review candidate. Health is not schema migration or index-coverage evidence. Neither is evidence that a User API, Product API, conversation runtime, progress service or mobile sync contract is implemented.

## 4. Question routing: direct, Fast, Explore and Research

Routes are behavior and budget contracts, not alternate admission levels. Every route preserves scope, source trace, explicit uncertainty and domain interpretation. The client may request a route or `auto`; the planner selects within the caller's ceiling and returns a route receipt before expensive work. A required missing feature returns a typed unsupported result. A route change that exceeds the admitted budget returns `needs_budget` rather than silently starting research.

Proposed `knowledge.question/v1` contains: application-resolved domain profile; question; `route: auto|direct|fast|explore|research`; optional typed entity anchors; purpose; required answer facets; domain context; world/recorded/knowledge/observed viewpoints supported by that adapter; allowed corpus/external-source classes; required/optional capabilities; latency/tool/token/spend bounds; freshness policy; idempotency key. The server derives tenant, visibility and entitlement filters. A client cannot lower the policy floor.

| Route | Selection and work | AI Engineer example | Biotech example | Result and escalation |
| --- | --- | --- | --- | --- |
| Direct | Exact ID/catalog query or bounded entity/state/trace lookup; no generative decomposition and no external acquisition | Read a pinned course/project, known implementation record or cataloged configuration | Resolve an NCT/DOI/UNII/product UID; read a protocol edition and its assertions | Typed records plus scope/snapshot/source trace. Ambiguous identity returns candidates; code may propose Fast/Explore within budget. |
| Fast | One bounded corpus retrieval with admitted lexical/semantic channels; optional rerank, then evidence-bound answer | Locate a documented SDK capability or explanation needed for a challenge | Find an admitted study, label section or source excerpt for a narrow fact | Packet, coverage, citation replay and unsupported facets. Missing support gives an explicit gap; Fast does not secretly fetch the web. |
| Explore | Bounded multi-step corpus investigation: decomposition, named reads, approved graph hops, comparisons and gap map | Compare architectures, tools or prerequisite concepts for a project | Compare study material with product formulation; inspect population/dose/duration, assay comparability or a bitemporal timeline | Ordered steps/snapshots, evidence packets and explicit truncation. Required unsupported graph behavior fails; an optional graph omission is visible. |
| Research | Durable Mission Control mission: first inspect known evidence/gaps, then permitted external acquisition, preparation, verification, proposed ingestion and synthesis | Investigate a changing framework release, implementation evidence or source-backed course refresh | Literature/registry investigation, protocol source update, regulatory-status comparison or contradiction review | Accepted task/mission reference, progress and cancellation, terminal evidence/artifacts; canonical changes and content publication retain their separate gates. |

Route selection is deterministic where possible: exact resource identifiers prefer Direct; explicit external freshness/missing evidence triggers a Research proposal; approved local comparisons fit Explore; a single supported corpus question fits Fast. Domain Jev may recommend a closed route label with `insufficient_context`; code validates the recommendation against capabilities and budgets. The user can request Research explicitly within authorization without another interview.

Explore needs a declared step, hop, node/row, source-family and time ceiling. Each hop preserves the predicate, assertion identity and source locators. Graph adjacency is discovery context until support is resolved. A generated summary cannot manufacture a path, bridge two similar entities or claim complete coverage after a cap. Research must begin with a corpus/gap read to avoid re-discovering stored facts; external data is captured and labeled before it can contribute to canonical support.

### Cache and replay semantics

Treat operation replay, result caching and citation replay as different mechanisms. Existing canonical retrieval can replay an already persisted run by operation ID; that does not establish a cross-query cache or fresh authorization. New caching needs a separate tested contract.

The proposed cache key includes application/tenant, actor authorization scope or equivalent ACL digest, entitlement-dependent view, domain/profile digest, normalized question/anchors/context, requested route and required facets, plan/policy versions, schema digest, backend-native corpus eligibility/publication/index/embedding-generation versions (vector-space versions only where that backend actually has them), knowledge/recorded/world/observed viewpoint, retrieval/reranker/embedding versions, recipe/model versions where used, and safety/privacy class. A current-head question resolves its current corpus/head before cache lookup; historical questions pin their declared viewpoint. Do not share answer text across apps, tenants or unauthorized users.

Cache deterministic reads and evidence references when policy permits. Cache generated answers only with their exact dependencies, generation version, supported claim links and expiration. Resolve mutable authorization, revocations/retractions, source availability and content withdrawal again before serving. On drift, evict/recompute or return a labeled stale historical view if the caller explicitly requested one and still has access. Immutable packet bytes remain historical evidence; current use may be blocked without rewriting the packet.

TTL is a domain-policy ceiling per question class, not a universal constant. Observed price, changing SDK release and regulatory status differ from a pinned historical protocol edition. Short TTL cannot substitute for revocation checks. No indefinite negative-result cache: an empty result is scope/head-bound and distinguishes unavailable, unsupported, truncated and truly empty outcomes. Private notes stay in an actor-scoped cache. Source-byte replay verifies capture/representation/selector/content digests; cached prose never replaces unavailable evidence bytes.

## 5. Skills, MCP and CLI are one domain procedure

Each domain skill defines when to use an operation, what evidence and context are required, how to interpret the result and uncertainty, and what constitutes completion. MCP and CLI provide typed execution of that procedure. A skill must name actual available operations and exact service contracts; unsupported transport cells are explicit. Internal service composition may reuse algorithms, but the domain procedures and interpretation rules remain owned by their domain.

| Procedure / domain skill | Current executable surface | Contract and required domain guidance | Proposed completion work |
| --- | --- | --- | --- |
| AI Engineer schema exploration | `schema-explore`; executor `schema_search`, `schema_get`, `schema_manifest`, `schema_materialize`; CLI through executor operation registry | Pinned PostgreSQL contract workspace is meaning, not tenant data; progressive disclosure and named query selection | Register/pin domain skill bundle and MCP server/tool capabilities; preserve executor distinction until an actual platform fold. |
| AI Engineer bounded read / ingest | `knowledge-db`, `knowledge-ingest`; executor `db_read_intent`, `ingest_plan`, `ingest_apply`, `ingest_receipt`; bounded SQL operator surface remains distinct | Repeatable-read snapshot, schema-head agreement, evidence-backed plan, temporal helpers, idempotent receipt; read-intent retrieval is deliberately skipped today | Expose common facade through adapter; retain canonical schema authority and lost-response receipt semantics. |
| AI Engineer acquisition / preparation / verification | `knowledge-acquisition-and-vetting`, `knowledge-preparation-and-promotion`, `knowledge-verification`, `knowledge-verification-recovery`; platform and executor operations as cataloged | Capture first, custody and selectors, faithful conversion, deterministic verification before semantic assessment; a routing receipt is not admission | Version domain guidance and inventory all called tools against deployment availability. |
| AI Engineer retrieval | `knowledge-retrieval-and-evidence` (version from the released skill manifest); `ks knowledge retrieve plan/search/explain/run/packet/citations`; MCP `knowledge_retrieve_*` counterparts | Evidence packets, stage explanation, source diversity, abstention and citation replay; context-only neighbors are never proof | Implement question routing and cache facade; do not claim current canonical executor graph support. |
| AI Engineer evaluation / activation | `knowledge-evaluation`, `vector-store-management`; operation catalog records exact transport exclusions | Frozen-version evaluation recommends a release; authorized publication alone moves official pointers | Preserve reviewer/operator publication authority; MCP publication exclusions are not removed by product parity. |
| Biotech schema exploration | `biotech-schema-explore`; `bks-schema search/get/slice`; MCP `schema_manifest/search/get/slice` | Domain/task/card slice, schema digest and forbidden implications; generated workspace never edited directly | Register own versioned skill/MCP capabilities, preserving Biotech schema owner. |
| Biotech bounded query | `biotech-kg-query`; `bks kg read/resolve`; MCP `kg_read`, `kg_resolve` | UID/identifier/exact-name before weak candidates; card/neighbors, `assertion.trace`, `state.asOf`, gaps and touched-set snapshot | Add scoped facade and evidence support adapter; current `ReadIntent` has no tenant/entitlement envelope and does not prove byte-level citation replay. |
| Biotech deterministic ingestion | `biotech-kg-ingest`; `bks kg plan/apply/verify`; MCP `kg_plan`, `kg_apply`, `kg_receipt` | Assertion + SourceLocator for source-derived edges; one transaction under intent marker; never delete, never write derived projections | Publish real `kg_apply` tool capability; do not equate an imagined `kg_ingest` fixture row with the implemented tool. |
| Biotech ad hoc baseline | `biotech-cypher-baseline`; MCP `cypher_run`, `cypher_introspect` | Evaluation/operator baseline, not evidence/admission; guard can permit bounded writes/deletes under configuration | Exclude from client Deep Agent default and ordinary research capability sets; no fallback around deterministic executor. |
| Both domains: closed decisions | `jev-system-one` 0.2.0; dedicated `jev` CLI; MCP `jev_submit/batch/get/list/cancel/workers` | Captured text/JSON, narrow closed choices, versioned criteria, uncertainty/fallback; confidence is not permission | Add per-domain recipes/skill bundles and isolated service bindings; ordinary host does not start Jev and `ks jev` is reserved today. |
| Both domains: external tools | External Firecrawl/Tavily/PubMed/clinical-registry/browser/etc. skill/provider pins where admitted | Provider results remain external/self-reported until captured, verified and admitted; preserve origin/license/access constraints | Discover and register external capabilities with actual host support, credentials references and versions; never wrap them into new Knowledge Services-owned provider authorities. |
| Both domains: product authoring | Proposed domain content skills over Product API/MCP/CLI | Same revision, permissions, content lifecycle and evidence rules as web/mobile | Implement contracts and transports before claiming parity or product readiness. |

### Version and register every domain capability

For each app, publish a complete inventory of domain skill bundles, MCP servers and child MCP tools into that app's existing Mission Control capability catalog. A deployment profile must not ship an unregistered domain tool or load a skill solely from a mutable local path. Register CLI binaries and every public subcommand through the existing `operation_binding` capability semantics; if the admitted definition cannot express the required command contract, extend it through a versioned Mission Control-owned contract change. Do not invent an unrecognized `cli` capability kind or count a skill's prose mention as registration.

Use existing catalog kind definitions and exact pins. Each record carries identity/version/digest, domain/application scope, service contract compatibility, input/output schema references, side-effect class, secret references, host-support matrix, required capability dependencies and provenance. Skill bundle custody includes full file manifest and digests; changes bump the version. MCP definitions declare the actual server and tool names/schema digests. Proposed, published/admitted and deployment-composed are distinct states. Resolve exact pins and fail on missing dependencies, incompatible lane or drift before execution. Retain resolved pins in the mission, operation and content/evidence lineage.

Common source bytes may be reused, but each app has its own skill seed bundle, application-specific custody manifest/prefix, catalog entry and binding. Do not substitute common seed scope for the required application skill manifest. Domain skills and policies remain separate entries/bindings, and neither installation confers authority in the other app. External tools remain external catalog/provider entries, with owner and origin; the catalog registers use rather than claiming implementation ownership.

Current limitation: Mission Control's capability-seed guide explicitly identifies missing production Biotech ingestion/literature-review rows and worker pin/materialization gaps. Fixture stand-ins and transcribed external tool lists are not deployable qualification. Before a domain vertical slice passes, replace stand-ins with verified real definitions and tool-schema evidence in the correct app catalog.

## 6. Explicit Jev recipes by domain

Jev supports Choice (1–255 labels), Score (2–10 rubric levels) and Noul judgments. It consumes captured text/JSON, not raw PDF/image binaries. It uses a dedicated persistent single-host SQLite queue and process workers; its current service is not a distributed multi-tenant admission service. Bind it separately per application's trust domain, or implement and qualify a new scoped facade before pooled use. Never forward user file paths or arbitrary remote URLs as implicit read authority.

Every proposed `knowledge.decision-recipe/v1` pins domain, recipe/question version and digest, input fields and truncation policy, fixed labels/levels, instructions, model/provider version, held-out evaluation reference, uncertainty policy, fallback and permitted downstream action. Include `other`, `not_applicable` or `insufficient_evidence` as relevant; do not force an answer. Questions within one provider request do not see one another's answers; a dependency requires a second request with explicit new state.

| Domain / proposed recipe | Closed output and source-bound input | Interpretation and fallback |
| --- | --- | --- |
| AI Engineer `aiengineer.question-route` | Choice `direct|fast|explore|research|insufficient_context`; question, known anchors, required facets, available routes | Recommendation only; code enforces route/budget. Uncertainty prefers a bounded exploratory plan or records missing context, never escalates spend silently. |
| AI Engineer `aiengineer.content-kind` | Choice `course|challenge|project|reference|other|insufficient_evidence`; objective, learner context, artifact requirements | Suggest structure: course sequence, challenge rubric, project deliverable/test evidence. LLM drafts open prose; Product API validates kind/lifecycle. |
| AI Engineer `aiengineer.learning-fit` | Separate Score levels for prerequisite coverage and difficulty, plus independent Noul checks for criterion coverage; pinned rubric/content and learner-approved context | Recommend explanation/next activity. Deterministic test failures remain failures. Missing evidence goes to agent reasoning with the actual rubric and artifacts. |
| AI Engineer `aiengineer.source-change-triage` | Choice `no_material_change|review_required|unsupported|insufficient_evidence`; old/new captured excerpts and affected content pins | Queue affected lessons/project references for review; never mutate canonical facts or published courses from a choice alone. |
| AI Engineer `aiengineer.tool-fit` | Choice over a retrieved, bounded list of exact capability pins plus `none`; task constraints and capability definitions; independent absolute-fit check | Recommend a real tool. Missing/ambiguous pin fails catalog validation. More than 255 candidates needs a versioned shortlist/hierarchy; no invented capability. |
| Biotech `biotech.claim-context` | Choice `study_result|mechanistic_observation|label_declaration|speaker_claim|regulatory_record|other|insufficient_evidence`; exact captured span and source type | Route extraction/read templates; keep study vs product, species, measured vs inferred and public vs private scope. Unclear context remains a staged mention/review case. |
| Biotech `biotech.study-applicability` | Independent rubric scores for material, population, dose, duration and outcome match; pinned study assertions and explicit use context; `unknown` via companion Choice | Preserve all dimensions and unknowns; no averaged score becomes clinical truth or personal suitability. Domain agent explains limitations and seeks missing evidence. |
| Biotech `biotech.protocol-completeness` | Independent Noul checks for identified edition, ordering, dose/unit, cadence, constraints, measurement/adjustment rules and source support; companion Choice `complete|partial|insufficient_evidence` | Recommend missing sections for a draft public protocol view. Arithmetic/unit validation and content review are deterministic gates. Never fill a missing dose from a similar protocol. |
| Biotech `biotech.evidence-relation` | Choice `supports|qualifies|contradicts|different_context|insufficient_evidence`; proposition, two exact source spans and domain context | Triage a contradiction/review record; source capture fidelity and assertion admission remain separate. LLM may explain candidate relation without overwriting old evidence. |
| Biotech `biotech.timeline-event` | Choice `study_registration|publication|formulation_observation|protocol_edition|regulatory_event|correction|other|insufficient_evidence`; cited event span and temporal metadata | Suggest timeline grouping. Code validates timestamps, identity and validity; observed/capture dates never become event dates automatically. |
| Biotech `biotech.evidence-gap-priority` | Score using fixed levels `no_gap|minor_gap|material_gap|blocking_gap`; question facets, source traces, capture completeness, unknowns | Prioritize Research work under budgets. Missing locator, unsupported context or identity ambiguity stays visible and cannot be repaired by high confidence. |

Calibrate thresholds per question/model/domain on independently labeled held-out sets, including ambiguous and adversarial evidence. Until calibrated, use decisions as advisory triage and expose uncertainty; do not invent universal 0.8/0.9 thresholds. Retain job ID, captured-input digest, recipe/version, model returned/requested, answer/probabilities, attempts, usage and fallback reason. Provider crash/timeout may repeat a paid request; local job idempotency does not prove exactly-once billing. On unavailable Jev, fail a required decision step explicitly; optional advisory steps may use a recorded LLM/manual/domain-rule fallback without claiming an equivalent calibrated decision.

## 7. Content lifecycle and domain evidence

Content has independent authorship and release state. Proposed lifecycle: `draft -> evidence_bound -> review_requested -> published -> superseded|withdrawn`. A review can return to draft with reasons; a revision creates a new immutable version. These are Product API states, not aliases of knowledge assertion/admission states. User-authored/private content can be useful while unverified and must carry its authority label. Official publication requires the product policy, supporting evidence version and review receipt. No generated artifact automatically becomes an official lesson, protocol or knowledge assertion.

Every content version stores domain/kind, author/origin, visibility, dependency versions, profile and recipe pins, evidence packet/snapshot IDs, claim-to-locator links, uncovered claims, generated-asset provenance, review/test receipts and supersession links. Knowledge corrections, retractions, withdrawn sources or capability changes mark dependent content for revalidation. Keep prior versions and evidence interpretable; block current promotion/use when policy requires it. Retrieval of a historical version must not imply it is current.

| Domain content | Required structure and completion evidence |
| --- | --- |
| AI Engineer course | Objectives, prerequisites, ordered modules, evidence links, exercises and versioned progression rules. Notes/retrieval work from the course context. |
| AI Engineer challenge | Task and constraints, artifact/submission contract, rubric and deterministic checks where applicable, attempt lineage and evidence-backed feedback. |
| AI Engineer project | Deliverables, real editor/workspace integration, setup/tool/harness guidance, runnable tests, external-agent progress handshake and artifact/test receipts. A prose claim that the project works is incomplete. |
| Biotech protocol | Named public protocol and immutable edition, source-derived steps/order, dose/unit/cadence only where sourced, constraints, measurements/adjustments, applicability and missing information. Public protocol content is separate from private user execution/personal records. |
| Biotech report | Research question/scope, method and corpus/source bounds, evidence synthesis, applicability dimensions, contradictions/gaps and claim-level trace. |
| Biotech article | Editorial structure, claim-level citations, source/author distinction, licensed assets, evidence/context labels and review. A source speaker's recommendation is not a BellLabs recommendation. |
| Biotech timeline | Explicit event type, entity and event/world time, recorded viewpoint and capture time, source locator and uncertainty; corrections/supersession preserved. Unknown time remains unknown. |

Concrete initial Biotech question classes come from existing validated sidecars, not a new universal taxonomy: what edition N of a protocol prescribes; whether study material matches a sold product; whether population/dose/duration apply; whether assay versions/specimens/reference intervals are comparable; what a label declared per serving at observation time; what regulatory status a jurisdiction's record actually reports; who said a claim and where; what changed between recorded viewpoints. Each selects schema/task cards before queries and carries the relevant forbidden implications into the domain skill.

## 8. Acceptance tests and release gates

These are implementation acceptance criteria. This documentation change does not execute app fixtures or claim runtime readiness.

| Test | Required observable result | Existing source/test seam |
| --- | --- | --- |
| Domain composition | Same neutral use case selects PostgreSQL or Neo4j adapter; incompatible profile/schema fails before data/provider calls; no internal cross-repo imports | KS `packages/host/src/create-host.ts`, `packages/application/src/operations/catalog.ts`; Biotech `packages/contracts/src/index.ts` |
| Identifier isolation | UUID and `hu:` references round-trip with backend/contract; cross-app resource substitution is rejected | KS retrieval contracts; Biotech contracts `common.ts`, `read.ts` |
| App/user authorization | Token for AI Engineer cannot retrieve Biotech catalog/content/evidence; private notes/entitlements filter both fresh and cached paths | Mission Control catalog HTTP principal binding; new User/Product facade tests |
| Route ceilings | Exact-ID Direct makes no embedding/provider call; Fast makes no acquisition; Explore respects step/hop/row caps; Research returns durable mission identity and cancellation | KS canonical retrieval executor tests; Biotech read/operations seam; Mission Control mission API |
| Capability truth | Required unsupported graph fails before embedding; optional graph is recorded as omitted; Biotech generated GraphQL vector option is not treated as evidence support parity | KS `canonical-retrieval-executor.test.ts`; Biotech `apps/graphql-api/src/graphql-api.test.ts` |
| Evidence discipline | Missing/revoked support, ambiguous entity, incompatible context and truncated coverage never produce an unqualified supported answer | KS `packages/persistence/src/retrieval-evidence.test.ts`, `packages/retrieval/src/search/retrieve.test.ts`; Biotech trace/read adapter tests to add |
| Clock fidelity | World time, knowledge sequence, recorded viewpoint and capture date stay distinct; no PostgreSQL K mapping invented for Neo4j | KS `packages/contracts/src/retrieval.test.ts`; Biotech `state.asOf`/trace query tests |
| Cache isolation/invalidation | Same question in different app/tenant/ACL/profile has no shared answer hit; head/policy/retraction/content change invalidates; current auth checked on historical packet fetch | New question cache facade tests; KS citation replay/cache tests cover bytes, not this new answer cache |
| Catalog completeness | Every domain skill/server/tool dependency resolves to an exact compatible admitted pin in its own app DB; drift and fixture-only definitions fail | Mission Control `tests/unit/capability/test_agent_capability_seeds.py`, `test_agent_skill_seeds.py`; deployment inventory test to add |
| Jev determinism boundary | Versioned recipe records input digest/job/model; low/unknown/timeout follows configured fallback; high confidence cannot pass failed deterministic test or admit an assertion | KS `packages/jev/src/service.test.ts`, `apps/jev/src/http.test.ts`; domain recipe evals to add |
| Ingestion parity of guarantees | Identical intent replay returns authoritative receipt; changed bytes conflict; stale precondition prevents apply; temporal correction retains old evidence | KS `packages/knowledge-db/src/ingestion/tests/executor.integration.test.ts`; Biotech `packages/kg-ops/src/kg-ops.integration.test.ts` |
| Product content lifecycle | Forked/draft content remains user-managed; publishing requires correct authority/evidence; superseded evidence flags dependents | New Product API tests in each app's owning repository |
| Agent/client parity | Same request through HTTP/MCP/CLI yields same permission outcome, state transition and evidence identity, or explicit transport exclusion; mobile reconnect creates no duplicate side effect | KS `apps/mcp/src/tests/api-mcp-parity.test.ts`, `no-http-shims.test.ts`; new Product API/handshake tests |
| External provider custody | External tool receipt retains provider origin; failed capture/verification cannot be relabeled canonical evidence | KS acquisition/verification operation seams; real catalog/provider qualification outside documentation scope |

Do not run broad final app fixtures to validate a planning artifact. Implementation proof must use isolated app databases/test graphs and the domain owners' commands. Unit tests establish local behavior; integration tests establish adapter effects; real provider and deployed composition evidence separately establish operational availability. Preserve current dirty work and never reset populated databases to create these proofs.

## 9. Vertical issue suggestions

Use these as implementation-sized stories and merge them into the parent delivery plan rather than creating a duplicate backlog. Each story must update its domain skill, transport contract and exact capability registration alongside runtime behavior.

| Suggested issue | Scope and dependencies | Reviewable acceptance |
| --- | --- | --- |
| Domain profiles and typed record envelope | Shared contract validation, adapter capability manifest and profile digest; precedes route facade | Two adapter contract fixtures, UUID/UID round-trip, missing module/contract/required feature failures. |
| AI Engineer Direct/Fast evidence question | Existing PostgreSQL reads/retrieval through proposed scoped question facade and client skill; depends on profile/envelope | Identifier lookup, narrow supported answer, replayable citation and absent-support abstention across HTTP/MCP/CLI. |
| Biotech Direct protocol/study trace | Scoped read adapter over real `node.resolve`, `state.asOf`, `assertion.trace`, schema/task skill; depends on profile/envelope | Protocol edition lookup and study-material trace with source gaps, ambiguous identity and unknown-validity tests. |
| Domain Explore comparisons | Bounded comparison planner and typed graph support resolution; depends on both read verticals and support facade | AI implementation comparison and Biotech study-vs-product example; truncation/unsupported hops explicit. |
| Research handoff and retrieval gap loop | Question facade to Mission Control existing mission API and external provider pins; depends on Direct/Fast and catalog registration | Durable mission/task identity, initial gap read, cancellation, receipt replay and verified evidence return. |
| Per-app capability inventory and publication | Versioned domain skills, actual MCP server/tools, CLI procedure dependencies in existing app catalogs | No fixture-only rows; inspect/render/pin and incompatible-lane/drift tests pass independently for each app DB. |
| Domain Jev recipe packs | AI learning/tool/route and Biotech applicability/protocol/evidence recipes plus held-out eval manifests; depends on catalog inventory | Advisory behavior before calibration, unknown/timeout fallbacks, persisted decision provenance and deterministic-gate protection. |
| User/Product contract and client Deep Agent | Reuse each app's existing data authority; versioned user state/content/conversation APIs and bounded agent tool surface | Same authorization/lifecycle for web/mobile/MCP/CLI; mobile reconnect/offline-note conflict and cross-app denial. |
| AI Engineer course/challenge/project loop | Product operations, notes/retrieval, editor/test receipts and external-agent handshake; depends on Product API and AI question vertical | User creates/forks content, submits an attempt, agent tests a project and records idempotent progress against a pinned rubric. |
| Biotech protocol/report/article/timeline loop | Product operations and evidence-bound domain templates; depends on Product API and Biotech trace/Explore | Public protocol edition and traceable report/article/timeline draft; review required, unknown dose/time preserved, no private graph write. |
| Scoped query/answer cache | Key/version/ACL/head dependency tracking, invalidation, historical use and citation recheck; depends on question facade | Cross-app/tenant misses, revocation/head invalidation, no stale prose substitution, bounded negative cache. |

## 10. Observed contradictions and limits

- The shared repository name does not make existing `@aiengineer/*` packages or database bindings neutral. Generalization needs ports and contracts; package renaming or schema relocation is not an acceptance criterion.
- Current KS retrieval contracts accept UUID anchors, PostgreSQL-specific instant precision and knowledge sequences. Biotech uses UIDs, valid/recorded time and snapshot/touched-set digests. Preserve different semantics instead of falsely promising identical native snapshots or mapping a graph timestamp to K.
- The canonical platform executor explicitly rejects required graph, concept/use-case anchors, soft boosts, context and upper freshness/observed bounds before providers. A more capable package or declared plan field does not establish platform support.
- Biotech's executor is read/resolve/plan/apply/receipt plus baseline Cypher; GraphQL vector enablement is optional and does not establish evidence packets, citation-byte replay, tenant admission, answer caching or route orchestration. These are new integration obligations.
- Biotech `ReadIntent` captures operations, actor/run context and limits; a client-facing app/tenant/entitlement boundary is absent from that native contract. Add an authenticated facade; do not pass an invented tenant parameter and claim isolation.
- A Biotech accepted assertion/capture is not scientific truth; a derived mechanism relationship is not evidence; a study intervention is not automatically a commercial product; a filing is not approval; observed label quantity is not active-moiety quantity. Domain skills and tests must retain these distinctions.
- The AI Engineer learner app is absent; User/Product APIs, client Deep Agent and web/mobile journeys require implementation ownership and do not already exist because the architecture names them.
- Jev is a working dedicated host, not automatically loaded by the ordinary KS host, and `ks jev` is reserved. Current single-host operator trust cannot be advertised as a pooled multi-tenant decision service.
- Capability-seed docs identify missing live domain capabilities and materialization gaps. Test fixtures cannot satisfy the owner's requirement to version/register every domain skill and MCP capability in its respective app catalog.
- Existing transport parity includes intentional exclusions, notably publication authority and executor-only surfaces. Product interface parity must preserve explicit authority boundaries rather than exposing every operator action as an agent tool.

Source anchors inspected: KS `packages/contracts/src/retrieval.ts`, `packages/application/src/knowledge/retrieval/canonical-retrieval-executor.ts`, `packages/application/src/operations/catalog.ts`, `apps/verification-executor/src/knowledge/operations.ts`, `packages/contracts/src/jev.ts`, `knowledge/retrieval-and-evidence.md`, `knowledge/jev-decisions-and-workers.md`; Biotech `packages/contracts/src/read.ts`, `packages/kg-ops/src/read.ts`, `apps/executor/src/mcp.ts`, `apps/graphql-api/src/server.ts`, `.agents/skills/biotech-kg-query/SKILL.md`, `schema/sidecars/domains.yaml` and `task-routes.yaml`; Mission Control `src/mission_control/application/capabilities/catalog.py`, `src/mission_control/interfaces/http/catalog.py`, `docs/adr/0023-capability-kinds-provider-neutral-core-host-projection.md` and `docs/knowledge/capability-seeds.md`. No runtime file, deployment or app fixture was changed or executed for this annex.

## Consumer and schema amendment

[GraphQL/client delivery](GRAPHQL-CLIENT.md) governs Biotech application entity reads; [native retrieval and ingestion](NATIVE-RETRIEVAL-INGESTION.md) governs agent artifacts and backend-specific GraphRAG. [Q01–Q04](CLARIFICATIONS.md) capture unresolved owner choices. v2 selection does not re-pin or migrate anything; 1536 embedding dimensions are not adopted by this program. Existing typed reads remain available under their supported pin while new corpus/vector behavior is unqualified. No complete fixture is run before F99.
