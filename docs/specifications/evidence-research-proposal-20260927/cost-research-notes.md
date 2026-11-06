# Research notes: verification economics, reliability, and provenance

Status: research support for a proposal; no implementation mandate. Collected 2026-09-27 (local date). Firecrawl research-paper search, related-paper expansion, and in-body passage retrieval were used. Standards were read using Firecrawl targeted extraction. Numerical findings below are reported by the named studies, not reproduced locally. arXiv sources are treated as preprints unless separately established otherwise.

## Findings with primary sources

### 1. Judge expense is not a dependable quality proxy

[Do You Need a Frontier Model as a Citation Verifier?](https://arxiv.org/html/2607.08700), July 2026, Sections 4–6 and Table 2. Eight judges from three families judged 624 attribution–citation pairs on two dimensions (1,248 rubric decisions). GPT-5-mini achieved source-relevance pass-class F1 0.908 (95% bootstrap CI .89–.93); factual-support intervals overlapped across models. Estimated judge costs spanned 49× using June 2026 provider prices and one call per dimension per pair. Comparable F1 hid different false acceptance, false rejection, and pass-rate drift. This motivates measuring the operating point, rather than selecting a verifier by prestige or a single average score.

Limitations: one adversarial document; factual-support gold pass rate only 18.4%; two evaluated judges also participated in the labeling council, with human adjudication of disagreements. Cost estimates do not establish actual production cost, latency, or batching performance. Overlapping intervals do not establish equivalence. The dominant error in this benchmark was rejecting genuinely supported citations; a blanket stricter gate can therefore damage usefulness.

### 2. The verifier changes the apparent failure rate; conformal transfer can fail sharply

[Evaluating and Guarding Citation Faithfulness in Agentic Scientific Synthesis](https://arxiv.org/html/2607.20527), July 2026, Sections 5.3–5.4, 7, and Supplement S6. On identical outputs, measured unsupported-citation rates varied approximately 3–18% with verifier strictness. Positive-specific agreement was .90–.96, but agreement on negative flags was only .27–.30. Full-passage sliding windows matter: prefix truncation inflated apparent unsupported rates. The paper's split-conformal guard bounds catch rate for unsupported citations under exchangeability, not conclusion correctness.

Critical deployment caveat: a threshold calibrated for 90% catch on easy in-paper distractors caught only 37% of harder human-labeled unsupported claims. Recalibration on representative negatives restores the target at a higher review budget. The adopted AttrScore verifier's .94 held-out recall is recall on *supported* citations, not a 94% hallucination catch rate. Retrieval was held fixed; this is not an end-to-end search-agent reliability guarantee. Treat the paper's use of citation faithfulness as support checking, distinct from causal reliance in source 3.

### 3. Correct support does not prove actual reliance

[Correctness is not Faithfulness in RAG Attributions](https://arxiv.org/html/2412.18004), December 2024, experiment and discussion. The authors distinguish whether a cited document supports a statement from whether it actually contributed to producing it. Injecting statements into relevant previously uncited documents induced citation in 57% of tested cases; random documents did so in 12% (116/936). These are intervention-specific results, not prevalence estimates for all deployed research systems.

The authors explicitly acknowledge an assumption: adding documents might itself change how the model generates an answer. Their probe is preliminary, with no direct access to causal ground truth. Implication: preserve retrieval and generation traces, but do not advertise traces or valid citations as proof of causal influence. Source-removal and contradiction interventions belong in controlled evaluations with random/no-op controls and repeated runs.

### 4. Iterative stopping can reduce cost, but source-free truth checking is not evidence verification

[FIRE: Fact-checking with Iterative Retrieval and Verification](https://arxiv.org/html/2411.00784), Sections 4–6 and Tables 5–7. The system jointly decides to answer or search again. Across 559 test claims from FacTool-QA, FELM-WK, and sampled BingCheck, GPT-4o-mini FIRE used $0.14 LLM + $0.20 search costs versus SAFE's $0.43 + $2.93 in the study's setup. The reported average savings versus compared frameworks were 7.6× LLM and 16.5× search. Forced extra searches in development did not improve measured accuracy and sometimes introduced noise.

Limitations: binary label harmonization, small/modified datasets, historical prices, common-knowledge claims, retrieval and benchmark quality concerns. A model can answer from memory in FIRE. Therefore savings cannot be directly transferred to an attribution contract requiring an inspected supporting source. Proposal implication: allow calibrated early stopping of *additional* search after adequate evidence exists; do not waive source inspection solely because the model feels confident.

### 5. Spend human review on structural failure modes, retaining random coverage

[Human-Anchored Factuality Evaluation with Strategic Annotation](https://arxiv.org/html/2609.00494), September 2026, Sections 4.2–4.4, Table 4, limitations. Active statistical inference combines machine predictions across all examples with selectively obtained human labels and sampling-aware correction. Failure-space signals include incomplete evidence, temporal mismatch, and rubric mismatch. Across simulated annotation budgets, effective sample-size gains over classical annotation averaged 40.3% on internal AutoFA and 27.1% on RAGTruth, with near-nominal 95% interval coverage. These are variance-efficiency gains, not automatically equal dollar savings or individual-claim guarantees.

Judge confidence alone missed confidently wrong decisions. Efficiency depends on stable residual structure and known sampling probabilities; uniform mixing mitigates undercoverage of unanticipated errors. Stronger feature correlations did not always improve efficiency when they caused unstable weights. Proposal implication: use a stratified human audit including random unflagged examples and known high-risk error families, preserve inclusion probabilities, and monitor shifts after model, retrieval, or rubric changes.

### 6. Abstention is useful but must earn its place against a strong baseline

[Calibrated Selective Fact-Checking via Evidence Chain Evaluation](https://arxiv.org/html/2607.18240), July 2026, Table 1 and Section 5. The benchmark contained 95 claims (57 true, 38 false). ECE answered 89 and achieved 97.8% selective accuracy at 93.7% coverage; standard accuracy counting abstentions as non-correct was 91.6%. The retrieval baseline achieved 97.9% accuracy at 100% coverage and better ECE, Brier, and AURC. This is evidence that selective reporting exposes a useful tradeoff, not proof that this abstention mechanism improved correctness or calibration over the baseline.

Small benchmark and one backend limit generalization. Do not accept a proposal merely because answered-only precision rose: require coverage, task completion, useful correct information retained, and abstention outcomes alongside it.

### 7. More documents can amplify imbalance and misinformation

[Retrieval-Augmented Generation with Conflicting Evidence](https://arxiv.org/html/2504.13079v2), RAMDocs and MADAM-RAG, Sections 6.2–6.3. Controlled 200-example subsets vary evidence balance and misinformation volume. Increasing support for one of two valid interpretations from one to three documents can suppress the underrepresented valid answer; concatenated baselines dropped by up to 8% in the reported analysis. Multi-agent document-specific processing and aggregation reduced this degradation, but performance still worsened with increasing misinformation.

This study manipulates document imbalance; it does not prove a production source-independence classifier. Proposal extrapolation: distinguish source count from independent evidence count, cluster copies/syndication/shared upstream studies, and preserve minority counterevidence. Test single-agent aggregation, independent document summaries, and multi-round debate at equal budgets; do not assume debate is always worth its expense. Ambiguity, different dates/populations, and true contradictions require different resolutions.

### 8. A standard vocabulary for provenance is available

[W3C PROV-DM](https://www.w3.org/TR/prov-dm/), Sections 2 and 5. The Recommendation distinguishes entities, activities, and responsible agents; generation, use, derivation, attribution, and association describe their relationships. Attribution in PROV assigns responsibility to an agent; it is not the same as citation entailment or causal model attribution. Provenance supplies information for assessing quality and trustworthiness; merely populating its relations does not establish truth.

Proposal mapping: source capture, parsed representation, selected evidence, claim revision, judgment, and released report are separate versioned entities; fetch, parse, extract, judge, and publish are activities. Preserve which artifact each activity used and generated, the model/tool/configuration responsible, time, and failure outcomes. Record semantic support as its own assessed relation rather than overloading `wasDerivedFrom`.

### 9. Evidence anchors must be tied to a representation

[W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/), Sections 4.2.4–4.3. TextQuoteSelector supports exact text with prefix/suffix context. TextPositionSelector uses start-inclusive/end-exclusive character positions but is brittle when a resource changes; State identifies the representation, including time and cached copies. Multiple quote matches remain ambiguous. Request headers may not fully recover the same resource.

Proposal extrapolation: pair an immutable capture digest/version with normalized-text digest, quote context, offsets, media-specific locator, and parser version. Replaying an anchor proves what was inspected and where, not that the statement is true. A changed page should produce a new capture and fresh judgment, not silently rewrite old evidence.

## Recommended strategy and experiments (proposal, not established empirical conclusions)

1. **A universal inexpensive evidence floor.** Require source resolution, capture identity, quote/locator replay, claim scope and qualifiers, and judgment provenance for externally checkable material claims. Simple integrity checks should fail explicitly before semantic evaluation.
2. **Escalate by consequence and uncertainty.** Use calibrated inexpensive semantic verifiers first; route high-impact conclusions, source conflicts, numerical claims, unfamiliar domains, and disputed results to additional evidence or review. Randomly audit passed low-risk claims to discover blind spots.
3. **Verify dependencies before polished prose.** A key premise that fails should invalidate dependent inferences and trigger targeted revision. Mark extrapolations as such, and test whether final prose introduces stronger claims than the checked ledger.
4. **Use source families rather than vote counts.** Ten reproductions of one press release are one evidential origin. Keep dependence unknown when it cannot be established; do not invent numerical independence probabilities.
5. **Stop searching when the next step is unlikely to change a decision.** Define a bounded additional-search budget and record why work stops: adequate evidence, stable unresolved conflict, exhaustion, or deadline. Budget exhaustion becomes unresolved/abstained, never an automatic pass.
6. **Account for full cost.** Record acquisition, parsing, storage, retrieval, model input/output/cache tokens, judge calls, retries, concurrency, p50/p95 wall time, human minutes, and re-verification. Compare cost per useful accepted claim and cost per human-adjudicated report under a fixed error budget; include omitted correct information so terse answers cannot win by dropping all difficult claims.
7. **Separate production gates from offline attribution audits.** Source provenance and entailment run routinely. Expensive leave-one-source-family-out interventions run on representative offline samples or pivotal conclusions; report causal sensitivity rather than claiming mechanistic proof.

Suggested factorial comparison: unverified generator; deterministic floor only; one fixed verifier for all claims; calibrated cheap-first escalation; uniform expensive verification; calibrated escalation plus targeted counterevidence. Keep generator/retrieval corpus/query suite and spend comparable, vary verifier independently, and report quality–coverage–cost frontiers. Add deduplication/cache ablations and source-family perturbations. Human gold must be independent of evaluated judges, with conflict adjudication and blind labels. Resample by query/report/source family rather than pretending correlated claims are independent. Thresholds must be selected on calibration data and evaluated on held-out data plus a harder temporal/domain-shift set.

Rerun inputs: firecrawl-research-papers; topic = deep research verifier reliability, economics, causal attribution, evidence conflict, provenance standards; primary papers retrieved by the linked arXiv IDs; related expansion seed = arxiv:2412.18004; standards = linked W3C Recommendations. No experiments were executed in the repository.
