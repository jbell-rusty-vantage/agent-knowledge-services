import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bellLabsRoot, requireBksRoot, requireLoopback } from "./tests/proof-guards.js";

/** WI-05 review: the fresh-process drivers wipe disposable stores, so their targets are guarded before connecting. */
describe("WI-05 proof-driver guards", () => {
  it("accepts only loopback Neo4j and PostgreSQL targets", () => {
    for (const uri of ["neo4j://127.0.0.1:7691", "bolt://localhost:7687", "postgresql://u:p@[::1]:5432/db"]) {
      expect(requireLoopback("URI", uri)).toBe(uri);
    }
    for (const uri of [
      "neo4j+s://abcd1234.databases.neo4j.io",
      "bolt://10.0.0.5:7687",
      "postgresql://u:p@db.supabase.co:5432/postgres",
    ]) {
      expect(() => requireLoopback("URI", uri)).toThrow(/WI05_GUARD/);
    }
    expect(() => requireLoopback("URI", undefined)).toThrow(/not set/);
  });

  it("refuses a missing, foreign or misnamed BKS checkout", () => {
    expect(() => requireBksRoot(undefined)).toThrow(/not set/);
    expect(() => requireBksRoot(join(bellLabsRoot(), "no-such-checkout"))).toThrow(/does not exist/);
    const outside = mkdtempSync(join(tmpdir(), "wi05-guard-"));
    try {
      writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "biotech-knowledge-services" }));
      expect(() => requireBksRoot(outside)).toThrow(/outside the BellLabs workspace/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    // Inside the workspace but another repository: this Knowledge Services checkout, which exists in every layout
    // (the BellLabs workspace locally, a lone clone in CI).
    const thisRepository = fileURLToPath(new URL("../../../../", import.meta.url));
    expect(() => requireBksRoot(thisRepository)).toThrow(/not the biotech-knowledge-services/);
  });
});
