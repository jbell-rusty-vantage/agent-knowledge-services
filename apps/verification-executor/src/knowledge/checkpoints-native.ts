import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  SourceDiscoveryAttemptSchema,
  SourceDiscoveryAttemptReadSchema,
  SourceDiscoverySelectionReceiptSchema,
  type CheckpointScope,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { checkpointScopeId } from "@aiengineer/knowledge-application";
import { canonicalizeJson } from "@aiengineer/knowledge-verification";
import { assertSameArtifact, validateStoredArtifact, type ArtifactCustody } from "../store-custody.js";
import type { FilesystemStore } from "../store.js";

const Identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/u);
const ArtifactId = z.uuid();
const ObjectValue = z.record(z.string(), z.unknown());
const ArtifactSummary = z.object({
  artifactId: ArtifactId,
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  byteLength: z.int().nonnegative(),
});
const ToolAction = z.object({
  kind: z.literal("tool-call"),
  callId: z.string(),
  toolName: z.string(),
  input: ObjectValue,
});
const ToolResult = z.object({
  kind: z.literal("tool-result"),
  callId: z.string(),
  toolName: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
});
// SV-17: the verification-chain tools (verify_claims ... verify_run_status) are retired; only capture/locate,
// workspace registration and source discovery outputs are custody references.
const CAPTURE_TOOLS = new Set(["verify_capture_source", "verify_capture_file"]);
const CAPTURE_READ_TOOLS = new Set(["verify_read_capture", "verify_search_capture", "verify_locate_quote"]);
const SOURCE_TOOLS = new Set([
  "source_discover",
  "source_import",
  "source_attempt",
  "source_reconcile",
  "source_select",
]);

export interface NativeCheckpointEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly turnId?: string | undefined;
  readonly data: unknown;
}
export interface NativeCheckpointInput {
  readonly scope: CheckpointScope;
  readonly store: FilesystemStore;
  readonly custody: ArtifactCustody;
  readonly previousRequiredArtifacts: readonly VerificationArtifactHandle[];
  readonly event?: NativeCheckpointEvent;
}
export interface NativeCheckpointReferences {
  runIds: string[];
  captureIds: string[];
  requiredArtifacts: VerificationArtifactHandle[];
}

/** Known MCP tools return one JSON text block; arbitrary tool text is never interpreted as custody. */
export function unwrapNativeCheckpointOutput(value: unknown): Record<string, unknown> {
  const output = ObjectValue.parse(value);
  if (output.isError === true) throw new Error("CHECKPOINT_NATIVE_TOOL_ERROR");
  if (output.structuredContent !== undefined) return ObjectValue.parse(output.structuredContent);
  const content = z
    .array(z.object({ type: z.literal("text"), text: z.string().max(16_000_000) }))
    .length(1)
    .parse(output.content);
  return ObjectValue.parse(JSON.parse(content[0]!.text));
}

export type NativeCheckpointToolResult = z.infer<typeof ToolResult>;
export type NativeCheckpointToolAction = z.infer<typeof ToolAction>;

export async function findNativeCheckpointAction(
  input: NativeCheckpointInput,
  result: NativeCheckpointToolResult,
): Promise<NativeCheckpointToolAction> {
  if (input.previousRequiredArtifacts.length > 10_000) throw new Error("CHECKPOINT_OBSERVATION_LIMIT");
  const producer = `knowledge:checkpoint-observation:${checkpointScopeId(input.scope)}`;
  let matched: z.infer<typeof ToolAction> | undefined;
  for (const artifact of input.previousRequiredArtifacts) {
    if (
      artifact.mediaType !== "application/vnd.aiengineer.checkpoint-observation+json" ||
      artifact.producerActivityId !== producer
    )
      continue;
    const stored = await input.custody.resolve(artifact.artifactId);
    if (!stored) throw new Error("CHECKPOINT_OBSERVATION_UNAVAILABLE");
    assertSameArtifact(artifact, stored.handle);
    validateStoredArtifact(input.scope.tenantId, stored.handle, stored.bytes);
    const observation = ObjectValue.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes)));
    if (
      observation.schemaVersion !== "checkpoint-observation.v1" ||
      canonicalizeJson(observation.scope) !== canonicalizeJson(input.scope)
    )
      throw new Error("CHECKPOINT_OBSERVATION_BINDING");
    const event = ObjectValue.parse(observation.event);
    if (event.eventType !== "actions.requested") continue;
    const data = ObjectValue.parse(event.data);
    for (const action of z.array(z.unknown()).max(1000).parse(data.actions)) {
      const parsed = ToolAction.safeParse(action);
      if (!parsed.success || parsed.data.callId !== result.callId) continue;
      if (
        parsed.data.toolName !== result.toolName ||
        (matched && canonicalizeJson(matched) !== canonicalizeJson(parsed.data))
      )
        throw new Error("CHECKPOINT_NATIVE_ACTION_CONFLICT");
      matched = parsed.data;
    }
  }
  if (!matched) throw new Error("CHECKPOINT_NATIVE_ACTION_UNPAIRED");
  return matched;
}

async function existingRun(store: FilesystemStore, proposed: unknown): Promise<string | undefined> {
  if (proposed === undefined) return undefined;
  const runId = Identity.parse(proposed);
  for (const name of ["state.json", "steps.jsonl"]) {
    try {
      await access(join(store.runDir(runId), name));
      return runId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

async function preserved(input: NativeCheckpointInput, id: unknown, summary?: z.infer<typeof ArtifactSummary>) {
  const handle = await input.store.preserve(ArtifactId.parse(id));
  if (handle.tenantId !== input.scope.tenantId) throw new Error("CHECKPOINT_NATIVE_TENANT_MISMATCH");
  if (summary && (handle.digest !== summary.digest || handle.byteLength !== summary.byteLength))
    throw new Error("CHECKPOINT_NATIVE_ARTIFACT_MISMATCH");
  return handle;
}

/** Extract only operation-defined references from a result bound to an immutable dispatched request. */
export async function collectNativeCheckpointReferences(
  input: NativeCheckpointInput,
): Promise<NativeCheckpointReferences> {
  const references: NativeCheckpointReferences = { runIds: [], captureIds: [], requiredArtifacts: [] };
  if (input.store.tenantId !== input.scope.tenantId) throw new Error("CHECKPOINT_NATIVE_TENANT_MISMATCH");
  if (input.event?.eventType !== "action.result") return references;
  const data = ObjectValue.parse(input.event.data);
  const parsed = ToolResult.safeParse(data.result);
  if (!parsed.success) return references;
  const result = parsed.data;
  const verifier = result.toolName.startsWith("verification__")
    ? result.toolName.slice("verification__".length)
    : undefined;
  const source = result.toolName.startsWith("knowledge-executor__")
    ? result.toolName.slice("knowledge-executor__".length)
    : undefined;
  const registered = result.toolName === "register_workspace_artifact";
  if (
    !registered &&
    !(verifier && (CAPTURE_TOOLS.has(verifier) || CAPTURE_READ_TOOLS.has(verifier))) &&
    !(source && SOURCE_TOOLS.has(source))
  )
    return references;
  const action = await findNativeCheckpointAction(input, result);
  const runId = await existingRun(input.store, verifier || registered ? action.input.runId : undefined);
  if (runId) references.runIds.push(runId);
  if (
    data.status !== "completed" ||
    result.isError ||
    (typeof result.output === "object" &&
      result.output !== null &&
      "isError" in result.output &&
      result.output.isError === true)
  )
    return references;
  const output = registered ? ObjectValue.parse(result.output) : unwrapNativeCheckpointOutput(result.output);
  if (output.runId !== undefined && output.runId !== action.input.runId)
    throw new Error("CHECKPOINT_NATIVE_RUN_MISMATCH");
  if (registered) {
    const summary = ArtifactSummary.parse(output);
    if (typeof output.path !== "string" || output.path !== action.input.path || typeof output.mediaType !== "string")
      throw new Error("CHECKPOINT_NATIVE_REGISTRATION_BINDING");
    const handle = await preserved(input, summary.artifactId, summary);
    if (handle.mediaType !== output.mediaType) throw new Error("CHECKPOINT_NATIVE_REGISTRATION_BINDING");
    references.requiredArtifacts.push(handle);
  } else if (verifier && (CAPTURE_TOOLS.has(verifier) || CAPTURE_READ_TOOLS.has(verifier))) {
    const captureId = Identity.parse(output.captureId);
    if (action.input.captureId !== undefined && action.input.captureId !== captureId)
      throw new Error("CHECKPOINT_NATIVE_CAPTURE_MISMATCH");
    const capture = await input.store.readCapture(captureId);
    if (capture.captureId !== captureId) throw new Error("CHECKPOINT_NATIVE_CAPTURE_MISMATCH");
    if (
      verifier === "verify_capture_source" &&
      action.input.url !== undefined &&
      action.input.url !== capture.requestedUrl
    )
      throw new Error("CHECKPOINT_NATIVE_CAPTURE_SOURCE_MISMATCH");
    references.captureIds.push(captureId);
    for (const field of ["contentArtifact", "originalArtifact"] as const) {
      const artifact = capture[field];
      if (!artifact) {
        if (output[field] !== undefined) throw new Error("CHECKPOINT_NATIVE_CAPTURE_MISMATCH");
        continue;
      }
      const summary = CAPTURE_TOOLS.has(verifier) ? ArtifactSummary.parse(output[field]) : undefined;
      if (summary && summary.artifactId !== artifact.artifactId) throw new Error("CHECKPOINT_NATIVE_CAPTURE_MISMATCH");
      const handle = await preserved(input, artifact.artifactId, summary);
      assertSameArtifact(artifact, handle);
      references.requiredArtifacts.push(handle);
    }
  } else if (source) {
    const attemptId = source === "source_attempt" ? ObjectValue.parse(output.attempt).attemptId : output.attemptId;
    const requestedAttempt =
      source === "source_select" ? ObjectValue.parse(action.input.request).attemptId : action.input.attemptId;
    if (requestedAttempt !== undefined && requestedAttempt !== attemptId)
      throw new Error("CHECKPOINT_NATIVE_SOURCE_ATTEMPT_MISMATCH");
    const handles =
      source === "source_select"
        ? [SourceDiscoverySelectionReceiptSchema.parse(output).selectionArtifact]
        : source === "source_attempt"
          ? (() => {
              const read = SourceDiscoveryAttemptReadSchema.parse(output);
              return [...attemptArtifacts(read.attempt), ...read.selectionArtifacts];
            })()
          : attemptArtifacts(SourceDiscoveryAttemptSchema.parse(output));
    for (const handle of handles) {
      const stored = await preserved(input, handle.artifactId);
      assertSameArtifact(handle, stored);
      references.requiredArtifacts.push(stored);
    }
  }
  return {
    ...references,
    runIds: [...new Set(references.runIds)],
    requiredArtifacts: [...new Map(references.requiredArtifacts.map((handle) => [handle.artifactId, handle])).values()],
  };
}

function attemptArtifacts(attempt: z.infer<typeof SourceDiscoveryAttemptSchema>): VerificationArtifactHandle[] {
  return [
    attempt.requestArtifact,
    attempt.rawOutputArtifact,
    attempt.externalReceiptArtifact,
    attempt.completionArtifact,
  ].filter((value): value is VerificationArtifactHandle => value !== undefined);
}
