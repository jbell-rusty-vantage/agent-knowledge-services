---
type: Direction Proposal
title: "The Knowledge Machine and the Content Machine: what Knowledge Services, the domain knowledge services, content services and user services become, cross-referenced to what exists"
description: "Owner request of 2026-11-02 restated as fourteen clear statements; the one-sentence purpose of every service; the knowledge API answer per domain; the feature catalog of the Knowledge Machine (acquisition, source intelligence, preparation, verification, ingestion, reads, retrieval, decisions, reports, experiments, guidance) and of the Content Machine (catalogs, mechanics, production, rendering, grading) with each feature labelled built / tested / integrated / qualified / absent; the minimal internal fallback set beside the external providers; the three paths as code-shaped projections; a gated sequence; and the decisions the owner must make."
tags: [knowledge-services, direction, knowledge-machine, content-machine, source-intelligence, decisions, experiments, user-services, product-api]
date: 2026-11-02
status: proposed
source: "Owner request 2026-11-02 (sprint-oc); inspected sources are cited inline. Written after the Mission Control documentation retrieval upgrade (agentic-sdlc-2026-11) and before the Knowledge Services truth pass."
---

# The Knowledge Machine and the Content Machine

Status words for every feature below: **built** (source exists), **tested** (unit or integration tests pass locally),
**integrated** (exercised through the real composed path on a disposable target), **qualified** (a W-checkpoint packet),
**absent** (no source), **proposed** (named in an accepted ADR or spec, no source). Nothing in this document is qualified;
W1 is open ([Sprint OC board](../../../../mission-control/docs/specs/provider-consolidation-2026-10/sprint-oc/NEXT-SESSION.md)).
Paths are relative to BellLabs unless they start with `packages/`, `apps/`, `skills/` or `knowledge/`, which are this
repository.

## What remains toward the owner goal, and what this document closes

The nearest goal is complete workflow and agent configuration logic on Deep Agents behind provider-neutral contracts. The
owner's larger product goal ([MC goals](../../../../mission-control/docs/knowledge/goals.md)) is evidence-backed reports and
content that people buy. Between those two sits an unnamed layer: what Knowledge Services and its domain bindings must
*become* so that a mission's output is retrievable knowledge and then content. This document names that layer, maps every
feature to its current state, and lists the decisions needed before the Knowledge Services truth pass
([handoff §4.2](../../../../mission-control/docs/specs/agentic-sdlc-2026-11/HANDOFF-2026-11-02.md)) rewrites the concepts.
It changes no code, no schema and no gate.

## 1. The request, restated as clear statements

Each statement is the owner's position as I read it. Where the request was a question, the statement is my answer and §9
records it as a decision to confirm.

| # | Statement | Where it is answered |
| --- | --- | --- |
| E1 | The Biotech knowledge API is the Neo4j GraphQL API. AI Engineer has no knowledge API yet. Both are called directly and by web/mobile apps, and are distinct from agentic retrieval. | §3 |
| E2 | Five service families need clear purpose: knowledge, report and evidence, content (datasets, courses, challenges, posts, images, video, games, 3D scenes), user, and the agent that users talk to. | §2, §4, §6, §7 |
| E3 | Three paths justify the whole effort: objective → advanced ingestion and reports; objective → content; advanced internal knowledge → content. | §8 |
| E4 | Agentic ingestion must accept any media type and turn it into retrievable knowledge. | §4.1, §4.3 |
| E5 | Retrieval experiments treat ingestion, embedding and search strategies (keyword, RAG, GraphRAG, hybrid) as experimental profiles that are tested and graded. | §4.8, §9 |
| E6 | External providers (open source in the cloud or hosted) do most acquisition and conversion; a minimal, powerful internal fallback set stays. | §5 |
| E7 | The ingestion and verification packages are right: intents, runs, evidence assertions, semantic judgement, report foundations. Keep them. | §4.4, §4.5, §4.9 |
| E8 | Knowledge Services is research, reporting, ingestion and retrieval mechanics combined with extremely high quality general and service-specific guidance. | §4.11 |
| E9 | Source intelligence is under-served: searches through provider skills (Tavily and the like) should be retained for a time, with a last-visit record, and provenance from sources to knowledge should be modelled better. | §4.2 |
| E10 | The OpenAI Decisions API and the Jev System One model are integral to Knowledge Services; the OpenAI CLI should be in the environment with guidance. | §4.7 |
| E11 | The owner is the first major user: running missions, creating and taking courses, requesting supplement recommendations. User services are still needed. | §7 |
| E12 | Knowledge schemas (AI Engineer PostgreSQL, Biotech Neo4j) get an optimization pass before anything is promoted to production or published. | §12 step 6 |
| E13 | Each application needs a content catalog (courses, challenges, and so on) fed by research with provenance. | §4.10, §6 |
| E14 | Experiments, flywheels and feedback loops exist beyond mission experiments: retrieval experiments, content output experiments. | §9 |

## 2. One sentence per service

| Service | Becomes | Owner | Must never own |
| --- | --- | --- | --- |
| **Knowledge Services** (`platform/knowledge-services`) | **The Knowledge Machine**: turns any source into exact captures, faithful representations, verified assertions, admitted domain knowledge and replayable retrieval, and measures itself with frozen experiments. | this repository | domain meaning, schema authority, product state, mission scheduling |
| **Domain knowledge services** (`aiengineer/ai-engineer-db-contract` + the `aiengineer-postgres` binding; `biotech/biotech-knowledge-services`) | The two **world models**: entity meaning, identity, schema, native writers and the **product knowledge API** of each application. | domain repositories | shared algorithms, mission state |
| **Report and evidence services** | Not a separate service. Reports are the **first content kind**, produced by missions, registered and assessed through `research-core` and the bindings' `report_v2` / `Report` projections. | Knowledge Services (mechanics), domains (storage) | publication authority (that is review) |
| **Content services** | **The Content Machine**: domain-owned content catalogs (courses, challenges, projects, guides, protocols, articles, timelines, datasets, media and 3D scenes) with shared mechanics (version, lineage, evidence binding, draft → review → publish) and mission-produced assets. | catalogs: domains; mechanics: Knowledge Services; production: Mission Control; rendering: product apps | knowledge truth (content cites it, never defines it) |
| **User services** | One **product service per application**: identity, entitlements, preferences, progress, saved work, notes, conversation state and the personal graph (Biotech). | domain product apps (`biotech/biotech-knowledge-services/apps/product-bff` exists; AI Engineer absent) | evidence, canonical knowledge |
| **User-facing agent** | Not a service. A **Deep Agents configuration** (Mission Control lane, lightweight state) that uses the same retrieval everyone uses, with the user's context injected as declared data and actor-scoped authorization. | Mission Control (configuration), product service (context) | a second retrieval stack |
| **Mission Control** | The scheduler and controller of every mission, including content production missions. Unchanged. | `platform/mission-control` | knowledge or content truth |

The map below is the one picture to keep. Arrows are contracts that exist or are proposed; the labels say which.

```text
                 world (web, papers, repos, video, labels, filings, user uploads)
                                   │  providers: Tavily, Firecrawl, Exa, Apify, PubMed, arXiv, GitHub, Context7
                                   ▼
   ┌───────────────────────── KNOWLEDGE MACHINE (platform/knowledge-services) ─────────────────────────┐
   │ source intelligence ─► acquisition ─► preparation ─► verification ─► ingestion intent/plan/apply   │
   │ (proposed)             (built)        (built)        (integrated)    (integrated, both bindings)    │
   │ decisions: Jev + Decisions API (built / proposed)     experiments: evaluation + eval ops (built)    │
   │ reads: knowledge.read_intent (integrated KS side)     retrieval: evidence packets (built)           │
   └───────────────┬──────────────────────────────────────────────────┬───────────────────────────────┘
                   │ K01 ks.knowledge_operation.v2 (built, integrated)  │
     ┌─────────────▼────────────┐                         ┌───────────▼──────────────┐
     │ AI Engineer world model   │                         │ Biotech world model       │
     │ PostgreSQL, AIDB 0.6.0    │                         │ Neo4j, biotech-schema     │
     │ product knowledge API:    │                         │ v2.2.0 (Fly runs v2.0.2)  │
     │ absent (api.* views only) │                         │ product knowledge API:    │
     └─────────────┬────────────┘                         │ GraphQL (built, deployed) │
                   │                                       └───────────┬──────────────┘
                   ▼                                                   ▼
   ┌───────────────────────────── CONTENT MACHINE (proposed) ──────────────────────────────┐
   │ catalogs: AIDB curriculum.* (built, no writer) │ Biotech content nodes (Report,       │
   │ Protocol, MediaWork exist; article/timeline/guide absent)                             │
   │ mechanics: ADR 0011 version/lineage/evidence/draft→review→publish (proposed)           │
   │ production: Mission Control missions with produce.* output contracts (produce.report  │
   │ built; course/media absent)   rendering: product UI component catalogs (absent)       │
   └───────────────────────────────────────┬───────────────────────────────────────────────┘
                                           ▼
                 USER SERVICES per app (Biotech BFF built, undeployed; AI Engineer absent)
                 web / mobile / the product agent / the owner's CLI and MCP (built)
```

## 3. The knowledge API per domain (E1)

**Biotech.** Yes: the product knowledge API is the Neo4j GraphQL API, `apps/graphql-api` in Biotech Knowledge Services,
Fly app `bks-biotech-graphql-api`, last released at `biotech-schema-v2.0.2` with mutations off; the pinned v2.2.0 was
installed on the disposable Aura `8032ec07` on 2026-10-28 and has no Fly redeploy record
([BKS README](../../../../../biotech/biotech-knowledge-services/README.md#current-pin-and-historical-observations)).
The typed client is `packages/graphql-client`; the reference BFF `apps/product-bff` validates sessions and entitlements and
is undeployed. **Built, tested, deployed at an old pin; not qualified.**

**AI Engineer.** There is no knowledge API. What exists is the SQL `api` schema in the database contract: eight views
(`entities`, `current_facts`, `current_relationships`, `events_current` and more) and RPCs (`resolve_entity`, `entity_card`,
`entity_at`, `entity_timeline`, `what_changed`, `summary_evidence`, `evidence_packet`, `hybrid_knowledge_search_1536`)
([schema summary](../../../../../aiengineer/ai-engineer-db-contract/docs/knowledge-model/SCHEMA-SUMMARY.md)). The
[service inventory](../../../../../docs/navigation/SERVICE-INVENTORY.md) is explicit that the `api` schema is a database
contract, not an HTTP service. **Built as SQL; absent as an API.**

**Recommendation (KM-D1).** Keep three access paths per domain and keep them deliberately different, as ADR 0014 already
decides ([ADR 0014](../../architecture/0014-product-graphql-and-native-agent-access.md)):

| Path | Who calls it | AI Engineer | Biotech |
| --- | --- | --- | --- |
| **Product knowledge API** (typed reads, no model, no mission) | web, mobile, the BFF, scripts | **PostgREST over the `api` schema** behind a thin BFF for entitlements; the views and RPCs already exist, so this is configuration plus a BFF, not a new query language | Neo4j GraphQL behind `product-bff` |
| **Agentic retrieval** (`knowledge.question` Direct / Fast / Explore / Research, evidence packets) | the product agent, external agents through skills and MCP, the owner's CLI | Knowledge Services `knowledge_retrieve_*` over the `aiengineer-postgres` binding (built; graph expansion unsupported) | **absent**: no Knowledge Services retrieval binding for Biotech; BKS has lexical schema search and a vector index flag only |
| **Native agent access** (recorded reads, intents, plans, applies) | missions | K01 `knowledge.read_intent`, `knowledge.apply` (integrated) | K01 through `biotech-graph` (apply integrated; read-intent port absent) |

Do not build a GraphQL for AI Engineer and do not route agents through GraphQL. The one thing to add for AI Engineer is
PostgREST exposure of `api` plus a BFF; that is the cheapest typed read surface and it reuses the contract's own views.

## 4. The Knowledge Machine: feature catalog with current state

### 4.1 Acquisition: any source, exact bytes

| Feature | State | Evidence | Gap |
| --- | --- | --- | --- |
| Exact HTTPS capture with pinned DNS, SSRF guards, redirect and credential rejection | built, tested, wired in the worker | `packages/sources/src/http/` | none |
| Manual upload with sidecar attestation | built, wired | `packages/sources/src/upload/` | none |
| Paper identity (arXiv, DOI, PubMed) and plan-as-HTTP | identity built and wired; execute unwired | `packages/sources/src/paper/` | wire execute against a provider |
| Immutable repository snapshot (commit-pinned) | built, **unwired** pending the capture-cardinality decision | `packages/sources/src/repository/adapter.ts` | decide cardinality (one capture per file versus per tree); AI Engineer facts are pinned to 40-hex commits so this is needed |
| Firecrawl acquisition adapter | built, **unwired**; agents use the Firecrawl skill and `source_import` | `packages/sources/src/firecrawl/adapter.ts` | wire as a *provider* of source intelligence (§4.2) |
| Sealed capture inspect, read, search | built | `packages/sources/src/inspect/` | none |
| Media accepted by preparation | text, Markdown, VTT, JSON, XML, HTML (deterministic); PDF and Office (Docling); HTML and PDF projections (isolated parser) | `packages/preparation/src/conversion/media-type.ts` | **audio, video, images, 3D are absent** (§4.3) |

### 4.2 Source intelligence (E9): what we asked the world, what came back, when to ask again

This is the under-served piece. The data model already exists on the AI Engineer side and nothing writes it:

| Piece | State | Evidence |
| --- | --- | --- |
| `evidence.search_provider` seeded with firecrawl, exa, tavily, brave, google, youtube, manual | built | AIDB migration `20260912010100_km_01_vocabularies.sql:41` |
| `evidence.source_query` (provider, query text, purpose, parameters, response artifact), `evidence.provider_result` (rank, url, title, snippet, payload), `evidence.source_encounter` (`discovered`, `captured`, `unchanged`, `failed`, `blocked`, `revisited`, timestamp, receipt), `evidence.source_provider_attempt`, `evidence.source_selection_revision`, `evidence.source_result_selection` | built (schema) | AIDB migrations `km_05_evidence`, `20260914010200_source_attempt_accounting`, `20260914010400_source_attempt_recovery` |
| A writer in Knowledge Services for those tables | **absent** | no `source_query` or `source_encounter` writer under `packages/` |
| Mission Control recognizes Tavily tools in the capability projection and seeds `tavily-mcp` | built | MC `catalog_projection_metadata.py:151`, `bootstrap/settings.py:699` |
| Biotech equivalent | **absent** in the pinned graph (`CaptureAttempt` and `Source` nodes exist; no query or encounter node) | BKS `schema/pinned/release/registers/node-register.yaml` |
| The idea as harvested from the old spec pack (`SourceEncounter`: reason, method, result digest, cost, freshness, authority, downstream consumers) | proposed, not built | MC `docs/specs/proposals-2026-10/SPEC-PACK-IDEAS-2026-11.md` row 7 |

**Recommendation (KM-D2).** Make source intelligence a named Knowledge Services capability with four operations on K01,
served to agents as one skill and one MCP tool group, provider-routed:

```text
source.search   (provider, query, purpose, filters)  → records source_query + provider_result rows,
                                                        stores the raw response as an artifact, returns ranked
                                                        candidates with their encounter history (last visit,
                                                        last change, capture id, authority class)
source.visit    (candidate | url, reason)            → acquisition (§4.1) + an encounter row
                                                        (captured | unchanged | failed | blocked)
source.revisit_due (scope, policy)                   → sources whose freshness policy has lapsed
                                                        (evidence.revalidation_policy exists in AIDB)
source.card     (source id)                          → everything known about one source: queries that
                                                        found it, captures, claims that cite it, consumers
```

Retention (KM-D3, owner to confirm): raw provider responses as artifacts for 90 days; `source_query`, `provider_result`
and `source_encounter` rows forever; a result is *discovery*, never evidence, exactly as both knowledge charters say today
([AI Engineer charter](../../../../mission-control/skills/ai-engineer-knowledge-charter/SKILL.md), [Biotech charter](../../../../mission-control/skills/biotech-knowledge-charter/SKILL.md)).
Biotech stores these rows in its application PostgreSQL (the `biotech-postgres-db-contract` consumer of the shared
component), not in Neo4j: it is high-volume operational data and the graph should hold `Source` and `CaptureAttempt` only.
Provider adapters (Tavily, Firecrawl, Exa, Apify, PubMed, arXiv, GitHub) are the *sources* of candidates; the unwired
Firecrawl adapter becomes the first.

Provenance from source to knowledge is already modelled end to end on AI Engineer (`source` → `source_capture` →
`locator` → `claim` → `claim_subject`/`segment_support` → `knowledge.record` → `operation_receipt_target`) and on Biotech
(`Source` → `SourceSnapshot` → `SourceLocator` → `Assertion`/`Claim` → `Assessment` → `Report`). What is missing is the
step *before* the source: the query and the encounter. Adding it closes the chain.

### 4.3 Preparation: faithful representations of any media

| Feature | State | Evidence | Gap |
| --- | --- | --- | --- |
| Deterministic text and HTML conversion; Docling route; gated Unstructured route; isolated html5lib/pdfplumber parser with byte, page, process and time bounds | built, tested | `packages/preparation/src/conversion/` | none |
| Immutable capture → representation → chunk → projection lineage; replay rejects conflicting metadata | built, tested | `packages/persistence/src/preparation.ts` | none |
| Chunking profiles, embeddings, projections, eleven 1536-d half-vector spaces on AI Engineer | built | `packages/retrieval/src/{embeddings,projections}`; AIDB `retrieval.*` | Biotech has none of this through Knowledge Services |
| Vector publication with manifests, evaluation binding, atomic pointer, rollback | built, tested | `packages/retrieval/src/vector-backends/publication/` | none |
| Audio and video (transcripts, timecodes, keyframes), images (description, OCR), 3D (scene manifests) | **absent** | | provider-backed *conversion routes* that produce `text/vtt` and image-description representations, with the provider identity recorded as a transformation; VTT ingestion already exists, so transcription providers plug in without a new custody model |

**Recommendation (KM-D4).** "Any media" means: every medium gets a provider-backed conversion route that ends in an
already-supported representation (text, VTT with timecodes, Markdown with figure descriptions, a JSON scene manifest).
No new representation kinds in persistence; new *transformation kinds* only. The AI Engineer `content.transformation_kind`
vocabulary and `conversion_decision` tables already fit this.

### 4.4 Verification and admission (E7, keep)

Built, tested, integrated on W0 (component `knowledge_verification` 2.5.0, migrations 0001..0008); deterministic checks
before semantic judgement before policy; exact-use oracle; reviewer grants; seal-key ceremony
([current state](../../architecture/current-state.md), [verification guide](../../verification/README.md)). Not qualified
(W1 open). Nothing to change in direction; the truth pass should record the two read-intent contracts correctly.

### 4.5 Ingestion: intent → plan → apply through bindings (E7, keep)

Integrated on both bindings: AI Engineer (receipt targets, `report_v2`, producer origin; 29 `mission_run_effects` rows on
a real run) and Biotech (Qualia fixtures, 146/146 and 165/165 effects read back)
([KS state inventory](../../../../mission-control/docs/specs/agentic-sdlc-2026-11/STATE-knowledge-services-2026-11.md)).
Open defect: `plan_preview` admits subjects missing NOT NULL typed columns. Open gap: Biotech read-intent port.

### 4.6 Reads

`knowledge.read_intent` (K01, eight named queries, every served read recorded) is integrated on the Knowledge Services
side only; no Deep Agents mission has called it. The older bounded `knowledge-read-intent.v1` still skips retrieval
(`RETRIEVAL_UNAVAILABLE`). The truth pass must name both contracts without collision.

### 4.7 Decisions: Jev System One and the OpenAI Decisions API (E10)

| Piece | State | Evidence |
| --- | --- | --- |
| `jev` package: Choice, Score, Noul; captured-input SQLite queue; child workers; direct adapter pinned `jev-1.13.0`; Gateway adapter that maps Noul to boolean and back | built, tested, dedicated binary | `packages/jev/`, `apps/jev/`, `knowledge/jev-decisions-and-workers.md` |
| Jev skill (closed-choice tasks, uncertainty handling, taxonomy search recipes) | built | `skills/jev-system-one/SKILL.md` |
| OpenAI CLI in the environment | **installed**: `openai` 1.46.0 at `C:\Users\Pinda\AppData\Local\OpenAI\bin\openai.exe`, with `openai decisions create` | verified 2026-11-02; user skill `openai-api-cli` |
| OpenAI Decisions API | public beta, `POST /v1/decisions`, model `gpt-6-luna` only; question types `predicate` (probability 0..1), `choice` (one of supplied values with probabilities), `score` (probability-weighted index over ordered levels); up to 400 questions per request; text, image and `input_json` inputs; conversation and tool-output items as evidence; prompt caching; refusal answers. Third-party reporting: USD 0.10 per 1M input tokens, no output charge (unverified against the price page) | [guide](https://developers.openai.com/api/docs/guides/decisions) |
| A Decisions API adapter in `jev` | **absent** | |

The two systems are the same shape. `predicate` is Noul, `choice` is Choice, `score` is Score. **Recommendation (KM-D5):**
add `DecisionsApiAdapter` beside the direct and Gateway adapters, keep the public `jev` contract unchanged, and make the
Decisions API the default provider for text, image and JSON judgements because it is the only one of the two that takes
images and structured JSON natively and runs 400 questions per call. Keep `typesafe-ai/jev` as the second provider and for
calibration comparisons. Calibration rule stays: no threshold is used for an admission or a route until a labelled
evaluation of that question exists (`packages/evaluation`). Guidance to write: one page in the Jev skill, "when Decisions,
when Responses, when a mission", with the CLI invocation for experiments:

```text
openai decisions create --model gpt-6-luna --input @evidence.json --questions @questions.json --format json
```

Where it is used inside the machine: exact-use and claim-support triage (`verification-semantic`), subject-resolution
candidates in ingestion planning, route selection in `knowledge.question` (`insufficient_context` as a label), content
rubric grading (§6), source-authority classification in source intelligence.

### 4.8 Retrieval and evidence packets, and retrieval experiments (E5)

| Feature | State | Evidence | Gap |
| --- | --- | --- | --- |
| Retrieval plan contract: policy version, subqueries, vector spaces, hard filters, three clocks, abstention threshold; capability preflight returns typed unsupported | built, tested | `packages/contracts/src/retrieval.ts`, `packages/application/src/knowledge/retrieval/canonical-retrieval-executor.ts` | graph expansion, freshness upper bounds, soft boosts, concept and use-case anchors are rejected today |
| Channels: exact, full-text, trigram, ANN; optional reranker validation; evidence resolution to admitted support; immutable packet with omissions and abstention | built, tested | `packages/retrieval/src/search/retrieve.ts`, `packages/persistence/src/retrieval-evidence.ts` | GraphRAG is the missing channel |
| Platform surface: `knowledge_retrieve_plan/search/explain/run/packet/citations` on API and MCP | built | `apps/mcp/src/catalog.ts` | not reachable through the bounded read executor |
| Biotech retrieval through Knowledge Services | **absent** | | a `biotech-graph` retrieval port (Cypher-backed lexical and vector channels over `Chunk` and `DocumentTextVersion`) |
| Evaluation: frozen datasets, dev/calibration/heldout partitions, real-bundle and adversarial fixture kinds, verification benchmark, human review | built, tested | `packages/evaluation/src/` | the 136 proof scripts under `scripts/` are deleted in the working tree (§11) |
| Eval operations: `ks knowledge eval generate/run/compare/failures` and MCP `knowledge_eval_*` | built | `skills/knowledge-evaluation/SKILL.md` | no *experiment registry* that names a profile |
| AI Engineer experiment tables: `evaluation.experiment`, `experiment_arm`, `gate`, `regression`, `promotion_gate_*` | built (schema) | AIDB `evaluation.*` (30 tables) | no writer from Knowledge Services; Biotech has none |

**Recommendation (KM-D6).** Define a **retrieval profile** as a frozen tuple and make it the unit of every retrieval
experiment:

```text
RetrievalProfile = {
  preparation: { chunking profile, projections, transformation kinds },
  representation: { keyword | dense(space, model) | graph(hops, predicates) | hybrid(weights) },
  channels: [exact, fulltext, trigram, ann, graph],
  rerank: { none | model, version },
  policy: retrieval policy version, abstention threshold,
}
Experiment = { dataset version, profiles[], metrics (recall, nDCG, MRR, citation validity,
               false acceptance, abstention, latency, cost), gate, result digest }
```

Keyword, RAG, GraphRAG and hybrid are four values of `representation`, not four systems. Record the experiment in the
AI Engineer `evaluation.experiment` tables through the binding, and give Biotech the same tables in its application
PostgreSQL by adding `knowledge_experiment` to the shared component (KM-D7 asks where).

### 4.9 Reports and evidence assertions (E7, keep; E2 "report and evidence services")

`research-core` 2.0.0 holds `report.register`, `report.derive`, `readSelected`, trusted assessment and use decisions;
the AI Engineer binding projects `research.report_v2_*` (package, section, section version, dependency) in the apply
transaction; the Biotech pinned release has `Report`, `ReportItem`, `ReportStatement`, `Assessment`. The Mission Control
`produce.report` output contract is built and integrated. **Reports are the first content kind and need no separate
service.** What they lack is the Content Machine mechanics (§6): review state, publication and a public rendering.

### 4.10 From knowledge to content: the provenance already modelled

AI Engineer: `curriculum.lesson_backed_by`, `curriculum.challenge_derived_from`, `curriculum.lesson_covers_concept`,
`content.document_about_entity`, `content.document_summary_source`, `research.downstream_handoff` all exist as schema
with no writer. Biotech: `Report` → `ReportStatement` → `Assertion` exists; nothing above a report. The Content Machine
reuses these edges; it does not invent a second provenance model.

### 4.11 Guidance: the differentiating asset (E8)

Ten root skills plus the executor skill ship here (`skills/`); the Jev skill, the knowledge charters and the
`mc-cognition-*` skills ship in Mission Control (`platform/mission-control/skills/`). The accepted direction is eight
canonical Deep Agents-ready skills (Unit 6, not delivered). The owner's words: "extremely high quality guidance" and the
specification's: "a generic search endpoint plus cosmetic domain prompts does not meet this requirement"
([domain surfaces §1](../belllabs-knowledge-platform/DOMAIN-SURFACES.md)). The truth pass is where this guidance becomes
measurable: the Knowledge Services benchmark is preserved as the first fixture set (17/18 screening today).

## 5. External providers and the minimal internal fallback set (E6)

Principle: providers do discovery and heavy conversion; the internal set covers every step where custody, determinism or
offline operation matters. Each internal piece below is already built, so "minimal" costs nothing new.

| Keep internally | Why | State |
| --- | --- | --- |
| URL → exact bytes (`ExactHttpAcquisitionAdapter`) | custody starts here; a provider's Markdown is never the capture | built, wired |
| bytes → text: deterministic text and HTML; isolated html5lib/pdfplumber parser | the offline, bounded fallback for every HTML and PDF when Docling is down | built |
| Docling container | open source, self-hosted, pinned; PDF and Office conversion | built (compose recipe) |
| Manual upload with attestation | user files, lab reports, exports | built |
| Paper and repository identity normalization | identity is cheap and must be ours | built |
| Sealed capture inspect and search | agents must read captured bytes without a model | built |
| Lexical retrieval (full-text, trigram) | the no-embedding fallback | built on AI Engineer; BKS lexical workspace search |
| Caption and VTT ingestion | the fallback when no transcription provider is admitted | built |

| Provider, not internal | Provider options (existing seats first) |
| --- | --- |
| Web search, extract, crawl, map, monitor | Tavily (MCP seeded in MC), Firecrawl (skill; unwired adapter), Exa |
| Transcripts | Apify (used by the pre-research agent), OpenAI transcription, Gemini |
| Image description and OCR, video understanding | OpenAI, Gemini; never a local OCR stack |
| Embeddings and reranking | AI Gateway routes already used by `live-gateway-embeddings` |
| Judgements | OpenAI Decisions API, typesafe-ai/jev (§4.7) |
| Papers and registries | PubMed, arXiv, bioRxiv, ClinicalTrials (MCP servers available in the Claude seat) |
| Code and docs | GitHub, Context7 (AI Engineer fixtures of 2026-10-31) |
| Media, game and 3D generation | image, video and Blender/Three.js providers as Mission Control capabilities (§6) |

Every provider call that produces a capture, representation or judgement records the provider identity and version as a
transformation or decision provider; a provider outage returns a typed unsupported result, never a silent fallback.

## 6. The Content Machine (E2, E13): catalogs, mechanics, production, rendering, grading

Content is every durable thing a user consumes that is *about* knowledge: reports, courses, lessons, challenges,
projects, guides, protocols, articles, timelines, datasets, images, videos, games, Blender scenes, generative UI views.
Five responsibilities, four owners:

| Responsibility | Owner | What it is | State |
| --- | --- | --- | --- |
| **Catalog** (what content exists, in which version, for which audience) | each application | AI Engineer: `curriculum.*` (curriculum, track, module, lesson, lesson_version, learning_objective, challenge, challenge_version and their evidence edges). Biotech: `Report`, `Protocol`, `ProtocolEdition`, `ProtocolStep`, `MediaWork`, `Chunk` in v2.2.0; article, timeline, guide, course absent | AI Engineer **built, no writer, no app**; Biotech **partial** |
| **Mechanics** (identity, version, lineage, evidence binding, draft → review → publish, supersession, permissions) | Knowledge Services | [ADR 0011](../../architecture/0011-content-lifecycle-and-publication.md) | **proposed**; the only publication machinery built is the vector publication coordinator |
| **Production** (missions that write content) | Mission Control | `produce.report` built; `produce.course`, `produce.challenge`, `produce.article`, `produce.media`, `produce.scene` absent; media and 3D generation providers (image, video, Blender) are capability lanes like any provider, with asset custody in the application object store | **partial** |
| **Rendering** (how content is shown) | product apps | web and mobile clients; a **UI component catalog** per application that generative UI and MCP Apps select from, each component with a text fallback ([MC ADR-0016](../../../../mission-control/docs/adr/0016-required-ui-surfaces-with-fallback.md)); components registered in the Mission Control capability catalog like skills and MCP servers so an agent can choose one | **absent** |
| **Grading** (is this content good) | Knowledge Services experiments + product signals | content experiments (§9) with Decisions rubrics, human review and learner outcomes | **absent** |

**Recommendation (KM-D8).** Where things go:

- `platform/knowledge-services/packages/content` (new): the ADR 0011 mechanics as a provider-neutral module with two
  ports (`aiengineer-postgres`, `biotech-graph`), the same shape as `research-core` and its bindings.
- AI Engineer: a `content_catalog` migration in the database contract (publication, review, audience, pins on
  `curriculum.*`), then the learner application. Biotech: `biotech-schema-v2.3.0` adds `Article`, `Timeline`, `Guide` and
  a `ContentPublication` node, or stores them in the Biotech application PostgreSQL if the owner prefers to keep the
  graph scientific (KM-D9).
- Mission Control: one `produce.<kind>` output contract per content kind, each with a schema obligation and a required
  provenance section (knowledge records and evidence packets cited).
- Product apps: `packages/ui-catalog` per application, manifest schema shared in `platform`.
- Media, game and 3D generation: provider capabilities admitted per application (image, video, Blender, Three.js scene
  exporters); the Content Machine stores the asset, its generation receipt and its provenance; it never stores the
  model prompt as truth.

Datasets are a content kind too: a frozen evaluation dataset or a published knowledge extract is versioned, cited and
published through the same mechanics.

## 7. User services and the product agent (E11)

The specification already names the logical operations ([domain surfaces §3](../belllabs-knowledge-platform/DOMAIN-SURFACES.md)):
User API (profile, preferences, entitlements, saved content, notes), Product API (content list, create, fork, revise,
submit-review, publish, withdraw), Learning API (enroll, progress, challenge attempt, project test), Research API
(question, protocol edition, timeline, report draft), Conversation API, external-agent handshake, knowledge facade. None
is built; Biotech has the BFF skeleton, AI Engineer has nothing. The owner's question "is there a distinct user-facing
agent service, or do we use the optimal retrieval everywhere with user context" has one answer: **the latter**. The
product agent is a Deep Agents node configured by Mission Control's `agent-configuration` machinery with:

- the application binding (which world model, which skills, which Decisions recipes);
- the user context as a declared Context Packet (profile, entitlements, progress, saved work, and for Biotech the
  personal graph), injected as data with actor-scoped authorization, never as a policy floor;
- the same `knowledge.question` facade and the same skills every other agent uses;
- escalation to a durable mission only within the user's budget (`needs_budget`, never silent research).

Because the owner is the first user, the first product service is the one that exists today: `missionctl`, `ks`, the
MCP servers and the skills. The user API grows out of what the owner records while using them (notes, saved work,
progress on a course the owner authored and took). The personal graph (Biotech vision, "ME2") is a user-service store,
never the public graph, exactly as the Biotech vision requires.

## 8. The three paths as code-shaped projections (E3)

Names that exist are plain; names that do not exist are marked `(proposed)`.

```text
# Path 1: objective → advanced ingestion → report
mission = missionctl start manifest.yaml           # StageGraph or GoalDirected, Deep Agents lane
  stage research:
    source.search(tavily|firecrawl|pubmed, query, purpose)   (proposed)   # recorded discovery
    source.visit(candidate)                                   (proposed)   # exact capture + encounter
    knowledge_read_intent(named query)                        # what we already know; integrated KS side
    verify_claims(captures, assertions)                       # deterministic → semantic (Jev/Decisions) → policy
  stage ingest:
    knowledge_apply(intent)                                   # plan → apply; receipt targets; both bindings
  stage report:
    report_register(content) → submit_output(produce.report)  # research-core; report_v2 / Report
  acceptance: trusted assessment, review, promotion           # built; W1 fulfillment open

# Path 2: objective → content
mission = missionctl start course-manifest.yaml
  stage plan:    knowledge.question(explore, anchors)         (facade proposed; retrieval built)
  stage draft:   content.draft(kind=lesson, cites=[records, packets])      (proposed, ADR 0011)
  stage media:   produce.media / produce.scene via admitted providers      (proposed)
  stage review:  Decisions rubric + human gate → content.submit_review     (proposed)
  publish:       content.publish by reviewer authority, never by the agent (proposed)

# Path 3: advanced internal knowledge → content
scheduled or signal-driven (what_changed, revisit_due):
  knowledge.question(direct, entity)  →  content.revise(existing, supersedes)   (proposed)
  grading: content experiment arms graded; learner signals feed eval cases      (proposed)
```

## 9. Experiments, flywheels and feedback loops (E5, E14)

Three experiment families, one registry, one rule: an experiment recommends, a separately authorized operation promotes.

| Family | Unit under test | Cases | Graders | Where recorded |
| --- | --- | --- | --- | --- |
| Retrieval | `RetrievalProfile` (§4.8) | frozen evaluation datasets; negatives and adversarial cases | deterministic metrics, Decisions judges, sampled human review | `evaluation.*` (AI Engineer built; Biotech absent) |
| Content | a content version or a production recipe | rubric cases per content kind; learner outcome signals (challenge pass rates, completion, corrections) | Decisions rubrics, human review, outcome metrics | same registry, `experiment.kind = content` (proposed) |
| Mission | a workflow or harness variant | the Mission Control idea "experiments as swarm variants" (`harness_comparison`, `model_comparison`, `eval_benchmark`) | Mission Control assessment | MC proposals row 3; not built |

The flywheel: source intelligence → ingestion → knowledge → content → user signals → new eval cases (the Biotech vision
already asks every mission to generate evals) → retrieval and content experiments → promotion. The feedback loop that
closes it is the **revisit** signal from source intelligence and the **what_changed** read from the world model.

## 10. Decisions requested from the owner

| Id | Question | Recommendation |
| --- | --- | --- |
| KM-D1 | AI Engineer product knowledge API | PostgREST over the `api` schema behind a thin BFF; no GraphQL; agents never use it |
| KM-D2 | Source intelligence placement | A Knowledge Services capability (`source.search/visit/revisit_due/card`) over the existing AI Engineer `evidence.source_*` tables; Biotech rows in its application PostgreSQL; graph keeps `Source` and `CaptureAttempt` |
| KM-D3 | Retention of raw provider results | 90 days as artifacts; query, result and encounter rows forever |
| KM-D4 | "Any media" | provider-backed conversion routes ending in existing representations (text, VTT, Markdown with descriptions, scene JSON); new transformation kinds, no new custody model |
| KM-D5 | Decisions API and Jev | one `jev` contract, three adapters; Decisions API default for text, image and JSON; calibration before any threshold; CLI guidance in the Jev skill |
| KM-D6 | Retrieval profiles | the frozen tuple in §4.8 as the unit of every retrieval experiment; keyword, RAG, GraphRAG, hybrid are values of `representation` |
| KM-D7 | Experiment registry for Biotech | add `knowledge_experiment` to the shared component (next component release) and consume it in both application databases, rather than a Biotech-only copy |
| KM-D8 | Content Machine split | catalogs per application, mechanics in `packages/content` with two ports, production in Mission Control output contracts, rendering in per-app UI catalogs registered as capabilities |
| KM-D9 | Biotech content storage | graph nodes in v2.3.0 for `Article`, `Timeline`, `Guide` (recommended, since Biotech content is evidence-shaped) versus application PostgreSQL |
| KM-D10 | Program names | "Knowledge Machine" and "Content Machine" as the two program names under which the Knowledge Services truth pass and the later content work are filed |
| KM-D11 | The 136 deleted scripts in this repository's working tree (§11) | confirm intent before the truth pass commits or restores them |

## 11. Evidence limits and the working tree

This document inspected source, tests, schema files, pinned releases and the Decisions API guide; it ran no provider,
touched no database and launched no mission. The Biotech GraphQL deployment state is the README's dated record, not a
fresh check. Decisions API pricing is third-party reporting.

The Knowledge Services working tree on `sprint-oc` at `94cbb7d` has **136 deleted files under `scripts/`** (the
`prove-*`, `live-*`, `evaluate-*`, `prepare-*`, `reconcile-*` proofs and their `tsconfig.*` files) and two under
`internal/`, uncommitted, with no stash. `scripts/AGENTS.md` still routes to four of them. This is either an in-flight
cleanup or an accident; the state inventory of 2026-11-01 recorded a clean tree. This document did not restore or commit
them (KM-D11).

## 12. Sequence, by gate and not by date

1. **Knowledge Services truth pass** (next, already planned) carries this vocabulary: concepts for source intelligence,
   decisions, experiments and content mechanics are registered with `implementation_status: proposed` where they are
   proposed; the two read-intent contracts are named; the benchmark is the first fixture set.
2. **Decisions adapter and guidance** (KM-D5): small, cheap, immediately useful in verification, ingestion planning and
   content grading; proof is a labelled calibration run on an existing evaluation dataset.
3. **Source intelligence writer** (KM-D2, D3) through K01, with the Firecrawl adapter wired as the first provider and a
   Tavily adapter beside it; proof is one mission whose captures all trace to a recorded query and encounter.
4. **Retrieval profiles and the experiment registry** (KM-D6, D7), plus the Biotech retrieval port; proof is one
   experiment comparing keyword, dense and hybrid on the AI Engineer fixture corpus with a recorded gate result.
5. **Media routes** (KM-D4): transcription and image description as provider transformations; proof is a YouTube
   transcript and a product label image reaching verified assertions.
6. **Schema optimization pass** (E12) on both world models, driven by steps 3 to 5, then the content catalog migrations
   and `biotech-schema-v2.3.0` (KM-D8, D9).
7. **Content mechanics, `produce.<kind>` contracts, the AI Engineer product knowledge API, product services and the
   product agent configuration** (KM-D1, D8). The real-work gate (W1 to W5) is unchanged by any of this: steps 2 to 5
   are proved on disposable fixtures.

Related: [BellLabs pathway](../../../../../docs/BELLLABS-SEQUENCE.md) steps 4 to 6 are the same sequence seen from the
workspace; [platform specification](../belllabs-knowledge-platform/SPECIFICATION.md) and ADRs 0005 to 0015 remain the
accepted direction this document refines; the [MC Knowledge Services boundary](../../../../mission-control/docs/knowledge/knowledge-services.md)
is the Mission Control side of the same line.
