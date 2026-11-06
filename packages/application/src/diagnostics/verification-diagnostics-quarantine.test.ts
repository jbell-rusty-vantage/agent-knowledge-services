import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const source = join(import.meta.dirname, "..");
const productFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "diagnostics" ? [] : productFiles(path);
    return /\.ts$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name) ? [path] : [];
  });

describe("diagnostics quarantine", () => {
  it("keeps product use cases free of diagnostics imports; only the barrel re-exports them", () => {
    const offenders = productFiles(source)
      .filter((path) => relative(source, path) !== "index.ts")
      .filter((path) => /(?:from|import\()\s*["'][^"']*\/diagnostics\//u.test(readFileSync(path, "utf8")))
      .map((path) => relative(source, path).replaceAll("\\", "/"));
    expect(offenders).toEqual([]);
  });
});
