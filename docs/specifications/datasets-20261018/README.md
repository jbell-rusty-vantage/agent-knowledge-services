---
type: Specification proposal
title: "Datasets: research-backed, evidence-bound data products as a content type"
status: PROPOSED
date: 2026-10-18
owner: belllabs-platform
scope: [knowledge-services, mission-control, ai-engineer-db-contract, biotech-knowledge-services, web-application]
related:
  - ../content-services-20261017/README.md
  - ../evidence-verification-system-20261017/README.md
  - ../evaluation-improvement-system-20261018/README.md
  - ../../../../../docs/research/2026-10-18-factories-and-data-products.md
---

# Datasets as a content type

> **Status: PROPOSED (2026-10-18).** A Dataset is the fourth fundamental product of the platform,
> beside reports, prepared content and the report system itself. It is a versioned, schema-bound
> table (or graph slice) in which every cell is traceable to verified assertions, carries its own
> time validity and rights class, and is released only through gates that measure its coverage,
> accuracy and freshness. This document defines the content type, the release pipeline, the
> distribution surfaces and the factory that produces it. No release has been built.

## 0. Why datasets, and what makes them different

A report answers one question at one time. A dataset answers a family of questions for a whole
universe of entities, repeatedly, in a shape that software can consume. Everything the earlier
proposals built converges on it:

- Verification gives each value a verdict, a level and a replayable locator.
- Bitemporal storage gives each value a validity interval and a knowledge time, so a release can be
  reproduced as of a date and two releases can be diffed exactly.
- Entity resolution gives each row a canonical key, with ontology identifiers never emitted by a model.
- The evaluation system gives each release a scorecard a customer can audit.
- Mission Control gives the recurring process that keeps it current.

Scraped or aggregated datasets have none of these properties. The sellable difference is not the
rows. It is that every cell can be clicked open to its evidence, every release ships with a measured
accuracy and coverage, and every change between releases is explained.

### Three things called "dataset" in this platform

| Term | Meaning | Where |
| --- | --- | --- |
| **Dataset (product)** | The content type defined here. | Proposed `datasets.*` schema; Biotech release artefacts. |
| External dataset (research object) | A dataset that exists in the world and is described as an entity (host, licence, used by a benchmark). | `corpus.dataset`, `staging.candidate_dataset`; Biotech deferred `Dataset` node. |
| Evaluation dataset (golden set) | Frozen cases with qrels used to evaluate retrieval and verification. | `evaluation.eval_dataset`, `packages/evaluation`. |

Documents and code use the qualified names. An external dataset can be the *subject* of a product
dataset's row; a golden set can be *derived from* a product dataset (§3.7). They are not the same
object.

## 1. Decision summary

1. **A Dataset is a derivation of the canonical store, never a parallel store.** Rows are compiled
   from admitted assertions at a pinned knowledge time. If a value is not in the store, it is not in
   the release; the cell is null with a reason. Datasets therefore pull on ingestion coverage, not on
   a separate extraction path.
2. **The specification is the product.** A `DatasetSpec` (family, grain, key, universe, columns
   with types, units, ontology bindings, temporal semantics, verification floor, rights policy,
   cadence, coverage target) is a versioned, reviewable artefact. A customer order is a spec. A
   factory is a spec bound to a recurring mission and an evaluation cell.
3. **Every cell carries provenance columns.** Assertion identifiers, verification level and verdict,
   independent source count, validity interval, knowledge sequence, rights class and null reason are
   first-class columns in every release, not an optional sidecar.
4. **Rights are compiled per cell and enforced per release.** The most restrictive contributing
   source sets the cell's rights class; the spec's rights policy decides whether that cell ships,
   ships without excerpt, or ships as null. Licence-gated ontologies are declared in the spec and
   gate distribution. The platform records and enforces a policy; it does not decide the law.
5. **Releases are immutable and gated.** A release has a digest, a knowledge sequence or snapshot
   set, a datasheet, a scorecard, a rights manifest and a changelog. It passes schema, key,
   coverage, verification-floor, conflict, freshness, drift and sampled-audit gates, with a recorded
   promotion decision using the evaluation system's vocabulary.
6. **Distribution is files plus live surfaces.** Parquet and JSON Lines with a JSON Schema, a
   datasheet and an evidence sidecar; the knowledge facade's dataset operations; MCP tools; a web
   data room with cell-level evidence and disputes. Deltas are first-class: subscriptions receive
   what changed, computed from the stores' own change functions.
7. **Dataset quality is on the scorecard.** Audited accuracy, coverage against a defined universe,
   freshness lag, verification-floor compliance, dispute rate, delta stability and cost per verified
   cell are measured per dataset and per release.
8. **Customer corrections are labels.** A dispute on a cell becomes a verification case and, if
   upheld, a correction in the next release; the dispute rate and time to resolution are published.
9. **One compiler, two store adapters.** The dataset compiler reads the AI Engineer store through
   its temporal API and the Biotech graph through snapshot-pinned Cypher; the spec, gates, datasheet
   and distribution are shared.

## 2. The content type

### 2.1 Dataset families

Like the report catalogue, families fix grain, key, required provenance and the report kinds that
feed them.

| Family | Grain and key | Typical content | Fed by (report kinds) | Store primitives |
| --- | --- | --- | --- | --- |
| **Entity registry** | One row per canonical entity | Companies, models, drugs, trials, libraries with stable attributes and identifiers | Entity dossier, landscape survey | AIE `corpus.*` entity tables with `entity_identifier`; Biotech entity nodes with ontology IDs |
| **Attribute fact table** | One row per (entity, attribute, validity interval) | Pricing, context window, enrolment, approval status, licence | Monitoring delta, entity dossier | `temporal.segment.valid_during`; Biotech Assertion validFrom/validTo |
| **Event log** | One row per event | Releases, approvals, readouts, filings, funding rounds, retractions | Timeline, filing digest, monitoring delta | `corpus.industry_event`, `corporate_transaction`, `funding_round`; Biotech `Event` with minted identity key |
| **Measurement series** | One row per (entity, metric, observed_at, source) | Benchmark scores, endpoint results, prices over time | Comparison, study appraisal | `corpus.benchmark_run`; Biotech outcome assertions |
| **Relationship table** | One row per (subject, predicate, object, validity) | Drug–target, model–benchmark, company–investor, library–protocol | Landscape survey, comparison | `corpus.relationship` and typed link tables; Biotech typed relationships |
| **Comparison matrix** | One row per entity, one column per criterion | Feature matrices from comparison reports | Comparison | Derived from attribute facts |
| **Annotated evidence corpus** | One row per claim or per source snapshot | Curated sources with extracted, verified claims and locators | Evidence report, source vetting | `evidence.*`, content document chain; Biotech SourceSnapshot and Assertion |
| **Evaluation benchmark** | One row per question with graded answers and evidence | Verified question–answer–evidence sets for a domain | Derived from golden sets and report assertions | `evaluation.eval_dataset`, `report_assertion` |
| **Delta feed** | One row per change between two releases | Added, changed, retracted values with reasons | Monitoring delta | `api.what_changed`; Biotech recordedAt/recordedTo |

### 2.2 DatasetSpec

```yaml
DatasetSpec:
  id: aie.frontier-model-releases          # stable slug
  version: 3                               # spec version; releases pin it
  family: event_log
  domain: ai_engineer | biotech | finance
  title, description, intendedUses, prohibitedUses
  grain: "one row per (model_version, release_event)"
  key:
    columns: [model_version_id, event_kind, occurred_at]
    identity: canonical_entity_id           # how rows are keyed to entities
    ontologyBindings: [{ column: organization_id, ontology: GLEIF_LEI, licence: open }]
  universe:                                 # what "should" be in the dataset
    definition: "model versions released by organisations in corpus.organization with lifecycle active, plus Hugging Face trending models above threshold"
    referenceRegistries: [huggingface_hub, arxiv, vendor_release_pages]
    coverageTarget: 0.95                    # placeholder
  columns:
    - { name: model_version_id, type: uuid, role: key }
    - { name: model_name, type: text, verificationFloor: L1 }
    - { name: context_window_tokens, type: integer, unit: tokens, verificationFloor: L2, temporal: interval }
    - { name: release_date, type: date, temporal: event, precision: day, verificationFloor: L2 }
    - { name: list_price_input_per_mtok, type: numeric, unit: usd, temporal: interval, verificationFloor: L2, rightsPolicy: value_only }
    - { name: benchmark_mmlu_pro, type: numeric, temporal: series, verificationFloor: L2, independentSources: 2 }
  temporalSemantics:
    asOf: knowledge_seq                      # release reproducibility anchor
    rowValidity: valid_from, valid_to        # for interval columns
  verification:
    defaultFloor: L1
    conflictPolicy: null_with_reason | report_both | prefer_authority
  rights:
    policy: allowed_and_restricted_values    # see §4
    excerpts: allowed_only
    licenceGatedOntologies: []
  release:
    cadence: weekly
    freshnessSlo: 7d
    deltaDelivery: true
    auditSampleSize: 50                      # rows re-verified by a human per release (placeholder)
  evaluationCell: { domain: ai_engineer, reportKind: monitoring_delta, queryClass: temporal }
  factoryRef: mission_template:aie.frontier-model-monitor@2
```

Column `temporal` values: `static` (no time), `point` (true as of the release), `interval`
(`valid_from`, `valid_to` emitted), `event` (`occurred_at` with precision), `series` (long format
with `observed_at` and `source_ref`). Verification floor values are the levels of the verification
proposal (§3 there). `independentSources` requires that many independent source families behind the
value, using the independence rule the Biotech kernel already defines.

### 2.3 Standard provenance columns

Every release emits, for every value column `c`, the following (prefixed with an underscore so they
sort apart):

| Column | Content |
| --- | --- |
| `_c_assertion_ids` | Admitted assertion identifiers (claims in AIE, Assertion uids in Biotech) that the value was compiled from |
| `_c_verification_level`, `_c_verdict` | Highest level achieved and its verdict |
| `_c_source_count`, `_c_independent_source_count` | Sources and independent source families |
| `_c_valid_from`, `_c_valid_to` | World-time validity (interval and point columns) |
| `_c_recorded_at` | Knowledge time the value was admitted |
| `_c_rights_class` | allowed / restricted / unknown / denied (most restrictive contributor) |
| `_c_null_reason` | When null: not_found / not_yet_researched / held / review_required / conflicted / restricted_rights / out_of_universe / superseded |
| Row level: `_as_of_knowledge_seq` or `_snapshot_set_digest`, `_release_id`, `_row_digest` | Reproducibility anchors |

The evidence behind an assertion identifier is served by the existing evidence surfaces
(`api.evidence_packet` in AIE; the Biotech evidence export), so the release does not duplicate
excerpts.

## 3. Release pipeline

### 3.1 Stages

| Stage | What happens | Produces |
| --- | --- | --- |
| **Spec admission** | Spec reviewed (schema sanity, universe definable, rights policy consistent with sources, ontology licences declared). Review subject of a new kind `dataset_spec`. | Admitted `dataset_spec_version` |
| **Universe enumeration** | Compile the "should exist" set from the store and reference registries at the as-of time. | `universe_snapshot` with member keys and sources |
| **Research fill** | Factory mission runs for universe members with missing or stale cells (monitoring-delta report kind, obligations derived from the spec's columns and floors). | Reports, ingestion intents, admitted assertions |
| **Compile** | Deterministic materialisation of rows from admitted assertions at the pinned knowledge time; conflicts resolved per policy; rights class per cell; null reasons. | Release candidate files plus evidence sidecar |
| **Gates** | §3.3. | `dataset_release_gate_result` rows, promotion decision |
| **Audit** | Sampled rows re-verified by a human; accuracy estimated with a Wilson interval (function exists). | Audit record on the datasheet |
| **Datasheet and manifests** | Datasheet, rights manifest, changelog against previous release, scorecard extract. | Release artefacts |
| **Publish** | Immutable release with digest; pointer `current` moves; subscribers notified with the delta. | `dataset_release` with status published |
| **Listen** | Disputes, downloads, API use, interaction. | `feedback.*` rows (evaluation system §4.4) |

### 3.2 Compiler

One `DatasetCompiler` with two adapters:

- **AI Engineer adapter**: rows from `corpus.*` and `evidence.*` through `api.entity_at(entity, as_of)`,
  `api.entity_timeline` and `api.knowledge_head`; delta through `api.what_changed(from_seq, to_seq)`;
  conflicts from `evidence.claim_conflict`; rights from the content chain's `rights` field; provenance
  from `claim → source_capture → locator`.
- **Biotech adapter**: rows from Assertions with `recordedAt ≤ T` and `recordedTo` open at T, world
  validity from validFrom/validTo with precision and basis; delta from recordedAt/recordedTo between
  two T values; identity from ontology identifiers; rights from source snapshot rights statements;
  provenance through `SourceLocator` (never document to entity, per the kernel rule).

The compiler is deterministic: the same spec version, as-of anchor and store state produce the same
row digests. That property is what makes a release reproducible and a dispute adjudicable.

### 3.3 Release gates

Gate results use the evaluation system's score-vector shape and promotion vocabulary.

| Gate | Check | Hard or quality |
| --- | --- | --- |
| Schema | Every column matches type, unit and nullability; JSON Schema validates every row | Hard |
| Key | Key uniqueness; entity resolution confidence above floor for every row; no unresolved merges in `corpus.entity_merge` touching the release | Hard |
| Rights | Every cell's rights class satisfies the policy; no excerpt from a non-allowed source; licence-gated ontology identifiers only with declared licence | Hard |
| Verification floor | Share of non-null cells at or above the column's floor equals 1.0; cells below floor are nulled with reason `held` | Hard |
| Coverage | Rows present divided by universe members at or above `coverageTarget`; per-column fill rate reported | Quality |
| Conflict | Share of cells with `conflicted` below placeholder; conflicts listed in the datasheet | Quality |
| Freshness | Age of the newest admitted assertion per universe member within `freshnessSlo`; stale share reported | Quality |
| Drift | Count and kind of changes versus the previous release within an expected band; unexplained large deltas route to review | Quality |
| Audit | Sampled human re-verification accuracy above floor, with interval | Quality, becomes hard once a baseline exists |
| Regression | Golden rows (customer-confirmed or human-audited cells from earlier releases) unchanged unless superseded with reason | Hard |

### 3.4 Datasheet

Following the "datasheets for datasets" structure, generated from the release and the spec:
motivation and intended uses; composition (families, grain, row and column counts, universe
definition and coverage); collection process (factory, source classes, capture dates, verification
levels); preprocessing (conflict policy, unit normalisation); distribution (formats, rights manifest,
licence); maintenance (cadence, freshness, dispute channel, changelog). Platform additions: verification
profile per column, audited accuracy with interval, null-reason distribution, independent-source
statistics, known gaps, and the scorecard extract for the dataset's evaluation cell.

### 3.5 Delta releases and subscriptions

A delta is itself a release of the `delta_feed` family between two parent releases: rows added,
changed (old value, new value, reason: new_source / correction / supersession / retraction), removed
(reason: out_of_universe / rights / retraction). Subscribers choose full or delta delivery. The delta is
computed from the stores' change functions, not by diffing files, so that the reason column is
real.

### 3.6 Disputes and corrections

A dispute on a cell is a `feedback.event` of kind `correction` with the row digest, column, the
customer's proposed value and source. It opens a verification case (expected locator and value), runs
through the verification system at the column's floor, and resolves to upheld (next release carries
the correction and the changelog credits the dispute), rejected (the datasheet's dispute log records
the reason) or inconclusive (cell flagged `review_required`). Time to resolution and upheld rate are
scorecard metrics.

### 3.7 Datasets that feed evaluation

Two families close a loop with the evaluation system. The **evaluation benchmark** family packages
verified question–answer–evidence triples (from golden sets and report assertions) as a product for
teams building retrieval or research systems in the domain. Conversely, every published dataset's
audited rows become golden rows for its own regression gate, and its disputes become verification
cases. Datasets are therefore both an output of the quality system and an input to it.

## 4. Rights and licensing

The content contract already classifies rights per captured item as allowed, restricted, unknown or
denied. The dataset layer composes those into a release:

| Cell rights class (most restrictive contributor) | Policy `allowed_only` | Policy `allowed_and_restricted_values` | Policy `internal_only` |
| --- | --- | --- | --- |
| allowed | ships with excerpt available | ships with excerpt available | ships |
| restricted | null, reason `restricted_rights` | ships as value only; excerpt withheld; locator retained | ships |
| unknown | null | null, reason `restricted_rights`; queued for rights research | ships with flag |
| denied | null | null | null |

Rules:

- The rights manifest lists every source family that contributed, its rights class and the
  cells it affected, so a customer's counsel can read it.
- Facts compiled from several sources carry the most restrictive class; the compiler does not launder
  a denied source through an allowed one.
- Licence-gated ontologies (MedDRA, CPT, KEGG, SNOMED and others the Biotech registers already mark
  as licence-gated) may appear as identifiers only when the spec declares the licence and the
  customer attests to holding it; otherwise the column is mapped to an open ontology or omitted.
- Verbatim excerpts never ship unless the source is `allowed`; the locator always does, so the
  customer can retrieve the excerpt under their own access.
- The platform enforces the declared policy and records what it did. Whether a given fact is
  protectable in a jurisdiction is a legal determination the owner makes outside the system.

## 5. Distribution surfaces

| Surface | Content | Notes |
| --- | --- | --- |
| Files | `rows.parquet`, `rows.jsonl`, `schema.json` (JSON Schema with units and ontology bindings), `evidence.parquet` (row digest, column, assertion ids, locators), `datasheet.md`, `rights-manifest.json`, `changelog.md`, `manifest.json` with digests | Immutable per release; object storage; signed URLs |
| Knowledge facade | `knowledge.dataset.list`, `.get(spec, release)`, `.rows(filter, as_of)`, `.cell_evidence(row_digest, column)`, `.diff(from, to)`, `.subscribe`, `.dispute` | Extends the facade proposal in `DOMAIN-SURFACES.md`; read operations capability-gated like retrieval |
| MCP | Tools mirroring the facade read operations for service agents and customer agents | Publication and dispute resolution excluded, as the MCP catalogue excludes publication today |
| SQL | Per-tenant read-only views over the current release for customers hosted on the platform | Views, never base tables |
| Web data room | Browse, filter, as-of slider, cell click to evidence packet, dispute button, datasheet and scorecard, download | The same evidence rendering the review workbench uses |

Service agents answering users cite dataset cells the same way they cite packet members: the
citation resolves to assertion identifiers and locators.

## 6. The dataset factory

A factory is the recurring process that keeps one dataset current. It is composed from existing
primitives rather than built:

| Factory component | Existing primitive | Binding |
| --- | --- | --- |
| Order | `DatasetSpec` version | Admitted through review |
| Schedule and runs | Mission Control mission template with recurring dispatch | `factoryRef` on the spec; each run pins the spec version and the configuration digest |
| Research per run | Monitoring-delta report kind with obligations generated from the spec's columns, floors and universe gaps | Content services §2.1, §2.4 |
| Admission | Ingestion intents derived from the report through `report_derive`; verification at the column floor | Verification proposal §3 |
| Compile and gate | `DatasetCompiler` and release gates | This document §3 |
| Quality | Evaluation cell per dataset: golden rows, audit sample, disputes, scorecard section | Evaluation system §7, §9 |
| Economics | Cost per verified cell and per release from spans and budget ledger | Evaluation system §9 |

A customer-defined factory follows the same path. The web application offers a spec wizard
(family, universe, columns, cadence, floor, rights policy); the platform compiles it to a mission
template and an evaluation cell; a pilot run estimates coverage and cost before the first release; the
customer sees the same datasheet and scorecard as any catalogue dataset. The platform's own catalogue
datasets are factories the owner ordered.

Worked example, AI Engineer: "frontier model releases and benchmark performance". Universe: active
model-releasing organisations plus trending hub models. Columns: release date (event), context
window and pricing (interval), benchmark scores (series with two independent sources required for
headline numbers), availability per provider (`corpus.ai_model_availability_fact`). Cadence weekly;
delta feed on. Each weekly run researches new releases and changed prices, admits assertions,
recompiles, gates, publishes a delta. A customer disputing a context-window value supplies the vendor
page; the verification system replays it; the next delta carries the correction with credit.

Worked example, Biotech: "late-phase oncology readouts". Universe: Phase 2 and 3 interventional trials
for a condition set from the registry. Columns: primary endpoint, result with effect size and
interval (series, floor L2, independent sources 2 where a publication and a registry result both
exist), readout date (event), sponsor (registry), status changes (interval). Every value traces to
SourceLocators; MedDRA-coded adverse events appear only for licence-attesting customers.

## 7. Evaluation of datasets

Dataset metrics join the scorecard per dataset and per release:

| Metric | Definition | Direction |
| --- | --- | --- |
| Audited accuracy | Share of sampled cells confirmed by human re-verification, with interval | Up |
| Coverage | Rows present over universe members; per-column fill rate | Up to target |
| Floor compliance | Share of non-null cells at or above floor (must be 1.0) | Hold |
| Freshness lag | Median and p95 age of newest assertion per member at release | Down |
| Conflict and null rates | By reason | Down, explained |
| Delta stability | Changes per release within expected band; unexplained share | Stable |
| Dispute rate and upheld rate | Disputes per 1,000 cells; share upheld | Down; informative |
| Time to correction | Dispute to published correction | Down |
| Cost per verified cell | Research plus verification plus audit cost over cells admitted | Down |

Recall is the hardest number and the most valuable: a dataset that is accurate but misses a third of
the universe is less useful than its accuracy suggests. Universe definitions and coverage audits
(sampling universe members absent from the release and researching why) are therefore mandatory
parts of the datasheet, not optional analysis.

## 8. Storage additions (proposed, owner decisions)

AI Engineer contract, new schema `datasets`:

| Table | Purpose |
| --- | --- |
| `dataset_spec`, `dataset_spec_version` | The order; JSON spec with digest; status draft / admitted / retired; review decision reference |
| `universe_snapshot`, `universe_member` | Enumerated should-exist set per release with source of membership |
| `dataset_release` | spec version, as-of anchor (knowledge seq or snapshot set digest), status candidate / published / superseded / withdrawn, file manifest with digests, datasheet artefact, rights manifest artefact, previous release, changelog artefact |
| `dataset_release_gate_result` | Gate id, score vector, passed, decision reference (evaluation system shape) |
| `dataset_audit_sample`, `dataset_audit_result` | Sampled row digests and human re-verification outcomes |
| `dataset_subscription` | Tenant, spec, delivery mode full / delta, channel |
| `dataset_dispute` | Links a `feedback.event` to the verification case and resolution |

Row and cell data live in the release files, not in tables; the evidence sidecar carries assertion
identifiers so that cell evidence resolves through existing evidence surfaces. A small
`dataset_cell_index` (release, row digest, entity id) may be added for the data room's filters if
file scanning proves too slow; that is an implementation choice.

Biotech: releases are artefacts with the same manifests; the spec and release records are `Activity`
and output nodes in the lineage spine, consistent with how `Report` and `ReportItem` are produced
through `report.publish`; the deferred `Dataset` node remains the research-object concept and is not
reused for product releases.

## 9. Implementation stages and proposed issues

| Stage | Content | Exit criterion |
| --- | --- | --- |
| D0 Spec | `DatasetSpec` contract and validator; spec review subject kind; two example specs (one per domain). | Two admitted specs. |
| D1 Compile | `DatasetCompiler` with the AI Engineer adapter over the temporal API; provenance columns; null reasons; rights per cell; deterministic digests. | Same inputs produce identical row digests twice; a release candidate for the AI Engineer example. |
| D2 Gate and sheet | Release gates, audit sampling, datasheet, rights manifest, changelog; `datasets.*` tables; promotion decision. | First published release with datasheet and scorecard section. |
| D3 Deliver | Files, facade operations, MCP read tools, data room with cell evidence and disputes; delta release and subscription. | A customer agent cites a cell; a dispute round-trips to a correction. |
| D4 Biotech | Biotech adapter over snapshot-pinned Assertions; ontology licence gating; first Biotech release. | Biotech example published. |
| D5 Factory | Spec wizard; mission-template compilation; pilot run with coverage and cost estimate; catalogue of factories. | A customer-defined dataset released without platform-side hand work. |

Proposed issues (provisional; owner to open or discard):

- **DS01** Spec contract, validator, review subject kind `dataset_spec`.
- **DS02** Universe enumeration with reference registries; coverage computation.
- **DS03** Compiler core and AI Engineer adapter (temporal API, conflicts, rights, provenance columns).
- **DS04** Release gates with score vectors and promotion decision; golden rows regression.
- **DS05** Audit sampling and human re-verification flow (reuses annotation packs and Wilson interval).
- **DS06** Datasheet, rights manifest, changelog generators.
- **DS07** `datasets.*` migrations (AI Engineer contract owner).
- **DS08** File distribution and manifest signing; facade `knowledge.dataset.*`; MCP read tools.
- **DS09** Web data room: browse, as-of, cell evidence, dispute, datasheet, scorecard.
- **DS10** Delta releases and subscriptions from `api.what_changed` and Biotech recorded-time diffs.
- **DS11** Biotech adapter and ontology licence gating.
- **DS12** Factory wizard and mission-template compilation; pilot estimation.
- **DS13** Evaluation benchmark family: packaging golden sets and report assertions as a product, with rights review.

## 10. What is explicitly not established

- No dataset has been compiled; coverage targets, audit sample sizes, conflict and freshness
  thresholds are placeholders.
- Whether facts compiled from restricted sources may be redistributed as values is a legal
  determination per jurisdiction and source; the policy table in §4 is a mechanism, not advice.
- Pricing and packaging (per release, subscription, seat, API) are out of scope.
- Universe enumeration for open-ended domains (all AI models) will never reach a true denominator;
  the datasheet must state the universe definition and its known blind spots.
- The evaluation-benchmark family depends on rights review of the underlying excerpts and on the
  golden sets reaching the volumes the evaluation system needs.

## 11. Reading route

1. This document §1, §2, §3.
2. [Content services](../content-services-20261017/README.md) §2 (report catalogue and derivations)
   and §2.5 (time), which datasets consume.
3. [Evidence and verification system](../evidence-verification-system-20261017/README.md) §3 for
   verification levels used as column floors.
4. [Evaluation and improvement system](../evaluation-improvement-system-20261018/README.md) §4 (score
   vector), §7 (promotion vocabulary) and §9 (scorecard), which dataset gates and metrics reuse.
5. [Factories and data products](../../../../../docs/research/2026-10-18-factories-and-data-products.md)
   for the product framing.
6. [Content factory](../content-factory-20261018/README.md) for the dashboard and leaderboard
   renditions of a dataset release and the publishing path they share with other content.
7. Store references: AI Engineer `api.entity_at`, `api.entity_timeline`, `api.what_changed`,
   `api.knowledge_head`, `api.evidence_packet`, `corpus.entity_identifier`, `corpus.entity_merge`,
   `evidence.claim_conflict`; Biotech Assertion bitemporal fields, SourceLocator rule, `Event`
   identity key, licence-gated ontology notes in the node register.
8. External: Gebru et al., "Datasheets for Datasets" (2018, CACM 2021) for the datasheet structure.
