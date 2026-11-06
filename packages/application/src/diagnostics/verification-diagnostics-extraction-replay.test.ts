import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "@aiengineer/knowledge-verification";
import { verificationBenchmarkDigest } from "@aiengineer/knowledge-evaluation";
import { replayDiagnosticsExtractionFixture } from "./verification-diagnostics-extraction-replay.js";

const repository = resolve(import.meta.dirname, "../../../..");
const fixture = resolve(
  repository,
  "catalog/verification-benchmarks/diagnostics-companies-pilot-v4-extraction-replay-v1",
);
const catalog = resolve(repository, "catalog/verification-benchmarks/diagnostics-companies-pilot-v4");
const expected = "sha256:6124fac14ef6b3c320c4a00c6efa57f6027adad1cbc88038af1762e7dbe04101" as const;

describe("pilot-v4 extraction replay fixture", () => {
  it("replays retained provider-neutral extraction outputs without external requests", async () => {
    const result = await replayDiagnosticsExtractionFixture({
      directory: fixture,
      catalogDirectory: catalog,
      expectedFixtureDigest: expected,
    });
    expect(result.externalRequests).toBe(0);
    expect(result.replayed).toHaveLength(72);
    expect(result.replayed.filter((item) => item.fieldMechanics).length).toBeGreaterThan(0);
    expect(result.unavailable).toHaveLength(6);
    expect(result.missingCaseIds).toEqual([
      "tru-turnaround-product-mutated",
      "tru-corrupted-locator",
      "tru-pdf-graph-text-abstention",
      "gl-same-page-superlative-source",
    ]);
    expect(result.missingArms).toHaveLength(8);
  });

  it("rejects a changed fixture manifest", async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "diagnostics-extraction-replay-"));
    await cp(fixture, temporary, { recursive: true });
    const manifestPath = resolve(temporary, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.entries[0].caseId = "forged";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(
      replayDiagnosticsExtractionFixture({
        directory: temporary,
        catalogDirectory: catalog,
        expectedFixtureDigest: expected,
      }),
    ).rejects.toThrow("FIXTURE_SEAL_MISMATCH");
  });

  it("rejects a resealed engineering copy whose retained artifact bytes were changed", async () => {
    const temporary = await mkdtemp(resolve(tmpdir(), "diagnostics-extraction-replay-tamper-"));
    await cp(fixture, temporary, { recursive: true });
    const manifestPath = resolve(temporary, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.entries[0];
    const recordPath = resolve(temporary, entry.recordFile);
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    const raw = Buffer.from(
      record.artifacts.find((item: { role: string }) => item.role === "granted_fragment").bytesBase64,
      "base64",
    );
    raw.writeUInt8(raw.readUInt8(0) ^ 1, 0);
    const fragment = record.artifacts.find((item: { role: string }) => item.role === "granted_fragment");
    fragment.bytesBase64 = raw.toString("base64");
    const { checkpointDigest: _ignored, ...checkpointMaterial } = record;
    record.checkpointDigest = verificationBenchmarkDigest(checkpointMaterial);
    const recordBytes = new TextEncoder().encode(canonicalizeJson(record));
    await writeFile(recordPath, recordBytes);
    entry.recordBytes = recordBytes.byteLength;
    entry.recordSha256 = `sha256:${createHash("sha256").update(recordBytes).digest("hex")}`;
    const { fixtureDigest: _fixture, ...fixtureMaterial } = manifest;
    manifest.fixtureDigest = `sha256:${createHash("sha256")
      .update(new TextEncoder().encode(canonicalizeJson(fixtureMaterial)))
      .digest("hex")}`;
    await writeFile(manifestPath, canonicalizeJson(manifest));
    await expect(
      replayDiagnosticsExtractionFixture({
        directory: temporary,
        catalogDirectory: catalog,
        expectedFixtureDigest: manifest.fixtureDigest,
      }),
    ).rejects.toThrow("ARTIFACT_DIGEST_MISMATCH");
  });
});
