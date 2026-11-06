import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpointScopeId } from "@aiengineer/knowledge-application";
import type {
  CheckpointManifest,
  CheckpointReceipt,
  VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { FilesystemStore } from "../store.js";
import type { ArtifactCustody } from "../store-custody.js";
import { KnowledgeCheckpointHarness, KnowledgeCheckpointHarnessRequestSchema } from "./checkpoints-harness.js";
import { CHECKPOINT_PROFILE_PINS } from "./checkpoints-policy.js";

describe("checkpoint harness behavior", () => {
  it("preserves paired pending work and files, and replays the original receipt before touching changed executor state", async () => {
    const root = await mkdtemp(join(tmpdir(), "ks-harness-behavior-"));
    const tenantId = randomUUID();
    const artifacts = new Map<string, { handle: VerificationArtifactHandle; bytes: Uint8Array }>();
    const manifests = new Map<string, { receipt: CheckpointReceipt; manifest: CheckpointManifest }>();
    const keys = new Map<string, { digest: string; receipt: CheckpointReceipt }>();
    let writes = 0;
    const custody: ArtifactCustody = {
      lookup: async (id) => artifacts.get(id)?.handle,
      resolve: async (id) => artifacts.get(id),
      register: async (handle, bytes) => {
        writes++;
        artifacts.set(handle.artifactId, { handle, bytes });
        return handle;
      },
    };
    const store = new FilesystemStore(root, tenantId);
    await store.init();
    store.attachCustody(custody);
    const service: ConstructorParameters<typeof KnowledgeCheckpointHarness>[0]["service"] = {
      registerScope: async (_tenant, scope) => checkpointScopeId(scope),
      resolveParentScope: async () => undefined,
      head: async () => [...manifests.values()].at(-1)?.receipt,
      read: async (_tenant, request) => ({
        ...manifests.get(request.checkpointId)!,
        ready: false,
        operationOutcomes: [],
        unresolved: [],
      }),
      restore: async () => {
        throw new Error("not used");
      },
      findCommittedByKey: async (_tenant, request) => {
        const prior = keys.get(request.idempotencyKey);
        if (prior && prior.digest !== request.harnessRequestDigest)
          throw new Error("CHECKPOINT_HARNESS_INPUT_CONFLICT");
        return prior?.receipt;
      },
      commit: async (_tenant, request) => {
        const receipt: CheckpointReceipt = {
          checkpointId: randomUUID(),
          scopeId: checkpointScopeId(request.manifest.scope),
          revision: manifests.size + 1,
          mode: request.manifest.mode,
          committedAt: new Date().toISOString(),
          manifestArtifact: request.manifest.executorStateArtifact!,
          harnessRequestDigest: request.harnessRequestDigest,
        };
        manifests.set(receipt.checkpointId, { receipt, manifest: request.manifest });
        keys.set(request.idempotencyKey, { digest: request.harnessRequestDigest, receipt });
        return receipt;
      },
    };
    const harness = new KnowledgeCheckpointHarness({ tenantId, store, custody, service });
    const base = {
      session: { sessionId: "session", sandboxId: "sandbox" },
      scopeContext: { tenantId, runId: "missionless-run", producerAttemptId: "attempt", namespace: "notes" },
      profilePins: CHECKPOINT_PROFILE_PINS,
    };
    const request = (extra: object) => KnowledgeCheckpointHarnessRequestSchema.parse({ ...base, ...extra });
    const execute = async (extra: object) =>
      (await harness.run(request(extra))) as { checkpointId: string; receipt: CheckpointReceipt };
    try {
      const beforeDenied = writes;
      await expect(
        execute({ action: "commit", files: [{ path: "notes/.env", base64: "", digest: "sha256:" + "0".repeat(64) }] }),
      ).rejects.toThrow();
      expect(writes).toBe(beforeDenied);
      await store.writeRun({
        runId: "actual-run",
        createdAt: "2026-09-13T00:00:00.000Z",
        updatedAt: "2026-09-13T00:00:00.000Z",
      });
      const initial = await execute({
        action: "commit",
        idempotencyKey: "original",
        files: [],
        runIds: ["actual-run"],
      });
      const afterCommit = writes;
      await store.writeRun({
        runId: "actual-run",
        createdAt: "2026-09-13T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      });
      const replay = await execute({ action: "commit", idempotencyKey: "original", files: [], runIds: ["actual-run"] });
      expect(replay).toEqual(initial);
      expect(writes).toBe(afterCommit);
      await expect(execute({ action: "commit", idempotencyKey: "original", runIds: ["missing-run"] })).rejects.toThrow(
        "CHECKPOINT_HARNESS_INPUT_CONFLICT",
      );
      expect(writes).toBe(afterCommit);
      const event = {
        eventId: "batch",
        eventType: "actions.requested",
        data: {
          actions: [
            { kind: "tool-call", callId: "one", toolName: "source", input: { query: "one" } },
            { kind: "tool-call", callId: "two", toolName: "source", input: { query: "two" } },
          ],
        },
      };
      const batch = await execute({ action: "observe", expectedHead: initial.checkpointId, event });
      expect(manifests.get(batch.checkpointId)!.manifest.pendingOperations.map((value) => value.operationId)).toEqual([
        "one",
        "two",
      ]);
      const partial = await execute({
        action: "observe",
        expectedHead: batch.checkpointId,
        event: {
          eventId: "partial",
          eventType: "action.partial",
          data: { result: { kind: "tool-result", callId: "one", output: "partial source" } },
        },
      });
      expect(manifests.get(partial.checkpointId)!.manifest.pendingOperations).toEqual(
        manifests.get(batch.checkpointId)!.manifest.pendingOperations,
      );
      const final = await execute({
        action: "observe",
        expectedHead: partial.checkpointId,
        event: {
          eventId: "final",
          eventType: "action.result",
          data: { status: "completed", result: { kind: "tool-result", callId: "one", output: "final source" } },
        },
      });
      expect(manifests.get(final.checkpointId)!.manifest.pendingOperations.map((value) => value.operationId)).toEqual([
        "two",
      ]);
      const afterFinal = writes;
      expect(await execute({ action: "observe", expectedHead: final.checkpointId, event })).toEqual({
        checkpointId: final.checkpointId,
        receipt: batch.receipt,
      });
      expect(writes).toBe(afterFinal);
      expect(manifests.size).toBe(4);
    } finally {
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes("ks-harness-behavior-"))
        throw new Error("TEST_CLEANUP_PATH_DENIED");
      await rm(root, { recursive: true, force: true });
    }
  });
});
