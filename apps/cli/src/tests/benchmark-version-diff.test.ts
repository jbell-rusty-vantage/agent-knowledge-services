import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareDiagnosticsBenchmarkRefreshProposal } from "@aiengineer/knowledge-application";

import { parseLocalBenchmarkVersionDiffArgs, runLocalBenchmarkVersionDiff } from "../benchmark-version-diff.js";
import { writeBenchmarkRefreshProposal } from "../benchmark-refresh-writer.js";

const catalogRoot = resolve(import.meta.dirname, "../../../../catalog/verification-benchmarks");
const command = (previous: string, proposed: string) => [
  "benchmark",
  "diff",
  previous,
  proposed,
  "--catalog-root",
  catalogRoot,
];
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const canonical = (value: unknown): string =>
  value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value as Record<string, unknown>)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
          .join(",")}}`;
const hash = async (value: unknown) =>
  `sha256:${(await import("node:crypto")).createHash("sha256").update(canonical(value)).digest("hex")}`;
const without = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

describe("local immutable benchmark version diff", () => {
  it("accepts exactly two positional versions and one optional local catalog root", () => {
    expect(
      parseLocalBenchmarkVersionDiffArgs(command("diagnostics-companies-pilot-v3", "diagnostics-companies-pilot-v4")),
    ).toMatchObject({
      previous: "diagnostics-companies-pilot-v3",
      proposed: "diagnostics-companies-pilot-v4",
      catalogRoot,
    });
    for (const args of [
      ["benchmark", "diff", "../diagnostics-companies-v1", "diagnostics-companies-v2"],
      ["benchmark", "diff", "diagnostics-companies-v1", "diagnostics-companies-v2", "--catalog-root"],
      [...command("diagnostics-companies-v1", "diagnostics-companies-v2"), "--catalog-root", catalogRoot],
    ])
      expect(() => parseLocalBenchmarkVersionDiffArgs(args)).toThrow();
  });

  it("uses a sealed non-frozen v2 refresh proposal only when the proposed catalog directory is absent", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "benchmark-version-refresh-"));
    const root = resolve(directory, "catalog"),
      proposalRoot = resolve(directory, "proposals");
    try {
      await cp(resolve(catalogRoot, "diagnostics-companies-v1"), resolve(root, "diagnostics-companies-v1"), {
        recursive: true,
      });
      const [dataset, ledger, manifest] = await Promise.all(
        ["dataset.json", "source-ledger.json", "manifest.json"].map(async (name) =>
          JSON.parse(await readFile(resolve(root, "diagnostics-companies-v1", name), "utf8")),
        ),
      );
      const baselineFiles = (manifest.files as readonly { readonly name: string }[]).map((entry) => entry.name);
      const baselineBytes = await Promise.all(
        baselineFiles.map((name) => readFile(resolve(root, "diagnostics-companies-v1", name))),
      );
      const sourceOutcomes = (ledger.sources as readonly { sourceKey: string; url: string }[]).map((source) => ({
        sourceKey: source.sourceKey,
        sourceUri: source.url,
        state: "unavailable" as const,
        failureStage: "submit" as const,
        code: "FORBIDDEN",
      }));
      const proposal = prepareDiagnosticsBenchmarkRefreshProposal({
        tenantId: id(1),
        baselineDataset: dataset,
        baselineSourceLedger: ledger,
        baselineCatalogManifestDigest: manifest.manifestDigest,
        baselineSourceLedgerCanonicalDigest: await hash(ledger),
        authenticatedCaptureOutcomes: sourceOutcomes.map((source) => ({
          sourceKey: source.sourceKey,
          state: "unavailable" as const,
          unavailableCode: source.code,
        })),
      });
      await writeBenchmarkRefreshProposal({
        outputDirectory: join(proposalRoot, "diagnostics-companies-v2"),
        proposal,
        sourceOutcomes,
      });
      const result = await runLocalBenchmarkVersionDiff([
        "benchmark",
        "diff",
        "diagnostics-companies-v1",
        "diagnostics-companies-v2",
        "--catalog-root",
        root,
        "--proposal-root",
        proposalRoot,
      ]);
      expect(result).toMatchObject({
        kind: "refresh_proposal",
        frozenDatasetCreated: false,
        humanApprovalGranted: false,
        proposed: { name: "diagnostics-companies-v2" },
        result: {
          historicalCaseCount: expect.any(Number),
          review: { frozenSuccessorDatasetCreated: false },
        },
      });
      expect(
        await Promise.all(baselineFiles.map((name) => readFile(resolve(root, "diagnostics-companies-v1", name)))),
      ).toEqual(baselineBytes);
      const outcomePath = join(proposalRoot, "diagnostics-companies-v2", "source-outcomes.json"),
        manifestPath = join(proposalRoot, "diagnostics-companies-v2", "manifest.json");
      const storedOutcomes = JSON.parse(await readFile(outcomePath, "utf8")) as Record<string, any>;
      storedOutcomes.outcomes[0].sourceUri = "https://attacker.example/mislabeled";
      storedOutcomes.outcomesDigest = await hash(without(storedOutcomes, "outcomesDigest"));
      const outcomeText = canonical(storedOutcomes);
      await writeFile(outcomePath, outcomeText, "utf8");
      const storedManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
      const entry = storedManifest.files.find((value: { name: string }) => value.name === "source-outcomes.json");
      entry.bytes = new TextEncoder().encode(outcomeText).byteLength;
      entry.digest = `sha256:${(await import("node:crypto")).createHash("sha256").update(outcomeText).digest("hex")}`;
      storedManifest.manifestDigest = await hash(without(storedManifest, "manifestDigest"));
      await writeFile(manifestPath, canonical(storedManifest), "utf8");
      await expect(
        runLocalBenchmarkVersionDiff([
          "benchmark",
          "diff",
          "diagnostics-companies-v1",
          "diagnostics-companies-v2",
          "--catalog-root",
          root,
          "--proposal-root",
          proposalRoot,
        ]),
      ).rejects.toThrow("BENCHMARK_VERSION_DIFF_PROPOSAL_OUTCOME_BINDING_INVALID");
      await writeFile(join(proposalRoot, "diagnostics-companies-v2", "proposal.json"), "{}", "utf8");
      await expect(
        runLocalBenchmarkVersionDiff([
          "benchmark",
          "diff",
          "diagnostics-companies-v1",
          "diagnostics-companies-v2",
          "--catalog-root",
          root,
          "--proposal-root",
          proposalRoot,
        ]),
      ).rejects.toThrow("BENCHMARK_VERSION_DIFF_PROPOSAL_MANIFEST_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not fall back to a proposal when a proposed frozen catalog directory exists but is corrupt", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "benchmark-version-no-fallback-"));
    const root = resolve(directory, "catalog");
    try {
      await cp(resolve(catalogRoot, "diagnostics-companies-v1"), resolve(root, "diagnostics-companies-v1"), {
        recursive: true,
      });
      await mkdir(resolve(root, "diagnostics-companies-v2"), {
        recursive: true,
      });
      await expect(
        runLocalBenchmarkVersionDiff([
          "benchmark",
          "diff",
          "diagnostics-companies-v1",
          "diagnostics-companies-v2",
          "--catalog-root",
          root,
          "--proposal-root",
          resolve(directory, "does-not-matter"),
        ]),
      ).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates complete local manifests and delegates sealed lineage/diff computation without network", async () => {
    const priorFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("NETWORK_FORBIDDEN");
    }) as typeof fetch;
    try {
      const result = await runLocalBenchmarkVersionDiff(
        command("diagnostics-companies-pilot-v3", "diagnostics-companies-pilot-v4"),
      );
      expect(result).toMatchObject({
        command: "benchmark diff",
        previous: { name: "diagnostics-companies-pilot-v3" },
        proposed: { name: "diagnostics-companies-pilot-v4" },
        humanApprovalGranted: false,
        externalRequests: 0,
        result: {
          lineage: { valid: true, previousVersion: 3, proposedVersion: 4 },
          sourcePreparation: { changed: false },
        },
      });
      if (result.kind !== "frozen_dataset") throw new Error("EXPECTED_FROZEN_DATASET_DIFF");
      expect(result.result.resultDigest).toMatch(/^sha256:/);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("rejects tampered catalog files before passing data to the pure version-diff helper", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "benchmark-version-diff-"));
    const root = resolve(directory, "catalog");
    try {
      await cp(
        resolve(catalogRoot, "diagnostics-companies-pilot-v3"),
        resolve(root, "diagnostics-companies-pilot-v3"),
        { recursive: true },
      );
      await cp(
        resolve(catalogRoot, "diagnostics-companies-pilot-v4"),
        resolve(root, "diagnostics-companies-pilot-v4"),
        { recursive: true },
      );
      const target = resolve(root, "diagnostics-companies-pilot-v4", "source-ledger.json");
      await writeFile(target, `${await readFile(target, "utf8")}\n`);
      await expect(
        runLocalBenchmarkVersionDiff([
          "benchmark",
          "diff",
          "diagnostics-companies-pilot-v3",
          "diagnostics-companies-pilot-v4",
          "--catalog-root",
          root,
        ]),
      ).rejects.toThrow("BENCHMARK_VERSION_DIFF_CATALOG_FILE_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a valid sealed dataset when its directory version label is false", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "benchmark-version-label-"));
    const root = resolve(directory, "catalog");
    try {
      await cp(
        resolve(catalogRoot, "diagnostics-companies-pilot-v4"),
        resolve(root, "diagnostics-companies-pilot-v3"),
        { recursive: true },
      );
      await cp(
        resolve(catalogRoot, "diagnostics-companies-pilot-v4"),
        resolve(root, "diagnostics-companies-pilot-v4"),
        { recursive: true },
      );
      await expect(
        runLocalBenchmarkVersionDiff([
          "benchmark",
          "diff",
          "diagnostics-companies-pilot-v3",
          "diagnostics-companies-pilot-v4",
          "--catalog-root",
          root,
        ]),
      ).rejects.toThrow("BENCHMARK_VERSION_DIFF_DATASET_NAME_BINDING");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
