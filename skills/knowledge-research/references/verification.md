# Verification: what "verified" means and how a claim gets there

**A claim is `verified` only when Knowledge Services admits external evidence for it.** Everything before that is a proposal, however strong. Never write, say or imply "verified" for anything else.

## One vocabulary

Use these words and no others. Confirm the current values with the schema navigation tools before you write one.

| Thing | Values |
| --- | --- |
| Claim status | `proposed` (the default, including "supported but not admitted"), `disputed` (a deterministic check contradicted it), `verified` (admitted) |
| Verdict | `directly_supported`, `supported_with_qualification`, `contradicted`, `not_supported`, `unverifiable` |
| Verdict state | `agent_proposed`, `human_confirmed` |
| Triage disposition | probe, docs check, registry check, duplicate, not checkable (advice or opinion; needs a live model; needs an external service), out of scope |

<a id="acts"></a>
## Five acts, kept apart

| Act | Question | Cost |
| --- | --- | --- |
| 1. Capture and reference | Do these bytes exist, and does this locator select exactly this span? | Mechanical |
| 2. Faithful extraction | What does *the document* say here? | Cheap, nearly always true |
| 3. Interpretation | What does that mean about the world: which entity, which qualifiers, which unit, as of when? | **Where most errors occur** |
| 4. Verification observations | Does the evidence support the *complete* claim? Who asserts it, with what authority? Is there contrary evidence? | Judgment, recorded as separate dimensions |
| 5. Use decision | Given those observations and this use, do we rely on it, for what, until when? | Policy; revocable |

- Keep acts 2 and 3 apart. "The page says X" is easy to prove. "X is true of entity E under qualifiers Q at time T" is the claim that can be wrong. Spend your checking on act 3.
- **The cheap path:** a typed fact a first party states about itself needs act 1, a deterministic act 3 and the authority rule. It stays attributed to that source and bounded to the date observed.
- **Escalate** prose, third-party restatements, inferences and anything consequential.
- Later acts add restrictions. They never reverse an earlier deterministic failure: a quote that does not resolve cannot be rescued by a judgment that the claim is true.
- Support, world correctness, attribution, source authority and provenance are recorded separately. No single score replaces them.

## The chain

<a id="claim"></a>
**1. Claim.** One atomic statement. Split compound prose. Keep the original meaning, conditions, units, version and time window. Attach at least one locator: a capture handle and a quote that is exact, contiguous and occurs once. Choose the shortest unique quote that holds both the value and what it measures. If a quote repeats, extend it to the enclosing row or object. A claim's text is not edited later; a correction is a new claim.

**2. Triage.** Decide how the claim can be checked, using the dispositions above. Triage is a working queue, not a judgment. When choosing which claims to check first, prefer contradicting pairs, claims that current work depends on, fixes bounded to a version, and open issues.

**3. Probe.** A probe is a small check you run against stated claims.

- Write the expected outcome before any run, and what would support and what would contradict.
- **Cells are dates, not hand-picked versions.** Each cell is the environment a reader would have got on that day. Include a cell where the claim should *not* hold.
- Deterministic by default: fixed inputs, no live model. A check that calls a live model is a **live arm** and is labelled as one.
- The run's output is captured like any other source: exact bytes, a digest, quotes that resolve.
- A cell that cannot be built is recorded as skipped. A run made to debug the script is labelled and not counted.
- Do not rerun a check until it passes. The first counted result stands; a new result needs a recorded reason, such as a new release.

A claim that needs no run uses a **docs check** (a located quote in a first-party page) or a **registry check** (a located record in the authoritative registry).

**4. Verdict.** One of the five values, with what each cell showed. It is `agent_proposed`.

- "Not reproduced" is `not_supported`. It does not refute the claim, which stays `proposed`.
- A deterministic contradiction sets the claim `disputed`. A disputed claim stays visible with its verdict.
- When two sources disagree and the check shows each was partly right, give each claim its own verdict.

**5. Human confirmation.** A named person confirms or rejects the verdict. The confirmed verdict supersedes the proposed one; nothing is overwritten.

<a id="restate"></a>
**6. Restatement before verification.** A claim worded "the post states that X" cannot be verified by a check of X. The check proves X. It does not prove what a post says. So before admission:

- write a new claim that states X, derived from the original;
- remove the attribution, and remove any half the check did not test;
- for a qualified verdict, write the qualification the check showed into the statement;
- have a person confirm the restated wording;
- leave the original `proposed`, as the record of what the source said.

**7. Admission.** A claim is offered only when its current verdict is `human_confirmed` and `directly_supported` by a deterministic check (a probe run, a docs check or a registry check). The offer carries the captured bytes and exact quotes from them, and rests on two independent observations: the deterministic check and the person's confirmation. Knowledge Services then checks, in order: the bytes are intact, the quotes resolve, the mechanics hold, the evidence supports the complete claim, and policy admits it for the declared use. The result is admitted, held or rejected. A decision is bound to one claim and one exact effect; a changed effect needs a new decision.

Not offered: a qualified verdict that has not been restated, a live arm, a contradicted claim, a not-reproduced claim, an unverifiable claim. List each with its reason.

Say what the claim will be used for. No default use exists, and a consequential use needs an exact decision.

## Who may do what

| Actor | May | May not |
| --- | --- | --- |
| Research agent | state claims, triage, design and run probes, propose verdicts, draft restatements, assemble evidence, submit a report for independent assessment | confirm a verdict or a restatement, assess its own report, admit, set `verified`, accept its own delivery |
| A different agent deployment | independently replay locators and check the first agent's extraction | check its own extraction |
| Named person | confirm verdicts and restatements, review a release | — |
| Knowledge Services | admit, hold or reject | — |

A person's confirmation recorded later from a written instruction is labelled as transcribed from that instruction. Never invent a confirmation.

<a id="controls"></a>
## Negative controls

Prove the path refuses what it should before you trust what it accepts. Whoever builds or changes an admission path runs these and reports each result. If you only use the path, read the last control results first:

- one byte of a capture changed: the decision is held;
- claim A's decision presented for claim B: refused;
- claim A's decision with its payload rewritten to name B: refused;
- a decision for an already verified claim: refused;
- a direct write of `verified`: refused;
- the whole run repeated: nothing is written twice.

For a probe, the control is the cell where the claim should fail, and the expectation written first.

<a id="alone"></a>
## Why a live arm or a community claim never verifies alone

- **A live arm** depends on a model's behaviour on the day. It cannot be replayed to the same bytes, so the evidence cannot be re-checked. It can qualify a claim. It cannot carry one.
- **A community claim** is one party's report, with unknown setup and unknown interest. Whether it is true is exactly what is in question. It needs a first-party locator or a deterministic check beside it.
- **Our own finding checked by our own probe** is recorded and counted apart. See [sources](sources.md#circular).

## After verification

A verdict holds for the versions it was run on. When a release of a subject lands, the checks that cover it are due again. Rerun them in a rebuilt latest cell. An unchanged outcome writes nothing new. A changed outcome opens a review and flags every released work that cites the claim.

<a id="availability"></a>
## Availability, checked 2026-11-16

**Capture and locate (acts 1 and 2): executor server.** Procedure: skill `knowledge-verify`.

| Step | Tool | Command line |
| --- | --- | --- |
| Capture a page, or a file you hold | `verify_capture_source`, `verify_capture_file` | `knowledge-verify capture`, `knowledge-verify capture-file`; `ks verify capture source`, `ks verify capture file` |
| See what can be captured | `verify_supported_media_types` | `knowledge-verify media-types`; `ks verify capture media-types` |
| Inspect a capture | `verify_list_captures`, `verify_read_capture`, `verify_search_capture` | `knowledge-verify read`, `knowledge-verify search`; `ks verify capture list`, `ks verify capture read`, `ks verify capture search` |
| Check that a quote occurs once | `verify_locate_quote` | `knowledge-verify locate`; `ks verify capture locate` |
| Make a capture quotable by a claim: register it in the knowledge base as an evidence capture with content units, and get the anchor of each quote | `source_prepare_captured` | `knowledge source prepare-captured <captureId> --quotes '["<quote>"]'` |
| Export the exact fragment a report cites | `verify_capture_fragment` | `knowledge-verify fragment` |
| Keep a file as an artifact | `verify_register_artifact`, `verify_get_artifact` | `knowledge-verify register`, `knowledge-verify artifact`; `ks verify artifact register`, `ks verify artifact get` |

- The `ks` commands in this table run on the local profile, over a file store on your machine. The `knowledge-verify` commands forward to a served executor.
- `verify_capture_fragment` needs durable custody. It runs only on a served executor.
- `source_prepare_captured` registers text, Markdown, HTML and JSON captures. It refuses a PDF, office or spreadsheet capture with `CAPTURE_MEDIA_TYPE_UNSUPPORTED`. The same bytes from the same address register once: a second call returns the first registration with `replayed` true.
- Each registration is filed on the ledger: its result carries `receipt.intent_id` and `receipt.receipt_id`, and the receipt names the capture, its source and its fetch. Keep the `receipt_id` with the capture in your working files; a replay returns the same one.
- Each unit is one block of the captured text (a heading, a paragraph, a list, a table, a code block; one line of an HTML page; one member of a JSON document). A quote anchors only when it lies inside one unit: an anchor of `not_in_one_unit` means shorten the quote to one block.
- The platform server cannot produce a quote. `knowledge_source_fetch` stores a capture for document preparation, and no tool on that server reads or locates text in it.

<a id="chain-tools"></a>
**The chain, steps 1 to 4 and the watch: executor server.** One tool, `chain_write`, carries nine operations. Each is one governed write of the knowledge base; you name it in `operation`. Command line: `knowledge chain write <request.json>`.

| Chain step | `operation` | It records | Read it back with `db_read_intent` |
| --- | --- | --- | --- |
| 1. Claim | `record_claim` | a statement as `proposed`, with 1 to 50 evidence anchors, its subjects and who stated it | `evidence.claim` |
| 6. Restatement | `restate_claim` | the testable statement X behind "the post states that X"; the original stays as it was | `evidence.claim_restatements` |
| 2. Triage | `record_triage` | what to do with a candidate: probe, docs check, registry check, not checkable, duplicate, out of scope | `evidence.claim_triage` |
| 3. Probe | `register_probe` | the check, the claims it tests and the expected outcome, before any run | `evidence.probes` |
| 3. Probe run | `record_probe_run` | one run in one cell, with its captured output as an anchor | `evidence.probe_matrix` |
| 4. Verdict | `propose_verdict` | what the recorded runs showed about one claim, as `agent_proposed` | `evidence.claim_verdicts` |
| Source | `record_source_assessment` | a role prior for a source, or an assessment derived from verdicts on its claims | `evidence.source_registry` |
| Watch | `raise_attention_sweep`, then `settle_attention_sweep` | one execution of an attention policy under a mission budget: opened before the work, settled once after | `acquisition.open_sweeps` |

How to call it:

- **Read the operation first.** `knowledge_describe` with `operation:record_claim` (or any name above) returns that operation's full input, its rules and a valid example. `knowledge_describe` with `tool:chain_write` lists all nine.
- **The call** is `{ "request": { "operation", "idempotency_key", "input", "actor" } }`. `input` holds the operation's arguments.
- **`idempotency_key` is yours.** Derive it from the work (`run-2fa5:claim:7`), never from the attempt. The same key with the same input returns the first result with `replayed` true and writes nothing. The same key with another input is refused.
- **`actor` says who acted:** `label` (the agent or tool, never a person), `mission_id` (the mission whose budget bounds the work) and `mc` (the Mission Control invocation). It is recorded as you send it.
- **An evidence anchor** is `{ "capture_id", "node_id", "quote" }`: a quote that is verbatim in one content unit of a capture held in the knowledge base. From a page you captured, in order:
  1. `verify_capture_source` (or `verify_capture_file`) stores the page and returns its `captureId`;
  2. `verify_locate_quote` checks that the quote occurs once in that capture;
  3. `source_prepare_captured` with that `captureId` and `quotes: ["<quote>"]` makes the capture quotable and returns, for each quote, the `anchor` to paste;
  4. `chain_write` `record_claim` with `evidence: [<anchor>]`.

  Content the knowledge base already holds needs no capture: `evidence_units` (`knowledge evidence units --text "<words>"`) returns each unit's text and its `anchor`. Copy the quote from that text.
- **A probe run's `output`** is an anchor too. Capture the run's output file with `verify_capture_file`, register it with `source_prepare_captured`, and pass the returned anchor. For JSON output, a unit is one member: send `{ "capture_id", "node_id", "selector_kind": "json_pointer", "pointer", "quote" }` with the unit's `pointer`.
- **Order matters.** A verdict needs a registered probe with a recorded run in every cell it cites. A derived source assessment needs a prior first. Do the work of a sweep only when it came back `open`.

<a id="not-written"></a>
**What `chain_write` never writes.** These are rules of the knowledge base. No tool works around them, and you do not look for another path.

| You want to | Answer | Refusal |
| --- | --- | --- |
| Mark a claim `verified` | No. Every operation leaves a claim `proposed`, or `disputed` after a deterministic contradiction. A claim becomes `verified` only when Knowledge Services admits a sealed verification run | `VERIFIED_CLAIM_REQUIRES_ADMITTED_USE` |
| Record that a person confirmed or rejected a verdict, reviewed a triage or a source, or reviewed a release | No. Propose, then ask for the review. Do not transcribe a person's answer into a row | `HUMAN_REVIEW_NOT_AGENT_WRITABLE`; a label that names a person is `ACTOR_INVALID` |
| Change or delete a verdict, a triage row or an assessment | No. They are append-only. Send the new one: it supersedes the old row, and the same one again writes nothing (`unchanged` true) | `CHAIN_OPERATION_UNKNOWN` for an update or delete operation |

<a id="refusals"></a>
**What a refusal means.** A refused call wrote nothing. The error carries a stable `code`, its class, what it means and what to do next. The class tells you whether to retry:

| Class | Meaning | Do |
| --- | --- | --- |
| `invalid_input`, `malformed` | The call does not match the schema or a rule of the function | Correct the named field and call again with the same key |
| `not_found` | An id names nothing in this tenant | Read the id back; do not invent one |
| `state_refuses` | The row's state forbids it | Read the state and change the plan. Example: `VERDICT_CELL_NOT_RUN` means record that cell's run first |
| `taken` | The key, slug or restatement already exists | Use the existing row, or a new key for a new write |
| `not_allowed` | One of the three rules above | Stop. Report where your authority ended |

`VERDICT_REQUIRES_RUNS` is the common one: `cells` must be an object keyed by the cell labels of recorded runs, with what each showed. `QUOTE_NOT_IN_UNIT` means the quote was paraphrased or joined from two units, or the unit has no text to hold it. A quote of only whitespace is `QUOTE_REQUIRED`.

**Reports, independent assessment and applying a decision (acts 4 and 5): executor server.** One tool, `knowledge_operation_invoke`, carries every operation below. `knowledge_operation_get` polls an operation, `knowledge_operation_cancel` cancels one, and `knowledge_receipt_get` looks up the receipt of an effect. `knowledge_describe` without a reference returns the binding descriptor, which lists the operations that binding serves.

| Step | Operation |
| --- | --- |
| Register a report: its claims, evidence fragments and support sets | `report.register` |
| Read one exact report | `knowledge.read` |
| Ask for the independent assessment of a registered report | `report.assess` |
| The evaluator's own steps | `report.observe`, `report.seal`, `report.decide`, `report.review`, `decision.resolve` |
| Derive domain proposals from a registered report | `report.derive` |
| Preview, then apply, a decision the host already recorded | `knowledge.plan_preview`, `knowledge.apply` |

- The evaluator's steps need an evaluator credential that the host issues. You cannot observe, seal or decide your own report.
- A seal is not admission. Registering a report is custody, and admission is the separate decision.
- **Claim-by-claim verification is not served.** The operation `verify.claims` is refused with `SCHEMA_UNSUPPORTED`, because the claims chain behind it was retired. The commands `knowledge-verify verify-claims`, `judge`, `policy`, `seal`, `check-report` and `status` exit with a retired error. A report's claims are checked in its independent assessment.

**Checks on extracted values: platform server.** `verify_extract` checks an extraction against registered captures, `verify_extraction_run` runs a structured extraction, `verify_bundle_replay` replays a finished check and `verify_status` polls them. These establish that extracted values match a capture. They do not set a claim `verified`. Procedure: skill `knowledge-verification`.

**No Knowledge Services tool, command or operation exists for:**

- **anchoring a quote in a PDF, office or spreadsheet capture.** `source_prepare_captured` refuses them (`CAPTURE_MEDIA_TYPE_UNSUPPORTED`). Capture an HTML or text version of the same document when one exists, or pass an existing `locator_id`;
- human confirmation of a verdict or of a restated wording (step 5): a person does it, through a path no agent holds;
- the admission evidence pack for a single claim, and its dispatch (step 7);
- running a probe. `record_probe_run` records a run you made; nothing here executes one.

When your tool list has none of a step, do it in your own working files, state the result as a proposal, and name in the handback the step where your authority ended.

**Outside this service, recorded 2026-11-15 and not checked here:** human confirmation and the admission pack exist as lab scripts for the AI Engineer knowledge base, with one Knowledge Services experiment for admission. On that date the lab held 27 verified claims, all on a disposable database and signed with a test key.
