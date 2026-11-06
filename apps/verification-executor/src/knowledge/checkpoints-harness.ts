import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  CheckpointSemanticHandoffSchema,
  CheckpointScopeSchema,
  type CheckpointManifest,
  type CheckpointProfilePins,
  type CheckpointRestoreResult,
  type CheckpointReceipt,
  type CheckpointScope,
} from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import {
  exportExecutorCheckpointState,
  restoreExecutorCheckpointState,
  validateExecutorCheckpointState,
} from "../checkpoint-state.js";
import { assertSameArtifact, type ArtifactCustody } from "../store-custody.js";
import type { FilesystemStore } from "../store.js";
import { CHECKPOINT_POLICY } from "./checkpoints-policy.js";
import { assertCheckpointPath, type SourceDiscoveryApplicationService } from "@aiengineer/knowledge-application";
import { collectNativeCheckpointReferences } from "./checkpoints-native.js";
import { importNativeCheckpointSource } from "./checkpoints-source-import.js";
import { checkpointRequestedOperations, checkpointTerminalOutcome } from "./checkpoints-events.js";

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const File = z.strictObject({ path: z.string().min(1).max(1024), base64: z.string(), digest: Digest });
const Session = z.strictObject({
  sessionId: z.string().min(1),
  sandboxId: z.string().min(1),
  parentSessionId: z.string().min(1).optional(),
  childId: z.string().min(1).optional(),
});
const ScopeContext = z.strictObject({
  tenantId: z.uuid(),
  runId: z.string().min(1),
  producerAttemptId: z.string().min(1),
  namespace: z.string().min(1),
});
const ObservedEventType = z.enum([
  "actions.requested",
  "action.partial",
  "action.result",
  "subagent.called",
  "subagent.completed",
]);
export const KnowledgeCheckpointHarnessRequestSchema = z.strictObject({
  action: z.enum(["restore", "commit", "observe"]),
  session: Session,
  scopeContext: ScopeContext,
  profilePins: z.object({
    storageProfileVersion: z.string(),
    storageProfileDigest: Digest,
    retentionPolicyVersion: z.string(),
    retentionPolicyDigest: Digest,
    capabilityProfileVersion: z.string(),
    capabilityProfileDigest: Digest,
  }),
  expectedHead: z.uuid().nullable().optional(),
  idempotencyKey: z.string().min(1).optional(),
  boundary: z
    .enum([
      "dirty_interval",
      "source",
      "verification",
      "ingestion",
      "report",
      "publication",
      "transfer",
      "failure",
      "cancellation",
      "completion",
      "manual",
    ])
    .optional(),
  files: z.array(File).max(2000).default([]),
  runIds: z.array(z.string().min(1)).max(128).default([]),
  captureIds: z.array(z.string().min(1)).max(2048).default([]),
  event: z
    .strictObject({
      eventId: z.string().min(1),
      eventType: z.string().min(1),
      turnId: z.string().min(1).optional(),
      data: z.unknown(),
    })
    .optional(),
});
export type KnowledgeCheckpointHarnessRequest = z.infer<typeof KnowledgeCheckpointHarnessRequestSchema>;
type CheckpointHarnessService = {
  registerScope(tenantId: string, scope: CheckpointScope): Promise<string>;
  resolveParentScope(
    tenantId: string,
    input: { runId: string; producerAttemptId: string; sessionId: string },
  ): Promise<string | undefined>;
  restore(
    tenantId: string,
    request: { checkpointId: string; expectedScope: CheckpointScope; expectedProfilePins: CheckpointProfilePins },
  ): Promise<CheckpointRestoreResult>;
  read(
    tenantId: string,
    request: { checkpointId: string; expectedScope: CheckpointScope; expectedProfilePins: CheckpointProfilePins },
  ): Promise<CheckpointRestoreResult>;
  head(tenantId: string, scope: CheckpointScope): Promise<CheckpointReceipt | undefined>;
  findCommittedByKey(
    tenantId: string,
    input: { scope: CheckpointScope; idempotencyKey: string; harnessRequestDigest: `sha256:${string}` },
  ): Promise<CheckpointReceipt | undefined>;
  commit(
    tenantId: string,
    request: {
      idempotencyKey: string;
      expectedHead: string | null;
      manifest: CheckpointManifest;
      harnessRequestDigest: `sha256:${string}`;
    },
  ): Promise<CheckpointReceipt>;
};

function scopeFor(input: KnowledgeCheckpointHarnessRequest, parentScopeId?: string) {
  return CheckpointScopeSchema.parse({
    tenantId: input.scopeContext.tenantId,
    runId: input.scopeContext.runId,
    producerAttemptId: input.scopeContext.producerAttemptId,
    sessionId: input.session.sessionId,
    sandboxId: input.session.sandboxId,
    namespace: input.scopeContext.namespace,
    ...(input.session.childId ? { childId: input.session.childId, parentScopeId } : {}),
  });
}
function bytes(file: z.infer<typeof File>) {
  const value = new Uint8Array(Buffer.from(file.base64, "base64"));
  if (sha256Digest(value) !== file.digest) throw new Error("CHECKPOINT_FILE_DIGEST_MISMATCH");
  return value;
}

/** Executor-only adapter: it serializes explicit workspace bytes and real verifier state; it never interprets agent messages. */
export class KnowledgeCheckpointHarness {
  constructor(
    private readonly input: {
      tenantId: string;
      service: CheckpointHarnessService;
      store: FilesystemStore;
      custody: ArtifactCustody;
      sourceDiscovery?: SourceDiscoveryApplicationService;
    },
  ) {}
  async run(proposed: KnowledgeCheckpointHarnessRequest): Promise<unknown> {
    const request = KnowledgeCheckpointHarnessRequestSchema.parse(structuredClone(proposed));
    if (
      request.scopeContext.tenantId !== this.input.tenantId ||
      canonicalizeJson(request.profilePins) !== canonicalizeJson(CHECKPOINT_POLICY.profilePins)
    )
      throw new Error("CHECKPOINT_HARNESS_BINDING");
    const parentScopeId =
      request.session.childId && request.session.parentSessionId
        ? await this.input.service.resolveParentScope(this.input.tenantId, {
            runId: request.scopeContext.runId,
            producerAttemptId: request.scopeContext.producerAttemptId,
            sessionId: request.session.parentSessionId,
          })
        : undefined;
    if (request.session.childId && !parentScopeId) throw new Error("CHECKPOINT_PARENT_SCOPE_REQUIRED");
    const scope = scopeFor(request, parentScopeId);
    const scopeId = await this.input.service.registerScope(this.input.tenantId, scope);
    if (request.action === "restore") {
      const head = await this.input.service.head(this.input.tenantId, scope);
      if (!head) return { checkpointId: null, files: [], ready: true, unresolved: [] };
      const restored = await this.input.service.restore(this.input.tenantId, {
        checkpointId: head.checkpointId,
        expectedScope: scope,
        expectedProfilePins: request.profilePins as CheckpointProfilePins,
      });
      if (restored.manifest.executorStateArtifact) {
        try {
          await restoreExecutorCheckpointState(this.input.store, this.input.custody, {
            scopeId,
            artifact: restored.manifest.executorStateArtifact,
          });
        } catch (error) {
          // An incoming settlement may observe a live owner that advanced after the pending checkpoint.
          // Preserve that namespace while readiness is blocked; never overwrite it with older indexes.
          if (restored.ready || !(error instanceof Error) || error.message !== "CHECKPOINT_RESTORE_NAMESPACE_NOT_CLEAN")
            throw error;
        }
      }
      const files = await Promise.all(
        restored.manifest.files.map(async (file) => {
          const value = await this.input.custody.resolve(file.artifact.artifactId);
          if (!value) throw new Error("CHECKPOINT_FILE_UNAVAILABLE");
          return { path: file.path, base64: Buffer.from(value.bytes).toString("base64"), digest: value.handle.digest };
        }),
      );
      return {
        checkpointId: restored.receipt.checkpointId,
        files,
        ready: restored.ready,
        unresolved: restored.unresolved.map((operation) => `${operation.owner}:${operation.operationId}`),
      };
    }
    const idempotencyKey =
      request.action === "observe" && request.event
        ? `checkpoint-event:${request.event.eventId}`
        : (request.idempotencyKey ?? `checkpoint:${sha256Digest(canonicalizeJson(request)).slice(7)}`);
    const harnessRequestDigest = sha256Digest(
      canonicalizeJson(
        request.action === "observe"
          ? { action: request.action, scope, profilePins: request.profilePins, event: request.event }
          : { ...request, expectedHead: request.expectedHead ?? null },
      ),
    );
    const priorReceipt = await this.input.service.findCommittedByKey(this.input.tenantId, {
      scope,
      idempotencyKey,
      harnessRequestDigest,
    });
    if (priorReceipt) {
      const adoption =
        request.action === "observe" ? await this.input.service.head(this.input.tenantId, scope) : priorReceipt;
      if (!adoption) throw new Error("CHECKPOINT_HEAD_UNAVAILABLE");
      return { checkpointId: adoption.checkpointId, receipt: priorReceipt };
    }
    let total = 0;
    for (const file of request.files) {
      assertCheckpointPath(file.path, CHECKPOINT_POLICY.allowedRoots);
      total += bytes(file).byteLength;
    }
    if (total > CHECKPOINT_POLICY.maximumBytes) throw new Error("CHECKPOINT_BYTE_LIMIT");
    const previous = request.expectedHead
      ? await this.input.service.read(this.input.tenantId, {
          checkpointId: request.expectedHead,
          expectedScope: scope,
          expectedProfilePins: request.profilePins as CheckpointProfilePins,
        })
      : undefined;
    const files = await Promise.all(
      request.files.map(async (file) => {
        const value = bytes(file);
        const artifact = await this.input.store.put({
          bytes: value,
          mediaType: "application/octet-stream",
          producerActivityId: `checkpoint:${scopeId}:file`,
          producerVersion: "checkpoint-harness.v1",
          dataClassification: "internal",
        });
        if (artifact.digest !== file.digest) throw new Error("CHECKPOINT_FILE_REGISTRATION_MISMATCH");
        return { path: file.path, artifact };
      }),
    );
    const native = await collectNativeCheckpointReferences({
      scope,
      store: this.input.store,
      custody: this.input.custody,
      previousRequiredArtifacts: previous?.manifest.requiredArtifacts ?? [],
      ...(request.event ? { event: request.event } : {}),
    });
    const priorState = previous?.manifest.executorStateArtifact
      ? await validateExecutorCheckpointState(this.input.custody, {
          tenantId: this.input.tenantId,
          scopeId,
          artifact: previous.manifest.executorStateArtifact,
        })
      : undefined;
    const state = await exportExecutorCheckpointState(this.input.store, {
      scopeId,
      runIds: [
        ...new Set([...request.runIds, ...native.runIds, ...(priorState?.runs.map((run) => run.state.runId) ?? [])]),
      ],
      captureIds: [
        ...new Set([
          ...request.captureIds,
          ...native.captureIds,
          ...(priorState?.captures.map((capture) => capture.captureId) ?? []),
        ]),
      ],
    });
    const pendingOperations = [
      ...(previous?.manifest.pendingOperations ?? []),
    ] as CheckpointManifest["pendingOperations"];
    const requiredArtifacts = [
      ...(previous?.manifest.requiredArtifacts ?? []),
      ...state.requiredArtifacts,
      ...native.requiredArtifacts,
    ];
    if (request.action === "observe") {
      if (!request.event) throw new Error("CHECKPOINT_EVENT_REQUIRED");
      const eventType = ObservedEventType.parse(request.event.eventType);
      const data = z
        .object({
          result: z
            .object({ callId: z.string().min(1), kind: z.string(), toolName: z.string().min(1).optional() })
            .optional(),
        })
        .passthrough()
        .parse(request.event.data);
      let operation: CheckpointManifest["pendingOperations"][number] | undefined;
      if (eventType === "actions.requested") {
        for (const requested of checkpointRequestedOperations(request.event.data)) {
          const existing = pendingOperations.find(
            (value) => value.owner === requested.owner && value.operationId === requested.operationId,
          );
          if (existing && existing.requestDigest !== requested.requestDigest)
            throw new Error("CHECKPOINT_OPERATION_BINDING");
          if (!existing) pendingOperations.push(requested);
        }
        operation = pendingOperations[pendingOperations.length - 1];
      } else if (eventType === "action.partial" || eventType === "action.result") {
        if (!data.result?.callId) throw new Error("CHECKPOINT_EVENT_RESULT_BINDING");
        const callId = data.result.callId;
        const prior = pendingOperations.find((item) => item.owner === "external_tool" && item.operationId === callId);
        if (!prior && data.result.kind !== "load-skill-result") throw new Error("CHECKPOINT_EVENT_RESULT_UNPAIRED");
        if (prior && eventType === "action.result" && checkpointTerminalOutcome(request.event.data))
          pendingOperations.splice(pendingOperations.indexOf(prior), 1);
        operation = prior;
      }
      const observation = await this.input.store.putJson(
        {
          schemaVersion: "checkpoint-observation.v1",
          scope,
          event: request.event,
          ...(operation ? { operation } : {}),
        },
        {
          mediaType: "application/vnd.aiengineer.checkpoint-observation+json",
          producerActivityId: `knowledge:checkpoint-observation:${scopeId}`,
          producerVersion: "checkpoint-observation.v1",
          dataClassification: "internal",
          transformation: { eventId: request.event.eventId },
        },
      );
      requiredArtifacts.push(observation.handle);
      if (this.input.sourceDiscovery)
        requiredArtifacts.push(
          ...(await importNativeCheckpointSource({
            scope,
            store: this.input.store,
            custody: this.input.custody,
            sourceDiscovery: this.input.sourceDiscovery,
            previousRequiredArtifacts: previous?.manifest.requiredArtifacts ?? [],
            event: request.event,
            observationArtifact: observation.handle,
          })),
        );
    }
    const manifestFiles = request.action === "observe" ? (previous?.manifest.files ?? files) : files;
    const notes = manifestFiles.find((file) => file.path === "handoff.md");
    const handoff = notes
      ? await this.input.store.putJson(
          CheckpointSemanticHandoffSchema.parse({
            schemaVersion: "checkpoint-handoff.v1",
            scope,
            pendingOperations,
            notesArtifact: notes.artifact,
            status: pendingOperations.length ? "partial" : "ready_for_continuation",
          }),
          {
            mediaType: "application/vnd.aiengineer.checkpoint-handoff+json",
            producerActivityId: `knowledge:checkpoint-handoff:${scopeId}`,
            producerVersion: "checkpoint-handoff.v1",
            dataClassification: "internal",
            parentArtifactIds: [notes.artifact.artifactId],
            transformation: { kind: "checkpoint-handoff", scopeId },
          },
        )
      : undefined;
    if (handoff) requiredArtifacts.push(handoff.handle);
    const uniqueArtifacts = new Map<string, (typeof requiredArtifacts)[number]>();
    for (const artifact of requiredArtifacts) {
      const existing = uniqueArtifacts.get(artifact.artifactId);
      if (existing) assertSameArtifact(existing, artifact);
      else uniqueArtifacts.set(artifact.artifactId, artifact);
    }
    const manifest: CheckpointManifest = {
      schemaVersion: "scoped-checkpoint.v1",
      scope,
      parentCheckpointId: request.expectedHead ?? null,
      ...request.profilePins,
      mode: handoff ? "continuation" : "archive",
      boundary: request.boundary ?? (request.action === "observe" ? "dirty_interval" : "manual"),
      files: manifestFiles,
      executorStateArtifact: state.artifact,
      requiredArtifacts: [...uniqueArtifacts.values()],
      ...(handoff ? { semanticHandoffArtifact: handoff.handle } : {}),
      pendingOperations,
    };
    const receipt = await this.input.service.commit(this.input.tenantId, {
      idempotencyKey,
      expectedHead: request.expectedHead ?? null,
      manifest,
      harnessRequestDigest,
    });
    return { checkpointId: receipt.checkpointId, receipt };
  }
}
