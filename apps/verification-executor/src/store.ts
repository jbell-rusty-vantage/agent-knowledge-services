import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import {
  assertSameArtifact,
  readArtifactFile,
  validateStoredArtifact,
  writeArtifactFileOnce,
  type ArtifactCustody,
} from "./store-custody.js";

/**
 * Content-addressed filesystem store: a non-authoritative working cache of captured bytes, capture records and
 * capture step receipts (SV-17). Verification runs, claims, seals and admission live only in the verification
 * component (knowledge_verification); nothing in this store is read as their authority. Remote custody, when
 * attached, is the durable copy of the artifact bytes.
 *
 * Layout under `rootDir`:
 *   artifacts/<hex>              raw bytes (hex = sha256 of the bytes)
 *   artifacts/<hex>.<identity>.handle.json  the logical handle; legacy plain handles remain readable
 *   captures/<captureId>.json    capture records (source + content handle)
 *   runs/<runId>/state.json      capture ids of one caller run (step log only)
 *   runs/<runId>/steps.jsonl     append-only step receipts (one JSON object per line)
 *   runs/<runId>/steps/NNN-<op>.json  the same receipts, one file per step, for humans
 *
 * Puts reuse the same bytes and provenance identity. Gets recompute the digest and
 * refuse to return bytes that do not match the address.
 */

export const encoder = new TextEncoder();
export const decoder = new TextDecoder("utf-8", { fatal: true });

export function deterministicUuid(namespace: string, value: string): string {
  const hex = createHash("sha256").update(`${namespace}\0${value}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function shortId(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export interface RegisterArtifactInput {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly producerActivityId: string;
  readonly producerVersion: string;
  readonly dataClassification?: "public" | "internal" | "confidential" | "restricted";
  readonly parentArtifactIds?: readonly string[];
  /** Any JSON value describing how the bytes were derived from the parents. Required when parents exist. */
  readonly transformation?: unknown;
  readonly createdAt?: string;
}

export interface StepReceipt {
  readonly runId: string;
  readonly sequence: number;
  readonly operation: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "succeeded" | "failed";
  readonly input: unknown;
  readonly output: unknown;
  readonly error?: string;
}

/** A capture step log keyed by the caller's run id. Non-authoritative: it carries no verdict, seal or admission. */
export interface RunState {
  runId: string;
  createdAt: string;
  updatedAt: string;
  captureIds?: string[];
}

export class FilesystemStore {
  readonly rootDir: string;
  readonly tenantId: string;
  private custody: ArtifactCustody | undefined;

  constructor(rootDir: string, tenantId: string) {
    this.rootDir = resolve(rootDir);
    this.tenantId = tenantId;
  }

  attachCustody(custody: ArtifactCustody): void {
    if (this.custody) throw new Error("ARTIFACT_CUSTODY_ALREADY_BOUND");
    this.custody = custody;
  }

  private async persist(handle: VerificationArtifactHandle, visiting = new Set<string>()): Promise<void> {
    if (!this.custody) return;
    if (visiting.has(handle.artifactId)) throw new Error("ARTIFACT_LINEAGE_CYCLE");
    visiting.add(handle.artifactId);
    try {
      for (const parentId of [
        ...handle.parentArtifactIds,
        ...(handle.attestationArtifactId ? [handle.attestationArtifactId] : []),
      ]) {
        const parent = await this.handleById(parentId);
        if (!parent) throw new Error(`ARTIFACT_PARENT_NOT_FOUND:${parentId}`);
        await this.persist(parent, visiting);
      }
      const registered = await this.custody.resolve(handle.artifactId);
      if (registered) {
        // Native worker parents already have their own canonical type and producer binding.
        // Retention verifies that identity; registering them as executor outputs would retype it.
        assertSameArtifact(handle, validateStoredArtifact(this.tenantId, registered.handle, registered.bytes));
        validateStoredArtifact(this.tenantId, handle, await this.bytes(handle));
      } else {
        assertSameArtifact(handle, await this.custody.register(handle, await this.bytes(handle)));
      }
    } finally {
      visiting.delete(handle.artifactId);
    }
  }

  async preserve(artifactId: string): Promise<VerificationArtifactHandle> {
    if (!this.custody) throw new Error("ARTIFACT_REMOTE_CUSTODY_UNAVAILABLE");
    const handle = await this.resolveHandle({ artifactId });
    await this.persist(handle);
    return handle;
  }

  private async materialize(value: VerificationArtifactHandle, bytes: Uint8Array): Promise<VerificationArtifactHandle> {
    const handle = validateStoredArtifact(this.tenantId, value, bytes);
    await mkdir(join(this.rootDir, "artifacts"), { recursive: true });
    validateStoredArtifact(
      this.tenantId,
      handle,
      await writeArtifactFileOnce(join(this.rootDir, handle.objectKey), bytes),
    );
    const path = join(this.rootDir, "artifacts", `${handle.digest.slice(7)}.${handle.artifactId}.handle.json`);
    const stored = await writeArtifactFileOnce(path, encoder.encode(JSON.stringify(handle)));
    assertSameArtifact(handle, validateStoredArtifact(this.tenantId, JSON.parse(decoder.decode(stored))));
    return handle;
  }

  async init(): Promise<void> {
    await Promise.all(
      ["artifacts", "captures", "runs"].map((dir) => mkdir(join(this.rootDir, dir), { recursive: true })),
    );
  }

  // ---- artifacts -----------------------------------------------------------

  /**
   * Artifact identity = bytes + lineage. Two derived artifacts with identical bytes but
   * different parents (e.g. a policy decision re-evaluated after a re-judge that happened to
   * produce the same outcome) must not collapse into one handle, otherwise the older handle's
   * parents leak into the newer run and the seal fails with LINEAGE_PARENT_MISSING.
   * New identities also bind producer and media metadata. Compatible legacy handles retain
   * their original identity; the stored bytes remain shared by digest.
   */
  artifactIdFor(digest: `sha256:${string}`, lineageSignature?: `sha256:${string}`): string {
    return deterministicUuid(
      "artifact",
      lineageSignature ? `${this.tenantId}:${digest}:${lineageSignature}` : `${this.tenantId}:${digest}`,
    );
  }

  private handlePath(hex: string, lineageSignature?: `sha256:${string}`): string {
    return join(
      this.rootDir,
      "artifacts",
      lineageSignature
        ? `${hex}.${lineageSignature.slice("sha256:".length, "sha256:".length + 16)}.handle.json`
        : `${hex}.handle.json`,
    );
  }

  async put(input: RegisterArtifactInput): Promise<VerificationArtifactHandle> {
    const digest = sha256Digest(input.bytes);
    const hex = digest.slice("sha256:".length);
    const parents = [...(input.parentArtifactIds ?? [])].sort();
    if (parents.length > 0 && input.transformation === undefined)
      throw new Error("ARTIFACT_TRANSFORMATION_REQUIRED_FOR_PARENTS");
    const transformationSignature =
      input.transformation !== undefined
        ? sha256Digest(canonicalizeJson(stripUndefined(input.transformation)))
        : undefined;
    const lineageSignature = sha256Digest(
      canonicalizeJson(
        stripUndefined({
          parents,
          transformationSignature,
          producerActivityId: input.producerActivityId,
          producerVersion: input.producerVersion,
          mediaType: input.mediaType,
          dataClassification: input.dataClassification ?? "public",
        }),
      ),
    );
    const handlePath = this.handlePath(hex, lineageSignature);
    const legacySignature =
      parents.length > 0 ? sha256Digest(canonicalizeJson({ parents, transformationSignature })) : undefined;
    const legacyPath = this.handlePath(hex, legacySignature);
    const priorPath = existsSync(handlePath) ? handlePath : existsSync(legacyPath) ? legacyPath : undefined;
    if (priorPath) {
      const existing = validateStoredArtifact(
        this.tenantId,
        JSON.parse(await readFile(priorPath, "utf8")),
        input.bytes,
      );
      if (
        existing.producerActivityId === input.producerActivityId &&
        existing.producerVersion === input.producerVersion &&
        existing.mediaType === input.mediaType &&
        existing.dataClassification === (input.dataClassification ?? "public") &&
        canonicalizeJson(existing.parentArtifactIds) === canonicalizeJson(parents) &&
        existing.transformationSignature === transformationSignature
      ) {
        await this.persist(existing);
        return existing;
      }
      if (priorPath === handlePath) throw new Error("ARTIFACT_REGISTRATION_COLLISION");
    }
    let handle: VerificationArtifactHandle = {
      artifactId: this.artifactIdFor(digest, lineageSignature),
      tenantId: this.tenantId,
      digest,
      mediaType: input.mediaType,
      byteLength: input.bytes.byteLength,
      objectKey: `artifacts/${hex}`,
      createdAt: input.createdAt ?? new Date().toISOString(),
      producerActivityId: input.producerActivityId,
      producerVersion: input.producerVersion,
      encryptionClass: "filesystem-plain",
      retentionClass: "experiment",
      dataClassification: input.dataClassification ?? "public",
      parentArtifactIds: parents,
      ...(transformationSignature ? { transformationSignature } : {}),
    };
    const registered = await this.custody?.lookup(handle.artifactId);
    if (registered) {
      assertSameArtifact({ ...handle, createdAt: registered.createdAt }, registered);
      handle = registered;
    }
    await mkdir(join(this.rootDir, "artifacts"), { recursive: true });
    const objectPath = join(this.rootDir, handle.objectKey);
    validateStoredArtifact(this.tenantId, handle, await writeArtifactFileOnce(objectPath, input.bytes));
    if (this.custody) {
      for (const parentId of handle.parentArtifactIds) {
        const parent = await this.handleById(parentId);
        if (!parent) throw new Error(`ARTIFACT_PARENT_NOT_FOUND:${parentId}`);
        await this.persist(parent);
      }
      const winner = await this.custody.register(handle, input.bytes);
      assertSameArtifact({ ...handle, createdAt: winner.createdAt }, winner);
      handle = winner;
    }
    const stored = validateStoredArtifact(
      this.tenantId,
      JSON.parse(decoder.decode(await writeArtifactFileOnce(handlePath, encoder.encode(JSON.stringify(handle))))),
      input.bytes,
    );
    assertSameArtifact({ ...handle, createdAt: stored.createdAt }, stored);
    if (!this.custody) return stored;
    assertSameArtifact(handle, stored);
    return stored;
  }

  async putJson(
    value: unknown,
    input: Omit<RegisterArtifactInput, "bytes">,
  ): Promise<{ handle: VerificationArtifactHandle; bytes: Uint8Array }> {
    const bytes = encoder.encode(canonicalizeJson(stripUndefined(value)));
    return { handle: await this.put({ ...input, bytes }), bytes };
  }

  /** Any handle over these bytes: the parentless one when it exists, else the first lineaged one. */
  async handleByDigest(digest: `sha256:${string}`): Promise<VerificationArtifactHandle | undefined> {
    const hex = digest.slice("sha256:".length);
    const plain = this.handlePath(hex);
    if (existsSync(plain)) return JSON.parse(await readFile(plain, "utf8")) as VerificationArtifactHandle;
    const dir = join(this.rootDir, "artifacts");
    if (!existsSync(dir)) return undefined;
    const lineaged = (await readdir(dir))
      .filter((name) => name.startsWith(`${hex}.`) && name.endsWith(".handle.json"))
      .sort();
    if (lineaged.length === 0) return undefined;
    return JSON.parse(await readFile(join(dir, lineaged[0]!), "utf8")) as VerificationArtifactHandle;
  }

  async handleById(artifactId: string): Promise<VerificationArtifactHandle | undefined> {
    const dir = join(this.rootDir, "artifacts");
    for (const name of existsSync(dir) ? await readdir(dir) : []) {
      if (!name.endsWith(".handle.json")) continue;
      const handle = validateStoredArtifact(this.tenantId, JSON.parse(await readFile(join(dir, name), "utf8")));
      if (handle.artifactId === artifactId) return handle;
    }
    const remote = await this.custody?.resolve(artifactId);
    if (remote) {
      if (remote.handle.artifactId !== artifactId) throw new Error("ARTIFACT_CUSTODY_IDENTITY_MISMATCH");
      return this.materialize(remote.handle, remote.bytes);
    }
    return undefined;
  }

  async resolveHandle(ref: { artifactId?: string; digest?: string }): Promise<VerificationArtifactHandle> {
    const handle = ref.artifactId
      ? await this.handleById(ref.artifactId)
      : ref.digest
        ? await this.handleByDigest(ref.digest as `sha256:${string}`)
        : undefined;
    if (!handle) throw new Error(`ARTIFACT_NOT_FOUND:${ref.artifactId ?? ref.digest ?? "?"}`);
    if (ref.digest && handle.digest !== ref.digest) throw new Error("ARTIFACT_REFERENCE_DIGEST_MISMATCH");
    return handle;
  }

  async bytes(handle: VerificationArtifactHandle): Promise<Uint8Array> {
    validateStoredArtifact(this.tenantId, handle);
    if (!existsSync(join(this.rootDir, handle.objectKey)) && this.custody) {
      const remote = await this.custody.resolve(handle.artifactId);
      if (!remote) throw new Error(`ARTIFACT_NOT_FOUND:${handle.artifactId}`);
      assertSameArtifact(handle, remote.handle);
      await this.materialize(remote.handle, remote.bytes);
    }
    const raw = await readArtifactFile(join(this.rootDir, handle.objectKey));
    if (sha256Digest(raw) !== handle.digest) throw new Error(`ARTIFACT_DIGEST_MISMATCH:${handle.artifactId}`);
    if (raw.byteLength !== handle.byteLength) throw new Error(`ARTIFACT_LENGTH_MISMATCH:${handle.artifactId}`);
    return raw;
  }

  async text(handle: VerificationArtifactHandle): Promise<string> {
    return decoder.decode(await this.bytes(handle));
  }

  async json<T = unknown>(handle: VerificationArtifactHandle): Promise<T> {
    return JSON.parse(await this.text(handle)) as T;
  }

  // ---- captures ------------------------------------------------------------

  async writeCapture(record: CaptureRecord): Promise<void> {
    await mkdir(join(this.rootDir, "captures"), { recursive: true });
    await writeFile(
      join(this.rootDir, "captures", `${safeName(record.captureId)}.json`),
      JSON.stringify(record, null, 2),
    );
  }

  async readCapture(captureId: string): Promise<CaptureRecord> {
    const path = join(this.rootDir, "captures", `${safeName(captureId)}.json`);
    if (!existsSync(path)) throw new Error(`CAPTURE_NOT_FOUND:${captureId}`);
    return JSON.parse(await readFile(path, "utf8")) as CaptureRecord;
  }

  async listCaptures(): Promise<CaptureRecord[]> {
    const dir = join(this.rootDir, "captures");
    if (!existsSync(dir)) return [];
    const records: CaptureRecord[] = [];
    for (const name of await readdir(dir))
      if (name.endsWith(".json")) records.push(JSON.parse(await readFile(join(dir, name), "utf8")) as CaptureRecord);
    return records.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  // ---- runs ----------------------------------------------------------------

  runDir(runId: string): string {
    return join(this.rootDir, "runs", safeName(runId));
  }

  async readRun(runId: string): Promise<RunState> {
    const path = join(this.runDir(runId), "state.json");
    if (!existsSync(path)) {
      const now = new Date().toISOString();
      return { runId, createdAt: now, updatedAt: now };
    }
    return JSON.parse(await readFile(path, "utf8")) as RunState;
  }

  async writeRun(state: RunState): Promise<void> {
    await mkdir(this.runDir(state.runId), { recursive: true });
    state.updatedAt = new Date().toISOString();
    await writeFile(join(this.runDir(state.runId), "state.json"), JSON.stringify(state, null, 2));
  }

  async appendStep(step: Omit<StepReceipt, "sequence">): Promise<StepReceipt> {
    const dir = join(this.runDir(step.runId), "steps");
    await mkdir(dir, { recursive: true });
    const existing = (await readdir(dir)).filter((name) => name.endsWith(".json")).length;
    const receipt: StepReceipt = { ...step, sequence: existing + 1 };
    const name = `${String(receipt.sequence).padStart(3, "0")}-${safeName(step.operation)}.json`;
    await writeFile(join(dir, name), JSON.stringify(receipt, null, 2));
    await writeFile(join(this.runDir(step.runId), "steps.jsonl"), `${JSON.stringify(receipt)}\n`, { flag: "a" });
    return receipt;
  }

  async listSteps(runId: string): Promise<StepReceipt[]> {
    const path = join(this.runDir(runId), "steps.jsonl");
    if (!existsSync(path)) return [];
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StepReceipt);
  }
}

export interface CaptureRecord {
  /** Immutable acquisition-time record. Old caches without it are not eligible for K01 provenance export. */
  readonly provenanceArtifact?: VerificationArtifactHandle;
  readonly captureId: string;
  readonly sourceId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly title?: string;
  readonly capturedAt: string;
  readonly captureMethod: string;
  readonly captureMethodVersion: string;
  readonly contentArtifact: VerificationArtifactHandle;
  /** Original bytes when the text representation was derived from a binary document (pdf, docx, …) or raw html. */
  readonly originalArtifact?: VerificationArtifactHandle;
  readonly characters: number;
  readonly sourceKind: "web_page" | "pdf" | "api" | "repository" | "other";
  readonly logicalIdentity: string;
}

/** JSON round-trip drops `undefined` members, which RFC 8785 canonicalization refuses to encode. */
export function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 180);
}
