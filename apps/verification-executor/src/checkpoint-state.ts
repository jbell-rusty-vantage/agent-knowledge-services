import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  VerificationArtifactHandleSchema,
  VerificationIdSchema,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import { encoder, decoder, type FilesystemStore } from "./store.js";
import {
  assertSameArtifact,
  readArtifactFile,
  validateStoredArtifact,
  writeArtifactFileOnce,
  type ArtifactCustody,
} from "./store-custody.js";
import { executorStateRevision } from "./checkpoint-state-fence.js";

const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/);
const RunStateSchema = z.strictObject({
  runId: Identifier,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  captureIds: z.array(Identifier).max(2_048).optional(),
});
const StepSchema = z.strictObject({
  runId: Identifier,
  sequence: z.int().positive(),
  operation: Identifier,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  status: z.enum(["succeeded", "failed"]),
  input: z.unknown(),
  output: z.unknown(),
  error: z.string().optional(),
});
const CaptureSchema = z.strictObject({
  captureId: Identifier,
  sourceId: VerificationIdSchema,
  requestedUrl: z.string().min(1).max(8192),
  finalUrl: z.string().min(1).max(8192),
  title: z.string().optional(),
  capturedAt: z.iso.datetime(),
  captureMethod: z.string().min(1),
  captureMethodVersion: z.string().min(1),
  contentArtifact: VerificationArtifactHandleSchema,
  originalArtifact: VerificationArtifactHandleSchema.optional(),
  characters: z.int().nonnegative(),
  sourceKind: z.enum(["web_page", "pdf", "api", "repository", "other"]),
  logicalIdentity: z.string().min(1),
});
export const ExecutorCheckpointStateSchema = z
  .strictObject({
    schemaVersion: z.literal("executor-checkpoint-state.v1"),
    tenantId: z.uuid(),
    scopeId: z.uuid(),
    runs: z.array(z.strictObject({ state: RunStateSchema, steps: z.array(StepSchema).max(10_000) })).max(128),
    captures: z.array(CaptureSchema).max(2_048),
  })
  .superRefine((snapshot, context) => {
    const unique = (values: readonly string[]) => new Set(values).size === values.length;
    if (
      !unique(snapshot.runs.map((run) => run.state.runId)) ||
      !unique(snapshot.captures.map((capture) => capture.captureId))
    ) {
      context.addIssue({ code: "custom", message: "checkpoint state identities must be unique" });
    }
    for (const run of snapshot.runs) {
      if (run.steps.some((step, index) => step.runId !== run.state.runId || step.sequence !== index + 1)) {
        context.addIssue({ code: "custom", message: "checkpoint step sequence or run mismatch" });
      }
    }
    for (const capture of snapshot.captures) {
      if (
        [capture.contentArtifact, capture.originalArtifact].some(
          (artifact) => artifact && artifact.tenantId !== snapshot.tenantId,
        )
      ) {
        context.addIssue({ code: "custom", message: "checkpoint capture tenant mismatch" });
      }
    }
  });
type ExecutorCheckpointState = z.infer<typeof ExecutorCheckpointStateSchema>;

function references(value: unknown, artifactIds: Set<string>, captureIds: Set<string>): void {
  if (Array.isArray(value)) {
    for (const member of value) references(member, artifactIds, captureIds);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, member] of Object.entries(value)) {
    if (/^(?:artifactId|.*ArtifactId)$/.test(key) && typeof member === "string")
      artifactIds.add(z.uuid().parse(member));
    else if (/ArtifactIds$/.test(key) && Array.isArray(member))
      for (const id of member) artifactIds.add(z.uuid().parse(id));
    else if (key === "captureId" && typeof member === "string") captureIds.add(Identifier.parse(member));
    else if (key === "captureIds" && Array.isArray(member))
      for (const id of member) captureIds.add(Identifier.parse(id));
    else references(member, artifactIds, captureIds);
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(decoder.decode(await readArtifactFile(path)));
}

async function snapshotState(
  store: FilesystemStore,
  scopeId: string,
  runIds: readonly string[],
  proposedCaptures: readonly string[],
) {
  const artifactIds = new Set<string>();
  const captureIds = new Set(proposedCaptures.map((id) => Identifier.parse(id)));
  const runs = [];
  for (const runId of runIds) {
    Identifier.parse(runId);
    const steps = (await store.listSteps(runId)).map((step) => StepSchema.parse(step));
    let state;
    try {
      state = RunStateSchema.parse(await readJson(join(store.runDir(runId), "state.json")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !steps.length) throw error;
      state = RunStateSchema.parse({ runId, createdAt: steps[0]!.startedAt, updatedAt: steps.at(-1)!.completedAt });
    }
    if (state.runId !== runId) throw new Error("CHECKPOINT_RUN_IDENTITY_MISMATCH");
    references({ state, steps }, artifactIds, captureIds);
    runs.push({ state, steps });
  }
  const captures = [];
  for (const captureId of [...captureIds].sort()) {
    const capture = CaptureSchema.parse(await readJson(join(store.rootDir, "captures", `${captureId}.json`)));
    if (capture.captureId !== captureId) throw new Error("CHECKPOINT_CAPTURE_IDENTITY_MISMATCH");
    references(capture, artifactIds, new Set());
    captures.push(capture);
  }
  const snapshot = ExecutorCheckpointStateSchema.parse({
    schemaVersion: "executor-checkpoint-state.v1",
    tenantId: store.tenantId,
    scopeId,
    runs,
    captures,
  });
  return { snapshot, artifactIds: [...artifactIds].sort() };
}

/** A checkpoint carries the local verifier indexes as well as their remotely held artifact closure. */
export async function exportExecutorCheckpointState(
  store: FilesystemStore,
  input: {
    scopeId: string;
    runIds: readonly string[];
    captureIds: readonly string[];
  },
): Promise<{ artifact: VerificationArtifactHandle; requiredArtifacts: VerificationArtifactHandle[] }> {
  const runIds = z.array(Identifier).max(128).parse(input.runIds).sort();
  const captureIds = z.array(Identifier).max(2_048).parse(input.captureIds).sort();
  let stable: Awaited<ReturnType<typeof snapshotState>> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const revision = executorStateRevision(store, runIds);
      const first = await snapshotState(store, input.scopeId, runIds, captureIds);
      const second = await snapshotState(store, input.scopeId, runIds, captureIds);
      if (revision === executorStateRevision(store, runIds) && canonicalizeJson(first) === canonicalizeJson(second)) {
        stable = second;
        break;
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) || attempt === 2) throw error;
    }
  }
  if (!stable) throw new Error("CHECKPOINT_EXECUTOR_STATE_DIRTY");
  const requiredArtifacts: VerificationArtifactHandle[] = [];
  for (const id of stable.artifactIds) requiredArtifacts.push(await store.preserve(id));
  const artifact = (
    await store.putJson(stable.snapshot, {
      mediaType: "application/vnd.aiengineer.executor-checkpoint-state+json",
      producerActivityId: `verification-executor:checkpoint:${input.scopeId}`,
      producerVersion: "executor-checkpoint-state.v1",
      dataClassification: "internal",
      parentArtifactIds: requiredArtifacts.map((handle) => handle.artifactId),
      transformation: { kind: "executor-state", scopeId: input.scopeId },
    })
  ).handle;
  return { artifact, requiredArtifacts };
}

function restoreFiles(snapshot: ExecutorCheckpointState): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const encode = (value: unknown) => encoder.encode(canonicalizeJson(value));
  for (const capture of snapshot.captures) files.set(`captures/${capture.captureId}.json`, encode(capture));
  for (const { state, steps } of snapshot.runs) {
    files.set(`runs/${state.runId}/state.json`, encode(state));
    files.set(
      `runs/${state.runId}/steps.jsonl`,
      encoder.encode(steps.map((step) => canonicalizeJson(step) + "\n").join("")),
    );
    for (const step of steps)
      files.set(
        `runs/${state.runId}/steps/${String(step.sequence).padStart(3, "0")}-${step.operation}.json`,
        encode(step),
      );
  }
  return files;
}

function identicalIndex(name: string, expected: Uint8Array, actual: Uint8Array): boolean {
  if (sha256Digest(expected) === sha256Digest(actual)) return true;
  const parse = (bytes: Uint8Array) =>
    name.endsWith(".jsonl")
      ? decoder
          .decode(bytes)
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line))
      : JSON.parse(decoder.decode(bytes));
  try {
    return canonicalizeJson(parse(expected)) === canonicalizeJson(parse(actual));
  } catch {
    return false;
  }
}

async function requireCleanOrIdenticalTree(
  root: string,
  prefix: string,
  expected: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  let entries;
  try {
    const info = await lstat(join(root, prefix));
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("CHECKPOINT_RESTORE_PATH_DENIED");
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const name = `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error("CHECKPOINT_RESTORE_PATH_DENIED");
    if (entry.isDirectory()) {
      await requireCleanOrIdenticalTree(root, name, expected);
      continue;
    }
    const bytes = expected.get(name);
    if (!entry.isFile() || !bytes || !identicalIndex(name, bytes, await readArtifactFile(join(root, name)))) {
      throw new Error("CHECKPOINT_RESTORE_NAMESPACE_NOT_CLEAN");
    }
  }
}

export async function validateExecutorCheckpointState(
  custody: ArtifactCustody,
  input: {
    tenantId: string;
    scopeId: string;
    artifact: VerificationArtifactHandle;
  },
): Promise<ExecutorCheckpointState> {
  const remote = await custody.resolve(input.artifact.artifactId);
  if (!remote) throw new Error("CHECKPOINT_EXECUTOR_STATE_UNAVAILABLE");
  assertSameArtifact(input.artifact, remote.handle);
  validateStoredArtifact(input.tenantId, remote.handle, remote.bytes);
  const snapshot = ExecutorCheckpointStateSchema.parse(JSON.parse(decoder.decode(remote.bytes)));
  if (
    snapshot.tenantId !== input.tenantId ||
    snapshot.scopeId !== input.scopeId ||
    remote.handle.mediaType !== "application/vnd.aiengineer.executor-checkpoint-state+json" ||
    remote.handle.producerActivityId !== `verification-executor:checkpoint:${input.scopeId}` ||
    remote.handle.producerVersion !== "executor-checkpoint-state.v1"
  )
    throw new Error("CHECKPOINT_EXECUTOR_SCOPE_MISMATCH");
  const artifactIds = new Set<string>();
  const captureIds = new Set<string>();
  references(snapshot, artifactIds, captureIds);
  if (canonicalizeJson([...artifactIds].sort()) !== canonicalizeJson([...remote.handle.parentArtifactIds].sort()))
    throw new Error("CHECKPOINT_EXECUTOR_PARENT_CLOSURE_MISMATCH");
  if ([...captureIds].some((id) => !snapshot.captures.some((capture) => capture.captureId === id)))
    throw new Error("CHECKPOINT_EXECUTOR_CAPTURE_MISSING");
  for (const id of artifactIds) {
    const dependency = await custody.resolve(id);
    if (!dependency) throw new Error("CHECKPOINT_EXECUTOR_DEPENDENCY_UNAVAILABLE");
    for (const capture of snapshot.captures)
      for (const handle of [capture.contentArtifact, capture.originalArtifact]) {
        if (handle?.artifactId === id) assertSameArtifact(handle, dependency.handle);
      }
  }
  return snapshot;
}

export async function restoreExecutorCheckpointState(
  store: FilesystemStore,
  custody: ArtifactCustody,
  input: {
    scopeId: string;
    artifact: VerificationArtifactHandle;
  },
): Promise<{ scopeId: string; artifactId: string; runIds: string[]; captureIds: string[] }> {
  const snapshot = await validateExecutorCheckpointState(custody, { ...input, tenantId: store.tenantId });
  for (const id of input.artifact.parentArtifactIds) await store.resolveHandle({ artifactId: id });
  const files = restoreFiles(snapshot);
  for (const prefix of ["runs", "captures"]) {
    try {
      const info = await lstat(join(store.rootDir, prefix));
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("CHECKPOINT_RESTORE_PATH_DENIED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const run of snapshot.runs) await requireCleanOrIdenticalTree(store.rootDir, `runs/${run.state.runId}`, files);
  for (const capture of snapshot.captures) {
    const name = `captures/${capture.captureId}.json`;
    try {
      const info = await lstat(join(store.rootDir, name));
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("CHECKPOINT_RESTORE_PATH_DENIED");
      if (!identicalIndex(name, files.get(name)!, await readArtifactFile(join(store.rootDir, name))))
        throw new Error("CHECKPOINT_RESTORE_NAMESPACE_NOT_CLEAN");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const [name, bytes] of files) {
    const path = join(store.rootDir, name);
    await mkdir(dirname(path), { recursive: true });
    if (!identicalIndex(name, bytes, await writeArtifactFileOnce(path, bytes)))
      throw new Error("CHECKPOINT_RESTORE_FILE_CONFLICT");
  }
  return {
    scopeId: input.scopeId,
    artifactId: input.artifact.artifactId,
    runIds: snapshot.runs.map((run) => run.state.runId),
    captureIds: snapshot.captures.map((capture) => capture.captureId),
  };
}
