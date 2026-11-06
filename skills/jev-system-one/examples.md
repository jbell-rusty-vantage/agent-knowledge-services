# Jev operational and composition examples

Run from the Knowledge Services root after building the service. Keep keys in the server environment.

## Local resource

Write task.json using an absolute path beneath JEV_ALLOWED_ROOTS:

```json
{
  "idempotencyKey": "retrieval-resource-v1",
  "input": { "type": "file", "path": "C:/data/ai-resources/retrieval.md", "format": "text" },
  "questions": {
    "topic": {
      "type": "choice",
      "instructions": "Which topic is the primary subject of this resource?",
      "criteria": {
        "retrieval": "Document retrieval, indexing, RAG, or reranking",
        "agents": "Tool use, planning, or agent control loops",
        "evaluation": "Measuring quality, test sets, or model evaluation",
        "other": "None clearly fits or evidence is insufficient"
      }
    },
    "depth": {
      "type": "score",
      "instructions": "How much implementation detail does this resource provide?",
      "criteria": ["Only mentions the topic", "Explains concepts", "Shows implementation steps", "Explains internals and tradeoffs"]
    },
    "has_code": { "type": "noul", "instructions": "Does the resource include executable code examples?" }
  }
}
```

```powershell
node apps/jev/dist/index.js submit task.json --wait
node apps/jev/dist/index.js workers
```

For a direct state use `{ "type":"inline", "state":{"text":"..."} }`. For remote prepared text/JSON use `{ "type":"remote", "url":"https://allowed.example/resource.json", "format":"json" }` with that origin allowed. A JSON input artifact is parsed as state, not a task manifest.

## Parallel tasks

Create tasks.json as an array of complete tasks. Code can reuse a versioned question map; move file references rather than large source text through agent context.

```powershell
node apps/jev/dist/index.js batch tasks.json --wait --out results.json --timeout 300000
node apps/jev/dist/index.js list
node apps/jev/dist/index.js get JOB_ID
node apps/jev/dist/index.js cancel JOB_ID
```

Set JEV_WORKERS=3 in the service environment for three worker processes. Verify distinct PIDs through workers and result receipts. Independent jobs occupy workers; questions inside one job share a provider request. The queue is single-host, not multi-host orchestration.

## HTTP from another process

```js
import { readFile } from "node:fs/promises";
const base = process.env.JEV_SERVICE_URL ?? "http://127.0.0.1:4318";
const headers = { "content-type": "application/json" };
if (process.env.JEV_SERVICE_TOKEN) headers.authorization = `Bearer ${process.env.JEV_SERVICE_TOKEN}`;
const task = JSON.parse(await readFile("task.json", "utf8"));
const response = await fetch(`${base}/v1/jev/jobs`, {
  method: "POST", headers, body: JSON.stringify(task), signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Jev service returned ${response.status}`);
const job = await response.json();
// Save job.id; GET /v1/jev/jobs/<id> until succeeded, failed, or cancelled.
console.log(job.id);
```

For MCP use jev_submit with task fields then jev_get with {id}; jev_batch accepts {tasks:[...]}. Return summaries and IDs to the parent agent instead of all source text.

## LLM to Jev to LLM

This is a caller orchestration recipe, not a built-in fallback executor:

1. An LLM proposes taxonomy and criteria. Code validates and freezes the question version.
2. Jev classifies resources and answers independent relevance, implementation, or missing-evidence checks.
3. Code applies task-specific thresholds validated on labeled development data. Missing confidence, no-match, or uncertainty enter review.
4. An LLM receives relevant evidence, candidate labels, rubric, and Jev answers for disputed items; it resolves ambiguity or reports insufficient evidence.
5. Store which stage decided each item. Measure total quality/cost. LLM disagreement alone does not prove Jev wrong.

For extraction, a small LLM proposes fields; Jev checks each field against source evidence; code escalates flagged items to a stronger LLM. Exact formats, arithmetic, and span verification remain deterministic. Semantic judgments cannot override deterministic failures.

## More than 255 candidates

**Shortlist and verify:** retrieve at most 254 candidates plus no-match; Choice selects a relative winner, Noul checks absolute fit. Recheck top candidates with fuller descriptions in a second task. Measure retrieval recall separately: Jev cannot choose an omitted candidate.

**Hierarchy:** code turns sibling categories into Choice questions; Jev evaluates branches; code retains a small beam (e.g. three paths) and builds the next tasks. Stop at leaves, depth/budget limit, or insufficient evidence. Preserve path decisions. Geometric-mean/log-probability path scores rank paths; they are not calibrated end-to-end confidence.

Neither recipe is a hierarchy mode in the service schema. [Hierarchy cookbook](https://docs.typesafe.ai/cookbooks/hierarchical_classification), [skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion).

## Atomic capability matrix

Generate independent questions against each resource:

```js
const capabilities = ["durable execution", "retrieval evaluation", "prompt caching", "tool permissions"];
const questions = Object.fromEntries(capabilities.map((capability, index) => [
  `capability_${index}`,
  { type: "noul", instructions: `Does this resource explain or demonstrate ${capability}, beyond merely mentioning it?` },
]));
```

A UI can filter/weight saved answers without rerunning inference when evidence and question meanings are unchanged. Retain uncertainty; probabilities are not exact factual annotations.

## Legacy direct runner

```powershell
node skills/jev-system-one/scripts/jev-batch.mjs items.jsonl questions.json results.jsonl 4
```

This older utility consumes {id,state} JSONL plus a question manifest and writes resumable direct-provider results. Its concurrent HTTP calls run within one process, unlike the service pool. Use it to reproduce the older direct workflow. Historical latency and agreement observations are not fresh service results.
