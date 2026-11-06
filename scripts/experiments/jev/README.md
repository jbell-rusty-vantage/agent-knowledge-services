# Jev public-resource experiment

This is a small, reproducible pilot, not a production calibration set. Expected categories describe each official project's primary purpose and were curated before execution by an agent. They are not independent human gold labels. Synthetic injection, abstention and capacity cases are reported separately.

## Reproduce

From the Knowledge Services root:

1. Optionally refresh public fixtures: `node scripts/experiments/jev/prepare.mjs`. This changes captured content and hashes. Committed fixtures permit an exact input replay.
2. Build and start the Jev HTTP service with four workers, the fixtures directory in `JEV_ALLOWED_ROOTS`, `https://raw.githubusercontent.com` in `JEV_REMOTE_ORIGINS`, and Gateway credentials in the environment. Set `JEV_PORT=4318` or provide `JEV_EXPERIMENT_URL` to the runner.
3. `node --env-file=.env scripts/experiments/jev/run.mjs`
4. `node scripts/experiments/jev/report.mjs`
5. Open `docs/jev/results/index.html`; receipts are in the sibling JSON file.

Each run submits 63 Jev jobs (1 smoke, 24 corpus, 1 paired direct-provider call, 6 synthetic, 3 remote, 1 choice capacity, 3 fanout, 12 serial and 12 parallel) plus up to 30 short GPT-4.1 mini comparisons. A failed Gateway smoke stops the suite. The direct pair also requires `JEV_API_KEY` in the service environment. The provider token-cost estimate should be well below $1 on this fixture set; the intended budget is $5. The runner never emits API keys. Running it again makes new paid Jev calls; results overwrite the report receipts and reuse existing comparator rows. Use `JEV_EXPERIMENT_OUTPUT` to retain separate trials. The `llm` argument resumes missing comparator rows in the existing receipts or starts the comparator first.

## Experiments and interpretation

- **Routing**: 24 public official README excerpts, six categories, four resources per category. Document text only is sent to models; reference labels and repository identifiers are not additional prompt fields (names may naturally appear in README text).
- **Retrieval and fanout**: each resource receives a primary-topic Choice, a four-level relevance Score and five independent concept Nouls. Relevance ranks infrastructure for vector retrieval; these scores have no independently adjudicated relevance labels.
- **LLM escalation**: compare actual GPT-4.1 mini outputs under the same taxonomy. Replay a fixed 0.80 confidence threshold. This is not held-out calibration or proof of net system improvement.
- **Adversarial and abstention**: six synthetic cases; no claim of robust security or general attack coverage.
- **255 options / 10, 100, 500 questions**: deliberately easy synthetic capacity cases. Repeated concepts measure large response handling, not diverse reasoning accuracy.
- **Input paths**: corpus JSON files, inline synthetic states, and three public HTTPS README artifacts exercise all supported source adapters.
- **Parallelism**: the same 12 documents run serially and as a batch with four OS worker processes. PIDs are recorded. Single-order trial, not a statistically controlled performance study.

Jev cost uses captured token usage at $0.042/M input tokens; GPT-4.1 mini uses $0.40/M input and $1.60/M output. Public Gateway model listing was checked for these rates on the run date. These are estimates, not invoice reconciliations. Gateway's Jev alias can change; preserve returned model/version metadata when available. Public source URLs may change; raw-source SHA-256 and state SHA-256 are captured. The fixture state contains a bounded cleaned excerpt; the raw-source hash attests the original download but original complete README bytes are not bundled.

## Observed label ambiguity

The captured Unsloth README prominently covers both running and training models. Its predeclared reference was `training`, while Jev selected `serving` at 0.43 confidence. This requires label adjudication; it is not an established Jev error. The fixed-threshold cascade reaches 24/24 reference agreement by selecting the LLM's `training` answer, but that does not prove improved real-world accuracy. The original labels and results are preserved without post-hoc relabeling.
