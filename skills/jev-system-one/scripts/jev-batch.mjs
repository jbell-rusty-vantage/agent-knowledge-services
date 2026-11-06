// jev-batch.mjs — resumable Jev batch runner (Node >= 20, no dependencies).
// Usage: JEV_API_KEY=... node jev-batch.mjs items.jsonl questions.json results.jsonl [concurrency]
//   items.jsonl     one {"id": "...", "state": <string|object|array>} per line
//   questions.json  {"id": "set-name", "version": "1", "model": "jev-1.13.0", "questions": {...}}
//   results.jsonl   appended; items already present (same request hash) are skipped on rerun
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const [itemsPath, questionsPath, resultsPath, concurrencyArg = "4"] = process.argv.slice(2);
const key = process.env.JEV_API_KEY;
if (!key || !itemsPath || !questionsPath || !resultsPath) {
  console.error("usage: JEV_API_KEY=... node jev-batch.mjs items.jsonl questions.json results.jsonl [concurrency]");
  process.exit(2);
}
const sha256 = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const set = JSON.parse(readFileSync(questionsPath, "utf8"));
const setHash = sha256(set);
const items = readFileSync(itemsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const done = new Set(existsSync(resultsPath)
  ? readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((r) => r.status === 200).map((r) => r.request_hash)
  : []);

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ask(body, attempt = 0) {
  const started = performance.now();
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => ({ status: 0, error }));
  const latency_ms = Math.round(performance.now() - started);
  if ((RETRYABLE.has(response.status) || response.status === 0) && attempt < 5) {
    const retryAfter = Number(response.headers?.get("retry-after")) * 1000;
    await sleep(retryAfter || Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random()));
    return ask(body, attempt + 1);
  }
  const payload = response.status ? await response.json().catch(() => null) : null;
  return { status: response.status, latency_ms, attempts: attempt + 1, request_id: response.headers?.get("x-typesafe-request-id") ?? null, payload };
}

const pending = items.map((item) => {
  const body = { model: set.model, state: item.state, questions: set.questions };
  return { item, body, request_hash: sha256(body) };
}).filter((job) => !done.has(job.request_hash));
console.error(`${items.length} items, ${items.length - pending.length} already done, ${pending.length} to run`);

let tokens = 0;
let failures = 0;
const started = performance.now();
await Promise.all(Array.from({ length: Number(concurrencyArg) }, async () => {
  for (let job; (job = pending.shift());) {
    const result = await ask(job.body);
    const ok = result.status === 200;
    tokens += ok ? result.payload.usage?.input_tokens ?? 0 : 0;
    failures += ok ? 0 : 1;
    appendFileSync(resultsPath, JSON.stringify({
      item_id: job.item.id,
      request_hash: job.request_hash,
      question_set: { id: set.id, version: set.version, hash: setHash },
      model_requested: set.model,
      model: ok ? result.payload.model : null,
      request_id: result.request_id,
      status: result.status,
      attempts: result.attempts,
      latency_ms: result.latency_ms,
      input_tokens: ok ? result.payload.usage?.input_tokens : null,
      answers: ok ? result.payload.answers : null,
      error: ok ? null : result.payload?.detail ?? "network error",
      at: new Date().toISOString(),
    }) + "\n");
  }
}));
console.error(JSON.stringify({
  seconds: +((performance.now() - started) / 1000).toFixed(1),
  input_tokens: tokens,
  cost_usd: +(tokens * 0.042e-6).toFixed(5),
  failures,
}));
