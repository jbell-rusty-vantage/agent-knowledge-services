# Content services: reports, preparation, ingestion and retrieval strategy

Status: PROPOSED consolidation, 2026-10-17. Companion to the
[evidence and verification proposal](../evidence-verification-system-20261017/README.md) and the
[research and sources note](../../../../../docs/research/2026-10-17-research-and-reports-sources-strategy-jev.md).
Nothing here changes an accepted ADR or a packet issue by itself. The
[primer](../../../../../docs/research/2026-10-17-ingestion-retrieval-evaluation-primer.md) explains the
concepts used here for a reader new to ingestion and retrieval.

This document answers four questions in order: what a mission produces and how that output turns into
knowledge (section 2); how content is prepared, promoted, linked and embedded (section 3); how the two
stores hold it (section 4); how retrieval strategies are built, evaluated and promoted to the agents and
the web application (sections 5 and 6). Section 7 compares the domains, section 8 gives the implementation
position, section 9 lists what is not established.

## 0. Scope and what this builds on

| Layer | Where | State |
| --- | --- | --- |
| Durable preparation pipeline: capture (acquire, seal), transformation (convert, inspect), chunk set (chunk, verify); conversion router deterministic → Docling → Unstructured; structural node tree; seven chunking profiles; governed chain representation decision → promotion proposal → promotion decision → embedding run → space publication | `packages/preparation`, `packages/persistence/src/preparation.ts`, `apps/worker/src/activity-registry.ts`, `apps/verification-executor/src/root-host-preparation.ts` | Implemented in the working tree. The executor route accepts only text and Markdown; the Docling path keeps provider JSON but rebuilds nodes from Markdown; `overlapTokens` and chunk edges are declared and unused; no generative summary, no entity extraction, no OCR |
| Knowledge database surfaces: schema workspace (`schema_search`, `schema_get`, `schema_manifest`), bounded reads (`knowledge-read-intent.v1`), ingestion (`ingest_plan`, `ingest_apply`, `ingest_receipt`), content links (`content-link-intent.v1`), literal summaries (`summary.materialize`), reports (`report_register`, `report_get`) | `packages/knowledge-db`, `apps/verification-executor/src/knowledge/operations.ts` | Implemented, executor-only (X01 folds them into the canonical surfaces) |
| Canonical retrieval executor: policy resolution, one embedding per space, `api.hybrid_knowledge_search_1536` (exact, FTS, trigram, ANN, RRF), optional reranker, canonical support resolution, diversity cap, coverage, abstention, immutable evidence packet, citation replay | `packages/application/src/knowledge/retrieval/canonical-retrieval-executor.ts`, `packages/persistence/src/retrieval-evidence.ts` | Implemented. Graph, context neighbours, soft boosts and upper time bounds are unsupported; runtime policy has no channel weights or stage toggles |
| Evaluation library and broad corpus: frozen datasets with graded qrels, recall, precision, MRR, nDCG, filter satisfaction, abstention, citation correctness, false acceptance, latency, cost; experiment matrix; promotion gate; rollback proof | `packages/evaluation`, `packages/testkit/src/broad-evaluation-corpus.ts`, `catalog/broad-heldout-evaluation.json` | Implemented, but the broad corpus runs only against the in-memory pipeline with deterministic vectors; no faithfulness metric; no link from an experiment arm to a retrieval policy version; no strategy promotion of any kind |
| AI Engineer content chain: document → version → representation → node tree → chunk set → chunks with contextual prefix → spans → projections → vector items with filter keys; first-class summaries with node-level sources; two clocks (`valid_during`, `k_from`/`k_to`); content links; report tables with `report_ingestion_link` | `aiengineer/ai-engineer-db-contract/workspace/domains/{content,retrieval,temporal-facts,evidence}.md` | Schema exists at migration head 20260916020200 |
| Biotech kernel: Source → SourceSnapshot → SourceLocator; `Chunk` as a projection off a snapshot (no document, no summary, no chunk edges); full-text indexes served; vector indexes recorded in optional DDL and not served; bitemporal Assertions; `biotech-knowledge-intent.v2`; `Report` and `ReportItem` with `DERIVED_FROM` | `biotech/biotech-knowledge-services/schema/pinned/release` (v2.0.2) | Pinned. Q01, Q02, Q03 decide graph binding, read-write semantics and the embedding contract |
| Direction | ADR 0002 (deterministic preparation), 0003 (embedding, retrieval, evaluation), 0006 (Direct, Fast, Explore, Research routes), 0011 (content lifecycle), 0015 (backend-native retrieval); `docs/specs/belllabs-knowledge-platform/{NATIVE-RETRIEVAL-INGESTION,DOMAIN-SURFACES}.md`; issues Q03, N04, N05, G08, R01–R03, C01, C02, D05, X01 | Authorized; none started |

External evidence cited in this document comes from two surveys run on 2026-10-17; their references are
listed in the primer's reading list. Vendor-run numbers are marked as such.

## 1. Decision summary

1. **The report is the fundamental mission output.** Every other product of a mission (entities, facts,
   events, content, embeddings, verification inputs, downstream handoffs) is a *derivation* of a report,
   with lineage back to it. A report catalogue (section 2.1) is a taxonomy of research types; each kind
   declares its obligation template, its assertion kinds and its allowed derivations.
2. **Reports never ingest directly.** Entity ingestion is always a transformation: report assertions bind
   to verified claims, claims bind to ingestion proposals, proposals are planned and applied under the
   existing intent contracts. When a report is authored in structured form the transformation is
   mechanical, so the agent's effort moves to authoring the report well, not to writing ingestion.
3. **Three clocks on everything.** World (valid) time, observation/publication time and knowledge
   (recorded) time are required fields on report assertions, chunks, projections and search filters. An
   assertion without a temporal basis cannot become a fact.
4. **Preparation is a fixed stage sequence driven by profiles that are data.** The agent chooses a
   profile, proposes deviations, and nominates promotion candidates. It never chooses the embedding
   model, dimensions, chunker version or projection procedure: those form an *index generation*, which
   is a governed artifact.
5. **Multi-representation indexing with a single return unit.** Raw chunks, contextualised chunks,
   summaries, verified claims and entity profiles are all searchable; what is returned and cited is
   always a chunk span or node with reconstructable locators.
6. **Promotion is budgeted and tiered.** Register everything that was captured; prepare what a mission
   obligation or a query needs; index what passes relevance, novelty and authority checks; canonicalise
   only verified claims. The corpus-overlap check runs before preparation, not after.
7. **Retrieval strategies are versioned profiles bound to index generations**, promoted champion versus
   challenger per domain and per route, and consumed by service agents and the web application only
   through the knowledge facade. A change to either the index generation or the profile invalidates
   the champion for that pair.
8. **One engine for both domains.** The difference is the store adapter, the rubric and the current
   maturity. Biotech lacks a document and summary layer and has vector search disabled; those are
   Q01/Q03 decisions, not a different pipeline.
9. **No number in this document is measured.** Every threshold is a placeholder until the evaluation
   program in section 6 has run on the canonical executor with real embeddings.

## 2. The output chain: mission → report → derivations

### 2.1 Report catalogue

A report kind is a named research type with an obligation template (what a complete report of this kind
must contain), dominant assertion kinds, required time fields and allowed derivations. It is the unit
that Mission Control requests and that the obligation ledger of the research loop is instantiated from.
The Biotech `d10.evidence-report@1` skeleton is the first instance; the catalogue generalises it.

| Kind | Primary question | Obligation template (minimum) | Dominant assertion kinds | Derivations allowed | Time fields required |
| --- | --- | --- | --- | --- | --- |
| Evidence report | Is proposition P supported? | Claim under test, interests, evidence for, evidence against, verdict, harms, open questions (`d10.evidence-report@1`) | Claim, qualification, contradiction | Claims and support sets; entity facts only for verified claims; content | As-of, each claim's validity and observation time |
| Entity dossier | What is X? (company, drug, tool, model, person) | Identity and identifiers, status, relationships, timeline, sources, conflicts | Fact state, relationship, identifier | Entities, aliases, identifiers, facts, events, entity profile projection | Validity per fact, status as-of |
| Landscape survey | What exists in area A? | Scope, inclusion rule, inventory with identifiers, grouping, gaps, counts with denominators | Entity existence, classification | Entities, relationships, `candidate.stage` for unresolved | Snapshot date, per-item status date |
| Comparison | How do X and Y compare on C? | Criteria, measurement sources, denominators, caveats, verdict per criterion | Metric observation, comparison | Metric observations, relationships (compares), content | Observation time per metric |
| Timeline | What happened to X between T1 and T2? | Events with dates, precision, sources, ordering, gaps | Event, extent | Events and occurrences, entity timeline projection | Occurrence interval, precision, basis |
| Monitoring delta | What changed since the last run? | Prior report reference, changes, superseded assertions, new sources | Supersession, revalidation | Revalidation events, superseding segments | Knowledge sequence of prior run, change observation time |
| Study appraisal (Biotech) | What does study S show and for whom? | Design, population, intervention, comparator, endpoints, effect, uncertainty, applicability, retraction status | Claim with scientific qualifiers | Claims, trial and publication entities, content | Publication date, data cut-off, registry status date |
| Implementation note (AI Engineer) | How do I do T with tool U? | Versions, config, steps, runnable example, test receipt, failure modes | Procedure, capability | Tool capability projections, implementation examples, content | Version date, verified-at |
| Filing digest (finance, regulatory) | What does filing F state? | Filing identity, sections, extracted figures with locators, material changes | Fact state, metric, event | Entity facts, events, content | Period of report, filing date, as-of |
| Source vetting | Is source S fit for use? | Identity, authority, independence, licence, capture fidelity, revisit policy | Authority observation | Source registry entries, revisit schedules | First seen, last seen, next revisit |

The catalogue is a pinned data artifact under the Knowledge Services catalog, versioned like capability
profiles. Domain skills contribute kinds; Knowledge Services owns the envelope.

### 2.2 Report structure

One envelope for every kind, carried by the existing `report_register` structure and mapped onto the
domain stores:

| Envelope element | Content | AI Engineer | Biotech |
| --- | --- | --- | --- |
| Identity and lineage | report id, version, kind, mission and attempt refs, authoring mode (`incremental` or `post_research`), supersedes | `research.research_bundle`, report version | `Report` with `supersedesUid`, `WAS_GENERATED_BY` Activity |
| Question and scope | the question, inclusion rules, jurisdiction, population, period | `research.report_question` | `Report.queryDigest`, scope fields |
| Clocks | `asOf` (world), `knowledgeHead` (recorded), run start and end | report `asOf`, `knowledge_seq` | `recordedAt`, `publishedAt`, `view{recordedAsOf, validAt}` |
| Sections | ordered sections with text, each section a node with offsets | report nodes | `ReportItem` SECTION |
| Assertions | UTF-16 spans with `statement_kind`, proposition, derivation, temporal basis | `research.report_assertion` | `Assertion` occurrences via `OCCURS_IN` |
| Support | assertion → claim bindings with role (supports, context, caveat, contradicts, premise) and support sets | `research.report_assertion_claim`, `report_claim` | `DERIVED_FROM` Assertions and Assessments, `HAS_EVIDENCE` locators |
| Census | obligation ledger state, unsupported-assertion count, coverage | `report_assessment` | `citationCompleteness`, `ledgerDigest` |
| Derivation proposals | typed list of proposed derivations (section 2.3), each with a report binding | `research.finding` with `proposed_record_kind`, `report_ingestion_link` | `report.publish` plus a follow-on intent whose basis cites the report snapshot |
| Open questions and next runs | questions, revisit triggers | `downstream_handoff` | `Report` open-question items |

Two additions to the current `report_register` schema are needed: an explicit `derivations[]` block with
per-item bindings, and a `timeCoverage` block (the world period the report speaks about, the observation
window of its sources, and the knowledge head it was written against).

### 2.3 Derivation paths

| Derivation | Trigger | Mechanism | Lineage |
| --- | --- | --- | --- |
| Verification inputs | always | assertions and support sets become `VerificationTaskContract` obligations and `SupportSet` records (verification proposal §4.1) | report → run |
| Entity ingestion | assertion bound to an admitted claim with a resolved subject and temporal basis | `knowledge-ingestion-intent.v1` (AI Engineer) or `biotech-knowledge-intent.v2` proposals with `reportBinding {reportVersionId, assertionKey}`; plan → apply → receipt; `report_ingestion_link` outcome | report → intent → plan → receipt → records |
| Content ingestion of the report itself | report kind allows it and the report is admitted | the report is registered as a document (kind `report`), converted, structured, chunked, summarised; its chunks link to its claims through `chunk.claim.link` | report → document version → chunk set |
| Content ingestion of cited sources | promotion ladder (section 3.6) | captured sources already registered become candidates for preparation and indexing | capture → representation → chunk set |
| Embeddings | promotion decision | projection targets: verified claims, summaries, entity profiles, sections; vector items carry `knowledge_seq`, `valid_during`, `freshness_at` | chunk set → projection → embedding run → space publication |
| Content links | after entity ingestion | `document.entity.link`, `chunk.entity.link`, `chunk.claim.link`, `chunk.relationship.link` | content-link intent → ledger |
| Downstream handoff | report kind | `research.downstream_handoff` targets curriculum, challenge, retrieval, ranking, publication | report → handoff |

### 2.4 Directly or after a transformation

After a transformation, always, and the transformation is the existing intent → plan → apply → receipt
path. The reasons are structural, not procedural:

- The ingestion planner needs a snapshot, an expected knowledge head and identity resolution. A report
  does not carry those; the intent does.
- Entity facts are bitemporal. A report assertion has a text span and a derivation; the fact needs
  `valid_during`, an extent with precision, a temporal basis and a knowledge batch. The transformation is
  where those are made explicit, and where an assertion with `temporalBasis: unresolved` is stopped.
- Identity resolution is risk-routed. Matches above the score threshold go to `staging.candidate` and
  `review_required`; the report cannot pre-empt that.
- Biotech has no distributed transaction; `report.publish` writes the `Report` node and a separate
  intent cites the report snapshot as `basis.snapshotRef`.

What changes with this proposal is *where the structure is created*. Reports are authored in
structured form from the start: every assertion has a span, a statement kind, a temporal basis and a
claim binding at authoring time. The transformation into proposals then becomes a deterministic
compilation step (`report_derive`, a new executor operation) that the agent reviews rather than writes.
The agent still owns subject resolution choices and the decision to hold or stage.

### 2.5 Time

Four clocks, three of which are stored:

| Clock | Meaning | AI Engineer | Biotech | Search field |
| --- | --- | --- | --- | --- |
| World (valid) time | when the fact was true | `temporal.segment.valid_during`, `extent{precision, earliest, latest}`, `temporal_basis`; `vector_item.valid_during` | `Assertion.validFrom`/`validTo` with precision and basis | `p_as_of`, `p_world_at`/`from`/`to`; `worldScope` in the retrieval plan |
| Observation and publication time | when the source observed or published it | `document_version.published_at`, `effective_from`; `source_capture.captured_at`; `vector_item.freshness_at` | `SourceSnapshot.observedAt`, `publishedAt`, `retrievedAt`; `Chunk.publishedAt` | `freshness_after` (built), `effectiveBefore`/`observedBefore` (declared, not built) |
| Knowledge (recorded) time | when the platform learned it | `k_from`/`k_to`, `knowledge_seq`, `temporal.knowledge_head` | `recordedAt`/`recordedTo`, `recordedFrom`/`recordedTo` on edges | `p_knowledge_seq`, `knowledgeScope.atKnowledgeSeq`; `view.recordedAsOf` |
| Run time | when the mission ran | report `asOf` and run timestamps | `Activity.startedAt`/`endedAt` | not a search field; reported in the packet's `queryClock` |

Rules that follow:

- A report declares `timeCoverage` and every assertion carries a temporal basis. `unresolved` is a legal
  value and blocks fact derivation, not report completion.
- Chunks and projections carry `valid_during` where the content speaks about a period (a trial result,
  a filing period) and `freshness_at` from the source clock. Where content has no world period, only
  the source clock is set. This is what makes "as of" and "latest" questions filterable at the search
  layer without reading documents.
- The web application exposes three filters, not one date picker: *valid at* (world), *published
  after/before* (source), and *as known at* (knowledge). The default is latest knowledge, no world
  filter, no source filter.
- Neo4j vector and full-text indexes must declare the temporal properties at index creation so that
  temporal predicates run in-index; otherwise filtered recall collapses on selective filters.
- A monitoring-delta report is the knowledge-time query `what_changed(k1, k2)` rendered as a report
  kind; it is how revalidation (V12) becomes visible to users.

## 3. Preparation and ingestion

### 3.1 Stage sequence

| Stage | What it does | As built | Required delta |
| --- | --- | --- | --- |
| 0 Register | source and capture rows, sealed bytes, identity receipt | `capture` activity: acquire → seal; `evidence.source`, `source_capture`, `orchestration.artifact` | none; Biotech equivalent is `SourceSnapshot` |
| 1 Inspect | media type, size, language, page count, text coverage, content class, duplicates, PHI and licence flags | `readSealedCapture`, `observeSealedCapture`; `conversion_evaluation` after conversion | an inspection record *before* conversion that drives the provider ladder and the promotion tier; Jev classifies content class and risk (section 3.8) |
| 2 Convert | bytes → provider-native output with page, bbox and character provenance | router deterministic → Docling → Unstructured, fallback on error or coverage < 0.5; Docling JSON stored but nodes rebuilt from Markdown | adopt Docling JSON provenance (`prov[{page_no, bbox, charspan}]`) as the node source; add an OCR/VLM tier for scans; register parsers in the D11 registry format with readiness scores; keep every converter's output normalised to `document_node` with page, bbox and offsets |
| 3 Structure | node tree with digests and locators | `structural-document.ts`; nine node kinds; acyclic tree; `document_node_edge` kinds exist in the schema | emit node edges (caption, footnote, cross_reference, same_table) from provider structure; tables kept atomic with HTML in `selector` |
| 4 Chunk | deterministic slicing under a profile | seven profiles; heading-bounded, token budget, boilerplate removal; QA requires span reconstruction | implement or remove `overlapTokens`; persist `parent_chunk_id` and `chunk_edge` (declared, unused); page-level profile for scanned documents |
| 5 Contextualise | text that situates the chunk for the embedder and the lexical index | `contextualHeadingPrefix` (nearest heading) exists; the governed path blanks it | keep the heading path on the governed path; add an optional LLM-written situating sentence as a *separate* representation (`contextual_prefix`), never altering `source_text`; cheap to produce with prompt caching |
| 6 Summarise | document and section summaries | `summary.materialize` with literal-of-admitted-claims text only | two summary classes (section 3.4) |
| 7 Extract and link | entity and relation candidates grounded to canonical ids | none; links only by explicit content-link intents | three-tier pipeline producing content-link proposals and `candidate.stage` (section 3.5) |
| 8 Project | searchable text per target (chunk, claim, summary, entity profile) | `search_projection` with `source_text`, `contextual_prefix`, `embedding_text`, `effective_during` | multi-representation per target; projection procedure versioned in the index generation |
| 9 Embed | vectors under a vector-space version | AI Gateway `text-embedding-3-small`, 1536, `halfvec`; receipts; cost budget | per-generation model and dimensions (section 4.2); batch and cache keyed on generation plus text digest (exists in memory only) |
| 10 Index and publish | HNSW per partition; publication pointer with manifests, evaluation and sample search | coordinator with rollback and reconcile | unchanged; add index-generation identity to the publication record |
| 11 Link back | what each search hit can cite | `chunk_span` → node → locator; `summary_evidence` RPC | unchanged; Biotech needs `Chunk → SourceLocator` served (today derived only) |

### 3.2 Provider ladder

The principle stays: external providers that do the job well, internal implementations as fallbacks,
every attempt sealed in a routing receipt. The ladder becomes a registry (D11 format: kind, access,
readiness 0–3, output provenance, cost class) and the router selects by inspection result:

| Content class (from inspection) | First | Second | Fallback | Notes |
| --- | --- | --- | --- | --- |
| Text, Markdown, HTML with text layer | deterministic structural | Docling (HTML) | none | HTML should move from regex stripping to a DOM-based converter; the native parser already uses html5lib |
| Born-digital PDF, Office | Docling with TableFormer | Unstructured `hi_res` (managed) | deterministic over extracted text | Docling provides page, bbox and charspan per item; keep it as the node source |
| Scanned or image-heavy PDF | OCR tier: Mistral OCR 4 (bbox, confidence) or Docling with OCR | Unstructured `hi_res` | quarantine | OmniDocBench and olmOCR-bench rank open specialised models above general APIs; choose by the registry's readiness, not by brand |
| Tables of record (labels, certificates, financial statements) | Docling TableFormer accurate | Reducto or LlamaParse agentic (optional, paid) | quarantine | table cells must survive as HTML with row and column provenance |
| Transcripts and media | existing VTT path | transcription provider (enum exists, no provider) | none | timecode locators exist |
| Repository and code | repository adapter (library, not wired) | none | none | code symbols profile exists |

Every converter output is normalised to the same node tree, so chunking, linking and retrieval never
see a provider.

### 3.3 Chunking policy

Defaults, with the evidence that supports them:

- Structural chunking bounded by tokens stays the default. Independent evaluations favour 200–400
  token recursive chunks without overlap (Chroma) and page-level chunking for scanned and
  layout-heavy documents (NVIDIA); semantic chunking shows no consistent gain for its cost
  (NAACL Findings 2025).
- Tables are never split mid-row; a table node is a chunk or a chunk group.
- Overlap is either implemented or removed from the profiles; a declared-and-ignored field is a
  reproducibility bug.
- Parent/child chunk edges are persisted so that retrieval can search small and return big.
- Contextualisation: heading path always; an LLM situating sentence as a separate representation for
  corpora where it is evaluated to help (Anthropic reports a 35% reduction in top-20 retrieval failure
  from contextual embeddings and 49% with contextual lexical indexing; vendor-run).
- Late chunking and contextualised embeddings (Jina late chunking, Voyage context models) are
  experiments against a new index generation, not changes to the chunker.
- Propositions and atomic claims are only indexed as projections of *verified* claims, never as a
  chunking of raw text.

### 3.4 Summaries

Two classes, because the current rule ("a summary is a literal rendering of admitted claims") is right
for evidence and wrong for navigation:

| Class | Text | Admissible as evidence | Embedded | Returned to users | Links |
| --- | --- | --- | --- | --- | --- |
| `evidence_summary` | literal rendering of admitted claims with qualifiers (`content-summary-literal.v1`) | yes, as `derived_summary` sharing the diversity group of its sources | yes (`document_summaries` space) | yes, with its claim bindings | `document_summary_source` rows, weights |
| `navigational_summary` | generative abstract, section summary, chunk-group summary, entity-centric view | never; same rule as Biotech `summaryText` | yes | only as a pointer to the chunks it covers | `document_summary_source` rows with coverage ratio; retrieval expands to source chunks |

This is the document-summary-index pattern: search the summary, return the chunks. A recursive summary
tree (RAPTOR) is an experiment on top of the navigational class, with the same rule that a summary node
is never cited.

### 3.5 Entity extraction and linking

Three tiers, and an absolute rule: a language model never emits a canonical identifier from memory.
Reviews of biomedical ontology use document that models fail to map terms to HPO, GO or gene
identifiers; identifiers come from linkers and from the schema workspace.

| Tier | Method | Output | Cost class |
| --- | --- | --- | --- |
| 1 Candidate generation | GLiNER2 or scispaCy for spans with character offsets; PubTator 3 precomputed annotations for PubMed-indexed documents; regex for identifier schemes already in the registry (DOI, NCT, PMID, CIK, HGNC, CAS, package names, model ids) | mention candidates with offsets and types | cheap, local |
| 2 Grounding | dictionary and dense linkers (SapBERT-class) to the canonical vocabularies; `schema_search` and bounded reads to find existing entities, aliases and identifiers; score threshold | grounded candidates with confidence, or `candidate.stage` | cheap to moderate |
| 3 Judgement | LLM only for ambiguous mentions, relation typing against the allowed predicate list, and schema validation; Jev for bounded classification (mention type, is-about versus mentions) | `content-link-intent.v1` proposals; `relationship.assert` proposals for verified relations | expensive, bounded |

Outputs are proposals, never writes. High-confidence links that cite an admitted claim apply through
the existing ledger; everything else routes to review by the same risk table the verification proposal
uses. Entity resolution merges run only on staged candidates, never on canonical rows.

### 3.6 The promotion ladder

"We cannot ingest and embed everything" becomes four tiers with explicit triggers and budgets:

| Tier | Name | What happens | Trigger | Who decides | Budget unit |
| --- | --- | --- | --- | --- | --- |
| R0 | Registered | capture sealed, inspection record, identifiers, overlap check | every capture | automatic | bytes stored |
| R1 | Prepared | converted, structured, chunked, heading-contextualised, lexical index | a mission obligation cites the capture, or a query demands it, or the source is in an authority register | agent proposes, policy admits | converter cost, chunk count |
| R2 | Indexed | summaries, LLM contextualisation, projections, embeddings, publication | relevance to an admitted question, novelty against the corpus, authority, licence allows embedding | agent proposes with the overlap report; promotion decision by reviewer (exists); automatic for noncritical profiles after section 6 gates | embedding tokens, summary calls |
| R3 | Canonicalised | entities, facts, events, relationships written to the domain store | verified claims only (verification proposal §2) | ingestion plan; review for `review_required`; human for scientific automatic promotion | review time |

The overlap check at R0 answers "what do we already have exactly or related to this". It is a bounded
read of identifiers and a hybrid search of the existing corpus with the capture's title, abstract and
identifiers, recorded as a `corpus_overlap` record on the inspection: exact duplicate (same content
hash), same work (same DOI or registry id, different rendition), related (hits above threshold), new.
Exact duplicates stop at R0; same-work renditions attach to the existing source family; related items
carry the hit list into the promotion proposal so the reviewer sees what the new item adds.

### 3.7 Worked scenario: a long trial case study

1. The agent finds, downloads and seals the PDF. Inspection: born-digital PDF, 84 pages, text layer
   present, tables detected, DOI and NCT number found, licence permits text mining. Overlap check: the
   NCT trial exists as an entity; the publication does not; two related chunks from a review article
   mention the trial. Result: `same_work: none`, `related: 2`, tier proposal R1.
2. Conversion routes to Docling; TableFormer extracts the baseline and outcome tables; nodes carry page
   and bbox; a `conversion_evaluation` grades coverage; a review subject is opened for the reviewer.
3. Chunking under `heading-sections-v1` with parent edges; tables are atomic chunks; the heading path
   becomes the contextual prefix. Lexical indexing is immediate.
4. The research obligation ledger cites three sections (primary endpoint, adverse events, population).
   The agent authors a study appraisal report; each assertion has a span, a temporal basis (data
   cut-off date from the paper; publication date), and a claim binding; verification runs under the
   scientific rubric.
5. Promotion proposal to R2 cites the admitted question, the overlap report and the licence. A
   navigational summary per section and one evidence summary of the admitted claims are produced; the
   proposal lists projection targets: 12 section chunks, 2 summaries, 4 verified claims. The reviewer
   accepts; the embedding run executes under the current index generation; publication moves the
   pointer.
6. Entity linking: candidates for the drug, the condition, the sponsor and the endpoints are grounded
   through the linker and the schema workspace; the sponsor is an existing entity; the endpoint names
   stage as candidates. Content links apply for the grounded ones.
7. `report_derive` compiles the appraisal into an ingestion intent: a `fact.assert_state` for the
   primary endpoint result with `valid_during` from the trial period, `event.assert` for the
   publication, `relationship.assert` (trial studies drug, trial sponsored by). The plan holds the
   endpoint facts behind the staged candidates; the rest applies; the receipt links back through
   `report_ingestion_link`.
8. In Biotech the same run ends with `report.publish` creating a `Report` with `DERIVED_FROM`
   Assertions and a separate `biotech-knowledge-intent.v2` whose basis is the report snapshot; the
   `Chunk` projection is rebuilt by the projection job; full-text search serves it; vector search waits
   on Q03.

### 3.8 How much freedom the agent has

| Decision | Who decides | Bound | Recorded where |
| --- | --- | --- | --- |
| Which capture to prepare | agent | promotion tier triggers and budget | promotion proposal |
| Conversion provider | router from inspection | registry readiness and policy (`managedProcessingAllowed`) | routing receipt |
| Chunking profile | agent selects from the catalogue; Jev may classify content class to suggest one | profile set; no ad hoc parameters | chunk set `frozen_config` |
| Deviation from a profile | agent proposes a new profile version | must be reviewed and pinned before use | profile catalogue |
| Which chunks and claims to project | agent in the promotion proposal | selection eligibility policy | `search_projection`, proposal |
| Summaries to write | agent | class rules (section 3.4) | summary rows with sources |
| Entity links | pipeline proposes, agent reviews the ambiguous tier | confidence thresholds, allowed predicates | content-link ledger |
| Embedding model, dimensions, tokenizer, projection procedure | nobody at run time; index generation owner | governed artifact | vector space version |
| Which retrieval profile to use in a mission | the route (Direct, Fast, Explore, Research) selects the champion; Research may use challengers | profile status | evidence packet `procedureVersionIds` |
| Publication | control plane only | ADR 0003 checks | publication events |

Jev's places here: content-class and risk classification at inspection, profile suggestion, promotion
tier triage, review routing of entity-link candidates, and query-class classification for retrieval
routing (section 5.5). All under the same calibration discipline as the verification proposal: advisory
until V09 labels exist.

## 4. Storage model and index generations

### 4.1 Common content model and its two projections

| Concept (KS contracts) | AI Engineer (PostgreSQL) | Biotech (Neo4j, v2.0.2) | Gap |
| --- | --- | --- | --- |
| Source, capture | `evidence.source`, `source_capture` | `Source`, `SourceSnapshot` | none |
| Document, version | `content.document`, `document_version` (`published_at`, `effective_from`) | none; `MediaWork` and `Publication` group sources | Biotech needs either a `Document` label or a documented rule that `SourceSnapshot` plus `MediaWork` is the document (Q01) |
| Representation | `document_representation` (six classes, `acceptance_state`) | `Chunk.textBasis`, `textVersionHash`, `extractorVersion` | representation identity exists only as chunk properties |
| Node | `document_node` with page, offsets, bbox, ms; `document_node_edge` | none | nodes are needed for citation of tables and figures; today locators point into snapshot text |
| Chunk | `retrieval_chunk`, `chunk_span`, `chunk_edge`, `parent_chunk_id` | `Chunk` with `chunkIndex`, offsets, `CHUNK_OF`, derived `COVERS_LOCATOR` and `MENTIONS` | no parent/child or edges in Biotech |
| Summary | `document_summary`, `document_summary_source`, `summary_evidence` RPC | none; `summaryText` properties marked never evidence | Biotech needs a summary node or a chunk role `summary` with coverage edges |
| Projection | `search_projection`, `projection_target` (one of entity, record, chunk, claim, summary) | none; domain `searchText` properties feed full-text | Biotech has no projection layer; `searchText` is the equivalent for entities |
| Vector item | `vector_item` (+`search_tsv`, filter keys, `valid_during`, `knowledge_seq`) and `vector_item_embedding_1536` partitions | `Chunk.embedding` property read by an optional index; `metric_embedding`, `mechanism_embedding` recorded | vectors not served in Biotech |
| Links | `document_about_entity`, `chunk_entity_mention`, `chunk_claim_link`, `chunk_relationship_evidence` | `MENTIONS` (derived), evidence only through `Assertion → SourceLocator` | Biotech rule "always record → SourceLocator, never document → entity" is kept; chunk links stay derived |
| Clocks | `valid_during`, `freshness_at`, `knowledge_seq` | `validFrom`/`validTo`, `publishedAt`, `recordedAt` | none; representations differ, semantics match |

### 4.2 Index generation

An index generation is the tuple that determines what a vector or lexical index means:

```
IndexGeneration {
  id, domain, store,
  conversionRegistryVersion,
  chunkingProcedureVersion, contextualizationMethod (heading | heading+llm-situating@prompt-hash),
  summaryClassesIncluded,
  projectionProcedureVersion,
  embeddingModel, dimensions, precision, normalization, tokenizer,
  lexicalConfig (tsvector config | bm25 engine, analyzer),
  temporalFilterFields,
  createdAt, supersedes
}
```

AI Engineer's `retrieval.vector_space_version` already carries most of this; the delta is to make the
chunking, contextualisation and summary-class identities part of it and to lift the hard-coded 1536
into the record (today the executor, the SQL function, the contracts and the publication evaluator all
assume 1536 `halfvec`). A new generation is a parallel build, evaluated, then switched by publication;
re-embedding policy is "build the new generation beside the old, compare under section 6, switch
eligibility, retire".

### 4.3 Model positions (not decisions)

| Use | Current generation | Candidates for the next generation | Why |
| --- | --- | --- | --- |
| General text, both domains | `text-embedding-3-small`, 1536 | Voyage 4 family (32k context, Matryoshka 256–2048), Gemini embedding (3072, Matryoshka), Qwen3-Embedding self-hosted (Apache-2.0) | longer context for section-level chunks; truncatable dimensions reduce index cost |
| Biotech paper-level and concept similarity | none | SPECTER2 (paper), MedCPT (PubMed query-article), BioLORD (concept) as additional spaces | domain models for paper-level similarity and concept matching; keep the general model for chunks |
| Code and tool docs (AI Engineer) | general | voyage-code or Codestral embed as a code space | code-specialised |
| Visual documents (labels, slides) | none | ColPali/ColQwen class as a reranker over a visual space | pgvector has no MaxSim; late interaction stays second stage |
| Reranking | deterministic overlap reranker in evaluation | Cohere Rerank 4, Voyage rerank-3, Jina reranker v3/v3.5 (listwise) | evaluated per query class, never over the corpus |

Dimensions policy: `halfvec` always; binary quantisation only with exact-distance rerank; `vector` type
indexing is limited to 2,000 dimensions, so 3,072-dimension models require `halfvec` or truncation.

### 4.4 Time on index rows

AI Engineer already has `valid_during`, `freshness_at` and `knowledge_seq` on `vector_item` with GiST
and btree indexes. Biotech should put `validFrom`, `validTo`, `publishedAt` and `recordedAt` on `Chunk`
and declare them in the vector index `WITH [...]` list so temporal predicates run in-index. The hybrid
SQL function already supports `p_as_of`, `p_knowledge_seq` and `freshness_after`; `effectiveBefore` and
`observedBefore` are declared in the plan schema and not built, which is the first retrieval delta.

## 5. Retrieval strategies and their promotion

### 5.1 Building blocks

| Block | What it does | Evidence position | Status here |
| --- | --- | --- | --- |
| Exact and trigram | identifiers, names, typos | wins on NCT, DOI, CVE, gene symbols, function names | built |
| Lexical (tsvector) | term matching | BM25-class scoring is stronger than `ts_rank_cd`; ParadeDB `pg_search` or Timescale text search are options | tsvector built; BM25 not |
| Dense | paraphrase, concepts | required for non-lexical questions; single-vector has a proven theoretical ceiling (LIMIT, ICLR 2026) | built, 1536 only |
| Fusion | merge channels | RRF needs no normalisation; weighted RRF or convex fusion wins when a labelled set exists (Bruch et al. 2023) | plain RRF in SQL; weights only in the in-memory pipeline |
| Rerank | rescore the fused top 50–200 | consistent gains; listwise rerankers strongest on reasoning queries | interface exists; only a deterministic reranker |
| Parent and summary expansion | search small, return big; search summary, return chunks | long-context studies favour fewer, larger units (top 5–10) | parent ids unused; `summary_evidence` RPC exists |
| Graph expansion | entity neighbours, claim support paths | helps multi-hop and corpus-level synthesis, not simple lookup (GraphRAG-Bench, HippoRAG 2) | unsupported in the canonical executor; Biotech has Cypher templates |
| Temporal filter and decay | as-of, latest, period | hard filters for as-of; decay only for "latest guidance" intents | `freshness_after`, `p_as_of`, `knowledge_seq` built |
| Query rewriting, multi-query, HyDE | better recall on vague questions | gains in domain-shifted settings; cost per query | subquery split by heuristics only |
| Agentic iteration | the agent searches, reads, searches again | keyword-only agents reach most of vector-RAG quality on small corpora; collapses on large corpora | the executor is already a tool; needs per-call logging |
| Long-context fallback | pass whole documents | wins on stable corpora under a few hundred thousand tokens; hallucination rises past 64k for most models | not a retrieval block; a route decision |

### 5.2 RetrievalProfile as a versioned artifact

```yaml
retrievalProfile: aie-engineering-fast@3
domain: ai_engineer
route: fast                       # direct | fast | explore | research
indexGenerations: [aie-gen-2]     # the profile is only valid against these
channels:
  exact: {enabled: true, weight: 2.0}
  trigram: {enabled: true, weight: 0.2}
  lexical: {enabled: true, weight: 1.0, engine: tsvector}
  dense: {enabled: true, weight: 1.0, spaces: [engineering_claims, source_native_sections]}
  graph: {enabled: false}
fusion: {type: weighted_rrf, k: 60}
candidateK: 100
rerank: {enabled: false}
expansion: {parent: true, summaryToChunks: true, graphHops: 0}
temporal: {mode: latest, decayHalfLifeDays: null}
filtersAllowed: [language, visibility, classification, source_kind, authority_level, freshness_after, valid_at]
abstention: {minimumCoverage: 0.5, minimumEvidenceScore: 0.2}
diversity: {maxPerSource: 3}
status: champion                  # experimental | candidate | champion | rollback | retired
evaluatedAgainst: [dataset:aie-heldout-v4@sha, experiment:exp-2026-10-20-03]
```

This is the existing `retrieval_policy_version` JSONB plus what it lacks: channel weights and stage
toggles in the runtime schema (they exist only in the in-memory `RetrievalPolicy`), the index-generation
binding, the route, the status and the evaluation references. `catalog/capability-profiles.v1.json`
already defines `retrieval.hybrid-rrf@1.0.0`; profiles live there and the runtime resolves them by
digest.

### 5.3 The coupling rule

The ingestion strategy determines the retrieval strategy because the retrieval unit, the text the
embedder saw, the lexical analyzer and the filter keys are all fixed by the index generation. Therefore:

- A profile declares the index generations it was evaluated against and is invalid for any other.
- An experiment is a cell in the matrix (index generation × retrieval profile × query class × dataset
  version). Changing the chunker or the embedding model creates a new generation and re-runs the
  matrix for the champion before the switch.
- The evidence packet records both identities (`procedureVersionIds` plus the generation), so any
  answer can be replayed against the exact configuration that produced it.

### 5.4 Promotion ladder for strategies

| Status | Who may use it | Entry condition | Exit |
| --- | --- | --- | --- |
| experimental | evaluation runs only | declared in an experiment | measured |
| candidate | Research route missions, explicitly labelled in the packet | passes hard gates on the dataset | promoted or retired |
| champion | Direct, Fast and Explore routes; service agents; web application | beats the current champion per query class on the fixed dataset with non-overlapping bootstrap intervals, passes quality and regression gates, passes an online interleaving or agent accept/discard comparison where traffic exists | superseded (previous champion becomes rollback) |
| rollback | control plane on regression | the last champion | retired after one further promotion |

Gates reuse `evaluatePromotionGate` as defined: hard (zero false acceptances, citation correctness 1.0,
every domain and query class present), quality (per-metric minimums, p95 latency, cost), regression
(overall and per-domain decline against the champion, not against itself as the broad corpus does
today). An answer-level faithfulness floor is added for routes that generate answers.

Service agents and the web application never name a profile; the knowledge facade
(`DOMAIN-SURFACES.md` §3 and §4) resolves the champion for the route and derives tenant, visibility and
entitlement filters server-side. The web application's filter, semantic and hybrid toggles are
restrictions of the champion (filters only; lexical only; full hybrid), not separate strategies.

### 5.5 Query classes

Golden sets and gates are per query class because strategies win and lose by class:

| Class | Example | Expected winning blocks |
| --- | --- | --- |
| identifier lookup | NCT04368728; CVE-2025-1234; `torch.compile` | exact, trigram |
| entity profile | what is company X | entity profile projection, graph neighbours |
| mechanism or how-to | how does drug D act on target T; how to configure U | dense, rerank, parent expansion |
| comparison | X versus Y on endpoint E | multi-query, claims space, rerank |
| temporal as-of | status of X on 2024-03-01 | world-time filter, knowledge filter |
| latest | current guidance on G | source-time filter, decay |
| multi-hop | which trials of drugs targeting T reported E | graph expansion, claims space |
| synthesis | state of field F | summaries space, graph communities (experiment) |
| negative | question with no support in corpus | abstention |

Jev classifies the query class at the facade; the class picks the champion's variant and is stored in
the packet for evaluation by class.

### 5.6 Graph retrieval position

Graph expansion stays off the Fast route until measured. Evidence is consistent that graph-augmented
retrieval helps multi-hop and corpus-level questions and underperforms a strong dense retriever on
simple lookup. Biotech's natural path is the hybrid-Cypher pattern (vector or full-text hit on `Chunk`,
then `MENTIONS` and `HAS_EVIDENCE` expansion in one governed read artifact), which fits the existing
read-artifact policy. AI Engineer's path is the unsupported `graph` capability in the canonical executor,
backed by `chunk_entity_mention` and `chunk_claim_link`.

## 6. Evaluation program

### 6.1 Position

What exists is a credible offline library and a reviewed dataset that has never run against the
canonical executor or real embeddings, with a regression gate that compares the control against itself.
The program below is ordered so that the first measured number is produced early.

### 6.2 Golden sets

- Three sources per domain: labelled questions from real agent traces (the packets already record
  queries and accepted citations), synthetic questions generated from the corpus (entity and
  multi-hop scenarios over chunks, as RAGAS test generation does), and hard negatives (superseded
  versions, same trial other phase, near-duplicate chunks).
- Graded qrels 0–3, partitions dev/calibration/heldout with leakage audit (exists), independent review
  with distinct author and reviewer (exists).
- One dataset per domain per query class mix; dataset digest pinned in every experiment.

### 6.3 Experiment registry

An experiment is the existing `knowledge.experiment` operation with two additions: the arm
configuration is a retrieval profile digest plus an index generation id (not opaque JSON), and the
worker executes retrieval for each arm on the canonical executor instead of accepting caller-supplied
outputs. Results land as `evaluation.promotion_gate_result` rows keyed on (dataset digest, generation,
profile). A new `retrieval_profile_promotion_decision` records champion changes with the reviewer and
the gate result, mirroring `content_promotion_decision`.

### 6.4 Metrics

Retrieval: recall@k at the k passed to the generator, nDCG@10, MRR, precision@k, filter satisfaction,
abstention accuracy, citation correctness, false acceptances, p95 latency, cost. Answer level (routes
that generate): faithfulness and groundedness against the packet, context precision and recall. Judges
are calibrated against a human-labelled slice, run with position swapping, and reported with their
agreement rate, as the verification proposal requires for Jev.

### 6.5 Online signals

Agents log accept or discard per retrieved item (the packet's `coveredSubqueryIds` and the citations
actually used by the report); the web application supports team-draft interleaving between champion and
candidate. Interleaving is more sensitive than A/B testing on the same traffic and is the cheap way to
confirm an offline win.

### 6.6 Placeholder gates (not measured)

The broad-corpus gate values (recall ≥ 0.9, MRR ≥ 0.75, nDCG ≥ 0.8, citation ≥ 0.98, p95 ≤ 1500 ms)
are reused as initial placeholders for the canonical executor. They were met by an in-memory run with
deterministic vectors and prove nothing about production retrieval. The first canonical run sets the
baseline; the second run is the first comparison.

## 7. Biotech versus AI Engineer

Same stage sequence, same profiles-as-data rule, same promotion ladder, same evaluation program. The
differences:

| Element | AI Engineer | Biotech | Flow difference? |
| --- | --- | --- | --- |
| Document, representation, node, summary layer | complete | absent; `Chunk` off `SourceSnapshot` | Schema gap (Q01), not a flow difference |
| Chunk lifecycle | immutable chunk sets, superseded, promotion-gated | projection job deletes and rewrites; no recorded time | Biotech chunks are a cache; citations must go through locators, which the schema already requires |
| Vector search | served, 1536 `halfvec` partitions, hybrid SQL | recorded, not served; 1536 explicitly not adopted | Q03 decision; the index-generation record makes dimensions per generation |
| Lexical | tsvector plus trigram | Lucene full-text on `Chunk.text` and entity `searchText` | different engines, same channel |
| Graph expansion | `chunk_entity_mention`, `chunk_claim_link`, unsupported in executor | native; governed Cypher read artifacts and templates | Biotech is ahead; both route by query class |
| Entity ingestion contract | `knowledge-ingestion-intent.v1`, knowledge head, batch receipt | `biotech-knowledge-intent.v2`, snapshot basis, plan digest, admission witness | representation; same proposal semantics |
| Report derivation | `reportBinding` → `report_ingestion_link` | `report.publish` then intent with report snapshot basis | mechanism; same lineage requirement |
| Clocks | integer knowledge sequence; one belief per stream slot | timestamp recorded time; conflicting asserters side by side | representation; search semantics identical |
| Summaries | first-class with sources | `summaryText` never evidence | Biotech's rule becomes the `navigational_summary` class for both |
| Entity linking | content-link intents | derived `MENTIONS` edges; evidence only via locators | Biotech keeps the stricter rule; AI Engineer should treat `chunk_entity_mention` as navigational, not evidential |
| Agent schema surface | `search/index.json`, named queries, scoped bundles | `bks-schema` CLI with lexical/semantic/hybrid search and `slice` | equivalent; Biotech's `slice` with a token budget is the better pattern to generalise |

Verdict: one pipeline, two adapters, one gap. The gap is Biotech's missing content layer and the
unanswered embedding contract, both already owned by Q01 and Q03.

## 8. Implementation position

Ordered so that the first measured number arrives before any schema work:

| Stage | Work | Depends on |
| --- | --- | --- |
| A. Measure what exists | run the broad corpus through the canonical executor with the gateway embedder; fix the regression gate to compare against a stored baseline; add faithfulness at answer level; bind experiment arms to policy versions | R01 acceptance already asks for this |
| B. Close preparation defects | Docling JSON as node source; overlap implemented or removed; parent and chunk edges persisted; heading prefix kept on the governed path; inspection record before conversion with overlap check | D05 |
| C. Profiles and generations | runtime policy schema with weights and toggles; index-generation record; lift 1536 into the generation; retrieval-profile status and promotion decision | A |
| D. Report catalogue and derivation | catalogue artifact; `derivations[]` and `timeCoverage` on `report_register`; `report_derive` compilation into intents | V01 (obligations), C01, C02 |
| E. Summaries and linking | navigational summary class; candidate generation and grounding tiers; proposals through content-link intents | B, V03 for rubric inputs |
| F. Biotech content layer | document/summary binding and embedding contract | Q01, Q03, then N04, N05, G08 |
| G. Facade and routes | champion resolution per route; web application filters; query-class classification | R01, R02, R03, X01 |

Proposed new packet issues, to be opened by the owner (ids provisional):

- P01 Report catalogue, envelope additions and `report_derive`.
- P02 Inspection record and corpus-overlap check before conversion.
- P03 Docling structural provenance as node source; OCR tier in the converter registry.
- P04 Chunk overlap, parent and edge persistence; governed path keeps contextual prefix.
- P05 Navigational summary class and summary-to-chunk expansion in retrieval.
- P06 Entity candidate generation and grounding pipeline producing content-link proposals.
- P07 Index-generation record and per-generation dimensions.
- P08 Retrieval profile runtime schema, status and promotion decision.
- P09 Experiment execution on the canonical executor; answer-level metrics; baseline-bound regression.
- P10 Knowledge facade champion resolution and query-class routing for service agents and the web app.

## 9. What is explicitly not established

- No retrieval number has been measured on the canonical executor with real embeddings.
- No chunking, contextualisation or summary variant has been compared on this corpus; the external
  evidence cited is from other corpora and, where marked, from vendors.
- No embedding model beyond `text-embedding-3-small` has been run through the gateway here.
- No entity extraction or linking component exists; the three-tier pipeline is a design.
- Biotech's embedding contract, document binding and vector availability are open (Q01, Q03, G08).
- The knowledge facade and the service-agent contract are proposals in `DOMAIN-SURFACES.md`; the
  learner application is absent from the checkout.
- Jev's role in classification here is advisory until the calibration issues (V09) deliver labels.
- Nothing in this document has been run, committed or migrated; `ai-engineer-db-contract` remains the
  only migration authority and any schema change above goes through it.

## 10. Reading route

1. [ADR 0002](../../architecture/0002-deterministic-preparation.md) and
   [ADR 0003](../../architecture/0003-embedding-retrieval-evaluation.md) for what is accepted.
2. `knowledge/capture-conversion-and-custody.md`, `knowledge/preparation-and-publication.md`,
   `knowledge/schema-read-and-ingestion.md`, `knowledge/retrieval-and-evidence.md`,
   `knowledge/evaluation-and-publication-gates.md` for what runs.
3. [`NATIVE-RETRIEVAL-INGESTION.md`](../../specs/belllabs-knowledge-platform/NATIVE-RETRIEVAL-INGESTION.md)
   and [`DOMAIN-SURFACES.md`](../../specs/belllabs-knowledge-platform/DOMAIN-SURFACES.md) for the
   authorized direction and the facade proposal.
4. This document for the output chain, the stage table, the promotion ladders and the domain comparison.
5. The [evidence and verification proposal](../evidence-verification-system-20261017/README.md) for
   how reports feed verification and how admission reaches the stores.
6. The [primer](../../../../../docs/research/2026-10-17-ingestion-retrieval-evaluation-primer.md) for
   the concepts, the evaluation arithmetic and the reading list.
7. The [evaluation and improvement system](../evaluation-improvement-system-20261018/README.md) for
   how §6 generalises into the platform-wide quality ledger, grader registry, experiment contract,
   promotion decisions and scorecard.
8. The [datasets specification](../datasets-20261018/README.md) for the fourth derivation target:
   releases compiled from admitted assertions over a defined universe, with provenance columns,
   rights per cell, gates, datasheets and delta feeds.
9. The [content factory](../content-factory-20261018/README.md) for produced content and media:
   the form catalogue, content kind specs, the grounding map that binds published claims to
   assertions, the creative iteration loop and the content queue.
