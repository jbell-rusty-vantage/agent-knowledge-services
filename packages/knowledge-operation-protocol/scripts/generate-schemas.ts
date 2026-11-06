import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHED_SCHEMAS, publishedJsonSchema } from "../src/schemas.js";
import { goldenVectors } from "../src/golden.js";

/**
 * Writes `schemas/<name>.schema.json` (JSON Schema draft 2020-12 for the Python consumer) and
 * `fixtures/knowledge-operation-protocol.v2.golden.json` (canonical bytes and digests Python must reproduce).
 * Deterministic: same source, same bytes. `golden.test.ts` fails when the committed golden file drifts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
mkdirSync(resolve(root, "schemas"), { recursive: true });
mkdirSync(resolve(root, "fixtures"), { recursive: true });

const index: Record<string, string> = {};
for (const name of Object.keys(PUBLISHED_SCHEMAS) as (keyof typeof PUBLISHED_SCHEMAS)[]) {
  const file = `${name}.schema.json`;
  const schema = { $id: `https://belllabs.local/knowledge-operation-protocol/${file}`, ...publishedJsonSchema(name) };
  writeFileSync(resolve(root, "schemas", file), `${JSON.stringify(schema, null, 2)}\n`);
  index[name] = file;
}
writeFileSync(
  resolve(root, "schemas", "index.json"),
  `${JSON.stringify({ protocolVersion: "ks.knowledge_operation.v2", schemas: index }, null, 2)}\n`,
);
writeFileSync(
  resolve(root, "fixtures", "knowledge-operation-protocol.v2.golden.json"),
  `${JSON.stringify(goldenVectors(), null, 2)}\n`,
);
console.log(
  JSON.stringify({
    schemas: Object.keys(index).length,
    golden: "fixtures/knowledge-operation-protocol.v2.golden.json",
  }),
);
