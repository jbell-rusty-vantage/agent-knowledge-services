# Jev execution module

`@aiengineer/knowledge-jev` owns Jev input capture, direct TypeSafe and Vercel Gateway adapters, and a bounded pool of actual Node child processes. Public schemas live in `@aiengineer/knowledge-contracts/jev`. In-process transports use the application facade. Other services use the HTTP client.

```ts
import { createJevService } from "@aiengineer/knowledge-jev";

const service = createJevService({
  databasePath: "./local/jev.sqlite",
  workers: 4,
  provider: { route: "gateway" },
  inputPolicy: { allowedRoots: ["/trusted/research"], remoteOrigins: [] },
});
await service.start();
const job = await service.submit({
  idempotencyKey: "paper-42-taxonomy-v1",
  input: { type: "inline", state: { excerpt: "The retriever returns evidence passages." } },
  questions: {
    relevant: { type: "noul", instructions: "The excerpt discusses retrieval for an LLM application." },
  },
});
// Poll service.get(job.id) until succeeded, failed, or cancelled.
// Always await service.close() when the host stops.
```

## Execution and persistence contract

- Requires Node >=24 for `node:sqlite`. Compile with `tsc`; tsup 8 rewrites the prefix of this native module incorrectly.
- Each configured worker is a distinct OS process with one request in flight. The supervisor owns SQLite and dispatches through IPC. Provider keys remain in inherited worker environment; request payloads contain no credentials.
- SQLite is a **single-host local queue**, separate from the shared Supabase database and canonical mission ledger. One supervisor may mutate a database at a time. Read-only inspection can coexist. Enqueue before `start()` acquires ownership but performs no inference until started.
- A successful submission captures input bytes, SHA-256 provenance, validated questions and the selected provider/model before committing the batch transaction. Restart uses that snapshot; it does not refetch remote content or reread changed files.
- Matching idempotency keys return the existing job; changed request content produces `IDEMPOTENCY_CONFLICT`. A batch either inserts all its jobs or none. Existing completed jobs remain readable. There is no automatic retention deletion.
- `close()` terminates children and returns interrupted running jobs to the durable queue (or fails exhausted attempts). A killed supervisor's children exit on IPC disconnect. The next supervisor reclaims interrupted jobs after verifying that the previous supervisor PID is no longer alive.
- Cancellation marks the job terminal before killing its child. Late IPC responses cannot change a cancelled job. Terminating a local request does **not** guarantee remote inference cancellation or prevent provider billing.
- Worker crashes, HTTP 429/5xx, network failures and timeouts consume an attempt and may retry. Validation failures and other HTTP errors are terminal. Retry backoff uses jitter and honors `Retry-After`; a delay beyond seven days fails explicitly. At-least-once retries may duplicate remote calls after a lost response.
- Results report successful-call usage only. Attempts that fail or lose a response may still be billed; these tokens and cost are **unknown**, not zero. `startedAt` describes the latest attempt; `createdAt` through `completedAt` covers total queue lifecycle.
- Limits: 1–32 workers, 1–8 attempts, default 600 dispatched requests/minute, at most 1,000 items and 32 MiB captured requests per batch, default 10,000 active jobs, 512 KiB per input, 1 MiB complete request, 2,000 questions. Provider token limits still apply; byte limits are not token guarantees. Rate accounting is per supervisor and resets after restart.

## Input and provider boundaries

Inline state supports a string, JSON object or array. Files must resolve under an operator-configured root and are read as bounded UTF-8 text or parsed JSON. Binary data must first pass through an appropriate parsing service. Remote inputs require HTTPS, exact allowed origins, no credentials, text/JSON media types and no redirects. Query strings are omitted from provenance source labels. The database nevertheless contains the resolved content and must be protected as local operator data.

Allowed roots and origins are operator trust configuration, not request options. Do not allow a filesystem root, secret directories, or arbitrary remote origins for an untrusted client. This module is not a multi-tenant filesystem sandbox. Native paths and errors from underlying OS operations should be mapped to safe transport errors.

Gateway defaults to `POST https://ai-gateway.vercel.sh/v1/evaluate` with `AI_GATEWAY_API_KEY` and `typesafe-ai/jev`. The adapter maps Noul to Gateway Boolean and normalizes its probability back to `noul`. Direct calls use `POST https://api.typesafe.ai/v1/systemone`, `JEV_API_KEY`, and pinned default `jev-1.13.0`. The optional endpoint override is trusted host configuration, primarily for isolated adapter tests; never derive it from a submitted task.

Answers must match every submitted question and option, contain bounded probabilities, and keep scores in their rubric range. Gateway rounding is accommodated when checking probability mass. A well-formed decision is not proof of correctness. Calibrate question-specific thresholds and send ambiguous/high-consequence decisions to an LLM or reviewer.

## Validation

`corepack pnpm --filter @aiengineer/knowledge-jev build`

`corepack pnpm --filter @aiengineer/knowledge-jev test`

Tests use a local mock provider and real child processes. They cover process overlap, all three primitives, crash replacement, cancellation, retry/terminal distinctions, invalid provider choices, snapshot durability, idempotency conflicts, atomic queue limits, owner exclusion, binary rejection and input allowlists.
