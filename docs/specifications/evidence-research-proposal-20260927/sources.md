# Source register and research method

**Status: research support for a proposed specification.** [Proposal](README.md) · [Protocol](evaluation-protocol.md).

Research cutoff: 27 September 2026, America/New_York. Sources were retrieved in this session through Firecrawl web search/scrape and Research paper search, related-paper expansion, and targeted in-body retrieval. “Body” below means relevant method/result/limitation passages were inspected, not that every line of the paper was read. “Docs” means primary project/vendor/standard documentation. Numerical results are authors' reports; none were reproduced locally.

The explicitly requested `firecrawl-deep-research` skill guided the mission; its companion `firecrawl-research-papers` skill guided scholarly-source verification. A runtime preference was requested; with no answer received during collection, exhaustive depth was used as the stated working assumption. Two bounded research subagents examined benchmarks and verification economics; the primary agent integrated the report and independently checked several load-bearing findings.

## Evidence register

| ID | Primary source | Inspection and role | Limit carried into proposal |
|---|---|---|---|
| S01 | [Salesforce: Towards Trustworthy Enterprise Deep Research](https://www.salesforce.com/blog/trusted-deepresearch/) | Full article body; starter framing and benchmark leads. Page metadata says published 24 October 2025, modified 27 April 2026. | Vendor enterprise comparison; access conditions and reported internal scores are not transferable release criteria. |
| S02 | [ALCE](https://arxiv.org/abs/2305.14627) and [author repository](https://github.com/princeton-nlp/ALCE) | Body §3.3/limitations and project reference; citation precision/recall. | Sentence/NLI assumptions; support differs from truth. |
| S03 | [FActScore](https://aclanthology.org/2023.emnlp-main.741/) / [paper](https://arxiv.org/abs/2305.14251) | Body §§3–4/appendix B; atomic factual precision. | Biography/reference-source scope; aggregate estimator quality is not per-claim accuracy. |
| S04 | [SAFE/LongFact](https://arxiv.org/abs/2403.18802) / [author code](https://github.com/google-deepmind/long-form-factuality) | Body §5/appendix D; search-backed fact checking and F1@K. | Chosen fact-count target is not complete-answer recall; search/judge errors remain. |
| S05 | [DeepTRACE](https://arxiv.org/abs/2509.04499) | Body §3.1; statement–source–citation matrices and audit metrics. | No final-answer truth assessment; denominator and algorithm-description caveats in benchmark notes. |
| S06 | [Cited but Not Verified](https://arxiv.org/html/2605.06635v1) | Body methods, tables 1–3, limitations; AST citation extraction and search-depth ablation. | Model judge; source truncation and limited human calibration; percent/percentage-point ambiguity corrected explicitly. |
| S07 | [Do You Need a Frontier Model as a Citation Verifier?](https://arxiv.org/html/2607.08700) | Body §§4–6/table 2; cost versus judge behavior. | Single adversarial document, skewed label prevalence, labeling-council dependence. Overlapping CIs do not demonstrate equivalence. |
| S08 | [Evaluating and Guarding Citation Faithfulness](https://arxiv.org/html/2607.20527) | Body §§5.3–5.4, 7, supplement S6; verifier variation and calibration transfer. | Conditional catch-rate guarantee; harder-negative transfer and retrieval-held-fixed setting. |
| S09 | [Correctness is not Faithfulness in RAG Attributions](https://arxiv.org/html/2412.18004) | Body experiments/discussion; support versus production reliance. | Intervention changes context; causal ground truth unavailable. |
| S10 | [FIRE](https://arxiv.org/html/2411.00784) | Body §§4–6/tables 5–7; adaptive retrieval stopping. | Some decisions use model memory; historical cost savings cannot justify waiving evidence inspection. |
| S11 | [Human-Anchored Factuality Evaluation with Strategic Annotation](https://arxiv.org/html/2609.00494) | Body §§4.2–4.4/table 4/limitations; sampling-aware human audits. | Variance-efficiency findings, not automatic dollar savings; retain known inclusion probabilities and random coverage. |
| S12 | [Calibrated Selective Fact-Checking via Evidence Chain Evaluation](https://arxiv.org/html/2607.18240) | Body table 1/§5; important negative comparison for abstention. | 95 claims; search baseline outperforms selective method on several measures. |
| S13 | [Retrieval-Augmented Generation with Conflicting Evidence](https://arxiv.org/html/2504.13079v2) | Body §§6.2–6.3; evidence imbalance and misinformation. | Controlled small subsets; no demonstrated production source-independence classifier. |
| S14 | [W3C PROV-DM](https://www.w3.org/TR/prov-dm/) | Recommendation §§2,5; entity/activity/agent vocabulary. | Responsibility attribution is not entailment or causal model reliance. |
| S15 | [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) | Recommendation §§4.2.4–4.3; quote/position selectors and representation state. | Locators on changing resources can be brittle; multiple quote matches can be ambiguous. |
| S16 | [Anthropic citations](https://platform.claude.com/docs/en/build-with-claude/citations) | Primary API docs; document-bound page/character/block citations and boundaries. | Text citation feature is not a truth service; native image citation not supported in inspected page. Cached page timestamp 27 September 2026. |
| S17 | [Who is the Agent to Blame?](https://arxiv.org/html/2608.24306v1) | Body method prompts, §7 interventions, limitations; errors across agent handoffs. | Running text only; observational role/model association; intervention result on one system. |
| S18 | [MRDRE: Beyond Single-shot Writing](https://arxiv.org/abs/2601.13217) | Body multi-turn results, §6, appendix B.4/E.1; revision incorporation and regression. | Evaluated agents/settings, not a universal regression rate or demonstrated repair solution. |
| S19 | [Cherry-pick Override](https://arxiv.org/abs/2606.07834) | Abstract plus body intervention ladder/§7 limitations; mixed evidence becoming unjustified directional output. | Dataset-defined outcomes; scope assumes a contract with a conflicting-evidence verdict. |
| S20 | [DEER](https://arxiv.org/abs/2512.17776) | Body introduction, §§4.2–4.3 and extraction prompt; expert rubrics and cited/uncited claims. Indexed text included v5 material. | LLM extraction/judging; expert-guided does not mean independently validated for our domain. Version must be pinned before evaluation. |
| S21 | [HiEviDR-Bench](https://arxiv.org/abs/2607.25151) | Body §§3.2–3.3/appendix references; evidence–claim–conclusion graphs and staged evaluation. | LLM-assisted graph construction with human validation; alternative valid paths may be missing. Dataset reproduction/download not performed. |
| S22 | [Budget-Aware Tool-Use Enables Effective Agent Scaling](https://arxiv.org/abs/2511.17006) | Body adaptive verification and limitations; resource-aware stopping/pivoting. | Tool-call budgets and search QA; multidimensional resource allocation remains open. |
| S23 | [Marco DeepResearch](https://arxiv.org/abs/2603.28376) | Body §§4–5/8.2; verified intermediate trajectories and test-time correction. | Much evidence concerns training and search-heavy QA, not long-report citation quality. |
| S24 | [AVeriTeC official dataset](https://fever.ai/dataset/averitec.html) and [paper](https://proceedings.neurips.cc/paper_files/paper/2023/hash/cd86a30526cd1aff61d6f89f107634e4-Abstract-Datasets_and_Benchmarks.html) | Dataset docs, schema, examples, download/license links; evidence sufficiency and conflicting cases. | Noncommercial license; changing source availability and original date matter. No dataset imported. |
| S25 | [WiCE](https://arxiv.org/abs/2303.01432) | Paper-index abstract/related-paper metadata; sub-sentence entailment and minimal supporting evidence. | Candidate component only; detailed harness/license not audited in this mission. |
| S26 | [DeepResearch Bench](https://arxiv.org/abs/2506.11763) / [project](https://deepresearch-bench.github.io/) | Body §3/appendix E; RACE and FACT methods. | Relative report evaluation and statement–URL counting; no claim of current leaderboard winner. |
| S27 | [LiveResearchBench](https://arxiv.org/abs/2510.14240) / [repository](https://github.com/SalesforceAIResearch/LiveResearchBench) | Body §4 and current README/license statements. | Paper/released-evaluator mismatch; use restrictions and live-source drift. |
| S28 | [DeepResearch Bench II](https://arxiv.org/abs/2601.08536) / [repository](https://github.com/imlrz/DeepResearch-Bench-II) | Body §§3,4.3; expert-derived rubrics and batching. | Small calibration study; historical prices; reference leakage risk. |
| S29 | [FRAMES](https://arxiv.org/abs/2409.12941) | Body empirical analysis; retrieval/oracle diagnostics. | Answer correctness does not establish full report attribution. |
| S30 | [HERB](https://arxiv.org/abs/2506.23139) / [repository](https://github.com/SalesforceAIResearch/HERB) | Indexed v1 body §§1,4; enterprise search and unanswerable tasks. | Synthetic setting; public versions/counts differ; mixed scoring scales. |
| S31 | [DRACO announcement](https://www.perplexity.ai/hub/blog/evaluating-deep-research-performance-in-the-wild-with-the-draco-benchmark) | Primary vendor article; real-request-derived tasks and weighted expert rubrics. | Vendor claims of superiority not adopted; code/license/evaluator not independently executed. Cached page timestamp 26 September 2026. |
| S32 | [Beyond Precision](https://arxiv.org/abs/2604.03141) | Body §3.4/limitations; weighted reference-fact coverage. | Retrieval and reference extraction can contaminate the gold standard. |
| S33 | [FACTOR](https://arxiv.org/abs/2606.22474) | Body §§III–VI; adaptive verification candidate. | Narrow 50-entity Phi-2 experiment and reporting ambiguities; not a basis for projected savings. |
| S34 | [Core](https://arxiv.org/abs/2407.03572) | Abstract only; pointer on trivial/repeated-fact scoring incentives. | No body-level empirical claim relied on; retained as a follow-up lead. |

Unless publication status is separately established by a proceedings source, arXiv works are treated as research preprints. A source's self-described “first,” “state of the art,” “guarantee,” or “human-level” claim is not accepted by repetition. The proposal uses methods and scoped findings rather than unverified superiority claims.

## Local context and reconciliation

The supplied earlier-research path was absent. The matching files were located at:

- Earlier proposal: `internal_hidden_docs/proposals/accountable-evidence-20260916/README.md`.
- Earlier implementation baseline: `internal_hidden_docs/proposals/accountable-evidence-20260916/local-baseline.md`.
- Earlier validation: `internal_hidden_docs/proposals/accountable-evidence-20260916/validation.md`.
- Earlier source ledger: `internal_hidden_docs/proposals/accountable-evidence-20260916/research-ledger.md`.

These were read as historical research and dated implementation observations, not fresh proof of the current system. This mission did not rerun their tests or copy their implementation counts into new claims. The ignored local files are named for provenance, not linked as dependencies of this tracked proposal. The new proposal does not repair or overwrite those historical documents.

Current context consulted: repository [AGENTS.md](../../../AGENTS.md), [verification guide](../../verification/README.md), [verification/admission concept](../../../knowledge/verification-and-admission.md), [retrieval/evidence concept](../../../knowledge/retrieval-and-evidence.md), workspace [product vision](../../../../ai-engineer-meta/docs/product/00-vision.md), [north-star path](../../../../ai-engineer-meta/docs/product/11-north-star-path.md), and [ownership/open decisions](../../../../ai-engineer-meta/docs/agents/workspace/RESPONSIBILITIES.md). These constrain where accepted implementation belongs; they do not determine the research conclusion.

## Rerun inputs and limitations

Workflow: firecrawl-deep-research plus firecrawl-research-papers. Depth: exhaustive. Output: Markdown proposal, evaluation protocol, source register, specialist notes, validation record.

Search angles included deep-research evidence verification/provenance, citation attribution benchmarks, local agent-invocation errors, multi-turn revision, conflicting/counterevidence, verification budget and stopping, calibrated cheap-versus-frontier judges, human-anchored auditing, evidence graph benchmarks, and enterprise deep search. Paper expansion used DeepTRACE/ALCE and attribution-faithfulness anchors. Named paper IDs and source URLs above provide concrete rerun seeds.

The collection is a broad decision-oriented synthesis, **not a systematic review with exhaustive inclusion screening**. Related-paper search also surfaced off-topic work, which was not treated as supporting evidence. Later or revised publications may change the assessment. No benchmark was executed, deployed systems were not audited, actual provider prices were not used to forecast the proposed budget, and no commercial-use rights were granted by this research.

Firecrawl may return indexed or cached content; access during this session does not prove each page was freshly fetched. No immutable archive of all source bytes, full search transcript, or reproducible evaluation environment was created. The source register preserves retrieval routes and inspection depth, not the stronger custody guarantees proposed for a future system.
