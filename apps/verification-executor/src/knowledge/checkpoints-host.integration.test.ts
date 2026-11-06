import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckpointReceiptSchema, SourceDiscoveryAttemptReadSchema } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-verification";
import { disposableDatabaseUrl, disposableStorageConfig } from "../../../../packages/persistence/test/disposable.mjs";
import { VerificationExecutor, loadExecutorConfig } from "../executor.js";
import { createKnowledgeServices, defaultUseClassesFile, type KnowledgeServices } from "./context.js";
import { knowledgeOperations } from "./operations.js";
import { CHECKPOINT_PROFILE_PINS } from "./checkpoints-policy.js";

const databaseUrl = disposableDatabaseUrl(),
  storage = disposableStorageConfig();
describe.skipIf(!databaseUrl || !storage)("native checkpoint integration with canonical custody", () => {
  it("imports self-reported native discovery and restores request-bound verifier indexes after deleting the producer store", async () => {
    const root = await mkdtemp(join(tmpdir(), "ks-checkpoint-public-")),
      tenantId = randomUUID();
    const base = {
      session: { sessionId: randomUUID(), sandboxId: randomUUID() },
      scopeContext: {
        tenantId,
        runId: "research-run",
        producerAttemptId: randomUUID(),
        namespace: "notes",
      },
      profilePins: CHECKPOINT_PROFILE_PINS,
    };
    const create = async (directory: string) => {
      const verification = await VerificationExecutor.create(
        loadExecutorConfig({ VERIFY_STORE_DIR: directory, VERIFY_TENANT_ID: tenantId }),
      );
      const knowledge = createKnowledgeServices(
        {
          databaseUrl: databaseUrl!,
          storage: storage!,
          workspaceDir: resolve(import.meta.dirname, "../../../../../../aiengineer/ai-engineer-db-contract/workspace"),
          artifactDir: join(directory, "ledger"),
          defaultTenantId: tenantId,
          allowStale: false,
          useClassesFile: defaultUseClassesFile(),
        },
        { verification },
      );
      return { verification, knowledge };
    };
    let services: KnowledgeServices | undefined;
    let head: string | null = null;
    const invoke = async (request: object) =>
      (await knowledgeOperations.invoke("checkpoint_harness", { request: { ...base, ...request } }, services!)).output;
    const commit = async (request: object) => {
      const result = (await invoke({ expectedHead: head, ...request })) as { receipt: unknown };
      const receipt = CheckpointReceiptSchema.parse(result.receipt);
      head = receipt.checkpointId;
      return receipt;
    };
    const observe = (eventType: string, data: unknown, eventId = randomUUID()) =>
      commit({ action: "observe", event: { eventId, eventType, data } });
    const action = (callId: string, toolName: string, input: object) => ({
      kind: "tool-call",
      callId,
      toolName,
      input,
    });
    const output = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
    try {
      const producer = await create(join(root, "producer"));
      services = producer.knowledge;
      const handoff = Buffer.from("Partial source review. Continue checking the captured text and outstanding gaps.");
      await commit({
        action: "commit",
        idempotencyKey: "initial",
        files: [{ path: "handoff.md", base64: handoff.toString("base64"), digest: sha256Digest(handoff) }],
      });
      const sourceCall = randomUUID(),
        toolName = "tavily__tavily_search";
      await observe("actions.requested", {
        actions: [action(sourceCall, toolName, { query: "fixture official source" })],
      });
      const terminalEvent = randomUUID();
      const terminal = {
        status: "completed",
        result: {
          kind: "tool-result",
          callId: sourceCall,
          toolName,
          output: output({
            results: [
              {
                url: "https://example.com/start",
                finalUrl: "https://example.com/final",
                redirectUrls: ["https://example.com/final"],
                title: "Fixture",
                content: "Source output",
              },
            ],
          }),
        },
      };
      const importedCheckpoint = await observe("action.result", terminal, terminalEvent);
      const rows = await services.db.transaction({ tenantId, role: "executor_service", readOnly: true }, (client) =>
        client.query("select id from evidence.source_provider_attempt where tenant_id=$1", [tenantId]),
      );
      expect(rows.rows).toHaveLength(1);
      const attemptId = String(rows.rows[0]!.id);
      const read = SourceDiscoveryAttemptReadSchema.parse(
        (await knowledgeOperations.invoke("source_attempt", { attemptId }, services)).output,
      );
      expect(read.attempt).toMatchObject({
        trust: "self_reported",
        origin: "imported",
        state: "succeeded",
        accountingCompleteness: "partial",
        resultCount: 1,
      });
      expect(read.results[0]).toMatchObject({
        requestedUrl: "https://example.com/start",
        finalUrl: "https://example.com/final",
      });
      const failedCall = randomUUID();
      await observe("actions.requested", {
        actions: [action(failedCall, toolName, { query: "fixture explicit failure" })],
      });
      await observe("action.result", {
        status: "completed",
        result: {
          kind: "tool-result",
          callId: failedCall,
          toolName,
          output: { ...output({ error: "synthetic provider failure" }), isError: true },
        },
      });
      const failedRows = await services.db.transaction(
        { tenantId, role: "executor_service", readOnly: true },
        (client) =>
          client.query("select id from evidence.source_provider_attempt where tenant_id=$1 and id<>$2", [
            tenantId,
            attemptId,
          ]),
      );
      expect(failedRows.rows).toHaveLength(1);
      const failedRead = SourceDiscoveryAttemptReadSchema.parse(
        (await knowledgeOperations.invoke("source_attempt", { attemptId: failedRows.rows[0]!.id }, services)).output,
      );
      expect(failedRead.attempt).toMatchObject({
        state: "failed",
        failureCode: "EXTERNAL_TOOL_FAILED",
        resultCount: 0,
        trust: "self_reported",
      });
      const captureCall = randomUUID(),
        verifierRun = "native-verifier-run",
        captureTool = "verification__verify_capture_file";
      await observe("actions.requested", { actions: [action(captureCall, captureTool, { runId: verifierRun })] });
      const captured = await producer.verification.captureFile({
        bytes: Buffer.from("Actual fixture capture bytes"),
        filename: "fixture.txt",
        sourceUri: "https://example.com/final",
        runId: verifierRun,
      });
      await observe("action.result", {
        status: "completed",
        result: { kind: "tool-result", callId: captureCall, toolName: captureTool, output: output(captured) },
      });
      const nextCaptureCall = randomUUID();
      await observe("actions.requested", { actions: [action(nextCaptureCall, captureTool, { runId: verifierRun })] });
      const nextCapture = await producer.verification.captureFile({
        bytes: Buffer.from("More actual capture bytes"),
        filename: "local.txt",
        sourceUri: "/workspace/run/local.txt",
        runId: verifierRun,
      });
      const advancedRun = await producer.verification.store.readRun(verifierRun);
      expect(await invoke({ action: "restore" })).toMatchObject({ ready: false });
      expect(await producer.verification.store.readRun(verifierRun)).toEqual(advancedRun);
      await observe("action.result", {
        status: "completed",
        result: { kind: "tool-result", callId: nextCaptureCall, toolName: captureTool, output: output(nextCapture) },
      });
      const expectedRun = await producer.verification.store.readRun(verifierRun),
        expectedSteps = await producer.verification.store.listSteps(verifierRun);
      const replay = (await invoke({
        action: "observe",
        expectedHead: head,
        event: { eventId: terminalEvent, eventType: "action.result", data: terminal },
      })) as { checkpointId: string; receipt: unknown };
      expect(replay).toEqual({ checkpointId: head, receipt: importedCheckpoint });
      head = replay.checkpointId;
      await commit({
        action: "commit",
        idempotencyKey: "after-replayed-event",
        files: [{ path: "handoff.md", base64: handoff.toString("base64"), digest: sha256Digest(handoff) }],
      });
      const savedHead = head;
      const actualHead = (await invoke({ action: "restore" })) as { checkpointId: string; ready: boolean };
      expect(actualHead).toMatchObject({ checkpointId: savedHead, ready: true });
      await services.close();
      services = undefined;
      const producerPath = resolve(root, "producer");
      if (!producerPath.startsWith(resolve(root) + sep)) throw new Error("TEST_CLEANUP_PATH_DENIED");
      await rm(producerPath, { recursive: true });
      const restored = await create(join(root, "restored"));
      services = restored.knowledge;
      expect(await invoke({ action: "restore" })).toMatchObject({ checkpointId: savedHead, ready: true });
      expect(await restored.verification.store.readRun(verifierRun)).toEqual(expectedRun);
      expect(await restored.verification.store.listSteps(verifierRun)).toEqual(expectedSteps);
      const after = SourceDiscoveryAttemptReadSchema.parse(
        (await knowledgeOperations.invoke("source_attempt", { attemptId }, services)).output,
      );
      expect(after).toEqual(read);
    } finally {
      await services?.close();
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes("ks-checkpoint-public-"))
        throw new Error("TEST_CLEANUP_PATH_DENIED");
      await rm(root, { recursive: true, force: true });
    }
  }, 120000);
});
