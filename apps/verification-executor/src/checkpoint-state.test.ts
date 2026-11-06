import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { FilesystemStore } from "./store.js";
import { validateStoredArtifact, type ArtifactCustody } from "./store-custody.js";
import { exportExecutorCheckpointState, restoreExecutorCheckpointState } from "./checkpoint-state.js";
import { beginExecutorStateMutation } from "./checkpoint-state-fence.js";

describe("executor state checkpoint capsule", () => {
  it("restores exact run, capture and step indexes after removing the producer and refuses missing dependencies", async () => {
    const tenantId = randomUUID(),
      scopeId = randomUUID();
    const root = await mkdtemp(join(tmpdir(), "ks-checkpoint-state-"));
    const handles = new Map<string, VerificationArtifactHandle>();
    const blobs = new Map<string, Uint8Array>();
    const custody: ArtifactCustody = {
      async lookup(id) {
        return handles.get(id);
      },
      async register(handle, bytes) {
        validateStoredArtifact(tenantId, handle, bytes);
        handles.set(handle.artifactId, structuredClone(handle));
        blobs.set(handle.digest, Uint8Array.from(bytes));
        return handle;
      },
      async resolve(id) {
        const handle = handles.get(id),
          bytes = handle && blobs.get(handle.digest);
        return handle && bytes ? { handle, bytes } : undefined;
      },
    };
    const create = async (name: string) => {
      const store = new FilesystemStore(join(root, name), tenantId);
      await store.init();
      store.attachCustody(custody);
      return store;
    };
    try {
      const producer = await create("producer");
      const content = await producer.put({
        bytes: new TextEncoder().encode("captured source"),
        mediaType: "text/plain",
        producerActivityId: "capture",
        producerVersion: "v1",
      });
      const capture = {
        captureId: randomUUID(),
        sourceId: randomUUID(),
        requestedUrl: "https://example.org/a",
        finalUrl: "https://example.org/b",
        capturedAt: "2026-09-13T00:00:00.000Z",
        captureMethod: "synthetic",
        captureMethodVersion: "v1",
        contentArtifact: content,
        characters: 15,
        sourceKind: "web_page" as const,
        logicalIdentity: "synthetic-source",
      };
      await producer.writeCapture(capture);
      const runId = "run-1";
      await producer.writeRun({
        runId,
        createdAt: capture.capturedAt,
        updatedAt: capture.capturedAt,
        captureIds: [capture.captureId],
      });
      await producer.appendStep({
        runId,
        operation: "capture_source",
        startedAt: capture.capturedAt,
        completedAt: capture.capturedAt,
        status: "succeeded",
        input: {},
        output: { captureId: capture.captureId, artifactId: content.artifactId },
      });
      const originalRun = await producer.readRun(runId),
        originalSteps = await producer.listSteps(runId);
      const releaseMutation = beginExecutorStateMutation(producer, runId);
      await expect(
        exportExecutorCheckpointState(producer, { scopeId, runIds: [runId], captureIds: [] }),
      ).rejects.toThrow("CHECKPOINT_EXECUTOR_STATE_BUSY");
      releaseMutation();
      const exported = await exportExecutorCheckpointState(producer, { scopeId, runIds: [runId], captureIds: [] });
      expect(exported.requiredArtifacts).toEqual([content]);
      const producerPath = resolve(producer.rootDir);
      if (!producerPath.startsWith(resolve(root) + sep)) throw new Error("TEST_CLEANUP_PATH_DENIED");
      await rm(producerPath, { recursive: true });
      const consumer = await create("consumer");
      await expect(
        restoreExecutorCheckpointState(consumer, custody, { scopeId: randomUUID(), artifact: exported.artifact }),
      ).rejects.toThrow("CHECKPOINT_EXECUTOR_SCOPE_MISMATCH");
      await restoreExecutorCheckpointState(consumer, custody, { scopeId, artifact: exported.artifact });
      expect(await consumer.readRun(runId)).toEqual(originalRun);
      expect(await consumer.listSteps(runId)).toEqual(originalSteps);
      expect(await consumer.readCapture(capture.captureId)).toEqual(capture);
      await restoreExecutorCheckpointState(consumer, custody, { scopeId, artifact: exported.artifact });
      await writeFile(join(consumer.rootDir, "captures", "unexpected.json"), "{}");
      await restoreExecutorCheckpointState(consumer, custody, { scopeId, artifact: exported.artifact });
      await writeFile(join(consumer.runDir(runId), "unexpected.json"), "{}");
      await expect(
        restoreExecutorCheckpointState(consumer, custody, { scopeId, artifact: exported.artifact }),
      ).rejects.toThrow("CHECKPOINT_RESTORE_NAMESPACE_NOT_CLEAN");
      blobs.delete(content.digest);
      await expect(
        restoreExecutorCheckpointState(await create("missing"), custody, { scopeId, artifact: exported.artifact }),
      ).rejects.toThrow("CHECKPOINT_EXECUTOR_DEPENDENCY_UNAVAILABLE");
    } finally {
      const cleanup = resolve(root);
      if (!cleanup.startsWith(resolve(tmpdir()) + sep) || !cleanup.includes("ks-checkpoint-state-"))
        throw new Error("TEST_CLEANUP_PATH_DENIED");
      await rm(cleanup, { recursive: true, force: true });
    }
  });
});
