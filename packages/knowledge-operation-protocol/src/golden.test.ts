import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { goldenVectors } from "./golden.js";
import { PUBLISHED_SCHEMAS, publishedJsonSchema } from "./schemas.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("published golden vectors and schemas", () => {
  it("the committed golden file equals the generated vectors (run `pnpm generate` to refresh)", () => {
    const path = resolve(root, "fixtures", "knowledge-operation-protocol.v2.golden.json");
    expect(existsSync(path), "fixtures/knowledge-operation-protocol.v2.golden.json missing; run pnpm generate").toBe(
      true,
    );
    const committed = JSON.parse(readFileSync(path, "utf8"));
    expect(committed).toEqual(JSON.parse(JSON.stringify(goldenVectors())));
  });

  it("every published schema renders to a JSON Schema with a committed file", () => {
    const index = JSON.parse(readFileSync(resolve(root, "schemas", "index.json"), "utf8"));
    for (const name of Object.keys(PUBLISHED_SCHEMAS) as (keyof typeof PUBLISHED_SCHEMAS)[]) {
      const rendered = publishedJsonSchema(name);
      expect(rendered.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      const file = resolve(root, "schemas", index.schemas[name]);
      const committed = JSON.parse(readFileSync(file, "utf8"));
      const { $id: _id, ...body } = committed;
      expect(body).toEqual(JSON.parse(JSON.stringify(rendered)));
    }
  });
});
