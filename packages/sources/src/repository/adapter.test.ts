import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import { ImmutableRepositoryAcquisitionAdapter } from "./adapter.js";
import type { AcquisitionRequest } from "../types.js";

const bytes = (value: string) => new TextEncoder().encode(value);
function request(target: AcquisitionRequest["target"], maximumBytes = 10_000): AcquisitionRequest {
  return {
    tenantId: "tenant-1",
    purpose: "test",
    target,
    expectedSourceClass: "official",
    preferredMediaTypes: ["text/markdown"],
    egressProfile: "public-web",
    maximumBytes,
    renderingPolicy: "allowed",
    interactionPolicy: "none",
    classification: "public",
    expectedOutputs: ["source_native"],
  };
}

describe("ImmutableRepositoryAcquisitionAdapter", () => {
  const sha = "a".repeat(40);
  const archiveBytes = bytes("archive");
  const entries = [
    { path: "LICENSE", bytes: bytes("MIT") },
    { path: "src/index.ts", bytes: bytes('const apiKey = "super-secret-value";') },
    { path: "pnpm-lock.yaml", bytes: bytes("lock") },
  ];
  const policy = { maximumArchiveBytes: 100, maximumExpandedBytes: 100, maximumEntries: 10, maximumFileBytes: 80 };
  const target = { kind: "repository", host: "github.com", owner: "org", repository: "repo", commitSha: sha } as const;
  it("binds the archive to a SHA and records license and redacted secret findings", async () => {
    const adapter = new ImmutableRepositoryAcquisitionAdapter(
      new InMemoryArtifactStore(),
      { fetchArchive: async () => ({ resolvedCommitSha: sha, archiveBytes, entries }) },
      policy,
    );
    const plan = await adapter.plan(request(target));
    const admitted = { ...plan, admissionId: "repo" };
    const first = await adapter.execute(admitted);
    const second = await adapter.execute(admitted);
    const manifest = await adapter.inspectManifest(admitted);
    expect(manifest.licenseFiles).toEqual(["LICENSE"]);
    expect(manifest.secretLikeFindings).toEqual([{ path: "src/index.ts", kind: "generic_assignment" }]);
    expect(JSON.stringify(manifest)).not.toContain("super-secret-value");
    expect(first.artifacts.map((x) => x.artifactId)).toEqual(second.artifacts.map((x) => x.artifactId));
  });
  it("rejects mutable identity, substitution, traversal, symlinks, and expansion", async () => {
    const adapterFor = (override: object, expanded = 100) =>
      new ImmutableRepositoryAcquisitionAdapter(
        new InMemoryArtifactStore(),
        { fetchArchive: async () => ({ resolvedCommitSha: sha, archiveBytes, entries, ...override }) },
        { ...policy, maximumExpandedBytes: expanded },
      );
    const invalid = adapterFor({});
    await expect(invalid.plan(request({ ...target, commitSha: "main" }))).rejects.toThrow(
      "IMMUTABLE_COMMIT_SHA_REQUIRED",
    );
    async function run(adapter: ImmutableRepositoryAcquisitionAdapter, id: string) {
      const plan = await adapter.plan(request(target));
      return adapter.execute({ ...plan, admissionId: id });
    }
    await expect(run(adapterFor({ resolvedCommitSha: "b".repeat(40) }), "a")).rejects.toThrow(
      "COMMIT_IDENTITY_MISMATCH",
    );
    await expect(run(adapterFor({ entries: [{ path: "../x", bytes: bytes("x") }] }), "b")).rejects.toThrow(
      "ARCHIVE_PATH_TRAVERSAL",
    );
    await expect(
      run(adapterFor({ entries: [{ path: "x", bytes: bytes("x"), kind: "symlink" }] }), "c"),
    ).rejects.toThrow("ARCHIVE_SYMLINK_DENIED");
    await expect(run(adapterFor({ entries: [{ path: "x", bytes: bytes("123") }] }, 2), "d")).rejects.toThrow(
      "ARCHIVE_EXPANSION_LIMIT_EXCEEDED",
    );
  });
});
