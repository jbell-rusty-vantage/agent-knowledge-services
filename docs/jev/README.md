# Run Jev locally

Requires Node 24 or newer and the repository's pinned pnpm. From the repository root:

See [measured results](results/index.html), [validation evidence](VALIDATION.md), and [provider research](RESEARCH.md).

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm jev:build
$env:JEV_ALLOWED_ROOTS = '["C:/path/to/prepared-inputs"]'
$env:JEV_REMOTE_ORIGINS = '["https://raw.githubusercontent.com"]'
$env:JEV_WORKERS = '4'
node --env-file=.env apps/jev/dist/index.js serve
```

The server defaults to `http://127.0.0.1:4318`, Gateway evaluation, and `.jev/jobs.sqlite`. `AI_GATEWAY_API_KEY` is required for Gateway; `JEV_API_KEY` for direct requests. Do not put either key in a task file or command argument. Environment files are loaded by Node, not parsed or logged by the service.

## Submit work

Save this as `task.json`:

```json
{
  "idempotencyKey": "routing-example-v1",
  "provider": "gateway",
  "input": {"type":"inline","state":{"text":"Our RAG service indexes documents and reranks retrieved passages."}},
  "questions": {
    "topic": {"type":"choice","instructions":"Primary technical subject of text?","criteria":{"retrieval":"Indexing, RAG and retrieval","training":"Model training and fine tuning","other":"Neither or insufficient evidence"}},
    "implementation": {"type":"score","instructions":"How much implementation detail is present?","criteria":["None","Some design detail","Concrete executable instructions"]},
    "relevant": {"type":"noul","instructions":"The text concerns retrieval engineering."}
  }
}
```

In another terminal:

```powershell
node apps/jev/dist/index.js submit task.json --wait --out result.json
node apps/jev/dist/index.js workers
node apps/jev/dist/index.js get JOB_ID
node apps/jev/dist/index.js cancel JOB_ID
node apps/jev/dist/index.js batch tasks.json --wait --out batch-results.json
```

`tasks.json` is an array of tasks. Each job occupies one process; its questions are evaluated together. A local file input is `{"type":"file","path":"C:/path/to/prepared-inputs/resource.json","format":"json"}`. A remote artifact is `{"type":"remote","url":"https://raw.githubusercontent.com/owner/repo/ref/README.md","format":"text"}`. File paths are on the server host. For a remote server, transfer prepared inputs to its allowed roots or submit authorized inline content.

`--wait` returns terminal jobs, exits 1 for failed/cancelled jobs, and exits 2 on usage/network errors. A wait timeout leaves the job running. Save the submission ID if operating a long job; use `get` or `cancel` later. Reusing an idempotency key with changed state or questions is a conflict.

## API and client

| Method | Path | Body / result |
| --- | --- | --- |
| POST | `/v1/jev/jobs` | Task → durable job, HTTP 202 |
| POST | `/v1/jev/batches` | `{ "tasks": [...] }` → jobs, HTTP 202 |
| GET | `/v1/jev/jobs/:id` | Job, result and provenance |
| GET | `/v1/jev/jobs?limit=100` | Recent jobs |
| POST | `/v1/jev/jobs/:id/cancel` | Cancelled or already terminal job |
| GET | `/v1/jev/health` | Worker PIDs and queue counts |

Out-of-process TypeScript callers use `KnowledgeJevClient` from `@aiengineer/knowledge-client/jev` with `{baseUrl,getAccessToken?}`, or the same methods through `new KnowledgeClient(options).jev`. It offers `submit`, `submitBatch`, `get`, `list`, `cancel`, `health`, and `wait`. In-process hosts use the application `/jev` entry point. No caller needs to import the internal algorithm package.

Set `JEV_SERVICE_URL` and `JEV_SERVICE_TOKEN` on CLI clients for a remote service. Set `JEV_HOST`, `JEV_PORT`, and `JEV_SERVICE_TOKEN` on its host; non-loopback binding requires a token. Use TLS for traffic leaving the machine. Provider keys stay on the host.

## MCP

Connect an MCP client to `http://127.0.0.1:4318/mcp` using Streamable HTTP. With a token configured, supply the same bearer token. Tools are `jev_submit`, `jev_batch`, `jev_get`, `jev_list`, `jev_cancel`, and `jev_workers`.

For a standalone stdio host use command `node`, arguments `--env-file=ABSOLUTE_ENV_PATH`, `ABSOLUTE_REPO_PATH/apps/jev/dist/index.js`, `mcp-stdio`. Set a dedicated `JEV_DATABASE_PATH` in its environment. Do not start stdio and HTTP hosts against the same database. The stdio transport keeps stdout reserved for MCP; logs go to stderr.

## Operations and limits

Stop with Ctrl+C/SIGTERM. Queued work survives; interrupted running work is retried up to its attempt limit after restart. Tests exercise process replacement and queue recovery. Back up the SQLite database with SQLite-aware tooling while active, or stop the host first. Never copy just the main file while WAL writes are in progress.

Defaults: 4 workers (1–32), 10,000 active jobs, batch size 1–1,000, 512 KiB captured input, 1 MiB provider request, 30-second attempt timeout, 3 attempts, 600 dispatches/minute per supervisor. Request byte guards are not token estimators; Jev additionally enforces its context limits. Input roots and remote origins default to empty lists. See [architecture](../architecture/modules/jev.md) for delivery guarantees and trust scope.

Run `corepack pnpm jev:test` for the targeted core/transport/client checks. The public experiment reproduction procedure lives in `scripts/experiments/jev/README.md`; the generated report is `docs/jev/results/index.html`. These experiments spend provider credits and are never part of the offline test command.
