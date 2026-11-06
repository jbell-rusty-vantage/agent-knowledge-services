import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function rootWith(relativePath: string) {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await readFile(join(cursor, relativePath), "utf8");
      return cursor;
    } catch {
      cursor = resolve(cursor, "..");
    }
  }
  throw new Error(`Could not locate ${relativePath}`);
}

describe("Gate 6 operational artifacts", () => {
  it("pins and isolates Docling Serve with a healthcheck", async () => {
    const root = await rootWith("services/docling/compose.yaml");
    const compose = await readFile(join(root, "services/docling/compose.yaml"), "utf8");
    expect(compose).toContain("@sha256:");
    expect(compose).not.toMatch(/image:.*:(latest|main)\s*$/m);
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("no-new-privileges:true");
    expect(compose).toContain("healthcheck:");
  });

  it("ships bounded versioned capability profiles", async () => {
    const root = await rootWith("catalog/capability-profiles.v1.json");
    const catalog = JSON.parse(await readFile(join(root, "catalog/capability-profiles.v1.json"), "utf8")) as {
      schemaVersion: string;
      profiles: Array<Record<string, unknown>>;
    };
    expect(catalog.schemaVersion).toBe("knowledge-capability-catalog/v1");
    expect(catalog.profiles.length).toBeGreaterThanOrEqual(3);
    expect(catalog.profiles.every((profile) => typeof profile.version === "string")).toBe(true);
    expect(JSON.stringify(catalog)).not.toMatch(/api[_-]?key|secret/i);
  });
});
