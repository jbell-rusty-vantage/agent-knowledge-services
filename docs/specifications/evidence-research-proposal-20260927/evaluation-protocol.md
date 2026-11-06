# Evaluation protocol and promotion gates

**Status: PROPOSED. No experiment below was run during this research mission.** [Main proposal](README.md).

This protocol asks whether a verification policy improves supported, useful research enough to justify its full cost. It distinguishes an evaluator's reliability from an agent's performance, and both from production authorization.

## 1. Evaluation objects and gold labels

Use five related objects: mission/question, required answer obligation, assertion occurrence, claim–evidence support set, and released report revision. A logical assertion can have several occurrences and several alternative sufficient support sets. Retain occurrence-level mapping for auditing, while counting unique material propositions in productivity measures to prevent repetition or over-decomposition from inflating scores.

Before seeing candidate outputs, a domain reviewer defines required questions, critical obligations, relevant scope, cutoff date, acceptable qualification, and known ambiguous or unanswerable cases. Weights reflect the task's decision needs and are frozen before holdout evaluation. New valid answers not anticipated by a reference are eligible for adjudication; a reference answer is not the only permissible wording or reasoning path.

Annotate source support separately from wider factual credibility. Human labels for support are: full support; support requiring stated qualification; partial support; contradiction; materially mixed evidence; insufficient evidence; unable to assess because of missing/access/parse context. Record why, supporting/contradicting fragments, missing qualifiers, and whether the evidence set is conjunctive or one of several alternatives. Keep unresolved human disagreements rather than forcing a false binary consensus.

For policy evaluation, derive whether a particular assertion is eligible for a specific use from those labels and the frozen use policy. For example, a qualified source report can be eligible while the unqualified world claim is not. Do not map every inaccessible source to “false.” Eligibility uncertainty is separately reported and held under the proposed official-use policy.

## 2. Dataset plan

**Proposed local suite: 120 tasks.** Assign 24 development, 24 calibration, 48 untouched test, and 24 later temporal/domain-shift tasks. Split by topic, source-origin family, and report lineage so paraphrases or revisions of the same origin cannot leak across splits. Stratify tasks across technical documentation, experimental measurements, comparative decisions, conflicting/time-sensitive evidence, tables/computations, and unanswerable or evidence-limited research. Each task may occupy several slices.

The seed-gold construction workload assumes about 12 material assertions per task, or roughly 1,440 assertions in one seed report/evidence set per task. This is a sizing assumption, not an output cap or a rule to ignore extra assertions. Candidate-output auditing across arms and replicates is a separate, larger workload. Inventory all generated material assertions for report-level evaluation. If sampling is necessary, preregister inclusion probabilities for population estimates and fully adjudicate critical assertions; do not silently discard hard claims.

Two trained annotators independently review each gold item, blind to candidate model/policy and one another's label. A third domain-qualified adjudicator resolves disagreements where evidence permits. Retain pre-adjudication labels, classwise agreement, and adjudication rationales. Candidate-judge majority vote cannot create the gold labels used to evaluate those judges.

At four minutes per annotator per assertion, double annotation of 1,440 assertions takes 192 hours. An illustrative 25% allowance for adjudication adds 48 hours, and task/rubric preparation at 30 minutes per task adds 60 hours: **about 300 hours for seed-gold preparation only**, before tool setup or difficult-case overruns. The 624 held-out/shift candidate reports planned below would add approximately 7,488 assertion occurrences at the same length assumption, requiring about 998 hours of double annotation plus 250 hours of adjudication: **approximately 1,248 additional hours**. Development/calibration candidate outputs and revision experiments add further work. Pilot annotation speed and the amount of safely reusable labeling before commissioning the remainder; do not present seed preparation as the total evaluation cost.

To control that expense, the pilot should estimate an output-audit plan: fully audit critical claims and a preregistered random, stratified sample of whole reports from every arm, with known inclusion probabilities. Use calibrated automated scores for all remaining reports, but label them as estimates; the primary human-anchored comparison and risk intervals must account for audit sampling. Gold support labels may be reused only for identical claims, qualifiers, and evidence; new report wording and citation bindings still need assessment. Any reduction in sample size can weaken the promotion bound and must be reported.

Add a distinct synthetic mutation suite. Cases include wrong entity, omitted negation, population swap, period swap, relative versus absolute percentage, denominator changes, units, table headers/footnotes, truncation before the evidence, fake or redirected citations, copied source families, conflicting evidence, stale captures, prompt injection in documents, and revisions that break old claims. Synthetic mutations test detection under controlled conditions; they do not estimate natural error prevalence.

Public diagnostic subsets supplement the local suite. Start with ALCE for citation handling, WiCE for partial entailment, AVeriTeC for real-world evidence sufficiency, DeepResearch Bench for end-to-end quality, and MRDRE-style revisions. Add HERB if enterprise retrieval is in scope and HiEviDR-Bench for intermediate support paths. Inspect actual artifact availability, terms, evaluator prompts, and dependencies before importing. Pin dataset/code versions and the exact selected IDs. Public test data must never become tuning data without changing its designation.

## 3. Measurement definitions

Let `C` be the independent census of candidate assertion versions submitted to the verification policy, including all rejected, held, and subsequently repaired versions. Let `A` be the independent assertion census of the final report, including any claim the writer added after candidate checking. Let `R ⊆ A` be factual assertions released as eligible for the stated use, and `Q` the original required answer obligations. Explicit unresolved findings are counted in `A` and assessed against their stated qualified meaning; they are not secretly counted as eligible world-fact claims.

For any set `X`, let `S_X` mean human-gold source-support failures for the exact assertion (including missing required qualifications), `N_X` mean all human-gold use-ineligible assertions, and `U_X` mean human-unresolved eligibility. `S_X` and `N_X` are distinct: a well-supported claim can be ineligible because of stale evidence, unsuitable use, or other policy conditions. Record support-unknown labels separately too. For pre-decision classification, let `P_C` be candidate versions the policy would permit unchanged. A removed or repaired assertion keeps its original label and disposition in `C`; its repair is a new version with a lineage link. This prevents repairs or deletions from erasing the negative denominator.

| Metric | Numerator / denominator or definition | Interpretation and trap |
|---|---|---|
| Assertion census recall | Human-gold assertion occurrences found by system / all human-gold material occurrences. | Evaluate summary, tables, captions, and headings too. Pair with precision and qualifier retention. |
| Sufficient citation coverage | Assertions in `A` with at least one fully adequate declared evidence set / all `A`. | Missing citations stay in denominator. Qualified support counts only if the output preserves the qualification. |
| Citation-edge precision | Correctly assigned supporting citation edges / all assigned support citation edges. | A fragment can be a legitimate contributing premise without entailing the whole claim alone; label its role. Irrelevant citation padding remains an error. |
| Factual-support precision | Supported material propositions / all adjudicated material propositions. | Reference-relative; not world truth. Report unknowns separately and a conservative lower bound treating unknowns as non-passes. |
| Required-question coverage | Sum of frozen weights for adequately answered obligations / sum of all `Q` weights. | Freeze weights before outputs; an explicit unknown can appropriately satisfy a question whose evidence is genuinely unavailable, but omission cannot. |
| Released unsupported rate | Source-support failures in `R` / support-adjudicable assertions in `R`. | Measures evidence support only. Report support-unknown fraction and a conservative bound counting unknowns as failures. |
| Released ineligible rate | `count(R ∩ N_A) / count(R minus U_A)`. | Measures all use-policy failures. Also report `count(R ∩ U_A)/count(R)` and worst-case `(count(R ∩ N_A) + count(R ∩ U_A))/count(R)`. |
| Candidate false acceptance rate | `count(P_C ∩ N_C) / count(N_C)`; also compute `count(P_C ∩ S_C) / count(S_C)`. | Fraction of bad candidates the policy permits, including candidates later removed by editing. Distinguish use-ineligibility and source-support failure; report natural and mutated sets separately. |
| Supported retention | Eligible useful gold assertions retained accurately / eligible useful gold assertions available in the candidate or reference obligation set. | Detects over-rejection. State whether the denominator is candidate preservation or task-reference coverage. |
| Selective coverage | `count(P_C minus U_C) / count(C minus U_C)`. | Pre-decision candidate-version measure; also report per-original-candidate eventual resolution so repeated repairs cannot inflate productivity. Pair with required-question coverage. |
| Conflict/contradiction recall | Gold conflicting/contradicted cases correctly surfaced / gold cases of that class. | Report classes separately; “not supported” is not a substitute for recognizing conflict. |
| Origin handling | Pairwise or cluster precision/recall for shared-origin classification; unknown fraction; independent-origin inflation rate. | No automatic assumption that different domains are independent. |
| Replay success | Exact original selections recovered / all required replay attempts. | Report missing rights, unavailable bytes, locator, parser, and drift failures separately. |
| Dependency correction recall | Known affected uses identified / known affected uses in seeded graph. | Pair with precision so invalidating everything cannot win. Measure stale-use race failures separately. |
| Revision break rate | Previously satisfied weighted obligations that become unsatisfied / previously satisfied obligation weight. | Report requested-edit incorporation and prior-edit preservation at every turn. |
| Calibration | Reliability plots, Brier score for a specified binary event, classwise error, risk–coverage curves. | Probabilities must refer to support/eligibility, not vague confidence. Report domain shift. |
| Useful completed report rate | Reports meeting the frozen task rubric and evidence policy / all attempted missions. | Count budget exhaustion, unusable output, and system failure; never grade only successful reports. |
| Cost and latency | Full cost per attempted mission, useful completed report, and unique useful supported proposition; p50/p95 wall time. | Include failed/held work. Human costs and machine costs shown separately and combined under declared labor-rate assumptions. |

Report raw counts, class prevalences, and denominators next to percentages. Zero-denominator metrics are `not applicable`, not perfect scores. Macro-average per task and pool micro counts separately: a long report must not silently dominate the score. Stratified samples require appropriate sampling weights for population estimates.

ALCE recall, SAFE's `F1@K`, DeepTRACE citation thoroughness, and DeepResearch Bench effective citations use different units and denominators. Preserve their official definitions when reporting official scores; our local metrics above have explicit local names. In particular, SAFE's target fact count is not gold-answer recall, and a supported statement cited to five URLs is not five independent facts. See [benchmark notes](benchmark-research-notes.md).

## 4. Baselines and shared controls

| Arm | Behavior |
|---|---|
| B0 | Generator's native citations; no verification intervention. Offline auditors still measure its outputs. |
| B1 | Native citations plus deterministic capture, locator, value, and arithmetic checks. |
| B2 | B1 plus one calibrated small semantic verifier on all retained factual assertions. |
| B3 | B1 plus the stronger candidate verifier on all retained factual assertions. |
| B4 | B2 plus selective escalation, bounded counterevidence, and random pass audits. |

Include a snapshot of the present module as an optional additional baseline only after freezing its build, policy, interface, and source inputs. It has no privileged status as the target design. A citation-native provider or simpler research system is also eligible to win.

Hold generator, task obligations, source snapshot, allowed tools, and output budget constant for component experiments. Run end-to-end comparisons under the same total currency ceiling and report the different resource allocations. Where live search is necessary, synchronize runs as closely as practicable, randomize arm order, preserve responses and capture times, and analyze live results separately from frozen-corpus results.

Use at least two generation replicates for paired mission comparisons; choose additional repeats from observed pilot variance. Freeze judge versions/prompts and temperature, while acknowledging that nondeterministic services may not replay bit-for-bit. Test scorer stability on a repeated subset. Keep the evaluator separate from the policy's decision model; ultimately anchor primary results in adjudicated labels.

Do not run every experiment as a giant Cartesian product. Screen components on development data, select operating points on calibration data, and preregister the final comparisons before opening the test split. Five arms × 48 held-out tasks × two replicates yields **480 report runs**; comparing three finalists on 24 shift tasks with two replicates adds **144 runs**. Claim checks, retrievals, and annotations are additional costs, not hidden inside those counts.

## 5. Eight experiments

| ID | Question and intervention | Controls and decisive measurements |
|---|---|---|
| E1 — Trust the measurement | Compare small/large judges, prompt variants, full relevant context versus prefix truncation, and independent human labels. | Fixed evidence/claims; blind model identity; classwise false acceptance/rejection, human agreement, cost, hard-negative and time-shift performance. Do not infer model equivalence from overlapping intervals alone. |
| E2 — Locate the bottleneck | Compare normal retrieval with supplied gold evidence and with irrelevant-but-topical evidence. | Same generator/verification policy; coverage, support, conflicts, cost. Improvement with oracle evidence identifies discovery problems; failure with oracle evidence points to interpretation or synthesis. |
| E3 — Preserve handoffs | Compare prose research notes, source snippets, and typed evidence packets; compare final-only checks with high-impact boundary checks. | Same source pool and total token/spend ceiling; qualifier retention, unsupported final assertions, table handling, source-role fidelity, latency. Count packet production and validation cost. |
| E4 — Earn adaptive savings | Compare B2/B3/B4; sweep escalation rates and 10/25/40% verification-budget reservations. | Equal total spend, plus matched required-question coverage analysis; risk–coverage–cost frontier and random audits of non-escalated cases. Match low-budget outcomes through calibration, not post-hoc test cherry-picking. |
| E5 — Challenge evidence | Add source-family grouping, explicit counterevidence retrieval, both, or neither. Compare with spending the same calls on ordinary additional retrieval. | Frozen duplicate-origin and mixed-evidence fixtures plus real tasks; contradiction recall, origin precision/recall, changed decision quality, useful coverage. Model debate is optional, not presumed helpful. |
| E6 — Find the search stopping point | Compare search depths and stopping on completed evidence obligations versus a fixed call limit. | Hold answer obligations and generator fixed; test compact packets versus raw accumulated context; measure supported useful findings gained per additional spend, omission, cost, and latency. More sources can change claim difficulty: analyze that confound. |
| E7 — Preserve revisions and repairs | Apply three content/format revisions; then change one upstream source in a seeded dependency graph. Compare full rewrite/full recheck with scoped repair plus final census. | Previously satisfied obligations, new feedback incorporation, citation retention, correction closure precision/recall, stale-use prevention, replay, repair cost. Independently known graphs provide gold for correction tests. |
| E8 — Inspect production attribution | On a small offline subset, remove or replace a cited source family and add a relevant irrelevant-to-answer/no-op control. | Multiple runs, frozen retrieval, compare answer/citation changes and support. Report intervention sensitivity; do not label this proof of internal causal reliance. Keep this out of the routine critical path unless it earns value. |

Each experiment records a hypothesis, success/failure interpretation, resource cap, seeds, input manifests, exact evaluator policy, and analysis plan before execution. Include unsuccessful runs and source-access failures in the results. Preserve source evidence within permitted retention/disclosure limits.

## 6. Statistical analysis and decision rules

Primary comparisons are paired by task. Use task/report-cluster bootstrap intervals for quality and cost differences, respecting shared-source families; use larger topic/family blocks when clusters overlap substantially. Do not treat 30 claims from one report as 30 independent trials. Report confidence intervals and slice sample sizes, not only p-values. Name a small set of primary hypotheses in advance; label the many secondary slices exploratory or apply an appropriate multiplicity adjustment.

Define non-inferiority margins for coverage and unsupported-release risk on calibration data using product consequences, not whichever values allow a candidate to pass. Proposed starting margins: at most 2 percentage points lower required-question coverage and at most 1 point higher released unsupported rate than the stronger baseline. Preregister task-level macro averages as the primary paired comparison. Require the one-sided 95% lower bound on candidate-minus-baseline coverage to exceed −2 points, and the one-sided 95% upper bound on its unsupported-rate difference to be below +1 point. Report pooled counts as secondary measures. These margins need approval for the initial use; they are not acceptable for all high-consequence settings. A candidate must meet absolute release gates as well as relative comparison. A weak reference baseline cannot license weak production behavior.

For a cost claim, require a paired interval indicating lower full machine cost and separately show human-review changes, p95 latency, and repair burden. Do not collapse expert time into a nominal dollar figure without stating the rate and sensitivity range.

The rule of three illustrates sample requirements: with zero errors in `n` independent Bernoulli opportunities, the approximate one-sided 95% upper error bound is `3/n`. Roughly 150 opportunities are needed for a 2% bound and 300 for 1%. Exact binomial bounds are preferable where assumptions apply. Correlated claims and selected negative fixtures do not satisfy independence or represent natural prevalence. A zero-error empirical bootstrap cannot certify a zero-width risk interval; use a justified rare-event bound and independent sampling design, or state that the gate is not established. The 120-task suite is a starting evaluation design, **not a guarantee it can certify the proposed risk limit**. Expand relevant independent samples or retain human gates if uncertainty is too wide.

## 7. Proposed promotion gates

All thresholds here are policy proposals, not empirical outcomes or published safety standards. Freeze them before testing.

| Gate | Proposed evidence required |
|---|---|
| Measurement validity | Reliable human adjudication and a documented error taxonomy; classwise judge performance on representative positive, hard-negative, mixed, and unassessable cases. No single aggregate agreement score substitutes for this. |
| Structural integrity | Zero silent source/locator substitution, fabricated evidence IDs, accepted tampered inputs, unauthorized disclosure, or stale-use admissions in the defined deterministic fixture suite. Passing this suite is bounded test evidence, not proof of universal absence. |
| Assertion discovery | At least 98% occurrence recall overall on gold; all designated critical assertions found in the critical fixture suite; qualifier retention reported separately. |
| Official-use support | Target one-sided 95% upper bound on released unsupported rate below 2% for the initial noncritical domain; separately require the released ineligible rate to meet the same bound. Human-unresolved released assertions are disallowed under this profile. Report candidate false acceptance on negatives separately. |
| Critical conclusions | Every critical conclusion has adequate premises, disclosed inferential steps, explicit conflict handling, and qualified human sign-off until slice-specific automatic performance is established. |
| Usefulness | Required-question coverage at least 90% on the approved rubric and within the approved non-inferiority margin of B3; appropriate evidence-limited responses assessed against the rubric. |
| Economics | Candidate chosen from policies that satisfy quality/usefulness gates; total measured cost advantage or a documented quality gain worth the extra cost. No mandatory percentage saving invented from literature. |
| Revision/correction | No designated critical regression; report-level preservation within approved margin; all known affected uses found in seeded graphs without suspending independent branches; no stale-use race failures. |
| Transfer | Shadow and time/domain-shift results remain inside the agreed limits. Otherwise narrow scope, recalibrate, or keep review requirements. |

If a gate cannot be estimated with adequate precision, status is “not established,” not “passed.” Calibration or policy changes after examining the test results require a new held-out evaluation. Roll back to the previous policy or narrower use profile if drift increases false acceptance or uncertainty.

## 8. Budget and deliverables for approval

Proposed initial commissioning cap: **up to 24 development tasks, up to 60 expert hours, and up to $300 machine expenditure**, stopping at the first cap. These are suggested authorization limits, not quotes, prices, or a promise that the work fits. This cap covers initial task/gold design and a small cost-metering subset of arms, not the full five-arm comparison or promotion certification. The research mission that produced this proposal did not commission these runs or spend this pilot budget. Use the pilot to estimate labeling speed, output-audit sampling needs, task cost, and failure prevalence; request a concrete full-suite budget from those measurements.

Deliver a manifest of tasks/source versions; rights and retention notes; annotation guide and labels; pinned baseline/policy/evaluator configurations; raw counts and error slices; risk–coverage–cost plots; paired uncertainty intervals; representative successes and failures; revision/correction traces; and a recommendation to promote, narrow, change, or reject the candidate policy.

The approval packet must state the exact domain, permitted use, risk threshold, remaining human-review requirements, responsible owner, and rollback conditions. A good report score does not authorize automatic knowledge mutation or deployment.
