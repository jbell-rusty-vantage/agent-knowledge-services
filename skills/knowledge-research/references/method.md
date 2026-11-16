# Method: tiers, orienting, queries, budgets, dead ends

Decide the question tier first. The tier sets how deep you go, how much you may spend and what "done" means.

<a id="tiers"></a>
## Question tiers

| Question tier | Shape | Example | Depth | Done when |
| --- | --- | --- | --- | --- |
| T1 Lookup | one entity, one property | the current list price of product P | the knowledge base, else one primary source | one located quote with its as-of date |
| T2 Complete comparison | every member of a set, in the same units | every product in class C with its price per unit | list the set first, then one T1 per member | every member has a value, or a stated reason it has none |
| T3 Time and change | as of a date; changed since | what changed on page X since date D, and when we learned it | two dated captures, or the first party's own change record | the change is stated with both dates and what was compared |
| T4 Cross-media and expert | one thing linked across media; known failure modes | which talk, paper and repository describe the same technique | one capture per medium, joined by an identifier both show | each link rests on an identifier present in both sources |
| T5 Goal or decision | a goal that needs a choice | choose A or B for goal G | split into T1–T4 questions plus one bounded decision | every sub-answer has provenance and the decision names its inputs |

- These are **question tiers**. **Source tiers** (T0–T4) are a different scale, in [sources](sources.md#tiers). Always write which one you mean.
- **T2: the set is the hard part.** A comparison that misses a member is wrong. Find the first party's own list of members before filling in values.
- **T3: keep four times apart.** When it happened, when it was published, when we observed it, when we fetched it.
- **T5 is scored twice:** did you retrieve every sub-answer with provenance, and was the decision reasonable. Report a miss by the layer that failed.
- **Spend rises with the tier.** A T1 costs one read or one capture. A T1 that needs a third search is mis-framed or has no source: stop and re-frame.
- **Split the budget before you start.** Give the largest share to the questions the decision rests on.

<a id="orient"></a>
## Orient before searching

Read the knowledge base first. An outside search for something already verified wastes budget and can add a weaker duplicate.

Choose the read by the shape of the question:

| Shape | Read |
| --- | --- |
| filter, compare, rank, count | the catalog: one list per kind of thing |
| as of a date, history, what changed | facts with time, and change records |
| explain, find the passage, "like X" | search over text, inside a scope you fixed first |
| a goal | all three, then the live web |

- Find the current relations and the named queries with the schema navigation tools. Prefer a named query to free-form query text.
- Text search is a scoped tool. Resolve the entity or the collection first, then search inside it.
- Read claims with their status. A `disputed` claim is knowledge: it tells you where the contrary evidence already is.
- Read what is recorded about the sources you expect to use: role, track record on this topic, last capture.
- Look for an existing capture of a URL before fetching it again.
- A read of the knowledge base is discovery. It is not evidence and it is not a decision.

Write three lists: verified, disputed or open, missing. Only "open" and "missing" go to the web.

## Write the expected answer first

Before you look, write what you expect to find and why. For a check you will run, write what result would support the claim and what result would contradict it.

The differences are the most useful findings. A check whose result surprised you is worth more to a reader than ten that matched.

<a id="queries"></a>
## Query strategy

1. **Start narrow and named.** Use the exact name, the version and the term of art.
2. **Aim at the primary source.** Restrict the search to the first party's domain, repository or registry when you know it.
3. **Widen on a miss, one step at a time.** Drop the version, then the qualifier, then use the broader term. Record each miss.
4. **Name the candidate when you test it.** Once a result suggests an answer, put that answer in the next query. Keep your best candidate until a source contradicts it. If nothing confirms it, search the main alternative by name.
5. **Read before you search again.** When a result names a likely answer, read that page before running another search.
6. **Go behind a secondary source.** An article, a summary or a documentation mirror got its fact from somewhere. Find that page and capture it instead.
7. **Look for contrary evidence on purpose.** Search for the failure, the fix, the retraction, the newer version, the competing number. One contrary capture is worth more than a third agreeing one.
8. **Split compound questions.** One query per sub-question. Write a search query, not a prompt.

| Bad | Good |
| --- | --- |
| `timeout problems with the client` | `<library> 2.3 <function> default timeout` restricted to the project's documentation domain |
| `is <candidate> the fastest` | `<candidate> <benchmark name> result <year>`, then `<main rival> <benchmark name> result <year>` |
| Three more searches after a result names the answer | Read the page the result points to, then decide |
| Quote the number from a comparison article | Follow the article's link to the vendor's page and capture that |
| Search only for support | Also search `<thing> regression`, `<thing> deprecated`, `<thing> fixed in` |

<a id="budget"></a>
## Budgets and stop rules

The mission states the ceiling. Check spend against it before every paid step.

Stop, record why, and hand back when one of these is true:

- **The budget is reached.** Record a budget stop and do no further paid work.
- **New searches stop adding evidence.** Answer with the best-supported candidate and say what you could not confirm.
- **Identity is ambiguous.** Two things could be the subject. Keep both, merge neither, report it.
- **A step would write outside the scope you were granted.**
- **A tool or a credential fails.** Record the failure. A paid call is not retried automatically. Credentials are never requested.
- **A check cannot be set up.** An environment will not resolve, or a page needs a login you do not have. Record it as skipped.

Budget rules:

- Spend you cannot read is unknown. Write "unknown".
- Every provider call is charged to the mission, including a billed failure.
- Set a page or credit cap before any bulk call (crawl, agent extraction, multi-page parse).
- A paid live-model check needs a budget that grants model spend. Without one, skip it and leave it due.
- Do not assume a tool will stop you. Count your own spend.

<a id="dead-ends"></a>
## Dead ends

A miss is a finding. Hand it back.

- **Not found.** Record what you searched, where and when. Write "not found in <source> on <date>", not "does not exist".
- **Missing value.** Record no value and the reason: not found, or not applicable. A missing value is never zero and never filled from memory.
- **Not reproduced.** A check that did not reproduce a report has not refuted it. The claim stays open, with what you ran.
- **Blocked, timed out, rate-limited, changed.** These are outcomes about the source. Record them. They change how the source is treated next time.
- **Second tool.** Try the second tool in the [routing table](tools/routing.md) once. After that, stop and report.
- **Paywall, login or unknown rights.** Stop and ask. Do not work around access controls.
- **Memory.** Your own recall closes no gap. If no source confirms it, it is unconfirmed.

<a id="selection"></a>
## When the task is to choose what to study

Research the candidates before any capture, then propose a subset for approval. For each candidate give the question it serves and its source address.

Keep a candidate only when it is:

- **consequential** for the stated goal;
- **current**: it changed recently or is scheduled to;
- **first-party or authoritative**;
- **refreshable**: a stable address or an interface you can read again;
- **question-bearing**: at least one framed question needs it.

List the rejected candidates with the reason for each, so the choice can be reviewed.

<a id="availability"></a>
## Availability, checked 2026-11-15

Everything in this list is on the **executor server** unless it says otherwise. The schema, read and lead-recording tools are registered only when that executor is configured with a database and a schema workspace. If your tool list lacks them, say so in the handback.

- **Schema navigation** (find the current relations and the named queries): `schema_search`, `schema_get`, `schema_manifest`. Command line: `knowledge schema search`, `knowledge schema get`, `knowledge schema manifest`. The platform server and `ks` have no schema tool. Procedure: skill `schema-explore`.
- **Reading the knowledge base:** `db_head`, `db_read_intent` (named queries in one snapshot), `db_sql_readonly`, `db_explain`. Command line: `knowledge db head`, `knowledge db read-intent`, `knowledge db sql`, `knowledge db explain`. Procedure: skill `knowledge-db`.
- **A recorded discovery read for a mission:** `knowledge_operation_invoke` with the operation `knowledge.read_intent`, on a binding whose descriptor lists it. It serves named queries, schema search and schema pages.
- **Existing captures:** `verify_list_captures` lists the captures in the executor's store. `ks verify capture list` does the same on the local profile.
- **Lead recording:** `source_discover` (the host runs one managed Tavily or Firecrawl search and keeps the receipt), `source_import` (account for a search you ran with your own tool), `source_select` (your selected, omitted and duplicate leads), `source_attempt` (read one back), `source_reconcile` (recover an interrupted attempt without a new search). Command line: `knowledge source discover`, `knowledge source import`, `knowledge source select`, `knowledge source attempt`, `knowledge source reconcile`. Procedure: skill `knowledge-acquisition-and-vetting`.
- **On the platform server,** `knowledge_source_discover` only ranks candidates you supply. It searches nothing.
- **Budgets.** Knowledge Services has no tool that reads or enforces a mission budget. A managed search through `source_discover` is bounded by the host for that one attempt. Count your own spend.
- **Choosing what to study.** No tool records a selection proposal. Return it in the handback.
