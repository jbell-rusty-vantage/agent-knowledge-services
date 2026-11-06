---
type: Specification proposal
title: "Content factory: content and media types, editorial evaluation, creative iteration and the content queue"
status: PROPOSED
date: 2026-10-18
owner: belllabs-platform
scope: [mission-control, knowledge-services, web-application, ai-engineer-db-contract, biotech-knowledge-services]
related:
  - ../content-services-20261017/README.md
  - ../evidence-verification-system-20261017/README.md
  - ../evaluation-improvement-system-20261018/README.md
  - ../datasets-20261018/README.md
  - ../../../../../docs/research/2026-10-18-factories-and-data-products.md
---

# Content factory

> **Status: PROPOSED (2026-10-18).** This document extends the factory model from reports and
> datasets to every kind of content and media the platform will publish: articles, newsletters,
> threads, images, diagrams, audio, video, courses, challenges, web pages and multi-chapter books. It
> answers three questions: how many kinds of content there are and how to classify them; what
> evaluation applies to content that gets released, with judgement, review and creative iteration at
> the centre; and what the content queue (the editorial desk in the dashboard) is. Nothing described
> here exists yet beyond the primitives named in §0.

## 0. Scope and what this builds on

| Layer | What exists (verified in source) | Relevance |
| --- | --- | --- |
| Captured content model (KS) | `packages/contracts/src/content.ts`: source roles, classification (public / restricted / confidential / sensitive), lifecycle (active / corrected / retracted / superseded / tombstoned), representation classes with `mediaType` and fidelity (byte_identical / faithful / derived), document node kinds, authenticity, `rights` (allowed / restricted / unknown / denied), acceptance dispositions | The same document, version, representation and node chain stores produced content; rights and classification carry over unchanged. |
| Captured media entities (AIE) | `corpus.media_work` (`media_kind` in video, audio, image, slide_deck, livestream, screencast; platform, channel, duration, dimensions, language), `corpus.video` with `transcript_artifact_id`, `corpus.talk`, `corpus.story`, `corpus.media_channel/platform/series` | Vocabulary for media kinds and channels already exists for *captured* media; produced media reuses it rather than inventing a second taxonomy. |
| Captured media (Biotech) | `MediaWork` with `rightsStatementVerbatim`; `MediaRightsRecord` folded into it | Rights statements as captured; produced media needs a rights manifest in the same spirit. |
| Reports | Ten report kinds with obligation templates; `report_register`; `report_derive` (proposed) | Reports are the evidence source for every evidence-bound piece of content. |
| Verification | Levels, claim binding, replay, judges with calibration | Correctness layer for content. |
| Evaluation system | Score vector, labels, grader registry, judge calibration, experiments, promotion decisions, error analysis, scorecard | Judgement layer and the improvement loop; the review workbench proposed there is the content queue's ancestor. |
| Mission Control | Mission templates, artefacts with schema refs and digests, human gates with feedback artefacts, goal verifier | Produces content pieces as artefacts; human gate is the first version of "approve / request changes". |
| Curriculum (AIE contract) | `curriculum.curriculum/track/module/lesson/lesson_version` (`content_artifact_id`, `publish_status` draft onwards, `published_at`), `learning_objective` with `bloom_level` (remember … create), `lesson_prerequisite` (no self-reference), `lesson_covers_concept` (depth mention / section / dedicated), `lesson_backed_by` (exactly one knowledge record plus `assertion_ref`), `challenge`, `challenge_version` (`statement`, `difficulty`, `environment_spec_artifact_id`, `rubric jsonb`, status), `challenge_targets`, `challenge_derived_from` | The course and challenge object model exists with grounding (`lesson_backed_by.assertion_ref`), Bloom levels and prerequisites built in. Missing: assessment items, cohorts, attempts and item analysis; no learner application consumes it. |
| Newsletter, publishing calendar, channel releases, editorial queue | None found in the surveyed contracts and source directories. | New, domain-owned (§8). |

## 1. Decision summary

1. **Content kinds are classified on six dimensions, not as a flat list.** Modality, form, purpose,
   grounding class, channel and lifecycle. The form catalogue (§2.2) has about sixty entries across
   seven modalities; the dimensions decide the evaluation, the review path and the rights work,
   the form decides the template.
2. **Every content kind has a content kind spec**, the analogue of a report kind's obligation
   template: required components, grounding class, rubric set, channel constraints, accessibility
   and rights requirements, review path and autonomy level.
3. **Four evaluation layers apply to released content**: correctness (verification of every
   factual claim for evidence-bound kinds), judgement (calibrated rubric judges and human preference
   per kind), fitness (channel, accessibility, rights, disclosure, safety, domain compliance) and
   outcome (what happened after release). Correctness and fitness are gates; judgement and outcome
   drive iteration and improvement.
4. **Creative iteration is a first-class, recorded loop.** Draft, critique, revise, with structured
   critiques bound to locations, revisions that cite the critiques they addressed, convergence and
   stop rules, different model families for author and critic, and every human edit captured as a
   preference label.
5. **Composite content (books, courses, campaigns, sites) is a tree of pieces with shared state**
   (a bible, a syllabus, a brand voice), gated at the outline and at each level, with continuity
   checks across siblings.
6. **The content queue is the editorial desk.** It is the review workbench of the evaluation system
   specialised for content: render, scores with rationale, critique history, grounding map,
   compliance checklist, variant comparison, inline edit with tracked changes, and decisions that
   are labels. It also serves error analysis and judge calibration.
7. **Autonomy is a ladder per content kind and channel**, promoted by measured edit distance,
   first-pass approval and post-release outcome, never by assertion.
8. **Educational content is evaluated on alignment and effect**: objective, content and assessment
   must agree in cognitive level; challenges must have a passing reference solution; items are
   analysed after a pilot cohort; completion and pass data feed revision.
9. **Taste for creative content is learned from pairwise preference, not asked of a judge.** Off-
   the-shelf judges reached 73% agreement with human preference on creative writing against 78% for
   small reward models trained on preference pairs (LitBench, EACL 2026); the platform collects
   pairs from its own editors and audiences before trusting any creative judge.
10. **Ownership**: Mission Control produces pieces as artefacts and runs the iteration loop;
    Knowledge Services grounds, verifies, evaluates and stores pieces in the content chain and runs
    the grader runtime; domain applications own channels, publishing, courses and the queue UI.

## 2. Content and media taxonomy

### 2.1 Six dimensions

| Dimension | Values | What it decides |
| --- | --- | --- |
| **Modality** | text, image, audio, video, interactive, data, composite | Which technical graders and renderers apply; which assets exist |
| **Form** | the catalogue in §2.2 | Template, required components, length and structure norms |
| **Purpose** | inform, educate, persuade or market, entertain, enable (reference), assess | Which judgement rubric dominates; which outcome metrics count |
| **Grounding class** | evidence-bound (every factual claim bound to a verified assertion), evidence-informed (narrative over evidence with opinion marked), creative (no factual claims, or fiction), promotional | Whether correctness gates apply and at which verification level; disclosure rules |
| **Channel** | platform web app, mobile app, website, courses, challenges, newsletter, third-party platforms (video, audio, social, publishing, code hosting), partner syndication, internal | Constraints (length, aspect, captions), policies, metrics available |
| **Lifecycle** | ephemeral, evergreen, serial, versioned edition | Review depth, maintenance cadence, retirement rules |

### 2.2 Form catalogue

The count that answers "how many types are there" depends on granularity; at the level where a
template and a rubric differ, the catalogue below has 61 forms. Captured-media vocabulary from
`corpus.media_work` is reused where it overlaps.

| Modality | Forms |
| --- | --- |
| **Text** (20) | evidence report (catalogue kind), article or blog post, long-form essay, explainer, tutorial or how-to, documentation page, reference entry or glossary term, FAQ, case study, newsletter issue, social thread, short post, press release, landing page copy, email sequence, script (video or audio), show notes, book chapter, multi-chapter book, white paper |
| **Image** (10) | diagram, chart or figure, infographic, illustration, thumbnail or cover, slide, slide deck, photo edit, UI mock-up, social card |
| **Audio** (5) | podcast episode, narration or voiceover, audiogram, interview edit, audio summary |
| **Video** (9) | explainer, screencast or tutorial, talking head, short-form vertical, lecture, animated explainer, trailer or teaser, interview edit, livestream segment |
| **Interactive** (8) | course module, lesson, quiz or assessment, challenge or exercise, notebook, playground or demo application, calculator or tool, interactive chart |
| **Data** (3) | dataset release (own specification), dashboard, table or leaderboard |
| **Composite** (6) | course, book, campaign, web page or site section, newsletter programme, talk kit (deck, script, notes, social cuts) |

Renditions are not new forms: a video cut to vertical, an article shortened for a newsletter, a
report summarised into a thread are **renditions** of a parent piece with lineage (§3.2).

### 2.3 Content kind spec

```yaml
ContentKindSpec:
  id: text.article.evidence-bound@2
  modality: text
  form: article
  purposes: [inform]
  groundingClass: evidence_bound
  sources: [report_kind: evidence_report | entity_dossier | monitoring_delta, dataset_release]
  components:                         # required parts, each gradable
    - { id: headline, required: true }
    - { id: standfirst, required: true, maxWords: 60 }
    - { id: body, required: true, minWords: 900, maxWords: 2000 }
    - { id: sources_section, required: true }
    - { id: hero_image, required: true, kind: image.diagram | image.social_card }
  rubrics: [correctness.evidence_bound@1, judgement.article@3, fitness.web@2, accessibility.text@1]
  styleGuide: brand-voice@4
  channels: [website, newsletter, platform_app]
  channelConstraints: { newsletter: { maxWords: 600, rendition: summary } }
  rights: { images: licensed_or_generated_with_manifest, quotes: allowed_sources_only }
  disclosure: { ai_generated: per_channel_policy, sponsorship: declare }
  reviewPath: { minHumanDecisions: 1, quorumFor: [medical_claims, legal_claims] }
  autonomyLevel: L2                   # see §6.5
  outcomeSignals: [reads, completion_depth, shares, corrections, subscriptions_attributed]
  evaluationCell: { domain, form: article, channel: website }
```

A content kind spec is a versioned artefact and a candidate under the evaluation system's experiment
contract; changing a rubric or a style guide is an experiment, not an edit.

## 3. Content object model

### 3.1 Piece, version, asset

```yaml
ContentPiece:
  id, kindSpecRef, title, domain, factoryRef, status: draft | in_iteration | in_review | approved | scheduled | published | retired | withdrawn
  derivedFrom: [report_version | dataset_release | entity | piece]      # lineage, mandatory for evidence-bound
  groundingMap: [{ span | region | timestamp, claimText, assertionIds[], verificationLevel, verdict }]
  styleGuideRef, brandVoiceRef, audienceRef
  rightsManifest: [{ assetRef, source, licence, attribution, consent?, modelOutputLicence? }]
  accessibilityManifest: { altText, captions, transcript, readingOrder, contrast, readingLevel }
  targetChannels: [channelRef]
ContentVersion:
  pieceId, iteration: n, authorRef (agent config digest or human), parentVersionId
  components: [{ id, representationRef }]                                 # stored in the content chain
  critiquesAddressed: [critiqueId], diffRef
  scoreVectors: [ScoreVector]                                              # evaluation system shape
  labels: [Label]
Asset:
  mediaType, digest, dimensions | duration, generation: { model, promptDigest, seed, params } | source: { captureRef }
  rights, derivedFromAssetId?
Critique:
  versionId, graderRef (agent, judge or human), dimensionId, severity: blocking | major | minor | suggestion
  location: { span | region | timestamp | component }
  finding, evidence, suggestedChange, status: open | addressed | rejected_with_reason | superseded
Rendition:
  parentVersionId, channelRef, transformation (summarise | cut | reformat | translate | caption), versionId
ChannelRelease:
  versionId, channelRef, scheduledAt, publishedAt, externalRef, status, metrics: [{ name, value, observedAt }]
```

Storage: pieces and versions are documents in the Knowledge Services content chain (document,
version, representation, node tree), so that grounding spans are node-addressable the same way
captured sources are; assets are binary representations with generation parameters; critiques,
labels and score vectors go to the quality ledger homes; channel releases and metrics belong to the
domain application's publishing tables (§8).

### 3.2 Composites and shared state

A composite is a tree of pieces with a shared state object:

| Composite | Tree | Shared state | Level gates |
| --- | --- | --- | --- |
| Multi-chapter book | book → parts → chapters → sections | **bible**: premise, audience, thesis per chapter, terminology, characters or recurring entities, style rules, cross-reference registry | outline approval; chapter approval; continuity pass; line edit; copy edit; proof; typeset |
| Course | course → modules → lessons → assets and assessment items | **syllabus**: objectives per level with cognitive verbs, prerequisite graph, misconception list, assessment map | objectives approval; syllabus approval; lesson approval; item review; pilot cohort; item analysis; release |
| Campaign | campaign → pieces per channel → renditions | **brief**: message, audience, calls to action, dates, claims allowed | brief approval; hero piece approval; rendition approval; schedule |
| Site section | section → pages → components | **information architecture** and terminology | structure approval; page approval; link and freshness checks |
| Talk kit | deck, script, notes, social cuts | **narrative spine** | script approval; deck approval; cuts approval |

Continuity checks run across siblings against the shared state: terminology drift, contradicted
facts between chapters, duplicated passages, broken cross-references, objectives without lessons,
lessons without assessment items. These are code graders where a rule exists and judges where it
does not.

## 4. Evaluation of released content

### 4.1 Four layers

| Layer | Question | Graders | Gate or signal |
| --- | --- | --- | --- |
| **Correctness** | Is every factual claim supported at the required level? | Claim extraction per component → binding to assertions (grounding map) → verification system at the kind's level; numbers, dates, names and quotes bound individually; opinions marked as such in evidence-informed kinds | Gate for evidence-bound and evidence-informed kinds: no unbound factual claim ships |
| **Judgement** | Is it good, for this kind, audience and channel? | Dimension-isolated rubric judges calibrated per kind; pairwise human preference; style-guide conformance (voice, terminology, reading level); structure checks (hook, thesis, progression, call to action); for images and video, technical dimensions plus advisory preference models; for long-form, coherence and continuity | Drives iteration and routing; becomes a gate only for dimensions whose judge is admitted and whose floor was set from human labels |
| **Fitness** | May it ship here? | Channel constraints (length, aspect ratio, duration, caption presence), platform policy, accessibility (alt text, captions, transcripts, contrast, reading order), rights (music, images, likeness and consent, model output licences, quotes), disclosure (AI generation labelling per channel policy, sponsorship), safety, domain compliance (medical and investment advice disclaimers, regulated claims) | Gate; failures are code-checkable wherever possible |
| **Outcome** | What happened? | Reads, completion depth, watch time, shares, saves, subscriptions attributed, course completion, challenge pass rate, corrections requested, complaints, unsubscribes, retention of the audience segment | Signal attributed to piece version and factory; feeds taste models and factory scorecards |

### 4.2 Correctness for content

Content is not re-verified from scratch. An evidence-bound piece is derived from reports and
datasets whose assertions already carry verdicts; the piece's grounding map binds each claim span to
those assertions, and the correctness grader checks three things: every claim span has a binding,
every binding's verdict and level meet the kind's floor, and no claim was introduced that has no
source (the "drift from source" check, which compares extracted claims against the derivation set).
A claim without a binding routes to the verification system as a new claim or is removed. Numbers
and dates are bound individually because paraphrase changes them silently. Images with factual
content (charts, diagrams) bind their data to assertions the same way.

### 4.3 Judgement rubrics per kind

Rubrics follow the evaluation system's rules: binary, content-bearing items grouped in dimensions,
one judge call per dimension, calibrated against human labels, "unknown" exit, different model
family from the author. Example dimension sets:

| Kind | Dimensions |
| --- | --- |
| Article, explainer | clarity of thesis; progression; evidence use (is evidence shown, not asserted); specificity (concrete examples, numbers with context); voice conformance; concision; headline accuracy (headline claims are in the body); reader value (what the reader can do after) |
| Newsletter issue | selection (why these items), framing, brevity, one clear call to action, consistency with programme |
| Thread or short post | hook; one idea; accuracy under compression; link to source |
| Tutorial, screencast | reproducibility (steps actually work in a clean environment, a code grader); prerequisites stated; error cases covered; pacing |
| Diagram, chart | correctness of encoded data (bound); legibility at target size; labelling; colour accessibility; no chart junk |
| Explainer video | script quality (as article); visual support of the point being made; pacing; audio levels and clarity; caption accuracy against script |
| Book chapter | fulfils its thesis in the bible; continuity with neighbours; variation of sentence and paragraph rhythm; no repetition of earlier chapters; chapter-level takeaways |
| Lesson | objective alignment (content teaches what the objective states, at the stated cognitive level); worked example present; misconception addressed; assessment item at the same level |
| Challenge | reference solution passes all graders; difficulty stated and measured after pilot; hints exist; solution leak check |

For images and video, automatic dimensions exist (VBench's sixteen disentangled dimensions for
video such as subject consistency, temporal flickering, motion smoothness and text alignment;
aesthetic and preference predictors for images). They are **advisory** here: they correlate with
human preference on benchmark distributions, not on the platform's diagrams and screencasts, and
they can be gamed (static scenes score high on temporal consistency). Release-quality visuals
require a human decision until the platform has its own preference labels and a calibrated judge.

### 4.4 Taste for creative content

Judgement dimensions that encode craft (is this prose alive, is this image striking) are learned,
not prompted. The protocol follows the evaluation system §5.5 and §8.4:

1. Editors and, where channels allow, audiences compare variants pairwise in the queue (left,
   right, tie); position is randomised; the label records the dimension being compared.
2. Pairs accumulate per kind and domain; a Bradley–Terry model gives each author configuration a
   strength with an interval; the strongest configuration is the champion for that cell.
3. When pairs reach the order of thousands for a kind, a per-kind preference judge is trained or
   fine-tuned, calibrated with chance-corrected agreement against held-out editor pairs, and admitted
   as a grader. Until then the creative dimensions of the rubric are advisory and the human decision
   is the gate.

### 4.5 Educational content

Courses and challenges add evaluation that other kinds lack:

- **Alignment** across the triad: objective (with a Bloom-level verb), content and assessment item
  must sit at the same cognitive level; the most common defect in generated courses is an "apply"
  objective taught as concepts and tested by recall. A code grader checks that every objective has
  content and at least one item; a judge checks level agreement; both run on the syllabus before any
  lesson is drafted.
- **Prerequisite graph** validity: no lesson uses a concept not yet introduced; cycles rejected.
  `curriculum.lesson_prerequisite` and `lesson_covers_concept` already hold the graph; the grader
  reads them. `learning_objective.bloom_level` already carries the cognitive level the alignment
  grader compares, and `lesson_backed_by.assertion_ref` is the lesson's grounding map.
- **Challenge hygiene**: a reference solution passes every grader before the challenge is admitted
  (the same rule the evaluation system applies to eval tasks); solution and test leak checks; hints
  graded for not giving the answer.
- **Item analysis** after a pilot cohort: difficulty and discrimination per item; items that
  everyone passes or that top learners fail are revised; distractor analysis for multiple choice.
- **Effect**: completion per lesson, time on task, pass rate per challenge, retry patterns, and
  learner feedback are outcome signals attributed to the lesson version; a lesson whose completion
  drops after a revision is a regression.

## 5. The creative iteration loop

### 5.1 Roles

| Role | Who | Authority |
| --- | --- | --- |
| Author | agent configuration (prompt, model, skill, style guide versions) or a human | produces versions |
| Critics | one judge per rubric dimension; a fact-checker that runs the correctness layer; a continuity checker for composites | produce critiques; never edit |
| Editor | a human for anything above the kind's autonomy level; a senior agent configuration below it | accepts, requests changes, edits directly, picks among variants, stops |
| Producer | code: renditions, channel adaptation, captions, packaging | produces renditions and releases |

Author and critic use different model families, or the critic is a panel, because a model reviewing
its own output is lenient on its own habits; this is the documented failure of single-model
self-refinement beyond the first round.

### 5.2 The loop

```
draft v1 ──► critique round r (all critics, blind to each other) ──► revision v(r+1) cites critiques addressed
          ▲                                                                   │
          └──────────── continue while: open blocking critiques > 0            │
                                     or judgement score rose ≥ δ last round    │
                                     and r < R_max and budget remains ◄────────┘
      stop ──► route to editor (human or senior agent per autonomy level) ──► accept | request changes (new critiques) | edit | pick variant | reject
```

Rules:

- A critique is structured (§3.1 `Critique`): dimension, severity, location, finding, evidence,
  suggested change. Free-text "make it better" is not a critique.
- A revision must list the critiques it addressed and may reject a critique with a reason; rejected
  critiques go to the editor.
- Convergence is measured, not felt: the loop stops when no blocking critique is open and the
  judgement dimensions stopped improving by more than δ, or at a round or cost budget. Scores per
  round are recorded so that "rounds to approval" is a factory metric.
- Critics are blind to previous scores in the same round and to each other, to avoid anchoring.
- Variant mode: for creative kinds, the author produces k variants at the first round; critics
  score all; the top two go to the editor as a pairwise choice. The choice is a preference label.
- Every human edit is captured as a before/after pair on the component with the editor's reason.
  Editor edits are the highest-value taste signal the platform has.

### 5.3 Editor's notes as persistent memory

Each factory keeps **editor's notes**: a versioned instruction document distilled from recurring
critiques and edits ("never open with a definition", "always state the time window of a benchmark").
Notes are a candidate under the evaluation system; the reflective prompt optimiser (evaluation system
§8.3) is the mechanism that proposes note changes from critique text, and a note change is promoted
only if first-pass approval improves on held-out pieces.

### 5.4 Modality-specific loops

| Modality | Unit of iteration | Loop shape |
| --- | --- | --- |
| Text | component (section, paragraph) | as §5.2; line-level critiques with spans |
| Image | region or whole asset | prompt and parameter variants; regeneration of regions; critic dimensions: correctness of encoded content, legibility, style conformance; editor picks or annotates regions |
| Audio | segment (timestamps) | script loop first (text), then narration takes; critics: pronunciation of names and terms (a code grader with a pronunciation dictionary), pacing, levels; re-record segments |
| Video | shot (storyboard unit) | storyboard approval → shot list → per-shot render and review → assembly review; caption accuracy against script is a code grader; shots iterate independently |
| Course | lesson, then item | syllabus loop (alignment graders) before lesson drafting; lesson loop as text plus alignment; item loop with pilot data |
| Book | chapter | outline loop with the bible; chapters in parallel against the bible; continuity pass as a dedicated critique round across all chapters; then line, copy and proof rounds |

### 5.5 Anti-patterns the loop guards against

- Sycophantic critique: same model as author, or critic sees the author's self-assessment.
- Infinite polishing: no δ or round budget; measured by rounds to approval.
- Scope creep: revisions that add unbound claims; the drift-from-source check runs every round.
- Rubric gaming: critics reward length or hedging; balanced calibration sets and length as a tracked
  cost dimension.
- Taste by prompt: a judge asked "is this beautiful" without preference labels behind it; the loop
  marks such dimensions advisory.

## 6. The content queue

### 6.1 What it is

The content queue is the editorial desk in the dashboard: the list of content versions waiting for
a human decision, and the workbench to make that decision well. It is the same component the
evaluation system proposed as the review workbench, specialised for content, and it doubles as the
error-analysis sampler and the judge-calibration labeller. One desk, three jobs.

### 6.2 Queue items and views

An item is a `ContentVersion` with a requested action: review, approve, compare variants, request
changes, edit, schedule, publish, retire, or audit (a sample of auto-approved pieces).

Views: by kind, by factory, by channel, by due date, by risk (grounding class, compliance flags
open, blocking critiques rejected by the author), by autonomy level, "needs me" (assigned or quorum
pending), and "audit sample".

### 6.3 Item view

| Panel | Content |
| --- | --- |
| Render | Text with tracked changes against the previous version; image with region annotations; video and audio with timestamped comments and caption overlay; course lesson with its objective and items beside it; book chapter with the bible's entry for it |
| Scores | Per rubric dimension: judge score, rationale, calibration status (admitted, advisory), trend across iterations |
| Critiques | Open, addressed, rejected with the author's reason; filter by severity |
| Grounding | Claim spans highlighted; click opens the assertion's evidence packet and verdict; unbound spans flagged |
| Fitness | Checklist: channel constraints, accessibility, rights manifest completeness, disclosure, compliance; each with pass, fail or needs human |
| Variants | Side by side or blind pairwise with randomised position; a pick is a label |
| Lineage | Reports, datasets, entities and parent pieces this version derives from; renditions it has spawned |
| Decision | approve / request changes (opens a critique form) / edit inline / pick variant / reject / schedule; every decision carries a rubric item and a reason and is stored as a `Label` |

Keyboard-first; a reviewer should move through routine approvals in seconds and spend time only on
flagged items.

### 6.4 Routing rules

What reaches a human is a policy, not an accident:

- Grounding class and domain compliance set a floor: evidence-bound medical or financial content
  always gets a human decision, with quorum for regulated claim types.
- Below that floor, routing uses the kind's autonomy level (§6.5) and the judges' risk–coverage
  curves (evaluation system §13): pieces whose dimension scores sit above the auto-approve threshold
  for admitted judges skip review but enter the audit sample at a fixed rate.
- Any blocking critique rejected by the author, any unbound claim, any fitness failure routes to a
  human regardless of scores.
- Service-level targets per queue: time in queue, and a cap on items per reviewer per day so that
  the audit sample is honoured rather than skipped.

### 6.5 Autonomy ladder

| Level | Meaning | Promotion evidence (measured per kind and channel) |
| --- | --- | --- |
| L0 | human-authored; agents assist with research and drafts of components | none |
| L1 | agent drafts; human rewrites | first-pass approval rate and edit distance recorded |
| L2 | agent drafts and iterates; human edits | edit distance per approval below placeholder for N consecutive pieces; no correctness or fitness failures post-release |
| L3 | agent iterates to convergence; human approves without editing most of the time | approval-without-edit rate above placeholder; post-release correction rate at or below the L2 baseline |
| L4 | auto-publish with sampled audit | audit failure rate below placeholder for a period; outcome metrics not worse than L3; regulated kinds excluded |

Promotion and demotion along the ladder are promotion decisions in the evaluation system's
vocabulary, recorded per (kind, channel, factory), with rollback to the previous level on an audit
failure spike.

### 6.6 Desk metrics

Throughput, time in queue, first-pass approval rate per factory, rounds to approval, edit distance
per approval, critiques per piece by dimension, audit failure rate, post-release corrections per
piece, and reviewer minutes per approved piece. These feed the scorecard (§7).

## 7. Content factories and their scorecard

### 7.1 Factory catalogue (initial)

| Factory | Source | Output and renditions | Grounding | Channel |
| --- | --- | --- | --- | --- |
| Research to article | evidence report, entity dossier | article; newsletter summary; thread | evidence-bound | website, newsletter, social |
| Monitoring to brief | monitoring delta | weekly brief; thread; audio summary | evidence-bound | newsletter, app, podcast |
| Dossier to explainer video | entity dossier, comparison | script; diagrams; explainer video; short cuts | evidence-bound | video platform, app |
| Knowledge area to course | a set of reports and entities | syllabus; lessons; assessments; challenges | evidence-bound lessons, educate | courses |
| Challenge series | tool capabilities, implementation notes | challenges with reference solutions and hints | enable, assess | challenges, code hosting |
| Report series to book | a report family over time | outline; chapters; book edition | evidence-informed | publishing |
| Entities to reference site | entity records, glossary terms | documentation and glossary pages with freshness | evidence-bound, enable | website |
| Dataset to dashboard | dataset release | dashboard; leaderboard page | evidence-bound | website, app |
| Talk kit | landscape survey | deck; script; notes; social cuts | evidence-informed | events, social |

Each factory is a content kind spec (or a composite of them) bound to sources, a mission template,
an autonomy level and an evaluation cell, following the factory definition in the direction note.

### 7.2 Scorecard section per factory

| Metric | Direction |
| --- | --- |
| First-pass approval rate; rounds to approval | up; down |
| Edit distance per approval; reviewer minutes per approved piece | down |
| Correctness gate failures per piece; unbound claims found at review | zero; down |
| Fitness failures by category (accessibility, rights, channel) | down |
| Judge–human agreement per admitted dimension | above floor |
| Post-release corrections and complaints per piece | down |
| Outcome per kind and channel (reads, completion, pass rate, shares) by piece version | up, attributed |
| Cost per approved piece; cost per thousand audience units | down |
| Autonomy level and its trend | up, earned |

## 8. Storage, surfaces and ownership

| Concern | Home | Notes |
| --- | --- | --- |
| Pieces, versions, components, grounding spans | Knowledge Services content chain (document, version, representation, node tree) | A produced piece is a document with `documentType` for the form and a derivation link; node addressing gives span-level grounding and critiques for free |
| Assets with generation parameters | Content chain binary representations plus an asset record with model, prompt digest, seed, params, rights | Generation parameters make a visual reproducible and attributable |
| Critiques, score vectors, labels | Quality ledger homes (evaluation system §4) | Critique is a `Label` with location; scores are `ScoreVector`s |
| Content kind specs, style guides, editor's notes, rubrics | Versioned catalogue artefacts; candidates under the experiment contract | |
| Channel releases, schedules, metrics, subscriptions | Domain application publishing tables (proposed `publishing.content_release`, `publishing.channel`, `publishing.release_metric`) | Product and channel concerns belong to the domain, per the workspace rule |
| Courses, lessons, objectives, prerequisites, challenges | `curriculum.*` in the AI Engineer contract (exists; lesson content as `content_artifact_id`, challenge rubric and environment spec as artefacts) | Lesson versions become content pieces whose component is the artefact; `lesson_backed_by` is the grounding map |
| Assessment items, cohorts, attempts, item analysis | Proposed additions to `curriculum.*` (`assessment_item`, `item_version`, `cohort`, `attempt`, `item_statistic`) | The learner application that would write attempts is absent today |
| Queue state | Derived view over versions awaiting decision plus assignment and SLA tables in the domain application | |
| Biotech | Produced pieces as artefacts in the lineage spine; `MediaWork` remains the captured-media concept | |

Surfaces: Mission Control runs factories and the iteration loop as missions; Knowledge Services
exposes grounding, verification, grading and content-chain storage through its existing application
layer; the web application hosts the queue, the publishing calendar, the courses and the site; MCP
read tools expose pieces and their grounding to service agents so that published content can be
cited with the same lineage as reports.

## 9. Implementation stages and proposed issues

| Stage | Content | Exit criterion |
| --- | --- | --- |
| CF0 Model | Content kind spec contract; piece, version, asset, critique, rendition records in the content chain; grounding map binding; three initial kind specs (article, diagram, newsletter issue) | A report-derived article exists as a piece with a grounding map and a rights manifest |
| CF1 Loop | Iteration loop in Mission Control with structured critiques, convergence rules, variant mode, editor's notes; correctness and fitness graders wired | A piece iterates to convergence with recorded rounds and critiques; edits captured as labels |
| CF2 Desk | Content queue in the web application: views, item view, decisions as labels, pairwise mode, audit sample, routing rules, desk metrics | An editor clears a day's queue with every decision recorded; first judge calibration set for the article rubric drawn from queue labels |
| CF3 Publish | Renditions, channel releases, scheduling, outcome metric ingestion for website and newsletter; scorecard section per factory | Outcome metrics attributed to piece versions on the scorecard |
| CF4 Media | Image and video loops (storyboard, shots, captions as code grader, advisory technical dimensions), audio loop with pronunciation grader; rights manifests for generated media | An explainer video produced from a dossier passes fitness and a human decision |
| CF5 Composite | Bible and syllabus shared state; continuity graders; book and course pipelines; alignment graders; pilot cohort and item analysis | One course and one multi-chapter book released through level gates |
| CF6 Autonomy | Ladder promotion decisions from desk metrics; auto-publish with audit for one low-risk kind | One kind at L4 with audit failure rate below floor |

Proposed issues (provisional; owner to open or discard):

- **CF01** Content kind spec contract and the first three specs; style guide and brand voice as versioned artefacts.
- **CF02** Piece, version, component, asset and rendition storage in the content chain; grounding map binding to assertions.
- **CF03** Correctness grader for content: claim extraction, binding check, drift-from-source.
- **CF04** Fitness graders: channel constraints, accessibility checks, rights manifest completeness, disclosure.
- **CF05** Iteration loop in Mission Control: critique object, convergence rules, variant mode, critic blinding, cost budget.
- **CF06** Editor's notes per factory and their coupling to the prompt optimiser.
- **CF07** Content queue: views, item view, decisions as labels, pairwise mode, routing rules, audit sample, desk metrics.
- **CF08** Judgement rubrics for article, newsletter, thread, diagram; calibration sets from queue labels; admission.
- **CF09** Publishing tables, channel adapters for website and newsletter, outcome metric ingestion and attribution.
- **CF10** Image loop with region annotation and regeneration; generation parameter records.
- **CF11** Video loop: storyboard, shot list, per-shot review, caption accuracy grader; audio loop with pronunciation grader.
- **CF12** Composite shared state (bible, syllabus), continuity graders, level gates.
- **CF13** Course alignment graders over `curriculum.learning_objective`, `lesson_prerequisite` and `lesson_covers_concept`; challenge hygiene over `challenge_version`; assessment item, cohort, attempt and item statistic tables; pilot cohort item analysis.
- **CF14** Autonomy ladder decisions and rollback.
- **CF15** Preference pair collection and per-kind taste judge training once volume exists.

## 10. What is explicitly not established

- No content kind spec, rubric, judge or queue exists; all thresholds (δ, round budgets, autonomy
  floors, audit rates) are placeholders.
- Which channels the platform publishes to first, and their policies on AI disclosure, is a product
  decision.
- Preference-pair volumes needed for a creative judge are an order-of-magnitude guess.
- Rights for generated media (model output licences, likeness, music) vary by provider and
  jurisdiction; the rights manifest records them, the owner decides policy.
- The `curriculum` schema exists but nothing reads or writes it today; assessment items, cohorts
  and attempts are new. Publishing tables and the learner application are domain-owned; the
  workspace rules place them outside Knowledge Services.
- Advisory visual metrics (VBench dimensions, aesthetic predictors) have not been tested on the
  platform's own content and should not gate anything until they are.

## 11. Reading route

1. This document §1, §2, §4, §5, §6.
2. [Evaluation and improvement system](../evaluation-improvement-system-20261018/README.md) §4–§9 for
   the score vector, labels, grader registry, calibration, experiments, promotion and scorecard that
   this document instantiates for content.
3. [Content services](../content-services-20261017/README.md) §2 for the report catalogue that feeds
   evidence-bound content and §3 for the content chain that stores it.
4. [Evidence and verification system](../evidence-verification-system-20261017/README.md) for the
   correctness layer.
5. [Datasets](../datasets-20261018/README.md) for the data modality and the dashboard factory's source.
6. [Factories and data products](../../../../../docs/research/2026-10-18-factories-and-data-products.md)
   for the product framing.

### External references (as published; not reproduced)

- Fein et al., "LitBench: A Benchmark and Dataset for Reliable Evaluation of Creative Writing"
  (EACL 2026; arXiv 2507.00769): best off-the-shelf judge 73% agreement with human preference;
  trained Bradley–Terry and generative reward models 78%.
- WritingBench (NeurIPS 2025): six writing domains, one hundred subdomains, style, format and length.
- Huang et al., VBench (CVPR 2024), VBench++ (TPAMI 2025), VBench-2.0 (2025): sixteen disentangled
  video dimensions with human preference validation; saturation and faithfulness dimensions.
- Madaan et al., "Self-Refine" (NeurIPS 2023) and the CMU inference lecture on limits of
  self-correction: single-model self-feedback gains concentrate in the first round and depend on
  external feedback for correctness.
- Anthropic Engineering, "Demystifying evals for AI agents" (2026): grader tiers, calibration, read
  the transcripts.
- Anderson and Krathwohl (2001), revised Bloom taxonomy; Quality Matters Higher Education Rubric
  (seventh edition) for objective, content and assessment alignment.
- Gebru et al., "Datasheets for Datasets" (for rights and provenance manifests by analogy).
