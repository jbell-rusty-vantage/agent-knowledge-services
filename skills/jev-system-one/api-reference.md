# Jev service and provider contracts

Checked 2026-09-26. Service schema authority: packages/contracts/src/jev.ts. External provider documentation can change.

## Service task

```json
{
  "idempotencyKey": "resource-42-taxonomy-v1",
  "input": { "type": "inline", "state": { "text": "Our pipeline reranks retrieved passages." } },
  "provider": "gateway",
  "questions": {
    "topic": {
      "type": "choice",
      "instructions": "Choose the primary technical topic of `text`.",
      "criteria": { "retrieval": "Search, indexing, RAG, reranking", "other": "Anything else or insufficient evidence" }
    },
    "has_retrieval": { "type": "noul", "instructions": "Does `text` describe retrieval work?" }
  }
}
```

Provider, model, and idempotencyKey are optional. Providers: gateway or direct. Service tasks always use noul; the adapter translates Gateway's wire format. Provider-compatible model names: Gateway typesafe-ai/jev; direct jev-1.13.0 or an intentional alias.

| Input | Shape | Meaning |
| --- | --- | --- |
| Direct | `{ "type":"inline", "state": ... }` | String/object/array |
| Local | `{ "type":"file", "path":"absolute/path", "format":"text" }` | Permitted server-local UTF-8 text; json parses state |
| Remote | `{ "type":"remote", "url":"https://allowed.example/artifact.json", "format":"json" }` | Allowed remote text/JSON |

Paths are server-local, not automatically uploaded from the CLI machine. Allowlists default empty. Use preparation/conversion for raw media first. Byte bounds do not replace token budgets. Keep credentials out of URLs and manifests.

Service caps: 1-2,000 questions per task, 1-1,000 tasks per batch. These are schema caps, not assurances that each request fits the model context. Choice supports 1-255 criteria, Score 2-10 levels. Optional Noul criteria supply both true and false descriptions.

## HTTP and CLI

Default HTTP base: http://127.0.0.1:4318. Use bearer JEV_SERVICE_TOKEN when configured. Non-loopback binding requires a token. CLI uses JEV_SERVICE_URL and JEV_SERVICE_TOKEN.

| Method/path | Purpose |
| --- | --- |
| POST /v1/jev/jobs | Task to queued job |
| GET /v1/jev/jobs | Recent jobs |
| POST /v1/jev/batches | `{ "tasks": [task, ...] }` to jobs |
| GET /v1/jev/jobs/:id | Job and result/error |
| POST /v1/jev/jobs/:id/cancel | Cancel |
| GET /v1/jev/health | Queue counts and workers |
| /mcp | MCP HTTP transport |

CLI: serve, submit <task.json> [--wait], batch <tasks.json> [--wait], get <id>, cancel <id>, list, workers, mcp-stdio. Batch files contain an array of tasks. Use --out <file> to save the response and --timeout <milliseconds> to bound waiting (default 120,000). Client waiting does not perform inference inside the CLI process. Failed/cancelled terminal jobs give exit code 1; command errors give exit code 2.

## MCP

Tools: jev_submit (task fields), jev_batch ({tasks}), jev_get ({id}), jev_list ({limit}), jev_cancel ({id}), jev_workers ({}). Poll job IDs after submission. Start stdio with `node --env-file=.env apps/jev/dist/index.js mcp-stdio`; stdout is reserved for protocol output. This starts its own host and workers, not a bridge to the running HTTP host. Give it a separate JEV_DATABASE_PATH or stop the HTTP host first. HTTP /mcp shares the existing HTTP host and queue.

## Results

States: queued, running, succeeded, failed, cancelled. Jobs contain ID, attempts, timestamps, request digest, and provenance (type, source, SHA-256, bytes, capture time). Results contain answers, input/output token usage, requested/returned model, provider, latency, request ID, and worker PID. Returned model and request ID can be unavailable.

- Choice: `{type:"choice",choice,probabilities,confidence?}`.
- Score: `{type:"score",score,probabilities,confidence?}`; probability keys identify level indices.
- Noul: `{type:"noul",noul}`.

Confidence is optional; absence is not certainty. Probability key order has no meaning. Scores are weighted rubric positions, not extracted exact numbers. Failure records carry a code and message; invalid tasks need correction before resubmission.

## External routes

| Route | POST endpoint | Yes/no | Usage/metadata |
| --- | --- | --- | --- |
| Direct | https://api.typesafe.ai/v1/systemone | noul / noul | input_tokens, output_tokens |
| Gateway native | https://ai-gateway.vercel.sh/v1/evaluate | boolean / probability | inputTokens, outputTokens, providerMetadata |
| Gateway compatible | https://ai-gateway.vercel.sh/typesafe/v1/systemone | noul / noul | input_tokens, output_tokens, provider_metadata |

All use JSON {model,state,questions} and bearer authentication. The service Gateway adapter uses native evaluation; compatibility is an alternative for external TypeSafe clients, not another service provider setting. Evaluation is not chat completions. [Gateway HTTP](https://vercel.com/docs/ai-gateway/modalities/evaluation), [compatibility](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)

Direct supports structured instructions and criteria. Direct responses include model, answers, usage, Choice/Score confidence, and Score legend. [TypeSafe contract](https://docs.typesafe.ai/api)

Provider context constraints: 64k total tokens, separately 32k state plus longest question. Retry 429/529 and transient failures with bounded backoff and retry hints. Authentication/schema errors need correction; oversize input needs explicit partitioning. Previously observed direct errors used detail as string/object/list; Gateway may use another envelope. Do not assume one error shape.

Pin direct model versions for reproducibility. Gateway alias is not a pinned direct model. Historical SDK observations of rounding/metadata must not substitute for validating the current route.
