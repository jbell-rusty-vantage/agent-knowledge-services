# Evaluation

**What it does.** `packages/evaluation` holds immutable retrieval evaluation datasets (frozen relevance judgments,
reviewed and unreviewed partitions), verification benchmark statistics and run comparisons, and human-review
structures. `scripts/consumer-surface-eval.ts` composes the platform MCP, the API, `ks`, the executor MCP and the Jev
MCP in process and scores whether an agent can answer the owner's questions through them: a scorecard, not a gate.
Concept: [evaluation and publication
gates](../knowledge/evaluation-and-publication-gates.md#evaluation-informs-publication-it-does-not-grant-authority).

**Code.** `packages/evaluation/src/{index,human-review,verification-*}.ts`; `scripts/consumer-surface-eval.ts`; the
evaluation rows in `packages/application/src/operations/catalog.ts`.

**Tests.** `packages/evaluation/src/index.test.ts`, `verification-benchmark*.test.ts`,
`verification-statistics.test.ts`, `verification-human-review.test.ts`.

**Reach it.**
- Platform MCP: `knowledge_eval_generate|run|compare|failures`, `knowledge_store_evaluate`; verification benchmarks:
  `verify_benchmark_run|compare|show|manifest|comparison`.
- `ks knowledge eval generate|run|compare|failures`, `ks knowledge store evaluate`.
- HTTP: `POST /v1/eval-datasets`, `/v1/experiments`, `/v1/eval-runs`, `GET /v1/eval-runs/:id/failures|report`;
  review decisions are HTTP-only.
- Root scripts: `corepack pnpm eval:consumer-surface [--out <dir>]` and `corepack pnpm examples:verification`.

**Prove it.** `./dev test evaluation src/index.test.ts`. The consumer-surface scorecard is also offline (its header:
no database, no network, no model call): `corepack pnpm eval:consumer-surface`.

**Gotchas.**
- The scorecard writes `dist/consumer-surface-eval/scorecard.{md,json}` by default; it imports `apps/*/src` directly but
  the packages' `dist`, so build first.
- `examples:verification` needs `apps/verification-executor/dist/index.js`.
- A scorecard result reported in a commit message (27 of 27 for 1a451fd) is not re-measured here; rerun it.
