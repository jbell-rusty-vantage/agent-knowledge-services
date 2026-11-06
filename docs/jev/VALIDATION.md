# Jev delivery evidence

Checked 2026-09-27. This records local execution, not a cloud deployment or production calibration.

## Passed

- `corepack pnpm jev:build`: all 20 packages in the service dependency build passed.
- `corepack pnpm jev:test`: 40 tests passed: 9 real-process runtime tests, 6 HTTP/MCP transport tests, and 25 client-package tests (including 5 Jev client tests).
- Runtime tests include overlapping requests in different OS processes, worker termination/retry, supervisor SIGKILL and recovery from the persisted queue, cancellation, idempotency, exclusive ownership, invalid provider responses, bounded retry behavior and startup failure containment.
- A real stdio MCP client initialized the compiled host, listed all six tools, and observed two distinct worker PIDs. Closing the client closed that temporary host.
- The compiled CLI submitted a Gateway Choice/Score/Noul task, waited successfully, and resubmitted the same idempotency key. Both submissions returned the same successful job with one provider attempt. This is one additional live smoke call beyond the 63-job benchmark.
- Restarted the benchmark service from its persisted SQLite queue; all 63 earlier completed jobs remained available. The additional CLI smoke makes 64 successful stored jobs.
- HTTP report, receipt JSON, and reproduction README returned 200. The report's filter and relevance sorting were visually exercised.
- `node skills/check.mjs`: catalog conformance passed, including the six Jev MCP tools and nine CLI commands.
- `node .agent-docs/cli.mjs check --repo .`: clean. `git diff --check`: clean.

## Repository-wide limitation

`corepack pnpm verify` passed its typecheck phase but stopped during tests on an unrelated benchmark fixture-manifest error:

```text
packages/application/src/verification/benchmark/verification-benchmark-registered-replay.test.ts:37
SEALED_CHECKPOINT_MISSING:records/25-gl-repeatability-mutated-haiku_judge-failure.json
```

The application test run reported 435 passed and one failed. The fixture-replay edits were separate working-tree changes and were not modified by this Jev task. The complete repository verification is therefore **not green**; later stages of that command did not run. The dedicated Jev build and checks above passed independently.

## Measured experiment

The [results page](results/index.html) and [raw receipts](results/receipts.json) record 63 successful Jev jobs, 1,006 typed decisions, 24 public resources, six synthetic adversarial/abstention cases, 255-choice capacity, 500-question fanout, all three input adapters, and a paired direct-provider call. Thirty actual LLM comparison calls are recorded separately.

The serial/parallel comparison measured 4.741 seconds versus 1.013 seconds over the same 12 inputs, a descriptive 4.68× speedup in one ordered trial. Jev agreed with 23/24 predeclared source-purpose labels. Unsloth's label is ambiguous, so that disagreement is not an independently established error. Confidence-gated LLM results are a replay using measured comparator outputs; they are not an automatically deployed fallback policy.

Combined estimated benchmark provider cost was $0.026759848. This excludes the additional CLI smoke and is not an invoice reconciliation. Failed or lost provider attempts may be billed even when no usage receipt is available.

The live background instance uses `.jev/experiments.sqlite`; `.jev/server-pid.txt` records its supervisor PID. Inspect that PID before stopping the background host. Its children exit when its IPC channel closes. It is not installed as an operating-system startup service.
