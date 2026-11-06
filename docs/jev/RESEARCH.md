# Jev research and composition design

Status: reference research, checked 2026-09-26. Provider contracts below were checked against live primary documentation. Design recommendations are our synthesis, not provider guarantees. Experiments and worker implementation have separate receipts; this document does not claim their completion or deployment.

## What belongs to Jev

Jev supplies semantic judgments over a bounded answer space. An LLM can construct a taxonomy, propose rubric questions, extract candidate values, interpret ambiguity, and write the eventual answer. Jev evaluates the repeated decisions. Deterministic code resolves paths, validates inputs, computes exact values, enforces policy, and executes actions. This division is also the recommended placement in an agent loop. [Vercel agent control](https://vercel.com/i/jev-agent-control)

The central distinction for large tasks is between many documents and many questions. Many independent questions over one state can share a provider call. Many independent documents can occupy separate worker processes. A later decision that needs an earlier answer requires another stage; merely putting both questions in one request does not create a dependency. [TypeSafe fan-out](https://docs.typesafe.ai/patterns/fan-out)

## Verified transport contracts

### Direct TypeSafe

Send `POST https://api.typesafe.ai/v1/systemone`, bearer authentication, and JSON `{model, state, questions}`. State and question instructions accept string, object, or array. Question IDs correlate answers but are not model instructions.

| Primitive | Criteria | Answer |
| --- | --- | --- |
| `choice` | Map of up to 255 options to string/object/array/null descriptions | `choice`, full `probabilities`, `confidence` |
| `score` | Ordered array of 2–10 string/object/array descriptions | Weighted level-index `score`, `probabilities`, `legend`, `confidence` |
| `noul` | Optional true/false descriptions | `noul`: probability of yes |

Response: `{model, answers, usage:{input_tokens,output_tokens}}`. The model field identifies the responding version. Documented errors include 401, 422, 429, and 529; retry rate limits and overload with backoff. Validate schemas before network submission. [TypeSafe API](https://docs.typesafe.ai/api)

### Vercel native evaluation

Send `POST https://ai-gateway.vercel.sh/v1/evaluate` with `Authorization: Bearer $AI_GATEWAY_API_KEY`. Use `{model:"typesafe-ai/jev",state,questions}`. Translate `noul` questions to `boolean`; their answers use `probability`. Choice and Score retain their basic shapes. Responses use camelCase `usage.inputTokens`, `usage.outputTokens`, and `providerMetadata.gateway`, including routing, generation ID and string-valued costs. Preserve metadata instead of substituting an estimated bill.

`providerOptions.gateway.only` restricts providers. Evaluation does not work through OpenAI chat-completions or Anthropic-compatible endpoints. HTTP avoids forcing this repository's other clients onto AI SDK 7. [Gateway evaluation API](https://vercel.com/docs/ai-gateway/modalities/evaluation)

### Vercel TypeSafe compatibility

`POST https://ai-gateway.vercel.sh/typesafe/v1/systemone` accepts the TypeSafe naming, including `noul`, using a Gateway credential and model `typesafe-ai/jev`. Responses have `usage.input_tokens` and `provider_metadata.gateway`; the documented response model is the Gateway alias. `GET /typesafe/v1/models` lists available models. Existing TypeSafe SDK clients can set base URL `https://ai-gateway.vercel.sh/typesafe`. [Gateway TypeSafe compatibility](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)

The compatibility route is an alternative adapter, not a reason to silently switch providers after a failure. Requested route, response metadata, billed cost, retries, and provenance must remain visible.

## Current limits, pricing, and uncertainty

The direct model page lists `jev-1.13.0`, also targeted by `jev-latest` and `jev-preview`. Limits are 64k tokens over state plus all questions, and separately 32k over state plus the longest question. Direct input costs $0.042 per million tokens; outputs are free. Published rate limits are 1,200 requests/minute and 250,000 tokens/second, explicitly subject to change. Input is text-based only. English is strongest. TypeSafe says requests are not used for training; enterprise ZDR is a separate arrangement. Pin direct versions when calibrating. [TypeSafe models](https://docs.typesafe.ai/models)

The Gateway catalog rounds its displayed input rate to $0.04/M. Do not infer exact billing from that rounded label; retain response cost metadata. [Gateway Jev catalog](https://vercel.com/ai-gateway/models/jev)

Choice/Score confidence describes distribution concentration. It is not the selected option's probability and not a guarantee of correctness. Noul lacks separate confidence: a value near 0.5 means uncertainty, not medium severity. Calibrate thresholds per task and consequence on held-out labeled data. Report accuracy together with coverage, false acceptance, false rejection, and sample count. [TypeSafe confidence](https://docs.typesafe.ai/confidence)

Known weaknesses include exact arithmetic/counting/date ordering, indirect questions, irrelevant context, conflicting criteria, and adversarial text. Separate questions do not guarantee complementary probabilities. A schema-valid answer can be false; the model cannot generate an explanation or an absent candidate value. [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## Input construction for this service

These are service design recommendations rather than native model capabilities:

| Input origin | Preparation | Receipt needed |
| --- | --- | --- |
| Inline/direct call | Validate JSON state and question schema | Request hash and schema version |
| Local artifact | Resolve a permitted path, bound bytes, decode UTF-8 or parse JSON/JSONL | Content hash, size, source reference |
| Remote artifact | Fetch an allowed HTTPS URL with deadline and size ceiling; validate destination and redirects | URL, fetch time, hash, content type |
| PDF/image/audio/video/binary | Acquire and convert through the existing preparation/conversion owner, then submit extracted text/fields | Original artifact and conversion provenance |

A URL or filename in the state is only text; it does not cause Jev to fetch/read the resource. Sending a base64 PDF does not grant PDF understanding. Distinguish unsupported raw media from a supported reference to its prepared text. Preserve evidence identity across conversion, selection, and evaluation.

Avoid silently truncating documents. Prefer task-relevant sections; otherwise use explicit windows with provenance. A maximum over window probabilities is a retrieval heuristic, not a calibrated document-level probability. Summed Choice probabilities from unrelated option sets are not comparable. Evaluate aggregation strategies separately.

## Large classification and choice patterns

1. **Flat taxonomy:** one Choice when all candidates and descriptions fit. Add no-match and insufficient-evidence options when appropriate. Version the taxonomy and definitions.
2. **Multi-label classification:** independent Noul questions for labels that may coexist. Do not force overlapping labels into an exclusive Choice.
3. **Large hierarchy:** classify sibling categories, retain several candidate paths, then expand their children. The official cookbook compares greedy traversal with beam search and ranks paths by geometric-mean edge probability, preferably computed in log space. That path score is a search heuristic, not calibrated end-to-end confidence. Its four-example demonstration is not evidence for our domain. [Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification)
4. **Retrieve, shortlist, rerank:** exact/BM25/vector retrieval narrows thousands of candidates; Jev evaluates comparable per-candidate relevance rubrics. Measure shortlist recall independently because reranking cannot recover omitted evidence. The provider's CLERC example reports better ranking over 40 queries, but is a small domain-specific example, not our benchmark. [Reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)
5. **Choose plus check fit:** a Choice finds a relative winner; a separate Noul checks whether it actually satisfies the request. Re-evaluate a shortlist with richer descriptions. The official skill-suggestion example also documents a surviving false match; two stages are not a correctness guarantee. [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)
6. **LLM extraction cascade:** a small LLM proposes structured fields; Jev checks each field against source evidence; deterministic gates escalate questionable cases to a stronger LLM. Preserve source, candidate output, checks, and final answer separately. Provider cost/quality charts are explicitly historical internal results. [Extraction cascade](https://docs.typesafe.ai/cookbooks/sde_cascade)

## Experiment plan and interpretation

Recommended evidence package for AI engineering resources:

| Experiment | Comparison | Useful measures |
| --- | --- | --- |
| Resource taxonomy | Jev, reference labels, optional LLM baseline | Macro accuracy/F1, confusion matrix, no-match recall, coverage/error curve |
| Capability matrix | Many atomic questions in one request vs separate requests | Input tokens, billed cost, end-to-end latency, answer agreement |
| Retrieval rerank | Original order vs Jev Scores over same shortlist | Recall@k before rerank, MRR/nDCG after rerank |
| Large candidate routing | Flat/shortlist vs hierarchy with beam | Expected destination recall, wrong confident choices, requests per item |
| Grounded verification | Supported, contradicted, missing-evidence and injected examples | False acceptance by stratum, abstention, escalation frequency |
| Process parallelism | Same manifest with one vs three workers | Distinct PIDs, overlapping execution intervals, throughput, failures, retries |

Freeze expected labels before running; identify synthetic fixtures separately from real documents. LLM agreement is not human-ground-truth accuracy. Use a development split to refine wording and an untouched test split to report quality. A tiny smoke suite can demonstrate integration and failure modes, but cannot establish production calibration. Show every failed or rejected case on the report, not only successes.

Compare equivalent work: same document bytes, question definitions, route, and cache policy. Separate startup/fetch/queue time from provider time. Report p50/p95 with sample count, and avoid percentage speed claims from one run. Record requested and returned models; Gateway aliases limit reproducibility. Attribute retries' usage when available; do not assume only the last successful request was billed.

For uncertainty-gated LLM composition, measure total cascade quality and total cost, including Jev and escalations. A quality claim requires actual fallback calls and reference outcomes; a plotted threshold simulation alone is not an executed LLM cascade.

## Worker and composition requirements

Recommended operational boundary: transport handlers submit validated jobs to shared application behavior; standalone workers own execution. Evidence of actual process parallelism requires independent operating-system PIDs and overlap, not merely `Promise.all` inside one API process.

Use bounded queues, task identities, leases/claims, terminal result receipts, retry ceilings, deadlines, cancellation, and restart recovery. One provider request can still contain many independent questions. Global account rate limits apply across workers; increasing process count is not permission to exceed them. Call semantics are normally at least once: a process can fail after provider acceptance but before saving a receipt, causing a repeated bill on recovery. Do not claim exactly-once inference without provider idempotency.

Expose reusable results to future Interfaze or Mission Control orchestration without granting Jev authority over deterministic verification or admission. Consumers should pass artifact references and validated question sets through published HTTP, CLI, or MCP interfaces, not import internal algorithm packages. Existing Knowledge Services ownership rules still apply.

## Existing skills and documentation corrections

The official MIT-licensed [TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md) is a useful provider companion. Its emphasis on atomic judgments, structured criteria, current docs, and separating model decisions from code maps well to this service. Prefer linking it rather than copying a second stale provider reference. The local `skills/jev-system-one` should own service commands, request files, worker operation, receipts, and escalation conventions. [Official installation guide](https://docs.typesafe.ai/agent-skill)

The existing local skill contains useful 2026-09-24 probe observations. Its 1,000-question latency, character-limit approximation, numeric drift, and 90-transcript label agreement are historical local evidence, not newly reproduced results. Preserve that distinction. Its Gateway-only-via-SDK account is now incomplete: both HTTP routes are documented. Its AI SDK `>=7.0.114` statement is more restrictive than the launch announcement, which identifies `7.0.105` as the first evaluation release; current HTTP integration does not depend on either version. [Gateway launch announcement](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway)
