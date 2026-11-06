import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { categories, questions, synthetic } from "./questions.mjs";

const base = process.env.JEV_EXPERIMENT_URL ?? "http://127.0.0.1:4318";
const fixtures = resolve("scripts/experiments/jev/fixtures");
const output = resolve(process.env.JEV_EXPERIMENT_OUTPUT ?? "docs/jev/results");
const corpus = JSON.parse(await readFile(resolve(fixtures, "corpus.json"), "utf8"));
const receipt = {
  schema: "jev-experiment-v1",
  startedAt: new Date().toISOString(),
  base,
  corpusSha256: hash(JSON.stringify(corpus)),
  questionSha256: hash(JSON.stringify(questions)),
  stages: [],
  llm: [],
  pricing: { jevInputPerToken: 0.000000042, llmInputPerToken: 0.0000004, llmOutputPerToken: 0.0000016 },
  limitations: [
    "Convenience sample: 24 public README excerpts; purpose labels curated by an agent, not independently adjudicated human gold.",
    "Taxonomy and threshold fixed before viewing outcomes. This is a pilot, not production calibration.",
    "Gateway model alias cannot guarantee an immutable provider version.",
    "Latency measurements include queueing, polling, network variability and cold starts. Serial/parallel order is not randomized.",
    "Synthetic option/fanout stress tests measure transport capacity, not broad semantic accuracy.",
    "Public URLs are mutable. Source bytes and input states have SHA-256 hashes and captured fixtures.",
  ],
};
await mkdir(output, { recursive: true });
const mode = process.argv[2] ?? "all";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
async function checkpoint() {
  await writeFile(resolve(output, "receipts.json"), JSON.stringify(receipt, null, 2));
}
async function http(path, body) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Service HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
function unwrap(data) {
  return data.job ?? data;
}
async function waitFor(ids) {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const jobs = await Promise.all(ids.map(async (id) => unwrap(await http(`/v1/jev/jobs/${id}`))));
    if (jobs.every((job) => ["succeeded", "failed", "cancelled"].includes(job.status))) return jobs;
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error("Experiment timed out waiting for jobs");
}
async function stage(name, entries) {
  const started = performance.now();
  const submitted = await http("/v1/jev/batches", { tasks: entries.map(({ task }) => task) });
  const jobs = await waitFor((submitted.jobs ?? submitted).map((job) => job.id));
  const value = {
    name,
    wallMs: performance.now() - started,
    entries: entries.map((entry, index) => ({ ...entry, job: jobs[index] })),
  };
  receipt.stages.push(value);
  await checkpoint();
  console.log(
    `${name}: ${jobs.filter((job) => job.status === "succeeded").length}/${jobs.length} succeeded in ${(value.wallMs / 1000).toFixed(2)}s; PIDs ${[...new Set(jobs.map((job) => job.workerPid))].join(",")}`,
  );
  return value;
}
const inline = (state, qs = questions) => ({ input: { type: "inline", state }, questions: qs, provider: "gateway" });
const entry = (item) => ({
  id: item.id,
  expected: item.expected,
  kind: "public-source",
  repository: item.repository,
  sourceUrl: item.url,
  sourceSha256: item.sourceSha256,
  stateSha256: item.stateSha256,
  task: {
    input: { type: "file", path: resolve(fixtures, `${item.id}.json`), format: "json" },
    questions,
    provider: "gateway",
  },
});

if (mode === "all") {
  try {
    const previous = JSON.parse(await readFile(resolve(output, "receipts.json"), "utf8"));
    if (previous.corpusSha256 === receipt.corpusSha256 && previous.questionSha256 === receipt.questionSha256)
      receipt.llm = previous.llm ?? [];
  } catch {}
  receipt.health = await http("/v1/jev/health");
  const smoke = await stage("gateway-smoke", [entry(corpus.items[0])]);
  if (smoke.entries[0].job.status !== "succeeded")
    throw new Error("Gateway smoke failed; saved receipt, stopping paid suite");
  await stage("public-routing", corpus.items.map(entry));
  await stage("direct-provider-pair", [
    {
      id: "pgvector-direct",
      kind: "public-source",
      expected: corpus.items[0].expected,
      task: { ...inline(corpus.items[0].state), provider: "direct", model: "jev-1.13.0" },
    },
  ]);
  await stage(
    "adversarial-abstention",
    synthetic.map((item) => ({ ...item, task: inline({ text: item.text }) })),
  );
  await stage(
    "remote-input",
    corpus.items
      .filter((item) => ["chroma-core/chroma", "langchain-ai/langgraph", "huggingface/trl"].includes(item.repository))
      .map((item) => ({
        ...entry(item),
        task: {
          input: { type: "remote", url: item.url, format: "text" },
          questions: {
            topic: {
              ...questions.topic,
              instructions: questions.topic.instructions.replace("`text`", "the state text"),
            },
          },
          provider: "gateway",
        },
      })),
  );
  const options = Object.fromEntries(
    Array.from({ length: 254 }, (_, i) => [
      `distractor_${i}`,
      `Unrelated fictional bookkeeping archive number ${i}; no vector retrieval capabilities.`,
    ]),
  );
  options.vector_database = "A vector database implementing nearest-neighbor similarity retrieval.";
  await stage("choice-255", [
    {
      id: "255-options",
      kind: "synthetic-capacity",
      expected: "vector_database",
      task: inline(
        { text: "A vector database implementing nearest-neighbor similarity retrieval." },
        { topic: { type: "choice", instructions: "Choose the option describing this text.", criteria: options } },
      ),
    },
  ]);
  const concepts = [
    "vector similarity search",
    "model fine-tuning",
    "HNSW indexing",
    "language model inference",
    "cosine distance",
    "reinforcement learning",
    "nearest neighbor retrieval",
    "evaluation benchmarks",
    "embedding storage",
    "workflow orchestration",
  ];
  await stage(
    "question-fanout",
    [10, 100, 500].map((count) => ({
      id: `fanout-${count}`,
      kind: "synthetic-capacity",
      questionCount: count,
      task: inline(
        {
          text: "This vector database provides embedding storage, vector similarity search, HNSW indexing, cosine distance, and nearest neighbor retrieval.",
        },
        Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `concept_${i}`,
            { type: "noul", instructions: `The resource provides ${concepts[i % concepts.length]}.` },
          ]),
        ),
      ),
    })),
  );
  const throughputItems = corpus.items.slice(0, 12);
  const serialStart = performance.now();
  const serial = [];
  for (const item of throughputItems) {
    const result = unwrap(await http("/v1/jev/jobs", inline(item.state)));
    serial.push({ id: item.id, job: (await waitFor([result.id]))[0] });
  }
  receipt.stages.push({ name: "serial-throughput", wallMs: performance.now() - serialStart, entries: serial });
  await checkpoint();
  await stage(
    "parallel-throughput",
    throughputItems.map((item) => ({ id: item.id, task: inline(item.state) })),
  );
  await runLlm();
  receipt.finishedAt = new Date().toISOString();
  await checkpoint();
}
if (mode === "llm") {
  try {
    Object.assign(receipt, JSON.parse(await readFile(resolve(output, "receipts.json"), "utf8")));
  } catch {}
  await runLlm();
  await checkpoint();
}

async function runLlm() {
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error("AI_GATEWAY_API_KEY is required for comparison");
  for (const item of [...corpus.items, ...synthetic.map((item) => ({ ...item, state: { text: item.text } }))]) {
    if (receipt.llm.some((row) => row.id === item.id)) continue;
    const started = performance.now();
    const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-4.1-mini",
        temperature: 0,
        max_tokens: 40,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `${questions.topic.instructions} Return only JSON {"topic":"category_key"}. Categories: ${JSON.stringify(categories)}`,
          },
          { role: "user", content: JSON.stringify(item.state) },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await response.json();
    const text = body.choices?.[0]?.message?.content;
    let topic = null;
    try {
      topic = JSON.parse(text).topic;
    } catch {}
    receipt.llm.push({
      id: item.id,
      expected: item.expected,
      model: body.model,
      topic,
      usage: body.usage,
      latencyMs: performance.now() - started,
      status: response.status,
      requestId: body.id,
      error: body.error ?? null,
    });
    await checkpoint();
    console.log(`LLM ${item.id}: HTTP ${response.status}; topic=${topic}`);
    if ([401, 402, 403, 429].includes(response.status)) break;
  }
}
