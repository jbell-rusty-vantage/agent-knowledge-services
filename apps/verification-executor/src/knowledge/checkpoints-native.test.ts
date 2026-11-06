import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { CheckpointScope, VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { checkpointScopeId } from "@aiengineer/knowledge-application";
import { FilesystemStore } from "../store.js";
import { validateStoredArtifact, type ArtifactCustody } from "../store-custody.js";
import {
  collectNativeCheckpointReferences,
  unwrapNativeCheckpointOutput,
  type NativeCheckpointEvent,
} from "./checkpoints-native.js";

async function fixture(run: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const value = await setup();
  try {
    await run(value);
  } finally {
    const path = resolve(value.store.rootDir);
    if (!path.startsWith(resolve(tmpdir()) + sep) || !path.includes("ks-checkpoint-native-"))
      throw new Error("TEST_CLEANUP_PATH_DENIED");
    await rm(path, { recursive: true, force: true });
  }
}
async function setup() {
  const scope: CheckpointScope = {
    tenantId: randomUUID(),
    runId: "harness-run",
    producerAttemptId: "attempt",
    sessionId: "session",
    sandboxId: "sandbox",
    namespace: "notes",
  };
  const values = new Map<string, { handle: VerificationArtifactHandle; bytes: Uint8Array }>();
  const custody: ArtifactCustody = {
    async lookup(id) {
      return values.get(id)?.handle;
    },
    async register(handle, bytes) {
      validateStoredArtifact(scope.tenantId, handle, bytes);
      values.set(handle.artifactId, { handle, bytes });
      return handle;
    },
    async resolve(id) {
      return values.get(id);
    },
  };
  const store = new FilesystemStore(await mkdtemp(join(tmpdir(), "ks-checkpoint-native-")), scope.tenantId);
  await store.init();
  store.attachCustody(custody);
  const content = await store.put({
    bytes: new TextEncoder().encode("actual captured source"),
    mediaType: "text/plain",
    producerActivityId: "capture",
    producerVersion: "v1",
  });
  const captureId = randomUUID();
  await store.writeCapture({
    captureId,
    sourceId: randomUUID(),
    requestedUrl: "https://example.com/source",
    finalUrl: "https://example.com/source",
    capturedAt: "2026-09-13T00:00:00.000Z",
    captureMethod: "fixture",
    captureMethodVersion: "v1",
    contentArtifact: content,
    characters: 22,
    sourceKind: "web_page",
    logicalIdentity: "fixture-capture",
  });
  await store.writeRun({
    runId: "actual-verifier-run",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    captureIds: [captureId],
  });
  async function observed(toolName: string, input: Record<string, unknown>, output: unknown) {
    const callId = randomUUID();
    const request = await store.putJson(
      {
        schemaVersion: "checkpoint-observation.v1",
        scope,
        event: {
          eventId: randomUUID(),
          eventType: "actions.requested",
          data: { actions: [{ kind: "tool-call", callId, toolName, input }] },
        },
      },
      {
        mediaType: "application/vnd.aiengineer.checkpoint-observation+json",
        producerActivityId: `knowledge:checkpoint-observation:${checkpointScopeId(scope)}`,
        producerVersion: "checkpoint-observation.v1",
      },
    );
    const event: NativeCheckpointEvent = {
      eventId: randomUUID(),
      eventType: "action.result",
      data: { status: "completed", result: { kind: "tool-result", callId, toolName, output } },
    };
    return { scope, store, custody, previousRequiredArtifacts: [request.handle], event };
  }
  return { scope, store, custody, content, captureId, observed };
}
const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

describe("native checkpoint references", () => {
  it("retains the actual capture and request-bound verifier run through the native MCP envelope", async () =>
    fixture(async (value) => {
      const input = await value.observed(
        "verification__verify_capture_source",
        { runId: "actual-verifier-run" },
        mcp({
          captureId: value.captureId,
          contentArtifact: {
            artifactId: value.content.artifactId,
            digest: value.content.digest,
            byteLength: value.content.byteLength,
          },
        }),
      );
      const refs = await collectNativeCheckpointReferences(input);
      expect(refs).toEqual({
        runIds: ["actual-verifier-run"],
        captureIds: [value.captureId],
        requiredArtifacts: [value.content],
      });
    }));
  it("ignores arbitrary tools and nested research IDs instead of recursively interpreting them", async () =>
    fixture(async (value) => {
      const input = await value.observed(
        "provider__untrusted_search",
        {},
        mcp({
          runId: "actual-verifier-run",
          captureId: value.captureId,
          nested: { artifactId: value.content.artifactId },
        }),
      );
      expect(await collectNativeCheckpointReferences(input)).toEqual({
        runIds: [],
        captureIds: [],
        requiredArtifacts: [],
      });
    }));
  it("rejects a known tool result without its immutable matching dispatched action", async () =>
    fixture(async (value) => {
      const input = await value.observed(
        "verification__verify_capture_source",
        {},
        mcp({ captureId: value.captureId }),
      );
      await expect(collectNativeCheckpointReferences({ ...input, previousRequiredArtifacts: [] })).rejects.toThrow(
        "CHECKPOINT_NATIVE_ACTION_UNPAIRED",
      );
    }));
  it("rejects wrong capture identities and mismatched artifact digests", async () =>
    fixture(async (value) => {
      const output = {
        captureId: value.captureId,
        contentArtifact: {
          artifactId: value.content.artifactId,
          digest: value.content.digest,
          byteLength: value.content.byteLength,
        },
      };
      await expect(
        collectNativeCheckpointReferences(
          await value.observed("verification__verify_capture_source", { captureId: randomUUID() }, mcp(output)),
        ),
      ).rejects.toThrow("CHECKPOINT_NATIVE_CAPTURE_MISMATCH");
      await expect(
        collectNativeCheckpointReferences(
          await value.observed(
            "verification__verify_capture_source",
            {},
            mcp({ ...output, contentArtifact: { ...output.contentArtifact, byteLength: 1 } }),
          ),
        ),
      ).rejects.toThrow("CHECKPOINT_NATIVE_ARTIFACT_MISMATCH");
    }));
  it("captures local register_workspace_artifact output without inventing an absent run", async () =>
    fixture(async (value) => {
      const input = await value.observed(
        "register_workspace_artifact",
        { runId: "not-started", path: "/workspace/run/notes/report.md" },
        {
          artifactId: value.content.artifactId,
          digest: value.content.digest,
          byteLength: value.content.byteLength,
          mediaType: "text/plain",
          path: "/workspace/run/notes/report.md",
        },
      );
      expect(await collectNativeCheckpointReferences(input)).toEqual({
        runIds: [],
        captureIds: [],
        requiredArtifacts: [value.content],
      });
    }));
  it("does not treat MCP errors as success", async () =>
    fixture(async (value) => {
      const failed = await value.observed(
        "verification__verify_capture_source",
        { runId: "actual-verifier-run" },
        { isError: true, ...mcp({ artifactId: randomUUID() }) },
      );
      expect((await collectNativeCheckpointReferences(failed)).requiredArtifacts).toEqual([]);
    }));
  it("accepts only one JSON text block or structured MCP output", () => {
    expect(unwrapNativeCheckpointOutput({ structuredContent: { x: 1 } })).toEqual({ x: 1 });
    expect(() =>
      unwrapNativeCheckpointOutput({
        content: [
          { type: "text", text: "{}" },
          { type: "text", text: "{}" },
        ],
      }),
    ).toThrow();
  });
  it("ignores the retired verification-chain tools (SV-17): their outputs are never custody", async () =>
    fixture(async (value) => {
      for (const tool of [
        "verification__verify_claims",
        "verification__verify_seal_run",
        "verification__verify_run_status",
      ])
        expect(
          await collectNativeCheckpointReferences(
            await value.observed(
              tool,
              { runId: "actual-verifier-run" },
              mcp({ runId: "actual-verifier-run", resultArtifactId: value.content.artifactId }),
            ),
          ),
        ).toEqual({ runIds: [], captureIds: [], requiredArtifacts: [] });
    }));
  it("retains typed source selection handles and rejects another attempt's receipt", async () =>
    fixture(async (value) => {
      const attemptId = randomUUID();
      const output = { attemptId, selectionArtifact: value.content, decisionCount: 1, revision: 1 };
      const refs = await collectNativeCheckpointReferences(
        await value.observed("knowledge-executor__source_select", { request: { attemptId } }, mcp(output)),
      );
      expect(refs).toEqual({ runIds: [], captureIds: [], requiredArtifacts: [value.content] });
      await expect(
        collectNativeCheckpointReferences(
          await value.observed(
            "knowledge-executor__source_select",
            { request: { attemptId: randomUUID() } },
            mcp(output),
          ),
        ),
      ).rejects.toThrow("CHECKPOINT_NATIVE_SOURCE_ATTEMPT_MISMATCH");
    }));
});
