# ADR 0003: Versioned embedding, retrieval, and evaluation

## Decision

Embedding execution is provider-neutral and secret-isolated. The initial live adapter calls Vercel AI Gateway with `openai/text-embedding-3-small`, validates model availability and ordered 1,536-dimensional finite output, and records input, route, model, output, retry, usage, cost, and latency receipts. CI uses the deterministic fake; live verification is an explicit separate command.

Postgres/pgvector remains canonical. `api.search_knowledge_1536` is the admitted tenant-scoped ANN boundary. The local exact-cosine backend is the correctness oracle. Exploratory publication validates all source-to-evaluation manifests, count, dimension, precision, index readiness, authorization, evaluation, and a sample query before atomically changing the active pointer. Rollback changes the pointer and preserves both immutable versions.

Retrieval runs independent exact, trigram-like, full-text-equivalent, semantic, verified graph, and optional reranking stages. Raw lexical and vector scores are never summed; deterministic weighted reciprocal-rank fusion combines ranked lists. Hard filters are verified after candidate eligibility, graph traversal is allowlisted and bounded, reranker failure degrades to fused output, diversity precedes parent/neighbor context, and unsupported required subqueries produce an explicit abstention. Evidence packets freeze locators, per-stage explanations, graph paths, assurance, freshness, contradiction/supersession state, omissions, and coverage.

Evaluation freezes independently reviewed datasets and qrels, runs ablation matrices, measures recall, precision, MRR, nDCG, filters, abstention, citations, latency, and cost, then applies separate hard, quality, and regression gates. Rollback proof binds the restored evaluated publication to its observed active vector version and verification queries.

The broad runner's deterministic planner is label-independent. It accepts only the public retrieval request (query plus explicitly requested spaces) and derives hard filters from query text and the public tenant/language/visibility/active-version policy contract. The request manifest is digest-bound in the evaluation receipt and sampled-human packet. Domain/query-class labels, expected filters, positive qrels, forbidden results, and expected graph paths are used only by the evaluator after retrieval; they are never planner inputs. A poisoning regression changes all of those labels and reruns the actual 96 hybrid packets, proving packet digests and results are unchanged.

## Operational commands

- `pnpm verify` runs deterministic CI verification.
- `pnpm evaluate:broad` verifies the independent review binding and runs the frozen 96-case experiment matrix, hard/quality/regression gates, rollback proof, and false-acceptance analysis.
- `pnpm test:live:gateway` performs the bounded live 41-claim embedding check and writes only a safe `internal_exploratory` receipt to `catalog/live-embedding-receipt.json`.
- `pnpm test:live:judge` performs a separate bounded 12-case calibration pass with a locked Gateway judge and writes a secret-free receipt to `catalog/live-judge-calibration-receipt.json`.

Secrets never appear in plans, receipts, events, logs, or persisted embedding artifacts.

## Broad evaluation evidence

The accepted `broad-heldout-v3.0.0` corpus contains 96 distinct cases split evenly across development, calibration, and held-out partitions. Each of the seven public domains plus `source_native_sections` has 12 cases, and the corpus covers exact, conceptual, mixed, constraint, multi-hop, code, contradiction, freshness/temporal, negative/abstention, adversarial, and selective filter queries. It contains 30 real-bundle-grounded cases, 54 explicitly synthetic gap cases, nine reviewed negatives, and three adversarial cases. Source/entity-family grouping, distinct query wording, immutable qrels, decoys, forbidden results, graph paths, expected facts/locators/result types, and authorization filters are checked by the runner.

Independent v4 review accepted candidate `sha256:cde7e540e00f05e4bebf9f163389c732bd2efc3f926d2693c7a66ae26d9d46fb`; the bound review artifact is `sha256:1988208b505406a9002c7369ff06b52399cebb6b99f8db3beb39ea1240adf469`. Earlier rejection findings remain in `catalog/broad-corpus-review-history.json` rather than being overwritten.

The deterministic control scored recall@10 `1.0`, MRR `0.868055555556`, nDCG@10 `0.89491221806`, filter satisfaction `1.0`, abstention accuracy `1.0`, and citation correctness `1.0`, with zero false acceptances. All hard, quality, and regression gates passed, as did the 32-query rollback proof. The live calibration used `openai/gpt-5.4-mini`, returned schema-valid judgments for all 12 locked cases, agreed on abstention and positive-evidence support for every case, and labeled 10/12 label sets valid. It labeled the two intentionally unsupported negative/adversarial examples invalid as evidence labels, so the raw label-validity rate is `0.8333333333333334`; this is recorded, not normalized away.

Residual limits are explicit: only three real source families were available, synthetic fixtures are not evidence about real-world facts, and the live judge is calibration rather than human adjudication. Local exact/HNSW evidence is now recorded separately in `catalog/local-hnsw-proof.json`; planner and recall checks still need to be repeated for each deployed PostgreSQL environment.
