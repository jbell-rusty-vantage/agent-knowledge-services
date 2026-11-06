# BellLabs Knowledge Platform specification

Status: owner-authorized implementation direction, amended 2026-10-10. Consumer boundaries are settled; schema adoption, native artifact details, corpus/index design and first-client access have explicit owner decision gates. This is a target contract, not a claim that implementation, database installation, or production qualification is complete.

Tracker: see [Linear publication](LINEAR.md). Linear is the delivery-status authority after promotion; this versioned specification and its ADRs are the architecture authority. A tracker change that changes architecture must amend this packet in the same delivery.

## Problem Statement

BellLabs operates AI Engineer and Biotech with common agentic execution but different knowledge stores and domain semantics. Existing knowledge tooling is strongest around research and ingestion; product retrieval, user APIs, authored content and external-agent consumption need one deliberate organization. AI Engineer uses PostgreSQL broadly. Biotech uses Neo4j for domain knowledge and PostgreSQL for Mission Control and operational records. Renaming the shared repository has not made its PostgreSQL bindings backend-neutral.

The differentiating products are the application-specific skills, MCP servers and CLI workflows that teach agents exactly how to achieve useful outcomes with BellLabs knowledge. They must be designed, versioned, installed, evaluated and released with the services, rather than appended as generic transport documentation. Users receive consistent domain outcomes and permissions across web/mobile, the product agent and their own agent environment; these consumers use different native query contracts.

Repeated sandbox exploration of a large ontology is too costly for everyday questions. Verification needs both stronger implementation of prior evidence/assertion research and efficient reuse of trustworthy work without confusing source fidelity with scientific truth or lowering publication standards.

## Solution

Establish four owners: product applications, domain knowledge services, the reusable Knowledge Services foundation, and Mission Control. Compose a reviewed application binding rather than infer application identity or branch shared algorithms on product names. Publish domain operations through HTTP/SDK, MCP and CLI, with application-specific skills that own the procedure, Jev recipes, evidence requirements and escalation guidance.

Keep existing repositories and working behavior while extracting tested seams. The shared TypeScript monorepo remains the algorithm/contract owner; the existing Biotech service remains the Neo4j domain owner. Isolate AI Engineer's domain binding in the current monorepo first, then move its service to its domain repository when independent release and contract tests work. No Python rewrite or all-repository monorepo is required.

## User Stories

1. As a learner, I want entity and course pages to load without starting a research mission, so navigation stays responsive.
2. As a researcher, I want direct access to graph entities and their evidence, so I can inspect the basis of a statement.
3. As a user, I want Fast, Explore and Research modes, so I can choose scope and effort.
4. As a user, I want missing or contradictory evidence made explicit, so concise answers do not imply unsupported certainty.
5. As a mobile user, I want the same authorized knowledge operations as the web app, so capabilities travel across clients.
6. As an external-agent user, I want an application-specific MCP server, CLI and skill bundle, so my agent knows both what to call and how to work.
7. As an AI Engineer agent, I want course, challenge and project procedures tied to learning objectives and runnable validation, so authored material is useful.
8. As a Biotech agent, I want protocol, report, article and timeline procedures that preserve scientific qualifiers and provenance, so synthesis does not overstate evidence.
9. As a content author, I want private drafts separated from reviewed and published versions, so experimentation does not mutate official knowledge.
10. As a user, I want my saved work, progress and entitlements handled consistently, so knowledge storage does not become the account system.
11. As a product agent, I want small relevant tool/skill sets and schema slices, so routine questions avoid full-workspace setup.
12. As a product agent, I want durable research delegated to Mission Control, so a disconnected chat does not lose the job.
13. As a domain agent, I want Jev recipes with explicit choices and insufficient-evidence outcomes, so classification is bounded and reviewable.
14. As an operator, I want domain skills, MCP servers and tools registered in each application's capability catalog, so installations and grants are inspectable.
15. As an operator, I want external provider dependencies pinned and declared, so installed guidance does not assume unavailable tools.
16. As a verifier, I want immutable source bytes and resolvable locators, so a citation can be replayed.
17. As a verifier, I want deterministic failures to stop semantic admission, so model confidence cannot repair broken evidence.
18. As a consumer, I want support, world correctness, attribution, authority and provenance represented separately, so one score cannot erase uncertainty.
19. As a scientific consumer, I want population, dose, organism, experimental context and study limitations preserved, so a narrow result is not generalized silently.
20. As an operator, I want verification state in the application's operational store and linked to its mission, so I can recover execution without making Mission Control the scientific record.
21. As a Biotech consumer, I want adjudications and evidence links in Neo4j, so verification is traversable alongside research products.
22. As an AI Engineer consumer, I want equivalent verification semantics in PostgreSQL, so backend choice does not change guarantees.
23. As a domain maintainer, I want a versioned minimal verification binding independent of the complete ontology, so unfinished schema design does not block progress.
24. As an operator, I want duplicate delivery and lost responses reconciled by stable effect identity, so retries do not duplicate canonical knowledge.
25. As a maintainer, I want reusable deterministic work and calibrated semantic routing, so verification cost falls without weakening quality.
26. As a maintainer, I want per-domain quality evaluations, so a successful education benchmark does not certify scientific judgments.
27. As a maintainer, I want compatible releases across services, schemas, query catalogs and skill bundles, so modularity does not create hidden deployment coupling.
28. As an owner, I want the two complete application fixtures run only after all implementation gates pass, so final acceptance exercises the integrated product rather than repeated partial experiments.

29. As a Biotech application developer, I want a typed GraphQL client for web and Expo, so entity reads use the deployed domain API without server dependencies or shared service secrets.
30. As an agent operator, I want native query artifacts and ingestion contracts, so deterministic execution does not force another read language or a GraphQL hop.
31. As a schema owner, I want explicit adoption and corpus interviews, so a candidate schema or placeholder embedding dimension cannot silently become production authority.
32. As an operator, I want measured GraphQL and Fly optimization, so resource changes preserve supported queries and have evidence.

## Implementation Decisions

### Ownership and composition

Product services own identity integration, entitlements, user preferences, progress, saved work, conversation UX, personalization and screen composition. Domain knowledge services own entity meaning, identity resolution, ontology and query catalogs, native writers and content validation. Shared Knowledge Services owns reusable acquisition/preparation, evidence, verification algorithms, retrieval machinery, evaluation, operation contracts and lifecycle primitives. Mission Control owns durable mission scheduling, capability admission, grants, budgets, execution attempts, human tasks and mission acceptance.

An authenticated `ApplicationBinding` selects installation/application identity, domain endpoint and audience, native schema pin, query catalog, policy/rubric pins, operation availability, skill bundle pins, provider grants and resource limits. Tenant and actor come from validated authorization context. Caller-supplied application names do not select credentials. Optional capability absence returns an explicit unsupported/degraded result; required absence rejects before provider calls.

General interfaces describe operations and evidence, not a universal ORM. SQL and Cypher planners retain their transaction, concurrency and identity semantics. Common envelopes preserve native payload bytes, canonicalization algorithm and digest. Existing HTTP/MCP handlers call application services in process; cross-repository consumers use published contracts.

### User, product and retrieval APIs

The product API composes user state and domain results. Domain APIs expose describe, schema search/slice, resolve/read, retrieve, content version/draft/review/publication, verify, plan/apply and receipt operations. Normal entity/content navigation is a typed read without an LLM or mission. Biotech application entity clients use Neo4j GraphQL; AI Engineer application entity clients use a custom PostgreSQL-backed API. Existing Biotech agents use native Neo4j skills or proprietary schema-workspace/read/ingest tools. The planned client-facing Deep Agent must use that native agent path too; it is not a GraphQL consumer. Persistent data APIs have pagination, allowlisted filters, visibility and entitlement enforcement, freshness, supported consistency and explicit partial/error statuses. Product responses must not reveal internal SQL/Cypher, secrets or operational debugging artifacts.

Direct, Fast, Explore and Research are execution paths. Direct is a prepared typed query. Fast uses bounded retrieval and optional synthesis over existing authorized knowledge. Explore adds a bounded schema slice and planning. Research invokes a durable mission and external acquisition. Escalation is constrained by declared user mode/budget; a thin result cannot silently become a paid research mission. Modes vary breadth and effort, not minimum evidence integrity or domain admission requirements.

Schema indexes/slices and query templates are built per schema version. Exact entity IDs and common query patterns precede model planning. Cache keys include authorization scope, query/profile versions and relevant content/publication heads; schema caches and data caches have different lifetimes. Revocation and current admission must be rechecked when cached evidence is served. Performance acceptance uses measured p50/p95 and cost with declared hardware, data size, scope and cold/warm conditions; no invented speedup target is a quality certificate.

The planned product-facing Deep Agent owns conversation behavior and domain skill selection. It uses lightweight state and published tools for ordinary work; sandbox execution is escalated as needed. Product-agent recovery state is distinct from mission business state. Mission Control remains the scheduler for durable missions.

### Content and domain differentiation

Common content mechanisms are identity/versioning, source lineage, evidence bindings, draft/review/publication, permissions and supersession. AI Engineer retains courses/lessons/challenges/projects and their learning/runnable validation. Biotech retains protocols/reports/articles/timelines and their scientific constraints. Content production is an intent; verification, domain validation, admission and publication are separate decisions. Drafts may contain unresolved claims visibly; published claims must meet their intended-use policy. User/private and official content use distinct grants and publication policy.

### Verification, data authority and linkage

Both applications use the same verification contract, deterministic engine and bounded semantic interfaces. Profiles supply domain-specific rubrics and admissible evidence; persistence adapters supply native storage. The common operational verification ledger belongs to Knowledge Services in each application's PostgreSQL. Mission Control records execution references, intents/receipts and acceptance references, never becomes the authoritative claim/judgment store.

Use scoped correlation `(installation, application, tenant, mission?, run?, activation?, attempt?, operation, verificationRun, effectKey)`; standalone verification is legal and must not invent a mission. Store immutable audit bytes in app-scoped object custody. AI Engineer projects authoritative knowledge/admission and queryable verification into its PostgreSQL schema. Biotech projects immutable adjudications, source snapshots/locators and lineage into Neo4j through its native executor. Result application and verification completion have separate states.

The minimal Biotech verification binding is versioned independently of the entire ontology. It maps to the current candidate's Assertion/Adjudication/SourceLocator/SourceSnapshot/Activity semantics where appropriate without accepting the whole candidate. Raw third-party statements, capture-fidelity status, scientific support and policy admission remain distinct. An uncertain response is reconciled using native receipts/markers; no cross-database atomic transaction is assumed.

Common operational SQL eventually has one platform-owned component, consumed into both application database release manifests. Existing AI Engineer migrations/generated types remain owned by its database-contract repository until an explicit expand/migrate/contract ownership transition is proved. Mission Control common SQL stays owned by its own contract package. New shared operational tables must never be slipped into Mission Control merely because both applications already install it.

The verification annex defines research-to-implementation decisions, staged checks, quality gaps, domain profiles, optimization eligibility, native mappings, delivery recovery and acceptance. A reused verdict is not fresh world knowledge; changes to evidence, claim binding, applicability, policy, judge or calibration invalidate the relevant reuse. Deterministic and semantic caches have different rules.

### Skills, MCP, CLI and Jev

Each domain release includes scenario-specific skills, a domain MCP server/tool manifest, CLI bindings and worked procedures. The same application use case must enforce authority across transports. Skills contain task selection, required reads, Jev questions and labels, evidence requirements, failure interpretation, escalation and completion criteria. Public procedural guidance can be distributed separately from private rubrics, credentials and internal research assets.

Jev supplies Choice/Score/Noul judgments over captured input. Domain profiles own label vocabularies, criteria, uncertainty thresholds and escalation recipes. Jev does not authorize publication, execute writes or convert a probabilistic label into truth. AI Engineer classification and Biotech scientific-applicability triage require different labeled evaluations. The existing single-host queue must not be described as a distributed multi-tenant service without an explicit deployment boundary.

Every BellLabs domain skill, MCP server and tool is registered in the existing application's Mission Control capability catalog in its own PostgreSQL database. CLI entrypoints are declared through supported capability/binding types, not a guessed new enum. Bundle bytes remain immutable in private object custody and catalog records carry manifests/digests/versions, scopes, dependencies, host support and admission. Registration alone is not installation, admission or execution readiness. Upstream tools remain external capabilities; internal fallbacks are explicit alternative routes with truthful completeness reporting.

### Maintenance and deployment

Ship a modular foundation, independently pinned domain consumers and a small number of deployable roles. Interactive APIs/agents and heavy verification/conversion/ingestion workers have separate queues/concurrency/budgets. Immutable captures, domain records, operational ledgers, mission records and runtime checkpoints have explicit owners and retention.

Release manifests pin service/client contracts, native schemas, query catalogs, policies, rubrics, provider routes, executor versions and skill/capability digests. New adapters pass behavioral contract tests; neither backend must impersonate unsupported semantics. Use additive migrations, compatibility windows, idempotent backfill and reconciliation, then retire old paths after consumers pass. Preserve existing worktrees, local changes and immutable fixtures/receipts.

## Testing Decisions

Test the highest useful seam: an authorized published operation through HTTP/MCP/CLI and its application handler, with the real native executor for adapter integration checks. Prior art includes API/MCP parity, no-HTTP-shim, registered verification replay, bounded reads, deterministic ingestion and Neo4j intent-marker recovery. Extend those seams rather than create algorithm-mirroring test suites.

Unit, contract, disposable-database integration, schema/skill parser conformance, replay and frozen labeled evaluation checks run during each implementation slice. These are not the final application fixtures. Do not run the complete AI Engineer or Biotech research-to-content-to-knowledge-to-consumer fixture until all implementation issues, required quality evaluations, capability installations and release-readiness gates are complete. The final fixture ticket must be natively blocked by that complete set in Linear. Failures reopen their owning slice and require targeted validation before a final rerun.

Final fixture evidence must demonstrate both native stores, scoped catalog discovery, installed skills/MCP/CLI, product retrieval, direct and escalated agent behavior, content creation, evidence verification, Jev uncertainty, review, duplicate delivery/recovery and publication/readback. A plan, EXPLAIN, mock or skipped integration test is not proof of a deployed behavior. All evidence states passed/failed/blocked/unrun explicitly.

## Out of Scope

This planning delivery does not run production migrations, register live capability rows, execute paid provider benchmarks or the final two application fixtures. Those are implementation/release issues with concrete acceptance gates, already authorized as direction but not completed by writing this document. It does not finalize the entire Biotech ontology, merge databases, recreate retired repositories, rewrite TypeScript in Python, or implement every future product screen.

## Further Notes

The owner explicitly preapproved planning, official tracker publication, ADR decisions and GPT-6.1-sol specialist work; the original Matt Pocock interview/quiz pauses were waived for initial publication. The later request explicitly restores clarification gates for unresolved schema, native-agent and retrieval decisions. Preapproval permits publishing these gates and researching options; it does not supply their answers. Research-derived improvements are implementation obligations where adopted, not blanket acceptance of every historical proposal. Any remaining hypothesis has an explicit evaluation gate, fallback and owner.

The newer v2 assembly is the selected review candidate, not accepted or migrated. TypeScript web and React Native/Expo are the confirmed GraphQL client targets. Read [clarifications](CLARIFICATIONS.md), [GraphQL/client delivery](GRAPHQL-CLIENT.md), and [native retrieval/ingestion](NATIVE-RETRIEVAL-INGESTION.md) before affected implementation. These annexes qualify earlier generalization wherever it implied uniform APIs, read languages or vector spaces.

See [domain surfaces](DOMAIN-SURFACES.md), [verification](VERIFICATION.md), [delivery and capabilities](DELIVERY-CAPABILITIES.md), [ADRs](ADRS.md), [implementation plan](PLAN.md), [current evidence](CURRENT-STATE.md), and [validation](VALIDATION.md).
