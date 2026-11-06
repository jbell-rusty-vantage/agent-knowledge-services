import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestBytes, InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import { BoundedManualUploadAdapter } from "./adapter.js";
import { FilesystemManualUploadSource } from "./filesystem-source.js";

describe("FilesystemManualUploadSource", () => {
  it("loads attested bytes from the upload root and rejects traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "acquisition-upload-"));
    try {
      const bytes = new TextEncoder().encode("operator file");
      await writeFile(join(root, "notes"), bytes);
      await writeFile(
        join(root, "notes.json"),
        JSON.stringify({
          relativePath: "notes.txt",
          mediaType: "text/plain",
          declaredDigest: digestBytes(bytes),
          attestation: {
            uploadId: "notes",
            origin: "operator",
            method: "local file",
            acquiredAt: "2026-09-16T00:00:00Z",
            accessAndRightsContext: "operator supplied",
            automaticFailureReason: "",
          },
        }),
      );
      const adapter = new BoundedManualUploadAdapter(
        new InMemoryArtifactStore(),
        new FilesystemManualUploadSource(root),
        { maximumBytes: 100, maximumPathLength: 80 },
      );
      const plan = await adapter.plan({
        tenantId: "tenant",
        purpose: "capture",
        target: { kind: "upload", uploadId: "notes", declaredOrigin: "operator" },
        expectedSourceClass: "other",
        preferredMediaTypes: ["text/plain"],
        egressProfile: "public-web",
        maximumBytes: 100,
        renderingPolicy: "none",
        interactionPolicy: "none",
        classification: "public",
        expectedOutputs: ["source_native"],
      });
      const result = await adapter.execute({ ...plan, admissionId: "fs" });
      expect(result.artifacts).toHaveLength(1);
      expect((await adapter.verify(result)).accepted).toBe(true);
      expect(await new FilesystemManualUploadSource(root).get("../notes")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
