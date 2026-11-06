# Benchmark methods and transfer limits

**Status: supporting research notes.** Collected 27 September 2026 through Firecrawl paper search, related-paper expansion, body-passage retrieval, and primary project documentation. Studies were inspected, not reproduced. [Proposal](README.md) · [Evaluation protocol](evaluation-protocol.md).

## Established components

| Source and inspected material | Method worth using | Transfer limit |
|---|---|---|
| [ALCE](https://arxiv.org/abs/2305.14627), §3.3 and limitations | ASQA, QAMPARI, ELI5 tasks; combined cited passages assessed for statement entailment, plus citation precision and answer quality. | Sentence units, NLI error, and partial support. It does not establish the cited source's truth. [Author code](https://github.com/princeton-nlp/ALCE). |
| [FActScore](https://arxiv.org/abs/2305.14251), §§3–4 and appendix B | Generated atomic facts checked against a specified knowledge source; supported facts divided by generated facts. | Biography/Wikipedia setting; precision rewards omission. Small aggregate system-score error does not imply small individual-claim classification error. |
| [SAFE/LongFact](https://arxiv.org/abs/2403.18802), §5 and appendix D | Search-backed classification of supported, unsupported, and irrelevant facts. [Author code/data](https://github.com/google-deepmind/long-form-factuality). | Search and model judges are part of the measurement error; irrelevant facts can disappear from headline denominators. |
| [DeepResearch Bench](https://arxiv.org/abs/2506.11763), §3 and appendix E | 100 expert tasks over 22 fields; RACE report quality, FACT citation support. [Author repository](https://github.com/Ayanami0730/deepresearchbench). | Reference-relative RACE is not a truth percentage; effective citations are statement–URL pairs, not unique independent findings. |
| [DeepTRACE](https://arxiv.org/abs/2509.04499), §3.1 | 303 queries, including debate and expertise questions; citation and support matrices expose different error types. | Does not determine whether the final answer is right. Its human support check was limited; automated full matrices can be expensive. |
| [LiveResearchBench](https://arxiv.org/abs/2510.14240), §4 plus [released README](https://github.com/SalesforceAIResearch/LiveResearchBench) | 100 expert live tasks; coverage checklists, consistency, analysis depth, citation-related evaluation. | Dynamic inputs. Paper describes six dimensions/four protocols; inspected README exposes five criteria/three protocols. Its citation criterion describes missing-citation counting, not necessarily exact source entailment. Reconcile code before claiming coverage. |
| [DeepResearch Bench II](https://arxiv.org/abs/2601.08536), §§3, 4.3 | 132 expert-report-derived tasks and 9,430 binary rubrics. [Author repository](https://github.com/imlrz/DeepResearch-Bench-II). | Reference-conditioned rubric; source reports must be withheld from generation. Evaluator calibration/batching comparison used ten reports, too small for universal claims. |
| [FRAMES](https://arxiv.org/abs/2409.12941), empirical analysis | Multi-hop factual retrieval/reasoning; no-retrieval, retrieved, and oracle evidence separate failure sources. | Free-form answer correctness does not measure complete long-report attribution or provenance. |
| [HERB](https://arxiv.org/abs/2506.23139), indexed v1 §§1,4 | 39,190 heterogeneous enterprise artifacts, 815 answerable and 699 unanswerable questions in the inspected body. [Author repository](https://github.com/SalesforceAIResearch/HERB). | Synthetic enterprise search. Different question types use different scoring scales; show them separately. Older snippets contain different counts, so freeze the actual version. |

## Denominators that change interpretation

**ALCE:** citation recall averages whether a statement is entailed by its combined cited passages. Citation precision evaluates whether citation instances contribute appropriate support, including joint evidence. Neither is proof of the cited source's wider credibility.

**SAFE:** factual precision is `S/(S+NS)`, where S and NS are supported and unsupported fact counts. Its recall proxy is `min(S/K, 1)` for a chosen target fact count K. `F1@K` is therefore not recall against an exhaustive task-specific gold answer. Keep original question coverage alongside it.

**DeepResearch Bench FACT:** for task t, deduplicate statement–URL pairs into U_t, and let S_t be the supported subset. Task citation accuracy is `|S_t|/|U_t|`, or zero if there are no pairs. Overall accuracy is the mean task accuracy. Effective citations are the average number of supported pairs per task. Five sources supporting one statement can count five times. Pooled edge precision is a different aggregation.

**DeepTRACE:** citation accuracy counts supported citation edges over all citation edges. Citation thoroughness counts those supported citation edges over *all support edges between statements and listed sources*. It can be below 100% even if every statement has sufficient evidence, because some redundant supporting sources were not cited. Unsupported-statement rate concerns relevant statements with no support among listed sources. None is interchangeable with required-question coverage.

DeepTRACE's source-necessity method description appears to mix a source-only covering problem with bipartite minimum vertex cover; its extracted uncited-source equation also needs checking against the prose/example. These are methodological review flags, not demonstrated bugs in its implementation. Do not copy those algorithms or thresholds without review.

**LiveResearchBench:** coverage is checklist-based; analysis-depth preferences exclude ties and use both report orders. Citation traceability uses an error-count rubric, not claim-normalized recall. Its preference agreement results must not be presented as universal factual-label accuracy.

## Recent diagnostics

| Source | Verified idea | Caution and proposed use |
|---|---|---|
| [Beyond Precision](https://arxiv.org/abs/2604.03141), §3.4 and limitations | Importance-weighted coverage of reference facts complements precision. | Generated reference sets can omit or misstate facts. Freeze human-reviewed critical obligations independently of candidate output. |
| [MRDRE](https://arxiv.org/abs/2601.13217), methods/results and appendix B.4 | Requested-edit incorporation can coexist with loss of previously satisfied content and citations. | Test 3–5 revisions and retention of earlier fixes, not only latest feedback. |
| [FACTOR](https://arxiv.org/abs/2606.22474), §§III–VI | Risk-adaptive factual verification combines uncertainty signals, NLI, and candidate selection. | Inspected experiment uses 50 biography entities with Phi-2 and Wikipedia. Table/interpretation ambiguities and narrow scope prevent a general cost-saving claim. Candidate hypothesis only. |
| [Core](https://arxiv.org/abs/2407.03572), abstract only | Decompose-and-score methods can be inflated by trivial or repeated propositions. | No body-level result used here. Explicitly test repetition and easy-fact padding as a local adversarial hypothesis. |

Bench II's small batching comparison motivates measuring batch size: verify several related assertions against shared context when efficient, but keep per-assertion dispositions and test omissions/cross-contamination. Historical per-task prices from ten reports are not budget predictions.

## Adoption and availability

Repositories linked above establish candidate resources, not that we downloaded, reproduced, or licensed them for our intended use. LiveResearchBench's inspected repository labels its dataset research-only with CC-BY-NC 4.0 and an additional restriction concerning development of models competing with OpenAI; evaluation code is described as Apache 2.0. Review the actual applicable terms before use. [AVeriTeC's official page](https://fever.ai/dataset/averitec.html) also links CC-BY-NC 4.0. No benchmark data was imported during this mission.

Use frozen corpora for controlled ablations, synchronized live runs for freshness, and a local human-gold suite for domain relevance. Keep source-access failures distinct from unsupported claims. Prefer per-slice evidence over leaderboard rankings when choosing a policy.
