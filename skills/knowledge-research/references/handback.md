# Handback: what a research mission returns

**Hand back handles and locators, not payloads.** The next agent or the owner must be able to check any sentence you wrote without rerunning you, and must be able to tell at a glance what is verified and what is not.

## The contract you are working under

A research request is accepted with an exact scope, a budget, a time window and a list of named outputs it owes. That shapes the handback:

- **Each owed output is delivered as the kind that was promised.** A report is not a substitute for a dataset that was owed.
- **You cannot accept your own delivery.** You deliver; a person assesses. Finishing your run is not acceptance of the mission.
- **The request closes only when every owed output is fulfilled.** Say which are fulfilled, which are partial and which are not started.
- **Changed scope is a new acceptance.** If the work needs a wider scope or more budget, stop and propose it. Do not drift.
- **A correction is a proposed change.** You stage it with its evidence; a person applies it. Earlier reports keep the inputs they were built on.

<a id="checklist"></a>
## The handback checklist

Return every item. Write "none" where an item is empty; do not drop it.

1. **Answers.** For each framed question: its question tier, the answer, and its state (answered, partial, not answered). Give the expected answer you wrote first and where the result differed.
2. **Claims with locators.** For each claim: the statement with its qualifiers, who asserts it, its status, its verdict and verdict state, the capture handle, the exact quote, the digest, the source address and the as-of date. Add the contrary evidence where it exists.
3. **Verified and not verified,** as four separate lists:
   - `verified`: admitted, with the decision or receipt handle;
   - supported but not verified, each with the reason: awaiting human confirmation, qualified and not yet restated, live arm, community only, no admission path available;
   - `disputed` or contradicted, with what the check showed;
   - not checked or `unverifiable`, with the reason.
4. **Sources used and why each was trusted.** For each: source tier, role, conflict of interest, method disclosure, its track record on this topic when you used it, and whether it is ours. Name the sources you rejected and why.
5. **The lead record.** Every query with its tool and date; the results selected and rejected, with reasons; every failure (timeout, block, rate limit, changed page).
6. **Value states,** for any dataset: observed, calculated (with the method and the input values), not found, not applicable. A missing value carries no number.
7. **Times.** Event time, publication time, observation time and retrieval time, kept apart wherever more than one applies.
8. **Open questions and dead ends.** What you could not confirm, what you would try next, and what needs the owner: access, rights, a decision, a confirmation.
9. **Cost.** Spend per provider in its own unit and in currency, model tokens, the budget remaining and the reason you stopped. Unknown spend is written "unknown".
10. **Effects.** What was written, each with its receipt. What was only proposed. What was held or refused, with the code returned.
11. **Rights.** Which captures are private copies. A work built on private copies cannot be released to a named or public audience until that is settled: flag it.

*Done when* a reader can take any factual sentence in your report, find its claim in item 2, and open its quote.

<a id="report"></a>
## Writing the report

- **Build from claims.** Every finding names the claim behind it. A finding without a claim is an opinion: label it as one or remove it.
- **Show status in the sentence,** not in a footnote. "Supported by a deterministic check on three dated environments, not yet admitted" is a complete statement. "Verified" is reserved.
- **Put the contrary evidence beside the finding.** A disputed claim is reported as disputed, with both sides.
- **Label the origin of each cited item:** ours, corpus or web.
- **State the derivation:** primary (from captures), synthesis (from several primary sources), or derived from other reports, with how many hops. A factual claim must reach a verified claim or a primary locator within two hops; mark anything that does not as circular.
- **An inference names its inputs** and the decision it answers. A recommendation is a judgment with a rationale, assumptions and a horizon; approval of it is never proof of it.
- **Pin your inputs.** A report cites the exact revision of a dataset or source it used, so a later correction does not silently change what the report said.

## Good and bad

Bad:

> The library's old helper is deprecated and the new function silently renamed a parameter. (Source: comparison article.)

Two claims in one sentence, one source, no version, no locator, no status, and "silently" is the article's interpretation.

Good:

> **Claim A.** From release 1.0.0 the old helper emits a deprecation warning that names its replacement. *Directly supported, human confirmed, verified* (decision handle …). Evidence: probe output captures for three dated environments, quote "…", digest …. Asserted by: the maintainer's migration guide (first party, about itself) and one third-party article.
>
> **Claim B.** The replacement "silently" renamed a parameter. *Contradicted; disputed.* The old parameter name raises a clear error in every environment tested; quote "…". Asserted by: one third-party article (vendor-adjacent, method fully disclosed). The rename itself is Claim C, directly supported.

Bad cost line: "Cost: minimal."

Good cost line: "Tavily 6 searches, 2 advanced; Firecrawl 3 scrapes, credits unknown (usage call failed); model 41k input and 9k output tokens, USD 0.31; ceiling USD 5.00; stopped because new searches added no evidence."

## Return handles, keep payloads out

- Write large tool output to a file or to custody and return its handle and digest. Do not paste pages into the report.
- A receipt is the authority on what was written. Quote the receipt, not your memory of the call.
- If you edited a registered file, register it again. The handle follows the bytes.
- Repeat nothing a reader can open: link the capture, quote only the located span.

<a id="availability"></a>
## Availability, checked 2026-11-15

- **Registering the report:** `knowledge_operation_invoke` with the operation `report.register`, on the executor server. It takes the report's content (task, fragments, assertions, support sets, report) and the host computes every digest. `report.assess` then asks for the independent assessment.
- **Receipts:** `knowledge_receipt_get` on the executor server returns the receipt of one effect. On the platform server `knowledge_operation_result` returns what a finished operation recorded: the identifiers and digests of each step.
- **Handles for large output:** `verify_register_artifact` on the executor server stores a file and returns its handle and digest. `verify_get_artifact` reads it back.
- **The lead record** (item 5): `source_import` and `source_select` on the executor server keep it. Without them, keep it in the report.
- **Not in Knowledge Services:** owed outputs, deliveries, acceptance and criteria. No tool here submits an output or records an acceptance. They belong to the system that gave you the task. State the status of each owed output in your final message.
- **Private copies block release.** How a report built on fetched pages may be shared (reference-only citation or a licensed snapshot) is an open owner decision.
