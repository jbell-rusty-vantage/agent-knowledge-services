import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("./fixtures/", import.meta.url));
const sources = [
  ["pgvector/pgvector", "master", "README.md", "retrieval"],
  ["facebookresearch/faiss", "main", "README.md", "retrieval"],
  ["qdrant/qdrant", "master", "README.md", "retrieval"],
  ["chroma-core/chroma", "main", "README.md", "retrieval"],
  ["vllm-project/vllm", "main", "README.md", "serving"],
  ["huggingface/text-generation-inference", "main", "README.md", "serving"],
  ["sgl-project/sglang", "main", "README.md", "serving"],
  ["BentoML/BentoML", "main", "README.md", "serving"],
  ["EleutherAI/lm-evaluation-harness", "main", "README.md", "evaluation"],
  ["explodinggradients/ragas", "main", "README.md", "evaluation"],
  ["promptfoo/promptfoo", "main", "README.md", "evaluation"],
  ["confident-ai/deepeval", "main", "README.md", "evaluation"],
  ["temporalio/sdk-typescript", "main", "README.md", "orchestration"],
  ["langchain-ai/langgraph", "main", "README.md", "orchestration"],
  ["PrefectHQ/prefect", "main", "README.md", "orchestration"],
  ["dagster-io/dagster", "master", "python_modules/dagster/README.md", "orchestration"],
  ["huggingface/peft", "main", "README.md", "training"],
  ["huggingface/trl", "main", "README.md", "training"],
  ["unslothai/unsloth", "main", "README.md", "training"],
  ["axolotl-ai-cloud/axolotl", "main", "README.md", "training"],
  ["pallets/flask", "main", "README.md", "other"],
  ["psf/black", "main", "README.md", "other"],
  ["pytest-dev/pytest", "main", "README.rst", "other"],
  ["astral-sh/ruff", "main", "README.md", "other"],
];
const hash = (text) => createHash("sha256").update(text).digest("hex");
await mkdir(directory, { recursive: true });
const items = [];
for (const [repository, branch, path, expected] of sources) {
  const url = `https://raw.githubusercontent.com/${repository}/${branch}/${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${repository}: HTTP ${response.status}`);
  const raw = await response.text();
  const text = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 8000);
  const id = repository.replace("/", "--");
  const state = { text };
  const item = {
    id,
    repository,
    url,
    sourceSha256: hash(raw),
    stateSha256: hash(JSON.stringify(state)),
    capturedAt: new Date().toISOString(),
    expected,
    labelOrigin: "Curated source-purpose reference; not independent human gold",
    state,
  };
  await writeFile(`${directory}${id}.json`, JSON.stringify(state, null, 2));
  items.push(item);
  console.log(`${id}: ${text.length} characters`);
}
await writeFile(`${directory}corpus.json`, JSON.stringify({ version: 1, items }, null, 2));
