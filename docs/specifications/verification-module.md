# Knowledge Verification Module — Implementation Specification

**Status:** Accepted design baseline; implementation acceptance remains open  
**Owner:** AI Engineer Knowledge Services  
**Target repository:** `ai-engineer-knowledge-services`  
**Canonical module:** `@aiengineer/knowledge-verification`  
**Initial contract version:** `verification.v1`  
**Last updated:** 2026-09-08  
**Audience:** coordinator agents, implementation agents, research-ingestion engineers, Cursor Cloud runtime authors, EVE authors, Mission Control developers, database-contract maintainers, dashboard developers, evaluators, and security reviewers

## 1. Executive decision

Implement verification as a distinct, provider-neutral module inside AI Engineer Knowledge Services. The module is the single owner of reusable data-extraction verification, evidence provenance, claim/source-attribution verification, report verification, metric verification, experiment execution, and replay logic.

The module must be callable in four ways without creating four implementations:

1. direct application-layer invocation by first-party Knowledge Services transports and workers;
2. versioned HTTP through `apps/api` for EVE and other service codebases;
3. a machine-readable CLI through `apps/cli` for Cursor Cloud Agents and operators;
4. bounded MCP tools through `apps/mcp` for agent frameworks that benefit from tool discovery.

The implementation is not a general research agent and is not a confidence-scoring prompt. It is an independent evidence compiler and policy-controlled verification service. Large-language-model judgment is only one bounded stage after deterministic checks.

Interfaze is included as an experimental perception and structured-extraction provider. It must never be the sole verifier of its own output. Its raw response, `precontext`, geometry, confidence, usage, and provider identifiers must be captured and translated into provider-neutral evidence records before verification.

## 2. Context and current-state findings

This section records the 2026-09-04 migration baseline. Current implementation and runtime evidence are tracked in the [workspace status](../workspaces/verification-module/STATUS.md) and [acceptance matrix](../workspaces/verification-module/ACCEPTANCE-MATRIX.md); the baseline descriptions below are not current capability claims.

This specification consolidates and relocates a substantial existing prototype rather than proposing a greenfield system.

Current reusable assets in `research_ingestion_systems_agent` include:

- versioned Zod contracts for captures, locators, claims, metrics, bundles, and results;
- SHA-256, exact-quote, normalized-quote, offset, JSON Pointer, identity, period, arithmetic, and deployment-independence checks;
- an EVE semantic verifier with a deliberately restricted tool surface;
- provider-matrix eval fixtures;
- source-attribution and entity/metric research probes;
- an Interfaze lab with strict JSON Schema validation, output/precontext hashes, usage, latency, cache, and ZDR controls.

Current reusable assets outside that repository include:

- canonical mission, work-item, attempt, artifact, source-capture, locator, claim, evidence, verification, and evaluation schemas in `ai-engineer-db-contract`;
- immutable artifact/capture workflows and a separate `verify_extraction` work item in the Cursor Cloud repository;
- a developed Knowledge Services monorepo with 23 current workspace packages/apps, including acquisition, conversion, documents, chunking, embeddings, retrieval, evaluation, projections, persistence, policy, runtime, observability, vector backends, a TypeScript client, testkit, and independently deployed API/MCP/CLI/worker processes;
- a dashboard pattern that reads through server route handlers and TanStack Query, while explicitly avoiding direct pipeline-completion mutation;
- a Mission Control repository with appropriate conceptual boundaries but currently skeletal execution behavior.

The migration must preserve the existing verification invariants while making Knowledge Services the authoritative runtime and module owner. During transition, compatibility adapters may remain in `research_ingestion_systems_agent`, but there must be one implementation of each algorithm.

## 3. Goals

### 3.1 Functional goals

The module must:

- verify structured extraction from text, HTML, JSON/API responses, PDFs, images, tables, repositories, transcripts, audio, and video;
- preserve and replay exact source provenance;
- map every accepted extracted field and externally verifiable report claim to one or more precise evidence fragments;
- distinguish source-pointer validity, semantic support, real-world correctness, attribution faithfulness, source authority, and provenance integrity;
- verify identities, metrics, units, periods, formulas, derived values, and comparability;
- support explicit abstention, review, repair, rejection, and policy admission;
- compare extractor, parser, retriever, judge, and policy variants through frozen, versioned benchmarks;
- support Interfaze and additional providers through adapters;
- produce portable, content-addressed audit bundles;
- run identically from local development, Cursor Cloud, EVE, workers, HTTP, CLI, and MCP;
- expose enough structured data for the Agents Dashboard to inspect experiments and evidence chains.

### 3.2 Quality goals

The module must be:

- fail-closed on broken or ambiguous provenance;
- deterministic for mechanically decidable checks;
- independently verifiable at the deployment level;
- idempotent and resumable;
- tenant-isolated;
- auditable without private chain-of-thought;
- statistically defensible as a benchmark harness;
- provider-neutral and version-aware;
- secure against hostile documents, prompt injection, SSRF, oversized content, schema abuse, and secret leakage.

### 3.3 Organizational goals

- Knowledge Services owns verification behavior and provider adapters.
- The database-contract repository owns persistence schemas, migrations, generated database types, RLS, and Storage policies.
- Mission Control owns cross-service orchestration, authorization, scheduling, retries, cancellation, and reconciliation.
- Cursor Cloud and EVE consume contracts; they do not fork algorithms.
- Agents Dashboard displays and controls runs through supported service APIs; it does not become an execution engine.

## 4. Non-goals

The initial module will not:

- claim to prove universal truth from a single source;
- use model confidence as an admission decision by itself;
- persist hidden model chain-of-thought as verification evidence;
- permit a producer deployment to independently verify itself;
- replace source discovery or full report synthesis;
- make provider-specific response shapes part of the public contract;
- create a new database schema local to Knowledge Services;
- create a Storage bucket per experiment;
- allow MCP or the dashboard to bypass application policy;
- automatically publish or rank content merely because verification completed.

## 5. Governing verification model

### 5.1 Five ordered questions

For every candidate result, evaluate in this order:

1. **Capture integrity:** were the exact source bytes or canonical representation preserved?
2. **Selector integrity:** does the stored locator deterministically select the claimed evidence?
3. **Mechanical correctness:** do identity, type, value, unit, period, normalization, and arithmetic checks pass?
4. **Semantic support:** does the selected evidence support the complete atomic claim?
5. **Policy admission:** does the risk- and use-case-specific policy permit publication, ranking, or downstream use?

Later stages may add restrictions but may not reverse an earlier deterministic failure.

### 5.2 Orthogonal properties

Store and report these independently:

| Property | Question | Example failure |
| --- | --- | --- |
| Evidence support | Does this evidence entail the claim? | Citation is topically related but omits the date or qualifier. |
| World correctness | Is the claim true under authoritative/corroborated evidence? | A captured company page supports a self-reported but false assertion. |
| Attribution faithfulness | Did the cited input influence production of the claim? | Post-hoc citation is attached to an answer generated from memory. |
| Source authority | Is this source fit for this kind of claim? | A blog supports a legal proposition that policy requires a statute to support. |
| Provenance integrity | Can the artifact and execution chain be authenticated and replayed? | URL exists, but the historical bytes and model configuration were not retained. |

No aggregate score may erase the component results.

### 5.3 Verdict lattice

Semantic and policy states must include at least:

- `directly_supported`;
- `supported_with_qualification`;
- `partially_supported`;
- `context_only`;
- `contradicted`;
- `mixed_or_conflicting`;
- `not_supported`;
- `insufficient_evidence`;
- `unverifiable`;
- `source_unavailable`;
- `locator_error`;
- `parser_error`;
- `derived_verified`;
- `derived_failed`.

Policy outcomes are separately represented as `pass`, `pass_with_warnings`, `review`, `fail`, or `abstain`.

## 6. Architecture

### 6.1 Logical pipeline

```text
producer output / extraction request
  -> declared verification intent
  -> source acquisition or trusted capture hydration
  -> immutable artifact registration
  -> parsing and canonical representation
  -> candidate extraction / claim atomization
  -> evidence-fragment resolution
  -> deterministic verification
  -> bounded semantic verification
  -> contradiction and authority assessment
  -> report/global consistency checks
  -> versioned policy decision
  -> audit-bundle sealing
  -> persistence and event publication
```

### 6.2 Required package topology

“Verification module” is one distinct private workspace package, `packages/verification`, in the existing Knowledge Services monorepo. It owns verification-specific algorithms, orchestration, provider conformance, benchmark/demo definitions, and the stable internal facade. It composes the repository's existing horizontal packages instead of creating duplicate extraction, evaluation, runtime, observability, or client packages.

```text
packages/
  verification/
    src/
      index.ts                 # stable module facade
      domain/                  # entities, verdict lattice, policy primitives
      selectors/               # text, JSON, HTML, PDF, table, media, repository
      claims/                  # assertion mapping and atomic-claim decomposition
      deterministic/           # pure mechanical verifiers
      authority/               # source fitness and conflict assessment
      metrics/                 # metric identity, periods, arithmetic, comparability
      provenance/              # lineage graph and audit bundles
      providers/               # verification-facing provider ports/conformance and Interfaze adapter
      experiments/             # benchmark definitions, scorers, statistics, and promotion gates
      demos/                   # diagnostics-company and future one-command demonstrations
      testing/                 # fixtures and conformance harnesses
```

The existing repository naming convention is `@aiengineer/*`; this specification settles the canonical package name as `@aiengineer/knowledge-verification`, not the older `@ai-engineer/*` spelling found in some design material.

`@aiengineer/knowledge-verification` is a private workspace package. Cross-repository consumers use the versioned HTTP contract, CLI artifact, or a separately versioned restricted client package. They must not reach into internal source paths. If offline in-process reuse is later required, publish a deliberately supported restricted package; do not make workspace-relative imports across repositories.

The public facade exports use cases and stable types, not provider SDK objects.

### 6.3 Integration with existing horizontal packages

- `packages/contracts` owns transport-visible request/response schemas and contract-version negotiation.
- `packages/domain` may re-export only genuinely service-wide primitives; verification-specific domain behavior remains in the module.
- `packages/application` composes verification use cases with persistence, authorization, queues, and other Knowledge Services capabilities.
- `packages/acquisition`, `packages/conversion`, and `packages/documents` supply captured bytes, canonical document projections, parser results, and residuals; verification binds their outputs to assertions and selectors.
- `packages/retrieval` supplies candidate evidence and retrieval traces; verification judges sufficiency, support, contradiction, and attribution without owning vector-store behavior.
- `packages/evaluation` supplies reusable dataset/run/scoring primitives. Verification owns verification-specific benchmark definitions and calls the shared evaluation machinery.
- `packages/persistence` owns database/object-store adapters, while verification owns the required provenance invariants and mappings.
- `packages/policy` supplies shared admission-policy machinery; verification owns verification verdict inputs and policy profiles.
- `packages/runtime` supplies durable operation, lease, outbox, and reconciliation primitives.
- `packages/observability` supplies shared telemetry and redaction facilities.
- `packages/client-typescript` is the supported typed client surface for EVE and other repositories; do not create a second verification-only client unless versioning requirements later demand it.
- `packages/config` validates provider, storage, database, policy, and runtime configuration.
- `packages/testkit` supplies provider fakes, deterministic clocks/IDs, fixture hydration, and conformance assertions.
- `apps/api`, `apps/mcp`, `apps/cli`, and `apps/worker` remain thin transports or runtime hosts.

This module specification is subordinate to the wider Agentic Knowledge Preparation and Retrieval Service specification already present in the workspace. Where the wider specification assigns general evidence/evaluation behavior to Knowledge Services and research-specific workflow behavior to EVE, this document provides the detailed verification implementation contract.

### 6.4 Port/adaptor boundaries

Required ports:

- `ArtifactStore`;
- `VerificationRepository`;
- `SourceAcquirer`;
- `CaptureHydrator`;
- `DocumentParser`;
- `ExtractionProvider`;
- `ClaimDecomposer`;
- `EvidenceRetriever`;
- `SemanticJudge`;
- `AuthorityResolver`;
- `HumanReviewQueue`;
- `PolicyRegistry`;
- `TelemetrySink`;
- `Clock`, `IdGenerator`, and `DigestService`.

Provider adapters implement ports and return canonical records. No domain or policy code may inspect an Interfaze/OpenAI/Anthropic-specific response directly.

## 7. Public use cases

The first stable application interface must include:

| Use case | Purpose |
| --- | --- |
| `captureSource` | Acquire or register immutable source content. |
| `parseArtifact` | Produce a canonical, locator-preserving document representation. |
| `extractStructuredData` | Extract against a versioned schema and retain candidate evidence. |
| `verifyExtraction` | Verify every extracted leaf and derivation. |
| `verifyClaims` | Verify atomic claims against selected evidence. |
| `verifyReport` | Verify claim coverage, citations, consistency, and policy admission. |
| `verifyMetricObservation` | Verify entity, metric definition, period, unit, source, and calculation. |
| `runBenchmark` | Run a frozen dataset against an experiment matrix. |
| `compareBenchmarkRuns` | Produce paired statistical comparisons and regression decisions. |
| `replayRun` | Re-run deterministic stages and optionally eligible provider stages. |
| `inspectAuditBundle` | Validate and summarize a sealed run bundle. |
| `requestAdjudication` | Create a human-review item with bounded evidence and failure context. |

Every long-running use case accepts an `OperationContext`, idempotency key, cancellation signal, and artifact-based inputs. It returns an operation receipt rather than embedding large artifacts in transport responses.

## 8. Contract model

### 8.1 Common envelope

Every command includes:

- `contractVersion`;
- `tenantId`;
- `operationId`;
- optional `missionId`, `workItemId`, and `attemptId`;
- `correlationId` and optional `causationId`;
- actor and capability version;
- idempotency key;
- request timestamp;
- data classification;
- requested policy version;
- input artifact handles and hashes.

### 8.2 Source and artifact model

Separate logical identity from immutable versions:

- `Source`: canonical logical resource, such as a URL, API object, repository file, paper, video, or uploaded document.
- `SourceVersion`/`SourceCapture`: immutable observation of the resource at a time.
- `Artifact`: content-addressed bytes or canonical JSON/JSONL/Markdown derived from a source or run.
- `Fragment`: precise selection within a source version or artifact.
- `LineageEdge`: typed derivation, usage, generation, quotation, revision, or primary-source relation.

Required artifact metadata:

- SHA-256 digest;
- byte size and media type;
- canonical object key/URI;
- content encoding;
- creation/capture time;
- producer activity and version;
- encryption/retention/data-classification class;
- parent artifacts and transformation signature;
- optional signature/attestation.

### 8.3 Selector union

Support these versioned selectors:

- exact text quote with prefix/suffix;
- character position with declared offset and normalization basis;
- ordered multi-fragment text selection for intentional omissions;
- RFC 6901 JSON Pointer;
- HTML DOM/CSS/XPath plus canonical text fallback;
- PDF page plus text-layer offsets;
- PDF/image page plus normalized or pixel bounding box;
- table ID, row/column coordinates, header path, and cell value;
- audio/video start/end timecode and optional speaker/channel;
- repository commit, path, and line/byte range;
- dataset row/column/key selector;
- API pagination and record-key selector.

Every resolved selector records occurrence count, resolved offsets/coordinates, selected-content digest, normalization policy, and resolution implementation version. Display excerpts are never selectors.

### 8.4 Extraction and assertion model

Represent both structured fields and report claims as assertions with different assertion kinds.

Each assertion records:

- stable assertion ID;
- kind: field, claim, metric, relationship, computation, or report assertion;
- typed value or proposition;
- producer attempt/deployment;
- output/report offsets where applicable;
- qualifiers and entity bindings;
- derivation type;
- zero or more evidence edges;
- verification intent;
- risk class and downstream use.

Each evidence edge records:

- source version and fragment;
- role: supports, contradicts, qualifies, or context;
- declared versus verifier-found status;
- expected and resolved selected-content hashes;
- source-authority vector;
- extraction/parser lineage;
- semantic judgment observations;
- human adjudication when present.

### 8.5 Judgment model

Judgments are append-only observations. Never overwrite a previous verdict.

Each judgment includes:

- target assertion/evidence edge;
- judge kind: deterministic, NLI, LLM, human, policy, or statistical;
- grader/version/prompt/schema hashes;
- blinded input artifact hash;
- categorical verdict;
- supporting and contradicting fragment IDs;
- unsupported facets;
- calibrated probability when available;
- public rationale;
- latency, token usage, cost, retries, and provider response ID;
- error/failure classification.

### 8.6 Run manifest

Every run manifest includes:

- dataset and dataset-version hashes;
- experiment definition and variant;
- policy, schema, grader, parser, normalizer, extractor, and prompt versions;
- code Git SHA and dirty-state declaration;
- runtime/container/platform identity;
- provider endpoint, model identifier, provider-native reasoning/configuration, and pricing snapshot;
- inputs, artifacts, stages, calls, retries, timestamps, costs, and outputs;
- random seed where meaningful;
- tool and network-access policy;
- result and gate hashes;
- ordered lineage graph;
- previous run/replay relation;
- manifest canonicalization and signature information.

Canonicalize signable JSON using RFC 8785 before hashing.

## 9. Source acquisition and parsing

### 9.1 Acquisition rules

- Only allow configured schemes and hosts.
- Resolve DNS and block private/link-local/metadata networks unless explicitly allowed.
- Bound redirects, response size, decompression ratio, time, and retries.
- Record request parameters and meaningful response headers.
- Store raw bytes before lossy conversion when licensing and policy allow.
- Treat live URLs as acquisition inputs, never as durable evidence locators.
- Model cache behavior explicitly; cached and live captures are distinguishable.
- Preserve pagination, API version, repository commit, and query lineage.

### 9.2 Canonical projections

One source version may have several projections:

- raw bytes;
- extracted native text;
- OCR tokens/lines with geometry;
- layout tree;
- HTML DOM and cleaned text;
- normalized JSON;
- rendered page images;
- table grid;
- transcript with timecodes and speakers;
- searchable chunks.

Each projection is a derived artifact with a transformation signature and parent digest. Verification may compare multiple projections; it must not silently replace one with another.

### 9.3 Parser candidates

Support pluggable parsers and benchmark them by modality. Candidate classes include native PDF/text libraries, Docling, OCR/VLM systems, HTML/DOM extraction, and provider APIs. The reserved Docling service remains an independent pinned deployment boundary.

## 10. Structured extraction

### 10.1 Schema safety gate

Before any provider call:

- accept only a supported JSON Schema subset;
- bound schema byte size, nesting, property count, enum size, and recursion;
- reject remote `$ref` and executable/content-fetching extensions;
- assign a schema ID/version and canonical hash;
- require explicit nullability and missing-value behavior;
- require field descriptions for semantically ambiguous fields;
- define additional-property behavior;
- store normalization and comparison rules separately from the schema.

Schema validity proves shape, not correctness.

### 10.2 Field evidence contract

Every candidate leaf should return or be augmented with:

```json
{
  "path": "/invoice/total",
  "value": 1024.55,
  "rawValue": "$1,024.55",
  "derivation": "normalized",
  "evidence": [{ "fragmentId": "fragment_..." }],
  "providerConfidence": 0.93
}
```

`providerConfidence` is diagnostic only until calibrated against held-out human labels by modality and field class.

### 10.3 Deterministic field checks

- JSON Schema validation;
- exact/normalized string comparison;
- null versus absent semantics;
- number, decimal, percentage, currency, unit, timezone, and date parsing;
- enum, range, checksum, identifier, and format validation;
- source quote/geometry/cell/timecode resolution;
- record uniqueness and duplicate detection;
- table row/column association;
- cross-field identities and totals;
- derived-value computation replay;
- entity/period/methodology consistency;
- unsupported-value detection when no evidence resolves.

## 11. Claim and report verification

### 11.1 Claim decomposition

Split prose into minimal externally verifiable propositions without losing:

- entity identity;
- time period;
- quantity and unit;
- scope and jurisdiction;
- comparison baseline;
- causal or methodological wording;
- negation;
- uncertainty and source attribution.

Claim decomposition itself is an evaluated component. Store source report offsets and measure claim-selection recall on annotated examples.

Classify claims as externally verifiable fact, source summary, calculation, inference, opinion, recommendation, or citation-not-required text.

### 11.2 Evidence resolution

- Resolve citations to exact source versions and fragments.
- Judge cited evidence separately from uncited retrieved alternatives.
- Require minimally sufficient evidence sets rather than document-level topical relevance.
- Preserve multiple supporting fragments for multi-hop claims.
- Mark malformed or out-of-range citations as pointer failures, not semantic failures.
- Search for contradictions and more authoritative evidence in a separate bounded rescue stage.

### 11.3 Semantic ensemble

The initial semantic stack should support:

1. deterministic entity/number/quote checks;
2. three-way NLI: entailed, neutral, contradicted;
3. a strict evidence-only LLM rubric returning full, partial, unsupported, or contradicted plus fragment IDs and unsupported facets;
4. a cross-family second judge for high-risk, uncertain, or disagreement cases;
5. human adjudication at configured thresholds.

The semantic verifier has no general shell, filesystem, arbitrary web, delegation, or unbounded retrieval tools. Bounded rescue is a separate capability with an explicit budget.

### 11.4 Attribution faithfulness

Self-reported citations demonstrate declared attribution, not causal use.

- For open-weight/logprob-capable models, support research adapters for ContextCite, MIRAGE, AttriBoT, or comparable influence methods.
- For closed providers, use controlled evidence deletion, replacement, and order-swapping on audit samples.
- Record claim survival, flip rate, and evidence sensitivity.
- Treat causal-attribution analysis as an audit metric, not a universal per-request gate until cost and reliability are established.

### 11.5 Report-wide checks

- claim-weighted citation completeness;
- citation correctness;
- source diversity and independence;
- unsupported high-severity claim detection;
- entity/date/number consistency across sections;
- table/text consistency;
- citation placement and pointer validity;
- duplicated or contradictory assertions;
- calculations linked to verified operands;
- disclosed conflicts, caveats, abstentions, and freshness limitations.

## 12. Entity, metric, and derivation verification

Resolve entity/artifact identity before accepting observations.

Each metric observation includes:

- canonical entity and artifact level;
- provider and provider-native field;
- metric definition and version;
- raw and canonical value;
- unit, scale, period, timezone, and point/interval/cumulative semantics;
- numerator, denominator, and population where applicable;
- aggregation, deduplication, and caveats;
- capture, locator, and observed/effective times;
- comparability group;
- computation proof for derived values.

Conflicting providers remain separate observations. Policy may select a preferred observation, but the rejected alternatives and rationale remain auditable.

Supported deterministic derivations should use a versioned expression/operation contract with operands referenced by observation ID, declared rounding/tolerance, and exact replay.

## 13. Interfaze provider specification

### 13.1 Supported modes

Implement two explicit adapters:

1. `InterfazeTaskProvider` for bounded fixed operations such as OCR, web scraping, transcription, detection, translation, and classification;
2. `InterfazeStructuredExtractionProvider` for caller-owned, schema-constrained extraction through the chat-completions API.

Do not expose `ask_interfaze`, unrestricted browsing, forecasting, GUI actions, file upload, or code execution through production verification until each has its own security and correctness evaluation.

### 13.2 Required capture

For every call retain:

- canonical request body excluding secrets;
- schema and prompt hashes;
- requested and returned model identifiers;
- response ID and raw response artifact;
- complete `precontext` artifact;
- OCR tokens, confidence, page geometry and bounding boxes when present;
- web result URLs, content, cache state, and retrieval metadata when present;
- usage, billed tokens/cost, latency, retries, HTTP status, and errors;
- SDK/adapter version;
- ZDR setting;
- extraction result and independent schema-validation result.

Generic OpenAI clients must not silently discard Interfaze-specific fields.

### 13.3 Security defaults

- Set `x-interfaze-zdr: true` for sensitive or non-public inputs.
- Never log API keys or authorization headers.
- Use the secret manager/runtime environment, not manifests.
- Disallow sensitive production data until legal/security review establishes acceptable terms, retention, subprocessors, output rights, and compliance evidence.
- Treat provider confidence as uncalibrated.
- Pin adapter versions and record provider model strings; re-baseline whenever a stable provider snapshot cannot be selected.

### 13.4 Experiment arms

At minimum compare:

- current extractor/provider;
- Interfaze;
- current extractor followed by Interfaze as a second opinion;
- Interfaze followed by an independent cross-family verifier;
- consensus-with-abstention when provider outputs disagree.

Interfaze is eligible for extraction/perception and evidence localization. It is not the policy admission authority.

## 14. Provider registry

Every provider registration declares:

- capabilities and modalities;
- contract version;
- stable model/version semantics;
- limits, timeout and retry policy;
- data residency/retention/ZDR characteristics;
- tool/network behavior;
- cost model and pricing snapshot source;
- supported schemas and selectors;
- expected evidence metadata;
- error mapping;
- health and conformance results;
- promotion state: lab, offline, shadow, admitted, suspended, or retired.

All provider adapters must pass a common conformance suite with recorded fixtures. Provider-specific extensions live under namespaced metadata and may not be required by the public core contract.

## 15. Benchmark and experimentation system

### 15.1 Dataset hierarchy

```text
benchmark suite
  -> immutable dataset version
  -> split
  -> case
  -> source artifacts
  -> gold assertions/fields
  -> acceptable evidence fragments
  -> contradictions and hard negatives
  -> expected abstention/policy outcome
```

Dataset versions are immutable and content-hashed. Corrections create a new version linked to the previous version.

### 15.2 Dataset strategy

Use three layers:

1. **Pilot:** 30–50 non-sensitive, hand-reviewed cases to validate the harness.
2. **Benchmark v1:** 150–300 real, stratified cases for provider and pipeline selection.
3. **Mature semantic benchmark:** approximately 600 cases divided into development, calibration, locked in-distribution, and locked distribution-shift sets.

Stratify by modality, layout, language, tables/charts, scan quality, density, source class, source authority, age, risk, length, entity ambiguity, and derivation complexity.

Use dual independent annotation and expert adjudication on high-risk and locked cases. Record annotation guidelines and inter-annotator agreement. Keep report, entity cluster, and source family within a single split to reduce leakage.

### 15.3 External benchmark adapters

Support import/adaptation—not blind score aggregation—for:

- ALCE and AttributionBench for citation correctness/completeness;
- TREC RAG/RAGTIME citation-support judgments;
- RAGChecker and RAGTruth for claim-level RAG diagnosis and hallucination spans;
- FActScore, SAFE, VeriScore, and RefChecker for atomic factuality;
- DocILE, OmniDocBench, OCRBench v2, ExtractBench, DocuBench, JSONSchemaBench, LLMStructBench, and SOB for extraction/document parsing;
- DeepResearch Bench and ReportBench for report and citation behavior;
- RGB and internally generated mutations for retrieval robustness.

External datasets remain identifiable by license, source, version, transformation, and split. They do not replace internal representative gold data.

### 15.4 Perturbation suite

Include:

- blur, rotation, noise, handwriting, low resolution, and OCR corruption;
- reordered, duplicated, missing, or truncated pages;
- merged/split columns and chunks;
- dropped support spans;
- irrelevant and authority-spoofed distractors;
- entity, number, date, unit, qualifier, and negation swaps;
- citation swaps and out-of-range pointers;
- obsolete versus current policies;
- mutually conflicting sources;
- prompt injection and data-exfiltration instructions inside documents;
- poisoned retrieval results;
- long-context dilution/truncation;
- unsupported questions and correct abstention;
- table values attached to the wrong row or column;
- incorrect but plausible derived totals.

### 15.5 Experiment definition

An experiment specifies:

- hypothesis and preregistered primary outcome;
- frozen dataset version and slices;
- variants and provider configurations;
- replica count and cache policy;
- randomization/blinding rules;
- graders and grader versions;
- calibration policy;
- statistics and multiple-comparison treatment;
- cost/latency budget;
- hard gates;
- stop/failure conditions;
- artifact retention and publication policy.

### 15.6 Statistics

- Use paired evaluation on identical cases.
- Use report/source-clustered paired bootstrap confidence intervals.
- Use McNemar tests for paired binary outcomes.
- Use paired permutation/bootstrap tests for continuous score differences.
- Report effect sizes and confidence intervals, not only p-values.
- Use correction when testing many variants/slices.
- Select abstention thresholds only on calibration data.
- Report reliability diagrams, Brier score, ECE, and risk–coverage curves.
- Surface catastrophic and worst-slice error rates separately from means.

### 15.7 Metrics

**Extraction:** schema validity, whole-document exact match, leaf exact/normalized match, field precision/recall/F1, numeric/date/unit accuracy, null/abstention accuracy, CER/WER, ANLS, table cell F1/TEDS, bbox IoU, locator resolution, quote coverage, calculation correctness, run stability.

**Retrieval:** gold supporting-span Recall@k, document recall, nDCG@k, MRR, context precision, evidence sufficiency, hard-negative rate, contradiction/noise rate, result stability.

**Attribution:** citation pointer validity, per-citation support precision, claim-weighted citation completeness, full/partial/unsupported/contradicted distribution, evidence minimality, source authority, corroboration, atomic-claim grounded precision, unsupported-claim recall, attribution sensitivity under ablation.

**System:** latency percentiles, billed cost, infrastructure failure rate, replay success, evidence-set Jaccard, claim flip rate, judge disagreement, review rate, worst-slice/p5 performance, and drift by parser/model/provider/version.

### 15.8 Initial gates

Targets must be validated, not assumed:

- 100% deterministic behavior on supported fixtures;
- zero admitted invalid or unresolved pointers;
- zero accepted same-deployment self-verification;
- zero admitted contradicted critical claims;
- 100% schema validity among accepted structured outputs;
- deterministic arithmetic at 100% for supported operations;
- at least 95% selective semantic accuracy at the selected coverage;
- at least 90% recall for critical unsupported claims;
- at least 99% resolution for admitted citation/identifier selector types;
- 100% required manifest and lineage completeness;
- explicit human review for critical mixed/conflicting evidence.

### 15.9 Required diagnostics-company verification pack

The first named internal research fixture is `diagnostics-companies-v1`, centered on TruDiagnostic and Generation Lab. It is both a benchmark slice and a human-readable product demonstration. It must prove that the pipeline can acquire changing web/PDF material, extract structured facts, generate short research reports, attach precise evidence, distinguish first-party support from independent corroboration, detect contradictions and marketing overreach, and replay every decision.

This pack is mandatory for the Pilot. It is not a medical-product endorsement or a clinical comparison. It evaluates research and verification behavior using public corporate and scientific content.

#### 15.9.1 Frozen source registry

Seed the discovery manifest with the following canonical sources. Acquisition resolves redirects and records the final URL, retrieval timestamp, HTTP metadata, content type, byte digest, rendered/canonical projection digests, and license/access notes. The captured bytes—not the live URL—are the benchmark input.

**TruDiagnostic first-party sources**

- [About TruAge](https://www.trudiagnostic.com/about-truage): three named clock families, biomarker lists, organ-system mappings, sample workflow, and turnaround claims.
- [TruAge report education](https://www.trudiagnostic.com/report-education): interpretation, limitations, technical-method claims, retest guidance, and the distinction between an aging indicator and a diagnosis.
- [TruAge product page](https://shop.trudiagnostic.com/products/truage-complete-epigenetic-collection): current product claims, included report components, methylation-site and biomarker counts, workflow, reproducibility claims, and sample-report discovery.
- [DunedinPACE product explanation](https://www.trudiagnostic.com/dunedin-pace): current first-party explanation of pace-of-aging output.
- Publicly reachable sample-report PDFs discovered from those pages. A discovery result must retain the referring-page locator. Do not bypass authentication, automate email capture, or accept terms on behalf of a user to obtain a gated report.

**Generation Lab first-party sources**

- [SystemAge test](https://www.generationlab.com/the-systemage-test): current product description, biomarker/system counts, report/action-plan description, workflow, testimonials, and sample-report discovery.
- [SystemAge science](https://www.generationlab.com/science): the 460-CpG selection description, BioNoise method claims, system mappings, and same-sample triplicate percentages.
- [SystemAge FAQs](https://www.generationlab.com/FAQs): the noise-barometer calculation description, biological-age framing, and linked publications.
- [Published research](https://www.generationlab.com/published-research): the company's claimed scientific lineage and outbound paper links.
- [Generation Lab terms](https://www.generationlab.com/terms-of-service): informational-use, clinician-discussion, and warranty limitations for reports.
- [Generation Lab comparison article](https://www.generationlab.com/blog/best-biological-age-test-systemage-vs-function-health-trudiagnostic-comparison): explicitly interested-party comparative and clinical-accuracy claims; treat as a hard-negative authority fixture, never as independent comparative evidence.
- Publicly reachable sample-report PDFs discovered from those pages under the same no-gate-bypass rule.

**Independent or publication-layer sources**

- [DunedinPACE, a DNA methylation biomarker of the pace of aging](https://pmc.ncbi.nlm.nih.gov/articles/PMC8853656/): primary paper for design, cohort, interpretation, reliability, and validation scope.
- [OMICmAge quantifies biological age by integrating multi-omics with electronic medical records](https://pmc.ncbi.nlm.nih.gov/articles/PMC13004675/): primary paper for OMICmAge development and validation; record author affiliations and commercial participation rather than labeling it fully independent.
- [Fail-tests of DNA methylation clocks and development of a noise barometer](https://pmc.ncbi.nlm.nih.gov/articles/PMC10522373/): primary paper linked by Generation Lab for the noise-barometer concept.
- [Generation Lab's published-research index](https://www.generationlab.com/published-research) outbound GeroScience paper on clock feature rectification: capture the publisher version, metadata, funding, affiliations, and exact claims used by the company.

The implementer may use a bounded research subagent to discover additional relevant pages, PDFs, publications, archived versions, and disconfirming sources. Its output must be a proposed source manifest with URLs, source class, discovered-from relation, expected claim families, access/license notes, and capture date. A human or coordinator approves additions before the locked split is regenerated.

#### 15.9.2 Research questions and extraction schema

For each company extract, at minimum:

- legal/brand identity and product names;
- sample type, collection method, laboratory claims, processing/turnaround time, and intended user;
- reported methylation sites, cytosines/CpGs, biomarkers, systems/organs, report components, and prices when captured;
- named algorithms/clocks, stated institutional collaborators, algorithm class, inputs, outputs, training/validation populations, and stated interpretation;
- named biomarkers and system-to-biomarker mappings;
- reported repeatability/reproducibility, accuracy, cohort, sample-size, and performance numbers with denominators and definitions;
- diagnostic/non-diagnostic scope, informational-use language, clinician guidance, privacy/consent, and material limitations;
- medical, preventative, comparative, superlative, causal, and intervention claims;
- publication links, author affiliations, conflicts/funding when available, and whether a publication validates the commercial product, an antecedent method, or only a general concept.

Every leaf contains an exact source locator and capture ID. Counts must never be silently reconciled. Store `as_stated`, normalized value/unit, page/product/version context, and conflict-set membership.

#### 15.9.3 Gold claim families

The curated gold set must include:

1. **Direct descriptive claims:** product includes named clock/report components, uses a finger-stick blood sample, or reports a stated number of systems.
2. **Algorithm claims:** what OMICmAge, SymphonyAge, DunedinPACE, SystemAge, and BioNoise are stated to measure and how the cited paper actually defines them.
3. **Biomarker extraction:** long lists, aliases such as HbA1c/HgbA1c, repeated biomarkers across systems, CpG identifiers, and table/card-to-heading relationships.
4. **Scoped numerical claims:** Generation Lab's three triplicate percentages must be attributed to the same-sample experiment; they must not be rewritten as population-level clinical accuracy. TruDiagnostic's methylation-site, biomarker, system, reproducibility, and turnaround figures must retain page/version context.
5. **Conflict/drift cases:** 19-versus-21 Generation Lab system wording, product-page count changes, TruDiagnostic 2–4 versus 3–4 week language, and any historical/current product-name or count mismatch.
6. **Authority cases:** a company page supports “the company says X,” but cannot alone establish “X is the world's most accurate,” disease prediction, clinical utility, causality, or superiority over a competitor.
7. **Publication-scope cases:** a paper supporting an antecedent method must not automatically validate every commercial report feature or marketing conclusion.
8. **Safety/qualification cases:** preserve not-a-diagnosis, informational-use, clinician-correlation, acute-event noise, population, and retesting limitations.
9. **Adversarial cases:** swapped company names, algorithms, counts, institutions, biomarkers, report timelines, citations, qualifiers, and conclusions; invented head-to-head findings; and true-looking claims cited to the wrong company.

Gold labels are assertion-level: `supported_by_source`, `independently_corroborated`, `partially_supported`, `contradicted`, `unsupported`, `outdated`, `promotional_only`, `not_verifiable_from_public_sources`, or `not_applicable`. The first label means source entailment, not real-world truth.

#### 15.9.4 Required mini reports

One run produces:

- `trudiagnostic-research-report.html` and its canonical Markdown/JSON representation;
- `generation-lab-research-report.html` and its canonical Markdown/JSON representation;
- `diagnostics-comparison-report.html`, limited to comparable, correctly scoped attributes;
- `verification-audit.html`, explaining extraction, evidence resolution, claim verdicts, conflicts, abstentions, calibration, perturbation results, cost, latency, and replay status;
- machine-readable claim ledger, field ledger, source manifest, run manifest, metrics, and signed or content-addressed verification bundle.

Each company report contains: snapshot date; product/method overview; algorithms and reported outputs; biomarker/system coverage; evidence-backed scientific basis; what is first-party versus independently corroborated; material limitations; contradictions/change-over-time; unanswered questions; and a claim-by-claim evidence appendix. It must visibly label company claims, research findings, reviewer inference, and unresolved assertions.

Reports may summarize public content but must not reproduce full copyrighted pages or sample reports. The fixture stores only content allowed by the approved retention policy; otherwise it stores a digest, locator, metadata, and a restricted-access handle.

#### 15.9.5 One-command demonstration

The installed CLI must support:

```powershell
knowledge demo diagnostics-companies --dataset diagnostics-companies-v1 --output ./artifacts/diagnostics-demo --open
```

This command runs from frozen captures by default so it is deterministic and available offline. It validates fixture integrity, runs extraction and claim/report verification, applies adversarial mutations, generates both mini reports and the audit report, replays deterministic decisions, and exits according to the normal quality/infrastructure exit-code contract. `--open` opens the local audit report only in interactive mode.

Live refresh is explicit and separate:

```powershell
knowledge benchmark capture diagnostics-companies --propose-version diagnostics-companies-v2
knowledge benchmark diff diagnostics-companies-v1 diagnostics-companies-v2
```

Refresh never mutates `v1`. Promotion requires source/license review, schema validation, drift review, gold-label update, leakage checks, and a sealed manifest. Network, parser, provider, and model failures appear separately from verification failures.

The audit report must show at least one example of each of these paths: exact field accepted; normalized field accepted; precise citation supported; partial support due to missing qualifier; conflict detected; promotional claim withheld for authority; publication overextension rejected; corrupted locator rejected; adversarial claim contradicted; and correct abstention.

#### 15.9.6 Pack-specific acceptance gates

- all admitted fields and report claims have resolvable capture-bound selectors;
- 100% of known count/timeline conflicts remain visible in the claim ledger and mini reports;
- no marketing superlative or medical/causal claim is independently corroborated solely from the interested company's page;
- no commercial product claim inherits validation from a publication without an explicit method/product applicability link;
- all seeded adversarial mutations produce the expected degraded verdict or abstention;
- deterministic replay reproduces capture, selector, extraction, policy, and report digests;
- generated reports contain no uncited material factual claims and no patient-specific medical advice;
- a reviewer can navigate from every displayed verdict to the exact captured fragment and back to the run manifest;
- the command runs offline from the frozen pack and produces the documented artifact set;
- a live refresh produces a proposed immutable version and drift report without changing prior results.

## 16. Storage and persistence

### 16.1 Ownership rule

Knowledge Services must not create local canonical migrations. All persistence changes go through `ai-engineer-db-contract`, followed by regenerated types and an updated pinned contract dependency.

### 16.2 Canonical relational concepts

Reuse or extend canonical tables for:

- missions, work items, attempts, and sessions;
- artifact registry and output manifests;
- logical sources and immutable captures;
- locators and extraction signatures;
- claims/assertions and evidence links;
- verification runs, findings, and assessments;
- evaluation datasets, cases, labels, graders, runs, scores, gates, and regressions;
- query/retrieval/capture provenance;
- human-review items and policy overrides.

Likely additive gaps to propose upstream:

- immutable dataset-version freeze/hash semantics;
- direct mission/work-item/attempt and run-manifest linkage on eval runs;
- lifecycle status and timestamps for evaluation runs;
- provider/model/prompt/policy/pricing/runtime snapshot fields or artifact links;
- result-artifact linkage for per-case scores;
- explicit report assertion-span-to-claim mapping;
- media-specific selector validation;
- computation-ledger representation;
- non-null producer-attempt and ranking-locator invariants;
- validated authority/independence vectors;
- views that prevent unadmitted findings from appearing verified.

Before coding persistence adapters, reconcile the existing TypeScript and database claim-type vocabularies. The prototype includes temporal, causal, comparative, and methodological claim kinds, while the provisional database seed also uses event, recommendation, definition, and provenance. Adopt one versioned taxonomy or an explicit lossless mapping; do not silently coerce between them.

The current evidence schema is marked provisional in its migration. Contract stabilization is therefore a Phase 0 dependency for public API read models and dashboard commitments, even though pure core and fixture work can proceed in parallel.

### 16.3 Object storage

Use a private mission/evaluation artifact bucket with content-addressed objects and stable prefixes:

```text
captures/sha256/<prefix>/<digest>
datasets/<dataset-id>/<version>/...
missions/<mission-id>/work-items/<work-item-id>/attempts/<attempt-id>/...
evals/<dataset-version-id>/<eval-run-id>/manifest.json
evals/<dataset-version-id>/<eval-run-id>/cases/<case-id>/input.json
evals/<dataset-version-id>/<eval-run-id>/cases/<case-id>/result.json
```

Every object is registered in the relational artifact ledger. Do not rely on bucket paths as the ledger and do not create a bucket per experiment. Create separate buckets only for materially different KMS, residency, access, quarantine, deletion, or legal-retention policies.

The existing `ai-engineer-cloud-bucket` usage needs an authoritative bucket/policy migration before production reproducibility can be claimed.

## 17. HTTP API

Initial endpoints:

```text
POST /v1/verification/captures
POST /v1/verification/extractions
POST /v1/verification/extractions:verify
POST /v1/verification/claims:verify
POST /v1/verification/reports:verify
POST /v1/verification/metrics:verify
POST /v1/verification/benchmarks:run
POST /v1/verification/benchmarks:compare
POST /v1/verification/runs/{runId}:replay
GET  /v1/verification/operations/{operationId}
GET  /v1/verification/runs/{runId}
GET  /v1/verification/runs/{runId}/manifest
GET  /v1/verification/runs/{runId}/cases
GET  /v1/verification/cases/{caseRunId}
GET  /v1/verification/evidence/{evidenceId}
POST /v1/verification/reviews
```

Rules:

- long-running POSTs return `202` plus an operation receipt;
- idempotency keys are mandatory for mutations;
- large inputs/outputs use artifact handles or presigned upload/download flows;
- all resources are tenant-scoped;
- pagination and filtering are stable and explicit;
- errors use a versioned typed problem-details contract;
- authorization distinguishes run, read, replay, adjudicate, promote, and policy-admin capabilities;
- the OpenAPI document and typed client are generated and contract-tested.

## 18. CLI

Expose through `apps/cli`:

```text
knowledge verify extract
knowledge verify citations
knowledge verify report
knowledge verify metric
knowledge benchmark run
knowledge benchmark compare
knowledge benchmark capture
knowledge benchmark diff
knowledge demo diagnostics-companies
knowledge bundle replay
knowledge bundle inspect
```

CLI requirements:

- JSON/JSONL/manifest-URI input and JSON/NDJSON output;
- no interactive prompts in agent mode;
- `--operation-id`, `--mission-id`, `--work-item-id`, `--attempt-id`, `--idempotency-key`, `--policy`, and `--output` support;
- checkpoint/resume support;
- concise stderr progress with structured stdout;
- exit `0` for completed/admitted result, `1` for a completed quality-gate failure, and `2` for infrastructure/configuration/authentication failure;
- cancellation propagation and bounded retries;
- no secrets or full sensitive evidence printed to terminals.

Cursor Cloud skills invoke this CLI or the versioned HTTP client. They never invoke provider SDKs directly for admitted verification.

## 19. MCP

Expose bounded, stateless tools such as:

- `knowledge_capture_source`;
- `knowledge_extract_structured`;
- `knowledge_verify_extraction`;
- `knowledge_verify_claims`;
- `knowledge_verify_report`;
- `knowledge_run_benchmark`;
- `knowledge_get_operation`;
- `knowledge_inspect_run`.

MCP is a distribution and discovery surface, not a validation boundary. Tools call the same application use cases as HTTP/CLI. Tool results return compact summaries and artifact handles rather than full raw provider payloads.

Do not expose unrestricted shell, browser, upload, or provider pass-through tools under the verification namespace.

## 20. Worker and orchestration semantics

The Knowledge Services worker executes versioned capabilities. Mission Control/Temporal orchestrates them.

Recommended benchmark DAG:

```text
compile_eval_dataset
  -> capture_or_hydrate_inputs
  -> run_extractor_variants
  -> run_deterministic_verification
  -> run_independent_semantic_verification
  -> compute_metrics_and_bias_slices
  -> evaluate_policy_gates
  -> seal_run_manifest
```

Each node:

- is idempotent by input/configuration hash;
- checkpoints after each case/batch;
- heartbeats with counts and bounded progress metadata;
- distinguishes cancellation, retryable infrastructure failure, terminal contract failure, and completed quality failure;
- registers artifacts before acknowledging completion;
- supports fan-out/fan-in without nondeterministic aggregation;
- records attempt and causation lineage.

Mission Control must dispatch capabilities and observe receipts; it must not reimplement verification. Until Mission Control is operational, the current Cursor Cloud CLI lane may call the Knowledge Services CLI/API directly while preserving mission/work-item/attempt IDs.

## 21. EVE and other-framework integration

EVE integration uses an authored bounded tool backed by the versioned Knowledge Services client. The tool:

- accepts artifact handles and verification intents;
- never embeds entire sensitive captures when a handle is sufficient;
- receives compact results and audit handles;
- cannot alter deterministic findings;
- propagates producer deployment/attempt identity;
- uses a verifier deployment distinct from the producer;
- persists before returning an admitted result.

The EVE research pipeline should become:

```text
source discovery
  -> research synthesis
  -> assertion/field/evidence bundle compilation
  -> Knowledge Services verification
  -> versioned policy admission
  -> response/persistence
```

Other frameworks use the same HTTP client, CLI, or MCP tools and pass the same operation envelope.

### Signed Eve runtime bridge

An Eve submission may use the signed runtime bridge when the API has both a
server-owned ownership grant with `eveRuntimeAuthority` and a matching public
key in `VERIFICATION_EVE_RUNTIME_ATTESTATION_KEYS_JSON`. The model-facing tool
still receives only the admitted verification request and artifact references.
It never receives a tenant, operation routing IDs, grant selection, key ID, or
signing capability.

The Eve host receives a fixed `EVE_VERIFICATION_GRANTS_JSON` catalog. An exact
grant contains its `runtimeAttestation` `{ issuer, keyId, agentDeploymentId }`
and the host uses `EVE_VERIFICATION_SIGNING_PRIVATE_KEY_PEM` only immediately
before the authenticated HTTP submission. The private key is not logged,
persisted in the binding ledger, placed in a tool result, or supplied to model
input. The API configuration retains only public Ed25519 keys. A safe shape is:

```json
{
  "VERIFICATION_EVE_RUNTIME_ATTESTATION_KEYS_JSON": "[{\"issuer\":\"eve.example\",\"keyId\":\"2026-q3\",\"publicKeyPem\":\"-----BEGIN PUBLIC KEY-----\\nREPLACE_WITH_ED25519_PUBLIC_KEY\\n-----END PUBLIC KEY-----\"}]",
  "VERIFICATION_SERVICE_OWNERSHIP_GRANTS_JSON": "[{\"tenantId\":\"<tenant-uuid>\",\"actor\":{\"kind\":\"service\",\"id\":\"<service-uuid>\",\"serviceIdentity\":\"knowledge_api\"},\"missionId\":\"<mission-uuid>\",\"agentDeploymentId\":\"eve-verifier-v1\",\"capabilityVersion\":\"verification.v1\",\"eveRuntimeAuthority\":{\"grantId\":\"eve-claims-v1\",\"issuer\":\"eve.example\",\"keyIds\":[\"2026-q3\"]}}]"
}
```

The host-issued idempotency key and correlation ID are stable for a retry. The
operation UUID is the canonical UUID for tenant, use case, and that key; the
correlation ID is `eve-verification:<operationId>`. Each submission signs the
actual Eve session, turn, and tool-call lineage with a short-lived JTI. The API
requires the request digest, authenticated service principal, ownership grant,
operation identity, and any external-lineage headers to match the signed
envelope exactly.

`knowledge_service.eve_operation_binding` freezes the first accepted external
execution per tenant/idempotency key. `eve_operation_invocation` then retains
every full public signed envelope, including a newly signed retry JTI, while
the operation continues to use the original execution context. A duplicate
issuer/JTI with altered data is rejected. Canonical `agent_session` and
`attempt.eve_turn_ids` are supplemental corroboration: populated values must
match the attestation; their absence does not become caller authority.

Roll keys by adding the new `{issuer,keyId,publicKeyPem}` to the API allowlist
and its key ID to the exact ownership grants, then retire the old key ID only
after its short attestation window has elapsed. Unknown, removed, malformed,
wrong-algorithm, or grant-unlisted keys and expired attestations fail before
operation admission. Revoking an ownership grant or its issuer/key ID
blocks future submissions; append-only prior binding and invocation evidence is
retained. This bridge conveys authenticated runtime lineage only. It neither
admits policy outcomes nor grants review, publication, or human authority.

The implementation design is recorded in
[`SW-03-EVE-LINEAGE-BRIDGE-DESIGN-20260908.md`](../workspaces/verification-module/swarm-plan-20260906/SW-03-EVE-LINEAGE-BRIDGE-DESIGN-20260908.md).
Current native evidence covers rollback-only API admission and isolated durable
binding concurrency ([admission receipt](../../../internal/verification-eve-native-admission-805e58bd-54a7-40ec-929c-a504ee4816b1.json),
[concurrency receipt](../../../internal/verification-eve-binding-concurrency-288164b9-548b-44ea-aeae-b8d5d3145c9b.json));
EV-136 additionally proves an actual Eve tool invocation through the native KS
worker and Storage to an independently audited signed report
([evidence aggregate](../../../internal/verification-eve-report-EV136-20260908.json)).
Eve inference was mocked and the KS semantic judge used one live Luna call.
EV-137 adds audited native same-deployment and corrupted-locator controls
([evidence aggregate](../../../internal/verification-eve-negative-controls-EV137-20260908.json)).
An unqualified verifier stops before sealing; the canonical database must not
record even a failed verification run by the same deployment. Capability
injection coverage, cancellation/recovery and live Eve inference remain separate
acceptance requirements.

## 22. Cursor Cloud Agent integration

Provide thin, fixture-tested skills:

- `run-extraction-benchmark`;
- `verify-extraction`;
- `verify-source-attribution`;
- `verify-report`;
- `replay-verification-run`;
- `adjudicate-verification`.

Each skill specifies:

- when it applies;
- required preflight and input artifacts;
- exact CLI/HTTP invocation;
- contract and capability version;
- success, quality-failure, and infrastructure-failure interpretation;
- artifact registration requirements;
- abstention and escalation rules;
- forbidden shortcuts such as treating display excerpts as selectors or retrying with the producer deployment.

Skills contain operational instructions, not verifier algorithms.

## 23. Mission Control dashboard integration

The dashboard home is `ai-engineer-mission-control/apps/dashboard`, as accepted in D-018 and the swarm instructions. `agents_dashboard` is a reference implementation only.

Ship read surfaces before mutation controls:

- experiment/dataset catalog;
- run status and stage timeline;
- variant comparison;
- per-case field and claim drilldown;
- original source/capture/fragment replay;
- deterministic and semantic findings;
- citation coverage and unsupported/contradicted claims;
- calibration, risk–coverage, cost, latency, reliability, and drift;
- provider versus harness failure taxonomy;
- regression and gate history;
- human-review queue and adjudication history.

After Mission Control exposes authenticated durable commands, add launch, cancel, retry, replay, promote, and suspend controls. Dashboard mutations call Mission Control or Knowledge Services APIs; they do not write orchestration/evidence tables directly.

## 24. Policy system

Policies are versioned data/code artifacts, not prompt text.

A policy may depend on:

- assertion risk class and downstream use;
- mechanical check results;
- semantic verdict and calibration band;
- source authority, independence, directness, freshness, jurisdiction, and licensing;
- corroboration and conflicts;
- provider/producer/verifier independence;
- expected false-acceptance cost;
- review availability;
- freshness and re-verification rules.

Policy evaluation is deterministic over recorded inputs. Store the exact policy artifact/hash and decision rationale. Overrides require actor, reason, timestamp, before/after outcome, and review authority.

## 25. Security and privacy

### 25.1 Threats

- prompt injection embedded in retrieved content;
- malicious PDFs, images, archives, HTML, SVG, or media;
- SSRF and cloud metadata access;
- excessive decompression, page count, schema depth, or output size;
- cross-tenant artifact access;
- secret/header leakage into manifests or traces;
- provider retention/training outside policy;
- model-generated fake artifact IDs, citations, or success receipts;
- malicious benchmark cases that attack judges;
- tampering with artifacts, manifests, graders, or policies;
- replay using changed provider models or mutable URLs;
- grader gaming and evaluation-data leakage.

### 25.2 Controls

- content and URL policy gates before acquisition/parsing;
- sandboxed parsers with CPU, memory, disk, page, time, and network limits;
- MIME sniffing and extension/content disagreement rejection;
- antivirus/malware scanning where required;
- tenant-scoped authorization and signed short-lived artifact access;
- content-addressed immutable storage and digest verification on hydration;
- secret manager integration and redaction-by-default telemetry;
- no raw source content in span attributes;
- prompt-injection text treated as untrusted data, never instructions;
- restricted verifier tool surface;
- schema complexity and remote-reference rejection;
- provider data-handling registry and policy enforcement;
- signed/canonical manifests and optional in-toto/SLSA attestations;
- private locked challenge sets with access auditing;
- human approval for policy/model/provider promotion.

## 26. Observability

Use OpenTelemetry spans/events for operations while keeping audit evidence in domain artifacts.

Record:

- operation, stage, case, attempt, mission, work-item, and correlation IDs;
- capability/contract versions;
- provider/model/parser/grader/policy IDs;
- request/result artifact hashes rather than raw content;
- token classes, cache use, cost, latency, retries, backoff, and rate-limit state;
- verdict/failure categories;
- queue, hydration, parse, inference, verification, and persistence timing;
- review creation and resolution;
- cancellation and idempotency behavior.

Operational telemetry may be sampled; the audit manifest and required lineage may not be sampled.

## 27. Failure taxonomy

Keep these distinct in contracts and dashboards:

- producer contract failure;
- capture unavailable, forbidden, oversized, or drifted;
- locator missing, ambiguous, or invalid;
- parser/conversion/OCR failure;
- extraction schema or value failure;
- identity missing, ambiguous, or conflicted;
- metric semantics, unit, period, or comparability failure;
- computation replay failure;
- semantic partial/unsupported/contradicted/mixed result;
- claim-decomposition failure;
- malformed judge output;
- provider authentication, rate-limit, timeout, or upstream failure;
- worker/queue/Temporal/harness failure;
- persistence/artifact-registration failure;
- policy rejection;
- human-review timeout;
- cancellation.

Completed quality failures are not infrastructure failures and must not trigger blind retries.

## 28. Testing strategy

### 28.1 Unit tests

- hashing and canonicalization;
- every selector and normalization basis;
- JSON Pointer escaping;
- Unicode/newline handling;
- decimal/date/unit parsing;
- arithmetic and tolerance;
- entity/period/comparability rules;
- verdict lattice and monotonic failure behavior;
- policy replay;
- schema safety;
- URL/network policy;
- error classification.

### 28.2 Contract tests

- Zod/OpenAPI/client compatibility;
- backward/forward version behavior;
- CLI JSON/NDJSON fixtures and exit codes;
- MCP tool schema and compact result behavior;
- database mapper tests against generated canonical types;
- provider adapter conformance and recorded-response replay.

### 28.3 Integration tests

- source capture through artifact registration;
- PDF/HTML/JSON/table/transcript selectors;
- extraction to deterministic verification;
- semantic verifier with fixed evidence;
- persistence/retrieval of a complete run;
- retry, cancellation, checkpoint, and idempotency behavior;
- cross-tenant denial;
- EVE tool and Cursor CLI invocation;
- dashboard API projections.

### 28.4 Evaluation tests

- natural and adversarial gold cases;
- same-family versus cross-family judges;
- order reversal, verbosity padding, provider-label spoofing, cautious/confident wording;
- claim decomposition recall;
- calibration and selective prediction;
- provider/model/parser drift;
- prompt injection and poisoned-source resistance;
- catastrophic-error and worst-slice gates.

### 28.5 Replay tests

Given a sealed bundle, deterministic replay must reproduce hashes, selector resolutions, computations, and policy decision. Provider-dependent replay must explicitly state whether the provider/model is reproducible, substituted, unavailable, or drifted.

## 29. Delivery phases and exit criteria

### Phase 0 — baseline protection and decisions

- inventory and preserve all current uncommitted work;
- approve this specification and module/package naming;
- record migration ownership and compatibility period;
- establish canonical DB-contract and bucket baselines.

**Exit:** clean, reviewable baseline commits exist or the coordinator has explicitly recorded ownership of every pre-existing uncommitted file.

### Phase 1 — module extraction

- create package facade, ports, canonical contracts, and testkit;
- port deterministic core and fixtures without behavior loss;
- add compatibility adapter in the old repository;
- add deterministic conformance/replay tests.

**Exit:** old and new fixture results are byte- or semantically equivalent, deterministic tests pass, and only the new module owns algorithms.

### Phase 2 — provenance and persistence

- implement artifact hydration and selector families;
- upstream required DB/storage changes;
- implement canonical mappers and audit manifests;
- add tenant/security controls.

**Exit:** an accepted fixture replays from database/artifact IDs to exact selected bytes and policy decision.

### Phase 3 — provider adapters and Interfaze pilot

- port/harden Interfaze lab adapters;
- implement current-provider and semantic-judge adapters;
- run common conformance and security tests;
- build the 30–50 case Pilot dataset;
- execute paired provider arms and calibrate Interfaze confidence.

**Exit:** complete replayable Pilot run, typed failures, measured cost/latency/stability, no critical promotion-gate failures.

### Phase 4 — service surfaces

- expose application use cases through HTTP, CLI, MCP, and worker;
- generate client/OpenAPI;
- add EVE authored tool and Cursor skills;
- preserve mission/work-item/attempt lineage.

**Exit:** the same fixture run succeeds through direct application, HTTP, CLI, MCP, EVE, and Cursor entry points with equivalent result hashes where determinism applies.

### Phase 5 — Benchmark v1

- annotate and freeze 150–300 representative cases;
- run provider/parser/verifier matrices and perturbations;
- validate judges against human labels;
- choose calibrated cascades and gates.

**Exit:** locked-test results, confidence intervals, calibration, costs, failure slices, and promotion decisions are sealed and reviewable.

### Phase 6 — orchestration and dashboard

- connect Temporal/Mission Control capability dispatch;
- add dashboard read surfaces;
- add authenticated controls only after durable commands exist;
- add human-review flow.

**Exit:** an operator can launch, observe, inspect, replay, cancel, and adjudicate a benchmark without direct database mutation.

### Phase 7 — shadow and enforcement

- shadow verification on production research/ingestion;
- compare against human adjudication;
- monitor drift, disagreement, review volume, cost, and latency;
- enforce admission after sustained policy gates pass.

**Exit:** versioned verification policy safely gates selected publication/ranking paths with rollback and override auditability.

## 30. Migration plan

1. Freeze and test the current `research_ingestion_systems_agent` verification behavior.
2. Copy contracts/core only through reviewed commits while preserving history/reference notes.
3. Replace implementation imports there with the Knowledge Services client or compatibility package.
4. Move Interfaze provider ownership and lab fixtures to Knowledge Services experiments.
5. Keep EVE-specific prompting/channel code in the EVE repository, backed by a Knowledge Services tool/client.
6. Update Cursor Cloud skills to invoke the Knowledge Services CLI/API.
7. Deprecate duplicate scripts after equivalent benchmark and replay evidence exists.
8. Remove old implementations only after all consumers are migrated and the coordinator records the deletion targets explicitly.

## 31. Research basis

This specification draws on the following primary standards, papers, and maintained implementations:

### Provenance and auditability

- [W3C PROV Overview](https://www.w3.org/TR/prov-overview/) — entities, activities, agents, derivation, and provenance bundles.
- [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) — text quote/position and media selectors.
- [OpenLineage specification](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md) — job, run, dataset, and extensible facets.
- [Workflow Run RO-Crate](https://www.researchobject.org/workflow-run-crate/) — portable workflow-run research objects.
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) — JSON canonicalization for stable hashing/signing.
- [SLSA provenance](https://slsa.dev/spec/v1.2/provenance) — builder, invocation, materials, and artifact attestations.
- [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) — interoperable agent/model operational telemetry.

### Citation and claim attribution

- [ALCE](https://arxiv.org/abs/2305.14627) and [code](https://github.com/princeton-nlp/ALCE) — answer correctness, citation correctness, and citation completeness.
- [AttributionBench](https://aclanthology.org/2024.findings-acl.886/) — attribution evaluation across tasks.
- [TREC RAG support evaluation](https://trec-rag.github.io/annoucements/evaluation/) — no/partial/full citation support judgments.
- [RAGChecker](https://github.com/amazon-science/RAGChecker) — claim-level retrieval/generation diagnostics.
- [RefChecker](https://github.com/amazon-science/RefChecker) — claim extraction, checking, and aggregation.
- [FActScore](https://aclanthology.org/2023.emnlp-main.741/) — atomic factual precision.
- [SAFE](https://deepmind.google/research/publications/85420/) — search-augmented factual evaluation.
- [VeriScore](https://arxiv.org/abs/2406.19276) — factuality of verifiable claims.
- [TRUE](https://research.google/pubs/true-re-evaluating-factual-consistency-evaluation/) — complementary NLI and QA factual-consistency methods.

### Causal/context attribution

- [ContextCite](https://github.com/MadryLab/context-cite) — context influence through ablation-style methods.
- [MIRAGE](https://aclanthology.org/2024.emnlp-main.347/) — model-internal RAG attribution.
- [AttriBoT](https://github.com/r-three/AttriBoT) — efficient training-data/context attribution techniques.

### Extraction and research-agent evaluation

- [ExtractBench](https://github.com/ContextualAI/extract-bench) — complex PDF-to-JSON extraction methodology.
- [LlamaIndex ExtractBench](https://github.com/run-llama/ExtractBench) — schema-guided enterprise extraction with evidence requirements.
- [DocuBench](https://github.com/DocuPipe/DocuBench) — reproducible field-level document extraction scoring.
- [OmniDocBench](https://github.com/opendatalab/OmniDocBench) — layout, text, table, and formula parsing.
- [OCRBench v2](https://arxiv.org/abs/2501.00321) — visual text localization and reasoning.
- [RAGTruth](https://github.com/ParticleMedia/RAGTruth) — span-level hallucination labels.
- [DeepResearch Bench](https://deepresearch-bench.github.io/) — report quality and citation trustworthiness.
- [ReportBench](https://github.com/ByteDance-BandAI/ReportBench) — cited and uncited statement verification.

### Evaluation reliability

- [ARES](https://aclanthology.org/2024.naacl-long.20/) — synthetic training, human calibration, and prediction-powered inference for RAG evaluation.
- [Stratified prediction-powered inference](https://proceedings.neurips.cc/paper_files/paper/2024/hash/c9fcd02e6445c7dfbad6986abee53d0d-Abstract-Conference.html) — combining imperfect automatic labels with limited human labels.
- [Self-preference bias in LLM judges](https://arxiv.org/abs/2410.21819) — evidence that judges may prefer familiar/self-generated outputs.
- [CONSTRUCT](https://arxiv.org/abs/2603.18014) — field-level trustworthiness scoring for structured outputs; useful for review prioritization, not proof.
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) and [Generative AI Profile](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence) — governance, measurement, risk treatment, and ongoing monitoring.

### Interfaze

- [Official Interfaze documentation](https://interfaze.ai/docs) — API, structured outputs, precontext, limits, and integrations.
- [Interfaze architecture paper](https://arxiv.org/abs/2602.04101) — vendor-authored hybrid architecture and benchmark claims.
- [Interfaze benchmark runners](https://github.com/InterfazeAI/interfaze-complete-benchmarks) — reproducible provider runner code.
- [Interfaze agent skills](https://github.com/InterfazeAI/interfaze-skills) — existing capability-wrapper patterns.
- [Interfaze security/ZDR documentation](https://interfaze.ai/docs/security) — explicit per-request ZDR mechanism.

### Diagnostics-company verification pack

- [TruDiagnostic TruAge](https://www.trudiagnostic.com/about-truage), [report education](https://www.trudiagnostic.com/report-education), and [DunedinPACE](https://www.trudiagnostic.com/dunedin-pace) — first-party product, algorithm, biomarker, interpretation, and limitation claims.
- [Generation Lab SystemAge](https://www.generationlab.com/the-systemage-test), [science](https://www.generationlab.com/science), [FAQ](https://www.generationlab.com/FAQs), and [published research](https://www.generationlab.com/published-research) — first-party product, BioNoise, biomarker, reproducibility, and scientific-lineage claims.
- [DunedinPACE primary paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC8853656/), [OMICmAge primary paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC13004675/), and [noise-barometer paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC10522373/) — publication-layer checks and product-to-paper scope verification.

## 32. Decision status and remaining approvals

The [decision log](../workspaces/verification-module/DECISIONS.md) records accepted choices and their scope. HTTP is the authoritative cross-repository runtime boundary (D-003); the package boundaries follow D-001/D-002; bounded Gateway/Cursor testing is authorized under D-014; the dashboard home follows D-018. Local signing and deployment evidence do not authorize production rollout or human adjudication. The following original decision inventory remains a checklist for any unresolved deployment, publication, licensing, or promotion choices; accepted choices in the decision log take precedence.

1. Final private package/client publication mechanism: service-only HTTP, private registry client, or both.
2. Canonical object-store bucket name and environment-specific policy.
3. Initial high-risk domains and required human-review qualifications.
4. Which existing/current extraction provider is the named baseline in Benchmark v1.
5. Initial semantic judge/NLI models and deployment-independence policy.
6. Licensing policy for retaining source bytes and redistributing benchmark fixtures.
7. Data residency and deletion requirements by tenant/classification.
8. Whether manifest signing begins in Phase 2 or is deferred until Mission Control identity is available.
9. Duration of the compatibility period for the old verification implementation.
10. Promotion authority for providers, graders, policies, and benchmark versions.

None of these prevents creation of the core package, deterministic port, fixture suite, or non-sensitive Pilot dataset.

## 33. Definition of done

The module is complete only when all of the following are evidenced:

- one authoritative implementation exists in Knowledge Services;
- stable contracts are versioned and contract-tested;
- accepted fields and claims resolve to immutable source fragments;
- deterministic replay reproduces selector, hash, arithmetic, and policy results;
- producer/verifier independence is enforced;
- Interfaze and the baseline provider pass common conformance tests;
- a frozen internal benchmark has been run with sealed artifacts and statistical comparisons;
- HTTP, CLI, MCP, Cursor, EVE, and worker paths produce equivalent semantics;
- persistence uses canonical database-contract types and migrations;
- tenant, security, retention, and secret controls pass review;
- dashboard users can inspect the complete evidence chain;
- operational and quality failures are distinguishable;
- shadow-production results meet approved selective-accuracy, critical-error, cost, latency, and review-volume gates;
- migration consumers no longer depend on duplicate verifier algorithms.

## 34. First implementation mission

The first coordinator mission should:

1. protect and commit/record the current untracked baselines;
2. create `packages/verification` and its public facade;
3. port the deterministic core and fixtures;
4. add artifact-based verification bundle contracts;
5. establish canonical database/bucket changes upstream;
6. port and harden Interfaze behind the provider interface;
7. create the 30–50 case Pilot dataset;
8. include the frozen `diagnostics-companies-v1` pack and gold/adversarial annotations;
9. expose `knowledge verify extract`, `knowledge verify citations`, `knowledge benchmark run`, `knowledge demo diagnostics-companies`, and `knowledge bundle replay`;
10. generate and verify the two company mini reports, comparison report, and audit report;
11. run and seal the paired Pilot experiment;
12. expose the resulting experiment read-only in the Mission Control dashboard.

This delivers a real verification experiment early while establishing the shared module that Cursor Cloud, EVE, and future research/ingestion systems will use.

### 2026-09-08 implementation checkpoint — EV139/140

The current acceptance matrix is 7 proved, 27 partial and 12 missing. Independently accepted requirements are VR002/003/004/013/032/043/046. New evidence establishes the bounded verifier tool surface, frozen gated-source acquisition boundary, native capture/semantic/policy replay and fail-closed policy overrides. This checkpoint does not change the definition of done or establish live Eve inference, human gold, Cloud, full multimodal/operation parity or production rollout. Exact aggregate receipts are internal/verification-boundaries-EV139-20260908.json and internal/verification-replay-override-EV140-20260908.json. No new provider spend; known Gateway cohort55settled/USD0.020643, prior Cursor dollars unknown.