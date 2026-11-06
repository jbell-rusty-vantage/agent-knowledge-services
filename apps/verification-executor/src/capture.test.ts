import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureFile, CAPTURE_METHOD_VERSION } from "./capture.js";
import { FilesystemStore } from "./store.js";
import { artifactDestination } from "./store-custody-profile.js";

describe("capture acquisition identity", () => {
  it("separates equal-byte acquisitions and original HTML artifacts while preserving immutable retries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ks-capture-identity-"));
    const store = new FilesystemStore(directory, randomUUID());
    await store.init();
    try {
      const input = {
        bytes: new TextEncoder().encode("<h1>Preserved fact</h1>"),
        filename: "source.html",
        sourceUri: "https://synthetic.invalid/source",
      };
      const first = await captureFile(store, input);
      const repeated = await captureFile(store, input);
      expect(repeated.reused).toBe(true);
      expect(repeated.record).toEqual(first.record);
      const fresh = await captureFile(store, { ...input, captureId: "new-acquisition" });
      const otherSource = await captureFile(store, { ...input, sourceUri: "https://synthetic.invalid/other" });
      for (const next of [fresh, otherSource]) {
        expect(next.record.contentArtifact.digest).toBe(first.record.contentArtifact.digest);
        expect(next.record.contentArtifact.artifactId).not.toBe(first.record.contentArtifact.artifactId);
        expect(next.record.originalArtifact!.digest).toBe(first.record.originalArtifact!.digest);
        expect(next.record.originalArtifact!.artifactId).not.toBe(first.record.originalArtifact!.artifactId);
        for (const handle of [next.record.contentArtifact, next.record.originalArtifact!])
          expect(artifactDestination(handle).artifactType).toBe("source_capture");
      }
      await expect(
        captureFile(store, {
          ...input,
          captureId: first.record.captureId,
          sourceUri: "https://synthetic.invalid/other",
        }),
      ).rejects.toThrow("CAPTURE_ID_CONFLICT");
      await expect(
        captureFile(store, {
          ...input,
          captureId: first.record.captureId,
          bytes: new TextEncoder().encode("<h1>Changed fact</h1>"),
        }),
      ).rejects.toThrow("CAPTURE_ID_CONFLICT");
      await expect(
        captureFile(store, {
          ...input,
          captureId: first.record.captureId,
          bytes: new TextEncoder().encode("<h1 >Preserved fact</h1>"),
        }),
      ).rejects.toThrow("CAPTURE_ID_CONFLICT");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns legacy captures with their original artifacts and timestamp without registering replacement objects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ks-capture-legacy-"));
    const store = new FilesystemStore(directory, randomUUID());
    await store.init();
    try {
      const bytes = new TextEncoder().encode("Legacy preserved fact"),
        capturedAt = "2026-01-01T00:00:00.000Z";
      const contentArtifact = await store.put({
        bytes,
        mediaType: "text/markdown; charset=utf-8",
        producerActivityId: "verification-executor:capture",
        producerVersion: CAPTURE_METHOD_VERSION,
        createdAt: capturedAt,
      });
      const legacy = {
        captureId: "legacy",
        sourceId: "legacy-source",
        requestedUrl: "https://synthetic.invalid/legacy",
        finalUrl: "https://synthetic.invalid/legacy",
        capturedAt,
        captureMethod: "file_text",
        captureMethodVersion: CAPTURE_METHOD_VERSION,
        contentArtifact,
        characters: bytes.length,
        sourceKind: "other" as const,
        logicalIdentity: "https://synthetic.invalid/legacy",
      };
      await store.writeCapture(legacy);
      const before = await readdir(join(directory, "artifacts"));
      expect(
        await captureFile(store, {
          bytes,
          filename: "source.txt",
          sourceUri: legacy.requestedUrl,
          captureId: "legacy",
        }),
      ).toEqual({ record: legacy, content: "Legacy preserved fact", reused: true });
      expect(await readdir(join(directory, "artifacts"))).toEqual(before);
      expect(artifactDestination(contentArtifact).artifactType).toBe("source_capture");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
