# Evidence and verification system: consolidated final proposal

**Status: PROPOSED consolidation, 2026-10-17.** This document integrates three layers that already exist
in this repository and one research note, into one reading route and one implementation position. It
changes no architecture decision on its own. Where it proposes an amendment to the 2026-10-10 packet,
the amendment is labelled and listed in section 8 for owner review.

| Layer | Where | Status today |
| --- | --- | --- |
| As-built verification module (`verification.v1`): five ordered questions, verdict lattice, 13 operation kinds, executor and platform surfaces, admission, recovery, checkpoints, source accounting | [`docs/verification/`](../../verification/README.md), [`knowledge/verification-and-admission.md`](../../../knowledge/verification-and-admission.md), [`packages/verification/CAPABILITIES.md`](../../../packages/verification/CAPABILITIES.md) | Implemented; "engineering-ready for Mission Control integration, quality promotion still gated" (31 proved / 8 partial / 7 missing on 2026-09-08). |
| Research proposal "Evidence that earns its cost" | [`evidence-research-proposal-20260927/`](../evidence-research-proposal-20260927/README.md) | Historically PROPOSED. Its adopted parts are listed in the annex below. |
| Verification annex of the BellLabs Knowledge Platform packet, with issues V01–V15 and ADRs 0007/0009/0011 | [`docs/specs/belllabs-knowledge-platform/VERIFICATION.md`](../../specs/belllabs-knowledge-platform/VERIFICATION.md), [issues](../../specs/belllabs-knowledge-platform/issues/) | Owner-authorized implementation direction (2026-10-10). Every V-issue is "implementation not started". V07 is `needs-info` behind Q01. |
| Research-and-reports note: sources, research loop, Jev placement | [`BellLabs/docs/research/2026-10-17-research-and-reports-sources-strategy-jev.md`](../../../../../docs/research/2026-10-17-research-and-reports-sources-strategy-jev.md) | Discussion note (2026-10-17). Section 4 of this document maps it onto the annex. |

The architecture authority remains the 2026-10-10 packet and ADRs 0005–0015; Linear owns delivery
status after promotion. This document is the integrating layer that answers three questions the
packet does not answer in one place: what the whole system is end to end, where the research loop and
Jev attach to it, and whether Biotech and AI Engineer have different verification flows.

## 1. Decision summary

1. **One engine, one contract, one verdict lattice for both domains.** Biotech and AI Engineer do not
   have different verification flows. They have different *pinned rubric profiles* and different
   *admission projections*. Both are data and adapters selected by profile, not branches in the
   algorithm (ADR 0009, annex §4 and §5). Section 5 lists every concrete difference and classifies it.
2. **The staged pipeline is: custody → L0 mechanics → census and support sets → L1 evidence-closed
   support → risk-routed L2 authority and counterevidence → L3 adjudication → use decision → domain
   projection → revalidation.** L0 and the final census are universal and cannot be waived by budget,
   confidence, or human action. Everything above L1 is risk-routed by a rule-based router with a
   routing receipt (annex §3 step order, §4).
3. **The research loop is a producer of verification inputs, not a parallel verification path.**
   Obligation ledger → `VerificationTaskContract`; evidence packets → `EvidenceFragment` and
   `SupportSet`; challenge rounds → `AuthorityObservation` with bounded counterevidence (V05); final
   census → V02; sealed report → report assessment and use decision. Section 4.
4. **Jev is a candidate B2 small verifier and a pre-filter, never a verifier of record.** It enters the
   pipeline only through the calibration registry (V09) and the rule router (V03), and never above the
   deterministic gate. Section 4.3.
5. **Verification is separate from admission, and admission is separate from publication.** A seal is
   custody; `packages/policy` is the admission authority; domain stores own canonical effects; human
   adjudication records review and today changes nothing (`admissionChanged` always false). This stays
   true until V06/V07/V08 deliver exact use-binding admission.
6. **Scientific automatic promotion stays human-gated** until a Biotech-specific adjudicated slice
   exists (annex §4, §8). Passing the engineering benchmark does not qualify scientific admission.
7. **Implementation order is V01–V08 (boundary and integrity), then V09–V12 (measurement and reuse),
   then V13 (qualification), then V14 (consumer rollout).** V07 waits on Q01. The research-loop skill
   and the source registries can proceed in parallel because they consume `verification.v1` as it
   exists today.
8. **No quality, cost, or safety number in this document is a measured result.** The 98% census recall,
   2% unsupported upper bound and 90% coverage figures are initial noncritical engineering targets
   adopted by the annex; "not established" is the correct status for every one of them today.

## 2. The system end to end

### 2.1 Stage table

Each row names the stage, what exists today, what the annex adds, and the issue that delivers it.

| # | Stage | As built today | Required delta (annex) | Issue |
| --- | --- | --- | --- | --- |
| 0 | **Task contract** | Mission `research_questions` free JSON; report `report_question` after the fact; executor intents per claim | `VerificationTaskContract`: frozen obligations and weights, cutoff, permitted sources, use, minimum risk, resource limits, rubric/policy versions. KS freezes it even when MC supplies task identity. | V01 |
| 1 | **Acquisition and custody** | Executor `verify_capture_source/file`, platform `knowledge.capture/v1` (web_page+html_dom, pdf+pdf_text+geometry only); sealed bytes with digest; discovery attempts preserved and self-reported imports marked | Unchanged. Capture once, reuse by digest + lineage + parser + rights + tenant (annex §7). | V10 |
| 2 | **L0 mechanics** | `verifyDeterministicBundle`: capture/selector/identity/type/unit/time/arithmetic/provenance; 12 selector kinds in the library, text quotes only on the executor; 11 field comparisons; `SEMANTIC_MECHANICAL_GATE_CLOSED` | Unchanged semantics. Unsupported media is explicit `unable_to_assess`; broken pointers never become semantic contradictions. | — |
| 3 | **Assertion census and support sets** | `report/decomposition.ts` validates *supplied* segmentation and offsets; `report_assertion` spans; `report_assertion_claim` roles including `premise` | Independent discovery of occurrences (prose, headings, captions, table cells, uncited text); `AssertionVersion` and `AssertionOccurrence`; `SupportSet` with all-required premises per set and separate alternative sufficient sets; missing citations stay in the denominator. | V01, V02 |
| 4 | **L1 evidence-closed support** | `semantic/authorize.ts`, `verify-case.ts`, `judge-output.ts`: evidence-only judge, 16 fragments / 16k chars each / 64k total, cross-family second judge on high/critical or uncertain; world correctness, authority and attribution set to `not_assessed` | Shared rubric: complete exact assertion, entity, quantity/denominator/unit, population, time, baseline, negation, modality, causal wording, attribution; cite admitted fragment IDs; list unsupported facets. Routing receipts, required-review behaviour, calibration profile, sampled-pass audits. | V03, V09 |
| 5 | **L2 authority and counterevidence** | `authority/assessment.ts`: one qualifying independent family satisfies corroboration; no origin lineage, applicability, or retraction check | `AuthorityObservation`: origin lineage with unknown frontier, directness, applicability, freshness, jurisdiction, revision/retraction. Bounded counterevidence capability: capture and L0 every rescue source; rescue never repairs the original citation retroactively. | V05 |
| 6 | **L3 adjudication** | Request and decision operations exist; decision actor must be `human` or `service:human_reviewer`; `admissionChanged` always false; no human gold labels | Reviewer grants bind exact contested versions; decisions carry evidence and actor provenance; critical conclusions require qualified human sign-off until slice calibration exists. | V06, V07, V14 |
| 7 | **Use decision and policy** | `packages/policy` admission per use; `PolicyOutcome` pass / pass_with_warnings / review / fail / abstain; fail-closed codes | `UseDecision`: exact assertion/support-set/report/effect digest, policy/rubric/calibration versions, conditions, expiry/refresh triggers, revocation epoch. Decisions reference digests, never mutable booleans. | V01, V03 |
| 8 | **Domain projection** | AI Engineer: `knowledge-db` evidence admission hydrates claims from sealed artifacts. Biotech: locator UID existence only | AI Engineer: extend `AuthoritativeClaim` with rubric, calibration, selected sufficient set, exact use/effect, revocation generation. Biotech: trusted admission witness, `VerificationBinding` kernel extension, outbox-before-dispatch, pending projection, verified acknowledgment, authoritative PostgreSQL eligibility check on every official use. | V06, V07, V08 |
| 9 | **Revalidation and correction** | `revalidation_policy/event`, `claim_conflict`, `conflict_reconciliation` tables; durable recovery cases with immutable denominators | Dependency closure premise → derived → occurrence → use → effect → publication; source correction, retraction, parser, rubric, policy or expiry enqueues the affected closure only; final census catches newly added text. | V12 |
| 10 | **Reuse and economics** | Replay of sealed runs; recorded provider outputs; no semantic cache | Deterministic memoization, semantic observation cache keyed on the full binding, admission reuse with fresh policy check, duplicate-occurrence sharing, isolated batches, bounded concurrency, cheap-first cascade only after B2/B3/B4 comparison. Meter everything including failed and held work. | V10, V11, V13 |
| 11 | **Transports** | HTTP (36 routes), `ks` CLI, MCP (30 tools), executor `knowledge-verify`; two surfaces must not be mixed in one run | Identical tenant/actor/use/admission/error envelopes across surfaces; v1 compatibility; capability negotiation; MC cancellation distinct from semantic hold. | V14 |

### 2.2 Invariants that do not move

These are already true in the as-built module and are restated by the annex. They are the test of
whether any later change is acceptable.

- Later stages may add restrictions; they never reverse an earlier deterministic failure.
- Evidence support, world correctness, attribution faithfulness, source authority and provenance
  integrity are stored and reported separately. No aggregate score erases a component. `not_assessed`
  is a value, not a gap to be filled by inference.
- A seal is custody. A passing report verification is not admission. Admission is per intended use.
  Publication is a separate reviewer-authorized act.
- Producer and verifier are different deployments. A reused judge is never an independent vote.
- Missing evidence means unknown, never false. Inability to fetch a source is an availability failure.
- Model confidence is diagnostic. No raw provider confidence is presented as calibrated. Caller-supplied
  lower risk cannot reduce the service-computed floor.
- Original denominators (obligations, candidates, failed versions) persist across repair, cancellation
  and retry.
- Source content is untrusted data at every stage. It cannot grant access, choose a threshold, or
  authorize a downstream action.

### 2.3 The verdict lattice and outcomes, unchanged

`SemanticVerdict`: pending_semantic_review, directly_supported, supported_with_qualification,
partially_supported, context_only, contradicted, mixed_or_conflicting, not_supported,
insufficient_evidence, unverifiable, source_unavailable, locator_error, parser_error, derived_verified,
derived_failed. `PolicyOutcome`: pass, pass_with_warnings, review, fail, abstain. Mechanical status:
passed, failed, review_required. Adjudication: affirm, reject, defer with `human_origin` or
`synthetic_engineering` provenance. Both domains consume these without translation; Biotech's
`verdict-lattice.yaml` mirrors them.

## 3. Verification levels and routing

Adopted from the research proposal and frozen by the annex (§4). Reproduced here because it is the
single most important operational table.

| Risk | Minimum routing | Admission before qualified automatic calibration |
| --- | --- | --- |
| Low | L0 + L1; sampled apparent passes audited independently | Official low-consequence source-attributed or engineering output needs a qualified calibration profile or human review. The scoped literal-extraction exception stays low-risk-only and never certifies world truth. |
| Medium | L0 + L1; L2 for uncertain applicability, changeable facts, conflict, or material inference | Hold uncertain or shifted cases; narrow attributed statements can pass with preserved qualifications. |
| High | L0 + L1 + L2 authority/counterevidence + cross-family L3; qualified human when the evaluator slice is unqualified | No admission from agreement or raw confidence alone. |
| Critical | All levels, complete premises, applicability, counterevidence frontier, qualified human sign-off | Unknown facts, contradictions, missing review, or unsupported media hold or fail. Human action cannot waive failed mechanics. |

Risk is derived from intended effect, consequences, uncertainty, volatility, unfamiliar modality or
domain, and downstream reuse. The router is rule-based first (V03); learned routing is deferred. A
routing receipt records matched rules, risk inputs, required versus completed levels, audit inclusion
probability, calls and budgets, stop reason, and incomplete requirements. Budget exhaustion, a missing
judge, a timeout, or a denied provider yields review or abstention, never a pass.

**Support-set rule.** An assertion passes if at least one alternative set fully supports it and every
required premise within the chosen set is supported. Contradictory evidence in other sets is
preserved and resolved by policy; choosing an easy alternative cannot hide contrary findings. A cycle
of derived assertions with no grounded premise is invalid. Unknown ancestors are an explicit frontier
and hold consequential conclusions.

## 4. Where the research loop and Jev attach

The research note describes how a sandboxed agent runs a mission from question to sealed report. The
annex describes how a report earns admission. They meet at well-defined records. This section is the
map; nothing here adds a second verification path.

### 4.1 Record mapping

| Research-loop artefact (note §2.3, §2.4) | Verification record (annex §3) | Who produces it | Issue |
| --- | --- | --- | --- |
| `mission.json` and `ledger.jsonl` (obligations, risk tier, cutoff, budgets, permitted sources, obligation states) | `VerificationTaskContract` frozen by KS at run start; obligation IDs reused on every `AssertionOccurrence` | Research planner proposes; KS freezes | V01 |
| `captures/` manifest with sealed bytes, digests, times, rights, attempt IDs | `EvidenceFragment` source/capture/representation bindings | Executor capture operations | existing |
| `packets/<sub>/<id>.json` (fragments, locators, roles, supported scope, conflicts, gaps) | `SupportSet` members with roles; alternative sufficient sets when the packet names them; context-only material stays `context` | Researcher workers | V01 |
| `claims/<sub>.jsonl` (atomized claims with type, qualifiers, premises) | `AssertionVersion` with qualifiers and premise dependencies | Extractor (never the same deployment as the verifier) | V01 |
| Disconfirmation plan and challenge results at sub-objective close | `AuthorityObservation` plus bounded counterevidence run; a search that found nothing is still an observation with its queries, frontier and budget | Challenge worker | V05 |
| Origin-family grouping from the literature tooling | Source-origin lineage on `AuthorityObservation`; unknown origin remains unknown | `literature.*` helper, then KS authority stage | V05 |
| `drafts/sections/` then composed `report/` | `AssertionOccurrence` spans bound to the final report digest; independent census over final bytes | Writer, then KS census | V02 |
| Jev receipts in `assessments/` | `VerificationObservation` with method/model/question-set hash; `CalibrationProfile` per question and slice | Jev service, KS routing | V03, V09 |
| Sealed report and `report_assessment` | `UseDecision` with conditions, expiry, revocation epoch | KS policy | V01, V03 |
| Cross-part synthesis of a multi-part mission | Derived assertions with premises pointing at each part's sealed assertions; `derived_verified` / `derived_failed`; conflict alignment on entity, time, population, method before "contradicted" | Synthesis worker, KS | V01, V12 |

### 4.2 Gap list from the research note, resolved

| Gap (note §4) | Resolution |
| --- | --- |
| 1. Mission-time obligations untyped | `VerificationTaskContract` (V01). The ledger is the worker's local projection of that contract and of the Mission Control work item; no new table. |
| 2. Origin families have no producer | Source-origin grouping is in V05; the producer helper belongs to the `literature.*` and `edgar.*` tooling, which emit candidate families that V05 records with an unknown frontier. |
| 3. Challenge records | V05 `AuthorityObservation` includes the counterevidence search as an observation. Amendment A2 in section 8 makes the "searched, found nothing" case explicit. |
| 4. Alternative sufficient sets | `SupportSet` (V01) already separates conjunctive premises from alternatives. |
| 5. Source-authority register per claim kind | Domain rubric registry (V03) plus the D11-format action-space registries per domain. Biotech has 167 entries; AI Engineer and finance need theirs. |
| 6. Freshness triggers | `UseDecision` expiry and refresh triggers (V01) feed revalidation (V12); the Biotech `monitored` claim disposition maps to a refresh trigger, not a verdict. |
| 7. Jev receipts | `VerificationObservation` carries method/model/configuration digests; the Jev job ID and question-set hash go in that record (amendment A1). |
| 8. Two claim identities | Platform `claim_digest` and Biotech `propositionHash` stay distinct; `VerificationBinding` (V07) carries the KS assertion version and digests into the graph, so the graph never stores a verdict it cannot replay. |
| 9. Human adjudication cannot change admission | Intended today. V06/V07/V14 deliver exact use-binding admission with reviewer grants; until then high-risk reports stay held. |
| 10. No study-quality model | Scientific rubric fields (annex §4) are required by claim class and domain contract; GRADE-style structured domains are a Biotech schema decision under Q01, not a verification-engine change. |

### 4.3 Jev placement

Jev may sit in exactly three places, all below the human and above the deterministic gate:

1. **Pre-filters that select work, never verdicts.** Lead relevance, source type, document kind,
   claim type, statement kind, risk-tier feature for the router, concept tagging. Their outputs are
   routing inputs and never appear as a support verdict. They need calibration only for their own
   error cost (wasted or missed work).
2. **B2 small verifier at L1.** "Fragment states or directly entails claim", "summary drops a
   qualifier present in claim", "fragment B reports the same experiment as fragment A". Jev becomes
   eligible only through a `CalibrationProfile` per question, domain, media and risk slice (V09), the
   rule router (V03), sampled-pass audits, and the B2/B3/B4 paired comparison (V13). Until then its
   answers are advisory observations with `pending_empirical_labels` status.
3. **Census assistant at V02.** "This sentence or table cell makes a checkable factual assertion."
   Recall is the metric; the 98% target applies to the census as a whole, with Jev as one candidate
   discovery method, never the only one.

Constraints inherited from the Jev skill and ADR 0010: question sets are versioned artifacts with
hashes recorded on every result; thresholds do not transfer across primitives or versions; code owns
counting, arithmetic, dates, units and identity; windows carry provenance and are never silently
truncated; Jev 1.13 is steerable by adversarial text, so it never sees untrusted content in a decision
that grants scope, authority, or publication. Domain skills own the recipe bundles (DOMAIN-SURFACES
§6 lists the initial AI Engineer and Biotech recipes).

## 5. Biotech versus AI Engineer: same flow, different profile and projection

Verdict first: **the verification flow is the same.** Stages 0 through 7 in section 2.1, the verdict
lattice, the routing table, the support-set rule, the reuse rules, the census gate and the economics
gates apply identically. ADR 0009 states this as a decision ("a tier or database must not change the
meaning of a judgment"), and the annex implements it by making every domain-specific element either a
pinned artifact or an adapter chosen by application profile.

The differences are real but they are all in two places: the **rubric profile** (what the judge must
check for a claim class) and the **projection** (how an admitted result reaches the domain store and
how a later official use is checked). The table classifies each.

| Element | AI Engineer | Biotech | Flow difference? |
| --- | --- | --- | --- |
| Verification engine, contracts, operations, transports | `verification.v1`, KS packages, HTTP/CLI/MCP/executor | Same | No |
| Verdict lattice, policy outcomes, mechanical status | KS enums | `verdict-lattice.yaml` mirrors them | No |
| Risk routing and levels | Annex §4 | Same table | No |
| Rubric profile | Educational (explanations, prerequisites, declared simplifications, reproducible examples) and Engineering (official specs self-sufficient, version/config/benchmark/denominator match, repository selectors bind commit and bytes, executable observations separate from static support) | Scientific (source report versus generalized proposition; design, population/species, intervention, comparator, endpoint, sample size, uncertainty, effect measure, follow-up, applicability, confounding, jurisdiction/date, retraction status; one study across reviews and news is one origin) | No. A pinned rubric artifact selected by profile (V03). The engine runs the same stages with different required facets. |
| Automatic promotion scope | Initial noncritical engineering profile may qualify through V09/V13 | Scientific automatic scope stays unqualified until its own adjudicated slice exists | No at the flow level. Different *gate state*, same gate. |
| Operational verification store | App-local PostgreSQL common KS component (`knowledge_service.operation`, `evidence.verification_*`, provider records) | Same component in Biotech's app PostgreSQL (consumes it once published; must not copy SQL) | No (V04) |
| Canonical domain store | PostgreSQL via `ai-engineer-db-contract` | Neo4j kernel (Source, SourceSnapshot, SourceLocator, Assertion, Claim, Adjudication, Assessment, Report, Activity) | Projection difference |
| Admission projection | In-process trusted oracle hydrates claim content and decisions from the co-hosted sealed store; database triggers enforce it (`enforce_verified_claim_gate`); extend `AuthoritativeClaim` with rubric, calibration, selected sufficient set, exact use/effect, revocation generation (V06) | Cross-store: `AdjudicationProposal` carries only a `verificationRef`; the executor hydrates the verdict from an Ed25519-signed `bks-sealed-verification.v1` checked against pinned issuer keys; witness issuance (`bks-apply-witness.v1`) rehydrates every cited sealed verification; pure planner + single `KsIntentMarker` transaction; admission endpoints for witness, revocations, deliver, reconcile and eligibility (Biotech ADR 0005); `VerificationBinding` kernel extension, outbox-before-dispatch and verified acknowledgment still to build (V07, V08) | **Real mechanism difference**, by design. Biotech has no distributed transaction, so a physical stale projection can exist and the guarantee is "a stale projection cannot authorize official use once revocation is observed". AI Engineer's effect and decision commit in one database. The verdict semantics entering both are identical. |
| Claim identity | `evidence.claim` with run-qualified `claim_digest`; UUIDs | `Claim.propositionHash` with Assertion occurrences; `hu:` UIDs; the full v1 selector is carried as JSON | Representation difference, carried by `VerificationBinding`; no coercion either way |
| Adjudication representation | `verification_adjudication_subject/decision` rows written by KS `requestAdjudication` / `recordAdjudicationDecision` | Immutable `Adjudication` node with `SUPPORT` or `CAPTURE_FIDELITY` kind; a human `AFFIRM` with `HUMAN_ORIGIN` arrives as a superseding sealed record; no native request path | Representation and delivery difference, same KS producer. One asymmetry: only Biotech's `CAPTURE_FIDELITY` adjudication may feed a graph `Assertion.status` projection. Support verdicts never change `Assertion.status` in either domain. |
| Locator kinds in practice | Text quote, JSON pointer, repository, table, PDF text and geometry, transcript timecode | Same library; PDF tables (labels, COAs), registry records, transcripts dominate | No |
| Content kinds verified | Course, challenge, project (runnable workspace and test receipts) | Protocol edition, report, article, timeline (scientific qualifiers, valid/recorded time) | No at the flow level. Domain payload validators are separate from verification (ADR 0011). |
| Jev recipes | question-route, content-kind, learning-fit, source-change-triage, tool-fit | claim-context, study-applicability, protocol-completeness, evidence-relation, timeline-event, evidence-gap-priority | No. Recipe bundles are domain skill deliverables under one calibration discipline. |
| Mission Control | Same common runtime and catalog, separate app database; MC correlation nullable on standalone runs. The `verificationWorkflow` adapter referenced by the integration guide lived in the retired `ai-engineer-mission-control` repository; no AI Engineer adapter exists under `platform/mission-control/integrations/` | `integrations/biotech/.../knowledge/` adapter with six logical interfaces (describe, query, plan, apply, receipt, verify_result); its capability file marks `knowledge.verify` unsupported because "Biotech consumes sealed verification references" | **Wiring difference today, not by design.** Mission Control's `verification_dispatch` executor kind is absent for both. |
| Agent procedure (skills) | `claim-evidence-workflow` skill with extractor and verifier roles; independence enforced by a database trigger | No verification or claim-evidence skill; only `biotech-kg-*`, schema, graph and Firecrawl skills | **Real procedure difference today.** Biotech needs the same skill with the scientific rubric overlay; it is a domain skill deliverable under ADR 0010, not a new flow. |
| Readiness | V06 ready-for-agent; sealed-run path implemented and database-enforced | V07 needs-info behind Q01 (minimal graph binding and pin); KS does not yet emit `bks-sealed-verification.v1`, so Biotech admission proofs run against a stand-in verifier script with synthetic data | Schedule and maturity difference |

Two further observations:

- The as-built verification documentation never mentions Biotech. The only domain marks are package
  names, the `ai-engineer-cloud-bucket` bucket, the `ai-engineer-db-contract` pin, and the
  `diagnostics-companies-v1` benchmark dataset. That absence is consistent with one flow: the module
  was written domain-neutral and the annex kept it that way.
- The Biotech evidence-report skeleton (`d10.evidence-report@1`: claim under test, interests, evidence
  for, evidence against, verdict, harms, open questions) is a *report obligation template*, not a
  verification difference. It feeds `VerificationTaskContract` obligations and the census. AI Engineer
  should adopt an equivalent template per content kind rather than a different pipeline.

So the suspicion is correct. The one thing to resist is letting the two projection adapters drift into
two semantic implementations. The acceptance criteria that keep them honest are V04 (one SQL
component), V08 (cross-store delivery tests that distinguish physical projection presence from current
eligibility) and V14 (identical envelopes across surfaces).

Two drifts already visible, both to close under those issues rather than by local patches:

- AI Engineer's `claim-evidence-workflow` contract says only `directly_supported` may promote a claim
  to `verified`, while the database gate `enforce_verified_claim_gate` also accepts qualified and
  derived findings. The database is the authority; the skill text must be aligned, and the annex's
  "qualified support is admissible only when the qualification appears in the output occurrence and
  the allowed-use policy" is the rule both must state.
- Biotech's `verdict-lattice.yaml` lists open items: no total order of verdicts and the effect of a
  human `REJECT` is undefined. Neither should be resolved in the graph vocabulary alone; the KS
  `UseDecision` semantics (V01, V03) define them and the graph mirrors them.

## 6. Implementation position

Release sequence from the annex §9, unchanged, with what each stage unblocks for research:

| Stage | Issues | What it proves | What it unblocks |
| --- | --- | --- | --- |
| A. Boundary and integrity | V01, V02, V03, V04, V05, V06, V08; V07 after Q01 | Obligations, support sets, census, router, authority and counterevidence, SQL component, AI Engineer exact admission, cross-store delivery | Research runs can produce `VerificationTaskContract` and `SupportSet` inputs; reports can be censused against obligations. |
| B. Measurement and reuse | V09, V10, V11, V12 | Honest calibration, evidence-bound cache, isolated batches, revalidation closure | Jev and other cheap judges can be *measured*; semantic reuse becomes safe; corrections propagate. |
| C. Qualification | V13 | Paired B0–B4 comparison with human anchor and full cost | A noncritical engineering profile may be promoted; scientific remains human-gated. |
| D. Consumer rollout | V14 | Transport parity and capability negotiation | Research agents and product agents call one admitted surface; A01 (Research delegation) and C02 (Biotech research artifact) can close. |

Work that proceeds in parallel now, without waiting on any V-issue:

1. The domain-neutral research-loop skill (run layout, obligation ledger, packet format, section-wise
   drafting, checkpoint discipline) over the existing executor surface `knowledge-verify`
   (capture → quote → intent → judge → policy → seal → check-report). It must emit packets in the
   `SupportSet` shape so that V01 is an adapter, not a rewrite.
2. Action-space registries for AI Engineer and finance in the Biotech D11 format, plus source-authority
   registers per claim kind, which become the V03 rubric inputs and the V05 origin-family seeds.
3. `literature.*` and `edgar.*` tooling, which produce the captures, identifiers and candidate origin
   families V05 needs. They register captures through the executor and never wrap inside KS MCP.
4. Jev question bundles per domain with pilot labels, kept advisory until V09.
5. A Biotech verification skill: the AI Engineer `claim-evidence-workflow` procedure (extractor and
   verifier roles, exact locators, fail-closed verdicts, time-scoped facts) with the scientific rubric
   overlay from annex §4 and the `d10.evidence-report@1` obligation template. This is the only
   procedure asymmetry between the domains and it is a skill deliverable, not engine work.

Not before their gates: any semantic cache (V10), any cheap-first cascade in an official path (V13),
Biotech canonical admission (V07 after Q01), and any claim that the system is calibrated.

## 7. What is explicitly not established

- No human-labelled calibration exists. `semanticCalibrationStatus()` returns
  `pending_empirical_labels`; benchmark publications set `humanGoldValidated`, `sourceAuthorityAssessed`
  and `calibrated` to false; the 180 review candidates are blank.
- World correctness, source authority and attribution faithfulness are `not_assessed` in the as-built
  semantic path.
- Human adjudication records review only; it changes no admission.
- The executor accepts text quotes only; platform capture admits two media shapes; no OCR,
  transcription or visual grounding anywhere.
- No semantic cache, no batch judging, no bounded counterevidence capability, no independent census.
- Biotech canonical admission is locator-existence only for ordinary intents; the signed
  `bks-sealed-verification.v1` and witness path exists in Biotech contracts, but KS has no emitter for
  it and the proofs use a stand-in verifier with synthetic data; the custody bucket is missing and the
  admission ledger is file-based and single-host; the graph binding is unselected (Q01).
- Mission Control has no `verification_dispatch` executor kind for either domain, and no AI Engineer
  knowledge adapter exists under `platform/mission-control/integrations/`.
- All thresholds in section 1 item 8 are targets. Every V-issue is "implementation not started" as of
  2026-10-10, and this document ran no fixture, test, migration or provider call.

## 8. Proposed amendments to the 2026-10-10 annex

Small, for owner review. None changes a decision; each closes a seam the research note exposed.

| ID | Amendment | Where it lands |
| --- | --- | --- |
| A1 | `VerificationObservation.method` records, for Jev-produced observations, the Jev job ID, provider route, model version and question-set hash; `CalibrationProfile` is keyed per question ID and version. | V01 schema, V09 registry |
| A2 | `AuthorityObservation` gains an explicit `counterevidence_search` variant whose outcome may be `none_found` with queries, sources inspected, frontier and budget. Absence of a record means "did not look". | V05 |
| A3 | `VerificationTaskContract` is the frozen form of the research obligation ledger; the ledger format in the research note is declared the producer convention, and the Biotech `d10.evidence-report@1` sections are an obligation template both domains may use. | V01, research skill |
| A4 | Source-origin family candidates may be supplied by acquisition tooling as *proposals*; V05 records them with provenance and never promotes a proposed family to known without its own observation. | V05 |
| A5 | The D11 action-space registry format is adopted for all domains as the rubric-registry source of source authority and readiness; registries are versioned artifacts pinned by the rule router. | V03 |

### 8.1 Sprint V owner direction and implementation projection (2026-10-24)

The owner chose a full refactor, with existing application data/history treated as disposable;
AI Engineer's PostgreSQL knowledge graph first, then Biotech's versioned Neo4j GraphQL SDL immediately
after, in the same sprint. BKS becomes the explicit schema author. Evidence report and study appraisal
are the first complete report kinds over one extensible core. Recorded decisions: SV-D6..14 in the
[Sprint V answers](../../../../mission-control/docs/specs/provider-consolidation-2026-10/answers/sprint-v/codex-gpt-6-2026-10-24/ANSWERS.md).

The [plan](../../../../mission-control/docs/specs/provider-consolidation-2026-10/SPRINT-V-PLAN.md) and
[contract projection](../../../../mission-control/docs/specs/provider-consolidation-2026-10/SPRINT-V-DESIGN.md)
were accepted by the owner in SV-D13. They specify V01..V08 in full, including the common operational component and both native admission bindings.
They retain amendments A1..A5, add report v2 and post-semantic aggregation, independent census, exact-use
human adjudication and correction/revocation closure. V09 label/profile infrastructure and V14 parity
for shipped surfaces are included; V12's safety-critical invalidation is included now. Semantic caching,
batching, live retraction feeds and broader consumer rollout follow qualification. No calibration labels
or quality achievement are invented. Legacy data import and compatibility adapters are not required.

All records in annex §3 are represented in the target core; `CalibrationProfile` infrastructure does not
certify a calibrated slice. Outcome-level scientific certainty is separate from source-support checking.
One operational run store/sealer/oracle replaces the split worker/executor paths. Shared operational
objects transfer once to a common component; AIDB retains domain bindings, and BKS owns its SDL source
and generated pin. Migration ownership is changed explicitly, never by copying SQL into two authorities.

**Hard usage gate (SV-D12):** real research, ingestion, retrieval and retrieval experiments begin only
after all four canonical workflow systems have output contracts/context transfer and Deep Agents is
fully qualified. Direct KS tests, disposable database fixtures and bounded model-backed engineering
tests may establish this foundation first. Sprint V service integration does not open that gate.

This amendment records owner scope and the accepted implementation specification; it does not mark V issues complete,
change remote tracker status, certify schema deployment, or approve scientific automatic admission.

## 9. Reading route

1. [`docs/verification/README.md`](../../verification/README.md) for what runs today.
2. [`VERIFICATION.md`](../../specs/belllabs-knowledge-platform/VERIFICATION.md) sections 3, 4, 5, 8 for the contract, routing, projections and gates.
3. This document for the end-to-end stage table, the research-loop mapping, the domain comparison and the amendments.
4. The research note for sources, the run layout and the Jev question catalogue.
5. The V-issues for acceptance criteria; Linear for status.
6. The [content services proposal](../content-services-20261017/README.md) for what happens after
   verification: the report catalogue, derivation into entity and content ingestion, preparation,
   embedding, and retrieval-strategy promotion.
7. The [evaluation and improvement system](../evaluation-improvement-system-20261018/README.md) for
   how verification verdicts, adjudications and judge outputs become labels in the quality ledger,
   how judges are calibrated and admitted, and how improvement is proven over time.
8. The [datasets specification](../datasets-20261018/README.md) for how verification levels become
   per-column floors in released data products and how customer disputes return as verification cases.
