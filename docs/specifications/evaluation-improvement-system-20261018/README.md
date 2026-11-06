---
type: Specification proposal
title: "Evaluation and improvement system: how Mission Control and Knowledge Services prove they are getting better"
status: PROPOSED
date: 2026-10-18
owner: belllabs-platform
scope: [mission-control, knowledge-services, ai-engineer-db-contract, biotech-knowledge-services, web-application]
supersedes: []
related:
  - ../evidence-verification-system-20261017/README.md
  - ../content-services-20261017/README.md
  - ../../../knowledge/evaluation-and-publication-gates.md
  - ../../architecture/0003-embedding-retrieval-evaluation.md
---

# Evaluation and improvement system

> **Status: PROPOSED (2026-10-18).** This document changes the architectural trajectory of the
> platform: from "build capabilities, then test them" to "every unit of work produces a scored,
> labelled record, and the organisation runs on those records". It names code to build, tables to
> write, and decisions that remain the owner's. Nothing in it is measured yet. Every threshold is a
> placeholder until the first canonical run sets a baseline.

## 0. Scope and what this builds on

The previous two proposals settled *what* the platform produces (verified evidence, reports, derived
entities, prepared content, retrieval surfaces). This one settles *how the platform knows it is
getting better at producing them*, and how that knowledge drives change. It covers Mission Control
(mission outcomes), Knowledge Services (knowledge artefacts and retrieval), the AI Engineer and Biotech
stores (where records land), and the web application (where users and reviewers act).

An inventory of the four repositories on 2026-10-18 found that the platform already holds most of
the loop's *schema*, with far fewer *writers*. The proposal is therefore ordered to write what exists
before creating anything new.

| Layer | What exists (verified in source) | What is missing |
| --- | --- | --- |
| Mission verdicts (MC) | `GoalVerificationResult` with decision, rubric/acceptance refs, unmet obligations, `actual_usage`; `CompletionValidation` with per-criterion checks; `HumanGateOutcome` with actor, comment, feedback artefacts; `RunOutcome` reducer; usage dimensions and budget ledger. | `mission_control.evidence_assessment` and `completion_decision` have **no writer**; verdicts live in Python and Temporal state. `EvaluationProfileDefinition.online_evaluators_enabled` is `Literal[False]`. Evaluator Optimizer is "specified and not implemented". No OpenTelemetry exporter; LangSmith tracing only. |
| Offline retrieval evaluation (KS) | `packages/evaluation`: frozen datasets with graded qrels, partitions and leakage audit; `evaluateRetrieval`; `ExperimentMatrix`; `evaluatePromotionGate`; `proveRollback`; writers for `evaluation.eval_dataset/eval_case/eval_run/eval_run_case_output/promotion_gate_result/regression_baseline` and `evaluation.experiment/experiment_arm`. | Experiments accept caller-supplied outputs; the broad corpus has only run in memory; the regression gate compares the control against itself. `evaluation.metric_observation` and `eval_score` are inserted only by tests. |
| Human review and statistics (KS) | Gate-5 human rubric (pass/fail/uncertain; accept/reject/needs_follow_up) with agreement metrics; verification annotation packs with nine semantic labels; human-gold admission and adjudication queues; `wilson95`, `mcnemarExact`, `pairedClusterBootstrap`, `pairedSignFlipTest`, `verificationCalibration` (Brier, ECE), `verificationRiskCoverage`, `holmAdjustment`. | Kappa is mentioned in two documents and computed nowhere. `evaluation.review_task` and `evaluation.review_decision` have no writer; review runs through `knowledge_service.review_*` and file-based packs. |
| Model judges (KS) | `test:live:judge` writes a calibration receipt (model identity, prompt and schema digests, label validity, abstention agreement, positive-evidence agreement, cost); `SemanticJudgeOutputSchema`; `observeSemanticModelDrift`; `semanticCalibrationStatus()` returns `pending_empirical_labels`. | `evaluation.judge_output` (with `calibration_identity`) has no writer. Calibration is a one-off file, not a record the runtime consults. |
| Evidence and reports (AIE contract) | `evidence.claim_evidence_assessment`, `verification_finding`, `verification_adjudication_decision` (human or service reviewer, provenance), `research.report_assessment`, `research.finding.resolution`, `research.downstream_handoff.status`, `evidence.source_query` and `source_result_selection` (agent-side selection with disposition and reason). | `evidence.revalidation_event` (`trigger_kind` includes `eval_failure` and `downstream_use`) has no writer. Nothing records whether a report was used, accepted or overturned downstream. |
| Telemetry (AIE contract, KS) | `observability.trace/span/raw_event/normalized_event/usage_rollup/coordinator_handoff`; KS `OperationMetric`, `ServiceSloSnapshot`, `InMemoryTelemetry`. | **No writer** for any `observability.*` table. KS telemetry is in memory only. |
| Optimisation plane (AIE contract) | `public.factory_candidate` (kinds: instructions, skill, tool, retriever, model_route…), `factory_episode`, `factory_assertion_result`, `factory_score_vector` (`reward_contract_version`, `eligible_for_promotion`), `factory_failure_cluster`, `factory_evolution_proposal`, `factory_experiment/_arm` (`assignment_probability`), `factory_promotion_decision` (`promote/reject/shadow/canary/roll_back/needs_human_review`), `factory_canary_result`; deferred `factory_champion`, `factory_rollback_execution`. | No writer anywhere. Lives in `public` under an `app_factory` migration name. Its vocabulary is exactly what this proposal needs; adoption or retirement is an owner decision (§10.3). |
| Biotech | `Report` (`verdict`, `worldCorrectness`, `policyVersion`), `ReportItem` (`citationCompleteness`, `uncitedSentenceCount`), `Assessment` node (`gradeScheme`, `grade`, `methodVersion`, `inputSetDigest`), `Adjudication`; frozen `evals/v2` suites with blinding protocol, gates and bootstrap intervals; `bks-schema eval` (Recall@10, MRR); question Q-K-24 "producer error rate per agent/model version". | Protocol states "No LLM run has happened". Q-K-24 has no materialised metric. |
| End users | Nothing. | No rating, correction, click, dwell, "citation used", interleaving preference or exposure log. Only agent-side selection exists. |

## 1. The trajectory change: what an enterprise does

An enterprise that sells judgement does four things that a project does not.

1. **It writes down what good means before it does the work.** Every mission has an acceptance
   contract and a rubric version pinned at dispatch (Mission Control already does this through
   `GoalVerificationRequest`). Every report kind has an obligation template (content services §2.1).
   Every retrieval route has a golden set and a gate. A unit of work without a contract cannot be
   scored, and work that cannot be scored cannot improve.
2. **It records every unit of work as a scored episode.** What was asked, which versions of prompt,
   model, skill, policy, index generation and retrieval profile did it, what it cost, what it
   produced, how it was graded, by whom, and what happened to the output afterwards. This is the
   **quality ledger** (§4). The ledger is not observability; observability tells you the system ran,
   the ledger tells you whether it was right.
3. **It turns every human decision into a label.** A reviewer approving a claim, a gate owner
   rejecting a report, a user correcting an answer, an analyst picking the left report over the
   right one: each is an expensive, scarce signal. The enterprise captures it with the subject digest,
   the rubric version and the reason, so that it trains judges, seeds regression cases and reveals
   taste. A decision stored as free text in a JSON blob is a wasted label.
4. **It changes one thing at a time and proves the change.** Candidates (a new prompt, a new
   chunking profile, a new model route) go through an experiment with a pre-registered primary
   metric, guardrails and a statistics plan; the champion changes only on a recorded promotion
   decision; the regression suite only grows. Improvement is a time series of promotion decisions
   with their evidence, not a feeling.

Two consequences change how the code is built.

- **Everything the system produces is a candidate against a contract.** A report, a claim verdict,
  an evidence packet, a retrieval result list, a mission completion: all of them carry a score
  vector (hard gates passed, quality dimensions, cost, latency) computed by versioned graders. The
  score vector is the same shape everywhere (§4.2); only the graders differ.
- **Correctness and taste are different signals and need different machinery.** Correctness is
  settled by deterministic graders and verification: did the claim replay, does the citation entail,
  did the SQL return the asserted fact, did the obligation get met. Taste (is this report the one an
  expert would have written; is this the right level of detail; did the agent pick the right
  sources) is settled only by recorded human preference, learned into calibrated judges and
  content-bearing rubrics. A system that uses a model judge for correctness or a string match for
  taste will drift without noticing.

The platform's product claim, "we provide access to proprietary knowledge and reports", is
therefore a claim about the ledger. A customer setting up a recurring mission for frontier-model
release tracking is buying a process whose acceptance rate, false-acceptance rate, freshness lag and
cost per accepted fact are measured and improving. The ledger is the product's warranty.

## 2. Decision summary

1. **Three loops, one ledger.** Mission loop (per run, owned by Mission Control), knowledge loop
   (per artefact and per retrieval, owned by Knowledge Services) and product loop (per user
   interaction, owned by the web application and the knowledge facade) each produce scored episodes
   that land in one logical quality ledger with one score-vector shape.
2. **Write the tables that exist before adding tables.** Stage E0 (§11) gives writers to
   `evidence_assessment`, `completion_decision`, `judge_output`, `regression`, `review_task`,
   `revalidation_event` and `observability.*` before any new migration. Four additions are proposed
   (feedback event, interaction event, judge calibration, estimate); nothing else.
3. **Graders are versioned, registered and tiered.** Code graders first, model judges second, humans
   third. A model judge is admitted only with a calibration record against human labels (chance-
   corrected agreement, position-swap consistency, per-failure-mode true-positive and true-negative
   rates, cost) and is re-calibrated on any model or prompt change. Raw agreement is never reported
   alone.
4. **Every human decision is a label.** Gate decisions, review decisions, adjudications, report
   acceptance, user corrections and pairwise preferences carry subject digest, contract or rubric
   version, actor identity and reason, and are queryable. They feed judge calibration, regression
   cases, failure taxonomies and taste models.
5. **Correctness through verification, taste through preference.** Correctness graders are
   deterministic or replayable; taste is learned from pairwise human preference per report kind, with
   rubric items derived from accepted expert reports (binary, content-bearing, verifiable), never
   from an LLM asked "is this good".
6. **One experiment contract, three modes.** Offline replay on frozen datasets, shadow or
   interleaved on live traffic, canary with rollback. Hypothesis, arms as full configuration
   digests, dataset digest, graders, primary metric, guardrails and statistics plan are pre-registered.
   The existing `evaluation.experiment` and `factory_experiment` are reconciled into this contract.
7. **Champion and challenger per cell.** Promotion is a recorded decision per (domain, route or
   report kind, query class), with the vocabulary promote / reject / shadow / canary / roll_back /
   needs_human_review. Rollback is proven, not assumed.
8. **Optimisers propose, gates dispose.** Automatic optimisation (reflective prompt evolution,
   parameter sweeps, learned judges) produces candidates with the textual feedback that motivated
   them. No optimiser writes production configuration. Every optimised candidate passes the same
   experiment and regression gates as a human change.
9. **Improvement is a scorecard, published as a report.** A monthly quality report per domain is a
   report kind in the catalogue, generated from the ledger, with the regression pass rate, capability
   climb, reliability (pass^k), false acceptance, judge agreement, cost per accepted claim and report,
   review load per accepted report, user acceptance and downstream overturn rate.
10. **Error analysis is a scheduled human practice, not a tool.** A named person reads a fixed
    sample of transcripts weekly, codes failures, and the taxonomy drives which graders and cases get
    built next. The platform supports it; it does not replace it.

## 3. The three loops

Each loop is described by the same six fields so that the ledger shape in §4 follows directly.

### 3.1 Mission loop (Mission Control)

| Field | Content |
| --- | --- |
| Unit of work | One mission run, decomposed into stage attempts. |
| Contract | `success_criterion` rows, obligation matrix, `GoalVerifierPolicy` (rubric_ref, rubric_version, acceptance_version), budget bounds, `EffectiveRunConfiguration` digest (compiler version, selected prompt, model, skill and evaluation-profile variants). |
| Graders | Code: `CompletionValidation` criterion checks, budget settlement, artefact schema checks. Model: the independent goal verifier (`GoalVerificationResult`). Human: `HumanGateOutcome`. |
| Signals produced | Decision (accepted / rejected / revision_required / repair_required), unmet obligations, findings, `actual_usage` per dimension, run outcome, review round count, gate comments and feedback artefacts. |
| Decision | `completion_decision` (accepted / rejected / needs_more_work / abandoned) with policy and contract digests. |
| Label yield | Every gate decision and every verifier decision that a human later confirmed or overturned. |

What changes: the verdicts that today live in Python objects and Temporal state are written to
`mission_control.evidence_assessment` (one row per requirement per assessor) and
`mission_control.completion_decision`, keyed by the run configuration digest so that outcome rates
can be grouped by prompt, model and skill version. An **estimate** is recorded at dispatch (expected
turns, tokens, cost, wall clock, expected verifier decision if the mission is a rerun) so that
planned versus actual becomes a column, not an inference from budget reservations. The Evaluator
Optimizer rounds, when implemented, write one `evidence_assessment` per round with the per-dimension
scores.

### 3.2 Knowledge loop (Knowledge Services)

| Field | Content |
| --- | --- |
| Unit of work | A verification run over claims; a report assessment; a preparation and ingestion operation; a retrieval run; a publication or promotion. |
| Contract | Verification policy version and level (verification proposal §3); report kind obligation template (content services §2.1); chunking profile and index generation; `RetrievalProfile` version; promotion gate definition. |
| Graders | Code: locator replay, citation entailment, schema validation, coverage, duplicate detection, `evaluateRetrieval` metrics. Model: semantic judge (calibrated), rubric judges per report kind. Human: reviewers through `knowledge_service.review_decision`, adjudicators through `verification_adjudication_decision`, annotation packs. |
| Signals produced | Claim verdicts and support labels, report assessments, conversion grades and coverage, retrieval metrics per case, abstention and false acceptance, judge outputs with prompt and model identity, review decisions with rationale. |
| Decision | Admission (claim, content tier R0–R3), publication (index generation pointer), promotion (retrieval profile champion), regression waiver (`review_subject.subject_kind = regression_waiver`). |
| Label yield | Human semantic labels on evidence; accepted and rejected report versions; adjudications that overturned a judge; reviewer rationale. |

What changes: experiments execute on the canonical retrieval executor instead of accepting caller
outputs; judge outputs are persisted with their calibration identity; review tasks and decisions in
the `evaluation` schema get writers; the semantic judge's calibration status moves from
`pending_empirical_labels` to a stored record that the runtime checks before trusting a probability.

### 3.3 Product loop (web application and knowledge facade)

| Field | Content |
| --- | --- |
| Unit of work | One user question answered by a service agent; one report delivered; one search in the web application; one recurring mission result consumed. |
| Contract | Route (Direct / Fast / Explore / Research) and the facade's answer contract (evidence packet, citations, abstention). |
| Graders | Code: citation presence and replay, abstention when coverage is low, latency. Model: groundedness and answer-relevance judges on a sampled fraction. Human: the user. |
| Signals produced | Explicit: rating, correction, "wrong source", "out of date", report accepted or rejected by the requester. Implicit: citation opened, result selected, dwell, follow-up question, report downloaded or forwarded, recurring mission kept or cancelled. Comparative: interleaving preference between champion and challenger. |
| Decision | Which profile serves which route; which report kinds are offered; which recurring missions are promoted to catalogue templates. |
| Label yield | Corrections are the richest label in the system: a user stating the right answer with a source becomes a verification case and a retrieval case at once. |

What changes: this loop does not exist. §4.4 proposes its two tables and §10.5 the UI surfaces.

## 4. The quality ledger

### 4.1 Principle

One logical ledger, several physical homes. The homes already exist: `mission_control.*` for mission
verdicts, `evaluation.*` for graded runs, `evidence.*` and `research.*` for claim and report
assessments, `public.factory_*` for candidates and promotion (if adopted), `observability.*` for cost
and latency, and the Biotech graph's `Assessment` and `Adjudication` nodes. The proposal does not
merge them. It fixes one record shape that every home can emit, and one analytic export that joins
them.

### 4.2 The score vector (one shape everywhere)

```yaml
ScoreVector:                      # emitted by every grader on every subject
  subjectRef:        { kind: report_version | claim | evidence_packet | retrieval_run | mission_run | stage_attempt | answer, id, digest }
  contractRef:       { kind: acceptance_contract | obligation_template | promotion_gate | retrieval_profile | verification_policy, id, version }
  configurationDigest: sha256     # EffectiveRunConfiguration, or index generation × profile, or policy version
  graderRef:         { id, version, tier: code | model | human, calibrationId?: string }
  hardGates:         [{ id, passed: bool, reason? }]
  dimensions:        [{ id, value: number, scale: binary | graded_0_3 | probability | count, evidenceRef? }]
  usage:             { inputTokens?, outputTokens?, toolCalls?, wallClockMs?, costMicros? }
  traceRef?:         string
  producedAt:        timestamp
  labelProvenance:   human_origin | model_judge | deterministic | synthetic_engineering
```

Mapping to existing homes:

| Home | Existing columns that already carry the shape | Gap |
| --- | --- | --- |
| `mission_control.evidence_assessment` | requirement_ref, assessor_identity, capability_version, rubric_version, policy_version, disposition, report_ref/digest | dimensions and usage live on the report artefact; configuration digest must be added or carried in the report. |
| `evaluation.eval_score` + `metric_observation` | metrics, passed, false_acceptance, false_rejection; metric_definition slug/version | grader_version is on `eval_run`; fine. |
| `evidence.claim_evidence_assessment` | verdict, authority_assessment, replay_signature_match | no usage; acceptable, cost is on the verification run. |
| `public.factory_score_vector` | reward_contract_version, weighted_score, eligible_for_promotion; `factory_assertion_result` has evaluator_version, hard_gate, score | closest match to the full shape. |
| Biotech `Assessment` | assessmentKind, disposition, verdict, certainty, gradeScheme, grade, methodVersion, inputSetDigest | dimensions as a map property or child nodes; owner decision in the v2 release program. |

Rule: a grader that cannot fill `contractRef`, `graderRef.version` and `configurationDigest` does
not run. This is what makes "producer error rate per model version" (Biotech Q-K-24) a `GROUP BY`
instead of a research project.

### 4.3 Labels

A label is a human decision bound to a subject digest:

```yaml
Label:
  subjectRef, subjectDigest
  rubricRef: { id, version, itemId? }      # which question was being answered
  value: accept | reject | pass | fail | uncertain | <semantic label> | <preference: left | right | tie>
  comparedToRef?: subjectRef               # pairwise only
  actor: { identity, role, provenance: human_origin | synthetic_engineering }
  rationale: text                          # mandatory; one sentence minimum
  context: { route?, reportKind?, domain?, queryClass? }
  recordedAt
```

Existing homes already hold labels in this shape or close to it: `HumanGateOutcome` (needs the
rubric item), `knowledge_service.review_decision` (has rationale and role), `verification_adjudication_decision`
(has provenance), `evaluation.eval_label`, human annotation packs. The gap is not a table; it is a
rule that every path that records a human decision also records the rubric item and the subject
digest, and that the decision is queryable with the configuration digest that produced the subject.

### 4.4 Proposed additions (the only new tables)

| Table (owner) | Purpose | Columns |
| --- | --- | --- |
| `feedback.event` (AIE contract; Biotech equivalent as an `Assessment` with `assessmentKind = user_feedback`) | Explicit end-user feedback | subject_ref, subject_digest, feedback_kind (rating / correction / wrong_source / out_of_date / accept_report / reject_report), value, correction_text, correction_source_ref, user_ref (pseudonymous), route, recorded_at |
| `feedback.interaction` (AIE contract) | Implicit interaction, sampled and pseudonymous | session_ref, subject_ref, action (citation_opened / result_selected / dwell / followup / download / forward / mission_kept / mission_cancelled), position, value, recorded_at |
| `evaluation.judge_calibration` (AIE contract) | The admission record for a model judge | grader_version_id, calibration_dataset_digest, n, raw_agreement, cohen_kappa, krippendorff_alpha?, position_swap_consistency, per_failure_mode (tpr, tnr), brier, ece, cost_per_judgment_micros, admitted bool, admitted_by, valid_until, notes |
| `mission_control.run_estimate` (MC contract) | Planned values at dispatch | run_id, configuration_digest, expected_usage per dimension, expected_decision?, estimator_version, recorded_at |

Everything else in this proposal writes to tables that exist.

### 4.5 Analytic export

A read-only export (materialised view or nightly job) joins the homes into a flat
`quality.episode` fact table: one row per (subject, grader version), with configuration digest, domain,
route, report kind, query class, score dimensions, hard gates, cost, labels, and downstream outcome.
The scorecard (§9), the error-analysis sampler (§6.4) and the optimiser (§8) read only from this
export. Keeping consumers off the operational tables is what lets the homes stay separate.

## 5. Graders

### 5.1 Three tiers and when each is allowed

| Tier | Use for | Never for | Examples in the platform |
| --- | --- | --- | --- |
| Code | Anything with an objective rule: replay, entailment of a quoted span, schema validity, presence of required obligations, filter satisfaction, duplicate detection, latency, cost, state checks (did the fact land in the store with the right validity interval). | Judging prose quality or sufficiency. | Deterministic verification, `evaluateRetrieval`, `CompletionValidation`, conversion coverage. |
| Model judge | Dimensions requiring reading: groundedness of a synthesis against a packet, whether a report meets a content-bearing rubric item, whether an abstention was appropriate, classifying a failure into the taxonomy. | Overriding a deterministic failure (already a repository invariant). Emitting ontology identifiers. Being the only grader on a correctness dimension. | Semantic judge, future report-kind rubric judges, groundedness sampler in the product loop. |
| Human | Calibration sets for every model judge; pairwise taste preference; adjudication of disagreements; error analysis; acceptance of reports that leave the platform. | Routine volume. | Gate-5 rubric, annotation packs, review decisions, gate owners. |

Grading rules carried over from field practice:

- Grade what was produced, not the path, except where the path is the contract (a required tool call
  such as verification before publication). Transcript constraints are tracked metrics, not graders.
- Give partial credit on multi-part obligations; binary-only scoring hides progress.
- Give every judge an "unknown" exit and count its use.
- Grade one dimension per judge call with a structured output; a single "overall quality" call is not
  a grader.
- Use a judge from a different model family than the producer where possible, or a panel; record
  self-preference risk in the calibration notes.
- Swap positions on every pairwise call and count a flip as a tie.
- A 0% pass rate across many trials is a broken task before it is an incapable agent; a reference
  solution must pass every grader before the task is admitted.

### 5.2 The grader registry

`evaluation.grader` and `grader_version` (model, prompt, config) exist. The registry adds:

- `tier`, `dimensionIds`, `subjectKinds`, `inputContract` (what the grader must be given: packet,
  report version, rubric item, reference solution).
- `calibrationId` for model judges (§5.3), with `admitted` and `valid_until`.
- `knownFailureModes`, mirroring `catalog/capability-profiles.v1.json`.
- A `GraderRunner` in `packages/evaluation` that executes a grader version on a subject, applies
  position swapping and the unknown exit, and writes `evaluation.judge_output` (prompt_sha256,
  model_identity, calibration_identity, output) and a `ScoreVector`. The runner refuses to run a model
  judge whose calibration is missing, expired or whose model identity drifted (`observeSemanticModelDrift`
  already detects the drift).

### 5.3 Judge calibration protocol

A model judge is a measurement instrument; it is validated like one.

1. **Calibration set.** 100–200 human-labelled items per failure mode or dimension, balanced
   between positive and negative, drawn from real traces, labelled by the named domain owner, with
   a second labeller on a 30-item slice to establish human–human agreement as the ceiling.
2. **Metrics.** Chance-corrected agreement (Cohen's kappa for two raters, Krippendorff's alpha for
   more), never raw agreement alone: the 2026 large-scale judge study found 33–41 points of kappa
   deflation between exact match and kappa on MT-Bench, and production judges with test–retest
   reliability above 0.95 that still carried position bias above 0.10. Per failure mode: true
   positive and true negative rate, both required above a placeholder of 0.80 before admission.
   Position-swap consistency on pairwise rubrics. Brier and ECE if the judge emits probabilities
   (`verificationCalibration` exists). Cost per judgment.
3. **Admission.** The calibration record is written to `evaluation.judge_calibration` and the grader
   version is marked admitted with a validity window. Admission is a review decision
   (`review_subject.subject_kind = harness_promotion` is the nearest existing kind).
4. **Re-calibration triggers.** Model identity change, prompt or schema digest change, calibration
   validity expiry, a measured disagreement spike in adjudication, or a new failure mode in the
   taxonomy.
5. **Continuous check.** A sampled fraction of production judge outputs goes to human adjudication
   every week; the running kappa is on the scorecard. When it falls below the admission floor, the
   judge is demoted to advisory and its dimensions are flagged in every gate it feeds.

### 5.4 Rubrics per report kind

Content services §2.1 defines ten report kinds. Each gets a rubric with two parts:

- **Obligation items** (correctness): derived mechanically from the obligation template; binary;
  graded by code where possible (required sections present, every quantitative claim bound to a
  verified assertion, time coverage stated, sources vetted at the required level).
- **Content items** (taste and depth): binary, content-bearing, verifiable statements of what a
  strong report on this question contains, derived from accepted expert reports on the same
  question, not from an LLM's generic criteria. DeepResearch Bench II built 9,430 such items from
  132 expert reports and found the strongest agents satisfy fewer than half; its central finding is
  that coarse or LLM-defined rubrics let plausible hallucinations pass and fine-grained,
  expert-derived rubrics do not. The platform's equivalent source is its own accepted reports: every
  report a gate owner accepts yields candidate rubric items for that question family, reviewed and
  versioned.

Rubrics are versioned artefacts (`rubric_version` already exists on `evidence_assessment` and
`GoalVerifierPolicy`). A rubric change is a candidate like any other and goes through §7.

### 5.5 Correctness versus taste

| | Correctness | Taste (judgement) |
| --- | --- | --- |
| Question | Is it right, supported, complete against the contract? | Is it what the expert would have wanted? |
| Ground truth | Replay, entailment, store state, obligation checks. | Recorded human preference. |
| Primary grader | Code; model judge only on dimensions that need reading, calibrated. | Pairwise human comparison; learned judge calibrated on those comparisons. |
| Aggregation | Hard gates and rates (false acceptance, citation correctness, pass^k). | Bradley–Terry strength per candidate from pairwise outcomes; win rate against champion. |
| Where it lives | Verification system, obligation templates, retrieval gates. | Report-kind content rubrics, preference labels, interleaving. |
| Failure if confused | Model judge passes a fluent hallucination. | String match rejects a better report. |

Taste is learnable. The 2026 "scientific taste" work trains a judge from community feedback
(citations) and shows it generalises to future years and unseen fields. The platform's community
feedback is the gate owner's accept/reject, the user's keep/cancel of a recurring mission, and the
downstream overturn rate. These are the training signal for a per-domain taste judge once volume
exists (§8.4); until then, pairwise human preference on a fixed sample is the only taste measurement
that counts.

## 6. Signals and labels: where feedback comes from

### 6.1 Signal catalogue

| Signal | Loop | Recorded where (existing or proposed) | Label yield | Status |
| --- | --- | --- | --- | --- |
| Verifier decision and unmet obligations | Mission | `evidence_assessment` (write), `completion_decision` (write) | Model label; becomes human label when a gate confirms or overturns | Table exists, no writer |
| Human gate outcome, comment, review round | Mission | `human_resolution`, `HumanGateOutcome` | Human label on mission output | Written; lacks rubric item and subject digest |
| Planned vs actual usage | Mission | `run_estimate` (new) vs `actual_usage` | None; forecasting signal | Absent |
| Claim verdicts and adjudications | Knowledge | `claim_evidence_assessment`, `verification_adjudication_decision` | Human label when adjudicated | Written |
| Review decisions with rationale | Knowledge | `knowledge_service.review_decision` | Human label | Written |
| Judge outputs with calibration identity | Knowledge | `evaluation.judge_output` | Model label | Table exists, no writer |
| Retrieval metrics per case | Knowledge | `eval_score`, `metric_observation` | Code label | Written only by tests |
| Agent-side result selection | Knowledge | `evidence.source_result_selection` (rank, disposition, reason) | Weak relevance label | Written |
| Report acceptance by requester | Product / Mission | `feedback.event` (new) and `research.report_version` status | Human label; taste source | Absent |
| Downstream use or overturn | Product | `downstream_handoff.status` (written), `revalidation_event` with `downstream_use` (no writer), `feedback.event` | Outcome label | Partial |
| User rating and correction | Product | `feedback.event` (new) | Human label; a correction with a source becomes a verification case and a retrieval case | Absent |
| Implicit interaction | Product | `feedback.interaction` (new) | Weak preference | Absent |
| Interleaving preference | Product | `factory_experiment_arm` exposure plus `feedback.interaction` | Comparative label on retrieval profiles | Absent |
| Cost and latency per span | All | `observability.span`, `usage_rollup` | None; denominator for cost per accepted outcome | Table exists, no writer |

### 6.2 The label rule

Every path that records a human decision must record, in the same write: the subject digest, the
rubric or contract item being answered, the actor identity and role, a rationale, and the
configuration digest of the producer. Mission Control's gate path, Knowledge Services' review path
and the web application's feedback path all adopt this. Labels without a rubric item are stored but
cannot calibrate a judge or seed a regression case.

### 6.3 From label to asset

| Label | Becomes |
| --- | --- |
| Reviewer rejects a claim verdict | Verification benchmark case (human gold admission exists); failure-taxonomy count |
| Gate owner rejects a report with reason | Candidate content rubric item; regression case for that report kind; failure-taxonomy count |
| User correction with source | Verification case (expected locator), retrieval case (expected result), ingestion intent for review |
| Pairwise preference | Bradley–Terry update for the two configurations; training row for the taste judge |
| Adjudication overturning a judge | Calibration set row; re-calibration trigger if the rate spikes |
| Recurring mission cancelled | Outcome label on that mission template; prompt for error analysis |

### 6.4 Error analysis as a scheduled practice

Field evidence from practitioners is unambiguous: the most valuable evaluation activity is a human
reading traces and writing down what went wrong, before any judge or dashboard is built. The
platform institutionalises it:

- **Cadence.** Weekly, per domain, a named owner (one person, the "benevolent dictator" for that
  domain's quality) reads a sample of 20–50 episodes: stratified across routes and report kinds,
  over-sampling low scores, user complaints, judge–human disagreements and abstentions.
- **Open coding.** One free-text note per episode naming the first failure observed. Stored as a
  `Label` with `rubricRef = open_code`.
- **Axial coding.** Notes are clustered into a failure taxonomy; `factory_failure_cluster` is the
  existing home for the clusters, with counts per configuration digest. An LLM may propose
  clusters; the owner validates them.
- **Output.** Each taxonomy item with meaningful count gets, in order: a regression case, a code
  grader if a rule exists, a model judge with a calibration set if not. The taxonomy and counts
  appear on the scorecard. Saturation (no new failure modes in three consecutive sessions) is the
  signal to shrink the sample, not to stop.
- **Tooling.** A review workbench in the web application (§10.5) that renders an episode with its
  transcript, packet, scores, labels and configuration, with keyboard-driven labelling. The existing
  `renderHumanReviewHtml` and annotation packs are the seed.

## 7. Experiments and promotion

### 7.1 One experiment contract

```yaml
Experiment:
  id, hypothesis (one sentence, falsifiable)
  subjectKind: retrieval_profile | index_generation | chunking_profile | prompt | skill | tool_policy | model_route | verification_policy | rubric | cognition_pack | mission_template
  cell: { domain, route?: Direct|Fast|Explore|Research, reportKind?, queryClass? }
  arms: [{ id, isControl, configurationDigest, description }]   # full digests, never opaque JSON
  mode: offline_replay | shadow | interleave | canary
  dataset: { digest, partition: heldout }                        # offline; or traffic spec for online
  graders: [graderVersionId]                                      # all admitted
  primaryMetric: { dimensionId, direction, minimumDetectableEffect }
  guardrails: [{ dimensionId, bound }]                            # false acceptance, citation correctness, p95, cost, abstention rate
  statistics: { test: paired_cluster_bootstrap | sign_flip | mcnemar | sequential, clusterUnit, alpha, correction: holm, trials: k }
  preRegisteredAt, registeredBy
  result?: { per-arm summaries, pairwise deltas with intervals, guardrail outcomes, decision }
```

Three existing homes carry parts of this: `evaluation.experiment/experiment_arm` (hypothesis,
configuration, is_control), `packages/evaluation` `ExperimentMatrix`, and `factory_experiment/_arm`
(assignment_probability for online modes). The contract above is the superset; the owner decides
which physical home survives (§10.3). What matters is that no experiment runs without a
pre-registered primary metric, a minimum detectable effect and guardrails, because an experiment
registered after the result is a story, not evidence.

### 7.2 Modes

| Mode | When | Mechanism | Decision statistic |
| --- | --- | --- | --- |
| Offline replay | Every candidate, first | Canonical executor runs each arm on a frozen held-out dataset; graders score; paired comparison per case. | Paired cluster bootstrap interval on the primary metric; sign-flip or McNemar on binary dimensions; Holm across dimensions; all exist in `verification-statistics.ts`. |
| Shadow | Candidate passed offline; affects an agent-facing surface | Candidate runs alongside champion on live requests; only champion's output is served; both are graded. | Same as offline, on live distribution; also drift of input mix. |
| Interleave | Candidate affects a ranked list the user sees | Team-draft interleaving of champion and candidate results in the web application; user selections credited to the contributing arm. | Preference win rate with sequential test; far more sensitive than A/B on the same traffic. |
| Canary | Candidate affects answers or reports; interleaving not applicable | Fraction of traffic served by candidate with guardrail monitoring and automatic rollback. | Guardrail breach count; sequential test on user acceptance. `factory_canary_result` holds traffic_fraction and rollback_reason. |

Reliability is measured with repeated trials. For agent surfaces, report pass^k (all of k trials
succeed) alongside pass@k; an agent with 75% per-trial success passes three trials only 42% of the
time, and customer-facing routes are experienced as pass^k. Trials run from a clean environment; shared
state between trials has been shown to both inflate and depress results.

### 7.3 Promotion

A promotion decision is recorded per cell with the vocabulary promote / reject / shadow / canary /
roll_back / needs_human_review (the `factory_promotion_decision` enumeration), the experiment id,
the gate result digest (`evaluatePromotionGate` output) and the reviewer. The champion for a cell is
the last promoted configuration; `factory_champion` (deferred migration) or a `retrieval_profile_promotion_decision`
(content services §6.3) is the pointer. Rollback is executed and proven with `proveRollback`, and a
rollback is itself a promotion decision with reason.

Gate structure stays as built: hard gates (zero false acceptance, every citation valid) that cannot
be waived; quality minimums per dimension; regression limits against the champion overall and per
domain and query class; latency and cost caps. A waiver is a `review_subject` of kind
`regression_waiver` with quorum, never a flag.

### 7.4 Regression suites only grow

Each promoted candidate's experiment cases join the regression suite for its cell. Capability suites
that reach a placeholder of 95% pass rate graduate to regression. A regression suite below 100% blocks
promotion in that cell until a waiver or a fix. Dataset staleness is managed by error analysis
(§6.4), not by discarding cases: a case whose expectation changed is superseded, with the reason, so
that scores stay comparable across versions.

## 8. Optimisation loops

The ordering is by trust, and every tier produces candidates for §7, never production changes.

### 8.1 Tier 0: gated manual change

The default. A human changes a prompt, profile or policy; it becomes a candidate with a configuration
digest; it goes through offline replay and the regression suite. This is already the intent of the
promotion gates; what is new is that it applies to prompts, skills and mission templates as well as
to vector spaces.

### 8.2 Tier 1: parameter sweeps

Fusion weights, candidate depths, reranker on or off, chunk size, overlap, contextual prefix,
verification level thresholds. `ExperimentMatrix` already expresses arms; the Experiment Service
(§10.2) runs them on the canonical executor and records the matrix. Sweeps are cheap because the
graders are code.

### 8.3 Tier 2: reflective prompt and instruction evolution

For prompts and skill instructions, reflective optimisation (GEPA, ICLR 2026) outperforms both
Bayesian prompt search and reinforcement learning on the reported tasks while using up to 35× fewer
rollouts, because it reads *why* a trial failed rather than a scalar reward. Its precondition is
exactly what §5 produces: graders that return textual feedback ("the report asserted a date the packet
does not support; the obligation 'state time coverage' is unmet") rather than a float. The platform's
adoption:

- Input: 20–100 episodes for the target prompt from the ledger, with grader feedback text, from the
  `dev` partition only.
- Process: the optimiser proposes instruction variants, evaluates on `dev`, keeps a Pareto frontier
  across dimensions (never a single weighted score), and emits the frontier as `factory_evolution_proposal`
  rows, each carrying the feedback that motivated it and its measured `dev` scores.
- Gate: every proposal is a candidate in §7, evaluated on `heldout` it has never seen, with the
  regression suite and the guardrails. Prompt length is a tracked cost dimension.
- Guard against reward hacking: balanced problem sets (both "should search" and "should not search"
  cases, as the Claude.ai web search team found necessary), a judge from a different family than
  the producer, human spot check of the top proposal's transcripts, and an explicit search for
  loophole solutions in the transcripts.

### 8.4 Tier 3: learned judges and taste models

When a cell has accumulated enough pairwise preferences and accept/reject labels (order of a few
thousand), train or fine-tune a per-domain judge on them, calibrate it under §5.3, and admit it as a
grader. This is the platform's version of learning from community feedback. It is explicitly later
work; the labels must exist first.

### 8.5 Out of scope

Weight updates to production models by the platform itself. Candidate model routes (including
fine-tuned models produced elsewhere) are evaluated as `model_route` candidates; the platform does
not train them.

## 9. Proving improvement: the scorecard

The scorecard is a report kind ("quality report", added to the content services catalogue) generated
monthly per domain from the analytic export, itself subject to the obligation template rule. Its
sections and metrics:

| Section | Metric | Direction | Why it is on the card |
| --- | --- | --- | --- |
| Holding the line | Regression suite pass rate per cell | Stays at 100% | Backsliding is the first thing customers notice. |
| Climbing | Capability suite pass rate per cell; graduated suites this period | Up; graduations counted | Shows the hill and progress on it; saturation is visible. |
| Reliability | pass^3 on agent-facing routes | Up | Users experience consistency, not best-of. |
| Correctness | False acceptance count (hard gate), citation correctness, verification precision on adjudicated sample | Zero; up; up | The warranty. |
| Judge health | Kappa judge vs human per admitted judge; unknown-exit rate; position-swap consistency | Above floor; stable; above floor | A drifting judge invalidates every gate it feeds. |
| Human load | Review minutes per accepted report; adjudications per 100 claims | Down | Measures whether automation is earning trust. |
| Economics | Cost per accepted claim; cost per accepted report; planned vs actual cost error | Down; down; narrowing | Joins `budget_ledger` and spans to acceptance; today impossible. |
| Product | User acceptance rate per report kind; correction rate; downstream overturn rate; recurring missions kept | Up; down; down; up | The only metrics that are not proxies. |
| Learning | Failure taxonomy counts by cluster and configuration; new modes found; promotions and rollbacks with reasons | Trend; falling discovery rate; documented | The organisation's memory. |

Two rules keep the card honest. Scores are reported per cell and never only in aggregate, because a
polished average hides a consequential slice. Every number links to the experiment, dataset digest and
grader version that produced it; a number without lineage is not on the card.

## 10. Responsibilities and the code to build

### 10.1 Mission Control

- Write `mission_control.evidence_assessment` from `GoalVerificationResult` (one row per requirement
  per round) and `completion_decision` from the terminal reducer, with the `EffectiveRunConfiguration`
  digest. These are the two highest-value, lowest-cost writes in the platform.
- Record `run_estimate` at dispatch; surface planned vs actual on the run evidence read model.
- Extend `HumanGateOutcome` persistence with rubric item and subject digest (§6.2).
- Implement the Evaluator Optimizer as specified, writing per-round assessments.
- Decide the fate of `online_evaluators_enabled: Literal[False]`: keep it false for in-run gating,
  but allow post-run sampled grading by Knowledge Services' grader runner.
- Emit outcome events (completion decision, gate outcome) on the existing event stream so the
  ledger export does not poll.

### 10.2 Knowledge Services

- `packages/evaluation` grows into the **grader runtime**: grader registry, `GraderRunner` with
  position swapping and unknown exit, calibration computation (add Cohen's kappa and Krippendorff's
  alpha beside the existing statistics), judge calibration record writer, rubric catalogue per
  report kind.
- **Experiment Service** in `packages/application`: the one experiment contract, offline replay on
  the canonical retrieval executor (content services P01–P04 are prerequisites), shadow and
  interleave hooks on the knowledge facade, promotion decision writer, regression suite management.
  This absorbs the "caller-supplied outputs" defect.
- Writers for `evaluation.judge_output`, `evaluation.regression`, `evaluation.review_task` and
  `evaluation.review_decision`, `evidence.revalidation_event` on eval failure and downstream use.
- **Telemetry writer**: persist `OperationMetric` to `observability.span` and roll up to
  `usage_rollup`; produce `ServiceSloSnapshot` from stored data, not memory. An OpenTelemetry
  exporter is the natural transport; Mission Control's LangSmith traces can be bridged later.
- **Feedback intake** on the knowledge facade: `knowledge.feedback.submit` (rating, correction,
  report accept/reject) and `knowledge.interaction.record` (sampled), writing `feedback.*`, and the
  label-to-asset transformations (§6.3).
- **Optimiser package** (proposed `packages/optimization`): tier-1 sweeps and tier-2 reflective
  prompt evolution, reading the analytic export, writing `factory_evolution_proposal` candidates,
  never configuration.
- **Quality report** generator: the scorecard as a report kind with `report_register`.

### 10.3 Database contracts (owner decisions)

- AI Engineer contract: the four additions in §4.4; no other new tables. Decision needed on
  `public.factory_*`: **adopt** it as the optimisation plane (its candidate, episode, score vector,
  failure cluster, proposal, experiment, promotion and canary tables match this proposal nearly
  one-to-one) and move it under an `optimization` schema in a later migration, or **retire** it and
  extend `evaluation.*`. The recommendation is to adopt: the vocabulary is right and the tables are
  empty, so the move is cheap now and expensive later.
- Mission Control contract: `run_estimate`; configuration digest on `evidence_assessment` if the
  report artefact does not carry it.
- Biotech: `Assessment` gains `assessmentKind = user_feedback` and a dimensions map; Q-K-24 is
  materialised as a query over `Assessment` grouped by the producing `Activity`'s policy and model
  version; the `evals/v2` suites get their first recorded LLM run under the existing blinding protocol.

### 10.4 Biotech versus AI Engineer

Same loops, same score vector, same experiment contract. Differences are the physical home
(`Assessment` and `Adjudication` nodes versus `evaluation.*` and `evidence.*` tables), the rubric
content per report kind (study appraisal rubrics draw on GRADE and risk-of-bias instruments;
engineering rubrics on reproducibility and benchmark provenance), and maturity: Biotech has frozen
suites with a blinding protocol and no LLM run; AI Engineer has a judge calibration receipt and no
persisted calibration. Neither has a product loop.

### 10.5 Web application

- Feedback controls on every answer and report: rating, "wrong source", "out of date", correction
  with source, accept/reject for delivered reports.
- Team-draft interleaving in search results when a challenger exists for the cell.
- Review workbench for error analysis and adjudication: episode view with transcript, packet,
  scores, labels, configuration; keyboard labelling; pairwise comparison view for taste labels.
- Scorecard view reading the quality report.

## 11. Implementation stages and proposed issues

Ordered so that the first scorecard with real numbers appears at stage E2, before any optimiser.

| Stage | Content | Exit criterion |
| --- | --- | --- |
| E0 Instrument | Writers for `evidence_assessment`, `completion_decision`, `judge_output`, `regression`, `review_task/decision`, `revalidation_event`, `observability.span/usage_rollup`; label rule on the three human-decision paths; `run_estimate`. | Every mission run and every verification run in the last 7 days has rows in the ledger homes with configuration digests. |
| E1 Read | First error-analysis cycle per domain: 30 episodes hand-read, open codes, first failure taxonomy in `factory_failure_cluster` (or `evaluation` equivalent), regression cases seeded from gate rejections. | A taxonomy with counts exists; at least 20 regression cases per domain come from real failures. |
| E2 Measure | Experiment Service offline mode on the canonical executor; first canonical retrieval baseline (content services stage A); first judge calibration with kappa, written and admitted; first quality report. | A scorecard with lineage exists for both domains. |
| E3 Compare | Champion/challenger per cell; second canonical run as first comparison; regression suite management; rubric v1 per report kind with obligation items and first content items from accepted reports. | One promotion decision with experiment lineage recorded per domain. |
| E4 Listen | Feedback intake and interaction recording; label-to-asset transformations; interleaving on one route; downstream overturn tracking. | User labels flow into regression cases and calibration sets; one interleaving experiment concluded. |
| E5 Optimise | Tier-1 sweeps and tier-2 reflective prompt evolution under the gates; proposals with feedback text. | One optimiser-proposed candidate promoted or rejected through the full gate, with the transcript spot check recorded. |
| E6 Learn | Taste judge per domain from accumulated preferences, calibrated and admitted; quarterly review of the scorecard trend. | Judge admitted with kappa above floor on a held-out preference set. |

Proposed issues (provisional identifiers, for the owner to open or discard):

- **Q01** MC: write `evidence_assessment` and `completion_decision` with configuration digest.
- **Q02** MC: `run_estimate` and planned-vs-actual on run evidence.
- **Q03** MC and KS: label rule on gate, review and adjudication paths (rubric item, subject digest, rationale).
- **Q04** KS: grader registry, `GraderRunner`, `judge_output` writer, kappa and alpha in statistics.
- **Q05** KS: `judge_calibration` record, admission as a review subject, re-calibration triggers.
- **Q06** KS: Experiment Service with the one contract; offline replay on canonical executor (depends on content services P01–P04).
- **Q07** KS: promotion decision writer, champion pointer, regression suite management, waiver as review subject.
- **Q08** KS: telemetry writer for `observability.*`; SLO snapshot from stored data.
- **Q09** KS and web: feedback intake, interaction recording, label-to-asset transformations.
- **Q10** Web: interleaving on one route; review workbench; scorecard view.
- **Q11** KS: rubric catalogue per report kind; content items from accepted reports.
- **Q12** KS: quality report kind and generator.
- **Q13** KS: optimisation package, tier 1 and 2, proposals only.
- **Q14** DB contract: adopt or retire `factory_*`; four new tables.
- **Q15** Biotech: `Assessment` extensions, Q-K-24 materialisation, first recorded `evals/v2` LLM run.
- **Q16** All: weekly error-analysis cadence with named owners per domain; the first three sessions' taxonomies committed.

## 12. What is explicitly not established

- No number in this document has been measured on production traffic or on the canonical executor.
  All floors (kappa, true-positive rate 0.80, capability graduation at 95%) are placeholders.
- Whether `public.factory_*` is adopted or retired is an owner decision; the proposal recommends
  adoption but has not assessed the migration cost of moving schemas.
- Volume needed for a learned taste judge is an order-of-magnitude guess; the preference labels do
  not exist yet.
- Interleaving credit assignment for evidence packets (as opposed to ranked lists) is unspecified.
- The privacy posture of `feedback.interaction` (sampling rate, pseudonymisation, retention) is for
  the owner and must respect the repository rule on PHI and private data.
- External figures (GEPA rollout savings, judge kappa deflation, DeepResearch Bench II rubric
  satisfaction) are reported as published and not reproduced here.

## 13. Vocabulary for speaking about this with precision

| Term | Meaning | Why you care |
| --- | --- | --- |
| Capability eval vs regression eval | Capability suites start with low pass rates and give a hill to climb; regression suites sit near 100% and catch backsliding. | Confusing them makes a saturated suite look like progress or a hard suite look like failure. |
| pass@k vs pass^k | Probability that at least one of k trials succeeds vs that all k succeed. | Users experience pass^k. |
| Raw agreement vs kappa | Agreement corrected for chance. | Raw agreement overstates a judge by tens of points on skewed labels. |
| Position bias, self-preference bias | A judge prefers the first option, or outputs from its own model family. | Swap positions; use a different family or a panel. |
| Calibration, Brier, ECE | Whether a stated probability matches the observed frequency. | A judge's 0.9 should be right nine times in ten before anyone acts on it. |
| Risk–coverage curve | Error rate as a function of how many items you accept automatically. | Sets the auto-accept threshold with eyes open. |
| Minimum detectable effect | The smallest improvement an experiment can distinguish from noise at its sample size. | Decides how many cases you need before you run, not after. |
| Paired test, cluster bootstrap | Compare arms on the same cases; resample by cluster (source family, report) to respect dependence. | Unpaired tests on dependent cases produce false confidence. |
| Holm correction | Adjusts significance when testing many dimensions at once. | Ten metrics at 5% each will "win" one by luck. |
| Sequential test | A test valid under continuous monitoring. | Lets you stop a canary early without lying to yourself. |
| Interleaving vs A/B | Mix both rankings in one list and credit clicks, vs split users. | Interleaving needs far less traffic for ranked results. |
| Champion/challenger, shadow, canary | The serving configuration vs a candidate; candidate runs unseen; candidate serves a fraction. | The promotion ladder's rungs. |
| Bradley–Terry | A model that turns pairwise preferences into a strength per candidate. | Turns taste into a number with an interval. |
| Open coding, axial coding | Free-text failure notes, then clustering into a taxonomy. | The step every team skips and regrets. |
| Goodhart, reward hacking | Optimising the measure instead of the goal. | Why optimisers propose and gates dispose. |
| Saturation | A suite everyone passes. | Time to graduate it and build a harder one. |

## 14. Reading route

1. This document, §1 and §2.
2. [Evidence and verification system](../evidence-verification-system-20261017/README.md) for the
   correctness machinery that the graders call.
3. [Content services](../content-services-20261017/README.md) §5–§6 for retrieval profiles, index
   generations and the retrieval evaluation program this proposal generalises.
4. [Evaluation and publication gates](../../../knowledge/evaluation-and-publication-gates.md) and
   [ADR 0003](../../architecture/0003-embedding-retrieval-evaluation.md) for the accepted gate
   invariants that remain in force.
5. [Datasets](../datasets-20261018/README.md) for release gates, audited accuracy, coverage and
   dispute metrics that join the scorecard per dataset, and
   [Factories and data products](../../../../../docs/research/2026-10-18-factories-and-data-products.md)
   for the product framing this system underwrites.
   The [content factory](../content-factory-20261018/README.md) instantiates the grader registry,
   labels, review workbench and autonomy promotion for published content and media.
6. Source: `packages/evaluation/src/index.ts`, `verification-statistics.ts`, `human-review.ts`,
   `verification-benchmark.ts`; `packages/persistence/src/publication-evaluation.ts` for the current
   writers.
7. Mission Control: `src/mission_control/domain/programs/contracts.py` (`GoalVerificationResult`),
   `completion.py`, `human_gate.py`; `packages/mission-control-db-contract/component/migrations/0003_execution.sql`
   and `0004_capability_artifacts.sql`.
8. AI Engineer contract migrations: `20260826001100_evaluation.sql`, `20260826001200_observability.sql`,
   `20260822010000_app_factory_optimization_control_plane.sql`.

### External references (as published; not reproduced)

- Anthropic Engineering, "Demystifying evals for AI agents" (2026-01-09): grader tiers, capability vs
  regression, pass@k and pass^k, task hygiene, read the transcripts.
- Norman, Rivera, Hughes, "Reliability without Validity" (arXiv 2606.19544, 2026): 21 judges, kappa
  deflation 33–41 points, consistency–bias paradox, Minimum Viable Validation Protocol.
- Agrawal et al., "GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning" (arXiv
  2507.19457, ICLR 2026 oral).
- "DeepResearch Bench II: Diagnosing Deep Research Agents via Rubrics from Expert Reports" (arXiv
  2601.08536, 2026); DeepResearch Bench (ICLR 2026) RACE and FACT frameworks.
- Tong et al., "AI Can Learn Scientific Taste" (arXiv 2603.14473, 2026): learning judgement from
  community feedback.
- "Log analysis is necessary for credible evaluation of AI agents" (arXiv 2605.08545, 2026): τ-bench
  pass^5 doubled after removing flawed tasks.
- Husain and Shankar, AI Evals FAQ and course notes (hamel.dev): error analysis, open and axial
  coding, 100–200 labels per failure mode, judge TPR/TNR above 0.80, benevolent dictator.
- Shankar et al., "Who Validates the Validators?" (arXiv 2404.12272).
- Yao et al., τ-bench (arXiv 2406.12045); Barres et al., τ²-bench (arXiv 2506.07982).
- Chapelle et al., interleaving evaluation (2012); Bradley and Terry (1952).
- "Rubrics as Rewards" and "Robust Reward Modeling via Causal Rubrics" (ICLR 2026): rubric-based
  reward beyond verifiable domains.
