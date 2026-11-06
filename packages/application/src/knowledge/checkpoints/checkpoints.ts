import {
  CheckpointCommitRequestSchema,
  CheckpointManifestSchema,
  CheckpointOperationOutcomeSchema,
  CheckpointProfilePinsSchema,
  CheckpointRelativePathSchema,
  CheckpointRestoreRequestSchema,
  CheckpointRestoreResultSchema,
  CheckpointScopeSchema,
  CheckpointTombstoneRequestSchema,
  VerificationArtifactHandleSchema,
  type CheckpointCommitRequest,
  type CheckpointManifest,
  type CheckpointReceipt,
  type CheckpointRestoreRequest,
  type CheckpointRestoreResult,
  type CheckpointScope,
  type CheckpointTombstoneRequest,
  type VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import type {
  CheckpointCustody,
  CheckpointOperationReconciler,
  CheckpointPolicy,
  CheckpointStore,
} from "./checkpoints-ports.js";
export type {
  CheckpointCustody,
  CheckpointOperationReconciler,
  CheckpointPolicy,
  CheckpointStore,
  CheckpointStoredRecord,
} from "./checkpoints-ports.js";
export function checkpointScopeId(scope: CheckpointScope): string {
  return deterministicUuid("checkpoint-scope.v1", canonicalizeJson(CheckpointScopeSchema.parse(scope)));
}
const FORBIDDEN_SEGMENT =
  /^(?:\.env.*|\.git|\.ssh|\.aws|\.azure|node_modules|__pycache__|(?:credentials?|secrets?|tokens?)(?:\..*)?|(?:auth|keys?)(?:\.(?:json|txt|yaml|yml|toml|ini|conf|config|env))?|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/iu;
export function assertCheckpointPath(path: string, allowedRoots: readonly string[]): void {
  if (!CheckpointRelativePathSchema.safeParse(path).success) throw new Error("CHECKPOINT_PATH_DENIED");
  if (
    path.split("/").some((segment) => FORBIDDEN_SEGMENT.test(segment)) ||
    !allowedRoots.some((root) => path === root || path.startsWith(`${root}/`))
  ) {
    throw new Error("CHECKPOINT_PATH_DENIED");
  }
}
function requireSame(expected: unknown, actual: unknown, code: string): void {
  if (canonicalizeJson(expected) !== canonicalizeJson(actual)) throw new Error(code);
}
function manifestArtifacts(manifest: CheckpointManifest): VerificationArtifactHandle[] {
  return [
    ...manifest.files.map((file) => file.artifact),
    ...manifest.requiredArtifacts,
    ...(manifest.executorStateArtifact ? [manifest.executorStateArtifact] : []),
    ...(manifest.semanticHandoffArtifact ? [manifest.semanticHandoffArtifact] : []),
  ];
}
export class CheckpointApplicationService {
  constructor(
    private readonly store: CheckpointStore,
    private readonly custody: CheckpointCustody,
    private readonly reconciler: CheckpointOperationReconciler,
    private readonly policy: CheckpointPolicy,
  ) {}
  async registerScope(tenantId: string, proposed: CheckpointScope): Promise<string> {
    const scope = CheckpointScopeSchema.parse(proposed);
    if (scope.tenantId !== tenantId) throw new Error("CHECKPOINT_TENANT_DENIED");
    const scopeId = checkpointScopeId(scope);
    await this.store.ensureScope({ tenantId, scopeId, scope });
    return scopeId;
  }
  async resolveParentScope(
    tenantId: string,
    input: {
      runId: string;
      producerAttemptId: string;
      sessionId: string;
    },
  ): Promise<string | undefined> {
    const scope = await this.store.findScopeBySession({ tenantId, ...input });
    return scope ? checkpointScopeId(scope) : undefined;
  }
  async findCommittedByKey(
    tenantId: string,
    input: {
      scope: CheckpointScope;
      idempotencyKey: string;
      harnessRequestDigest: string;
    },
  ): Promise<CheckpointReceipt | undefined> {
    const scope = CheckpointScopeSchema.parse(input.scope);
    if (scope.tenantId !== tenantId) throw new Error("CHECKPOINT_TENANT_DENIED");
    const record = await this.store.findByKey({
      tenantId,
      scopeId: checkpointScopeId(scope),
      idempotencyKey: input.idempotencyKey,
    });
    if (!record) return undefined;
    if (record.receipt.harnessRequestDigest !== input.harnessRequestDigest)
      throw new Error("CHECKPOINT_HARNESS_INPUT_CONFLICT");
    await this.read(tenantId, {
      checkpointId: record.receipt.checkpointId,
      expectedScope: scope,
      expectedProfilePins: this.policy.profilePins,
    });
    return record.receipt;
  }
  async commit(tenantId: string, proposed: CheckpointCommitRequest): Promise<CheckpointReceipt> {
    const request = CheckpointCommitRequestSchema.parse(structuredClone(proposed));
    this.validateManifest(tenantId, request.manifest);
    const scopeId = checkpointScopeId(request.manifest.scope);
    const requestDigest = sha256Digest(canonicalizeJson(request));
    const existing = await this.store.findByKey({ tenantId, scopeId, idempotencyKey: request.idempotencyKey });
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new Error("CHECKPOINT_IDEMPOTENCY_CONFLICT");
      await this.read(tenantId, {
        checkpointId: existing.receipt.checkpointId,
        expectedScope: request.manifest.scope,
        expectedProfilePins: this.policy.profilePins,
      });
      return existing.receipt;
    }
    const previous = request.expectedHead
      ? await this.store.read({ tenantId, checkpointId: request.expectedHead })
      : undefined;
    if (request.expectedHead && (!previous || previous.receipt.scopeId !== scopeId))
      throw new Error("CHECKPOINT_PARENT_SCOPE_MISMATCH");
    const roots = manifestArtifacts(request.manifest);
    const previousArtifacts = previous ? [previous.receipt.manifestArtifact] : [];
    for (const historical of previousArtifacts) await this.requireManifestArtifact(tenantId, historical);
    const closure = await this.verifyClosure(
      tenantId,
      roots,
      new Set(previousArtifacts.map((artifact) => artifact.artifactId)),
    );
    if (request.manifest.mode === "continuation") await this.validateContinuation(tenantId, request.manifest);
    const bytes = new TextEncoder().encode(canonicalizeJson(request.manifest));
    if (bytes.byteLength > this.policy.maximumManifestBytes) throw new Error("CHECKPOINT_MANIFEST_BYTE_LIMIT");
    const parentArtifactIds = [
      ...new Set([...roots, ...previousArtifacts].map((artifact) => artifact.artifactId)),
    ].sort();
    const manifestArtifact = await this.custody.registerManifest({
      tenantId,
      manifest: request.manifest,
      bytes,
      parentArtifactIds,
    });
    if (manifestArtifact.digest !== sha256Digest(bytes)) throw new Error("CHECKPOINT_MANIFEST_REGISTRATION_MISMATCH");
    requireSame(
      parentArtifactIds,
      [...manifestArtifact.parentArtifactIds].sort(),
      "CHECKPOINT_MANIFEST_PARENT_MISMATCH",
    );
    await this.requireManifestArtifact(tenantId, manifestArtifact);
    return this.store.commit({
      tenantId,
      scopeId,
      request,
      requestDigest,
      manifestArtifact,
      closure: [manifestArtifact, ...closure, ...previousArtifacts],
    });
  }
  async head(tenantId: string, proposed: CheckpointScope): Promise<CheckpointReceipt | undefined> {
    const scope = CheckpointScopeSchema.parse(proposed);
    if (scope.tenantId !== tenantId) throw new Error("CHECKPOINT_TENANT_DENIED");
    const receipt = await this.store.head({ tenantId, scopeId: checkpointScopeId(scope) });
    if (receipt)
      await this.read(tenantId, {
        checkpointId: receipt.checkpointId,
        expectedScope: scope,
        expectedProfilePins: this.policy.profilePins,
      });
    return receipt;
  }
  async read(tenantId: string, proposed: CheckpointRestoreRequest): Promise<CheckpointRestoreResult> {
    const request = CheckpointRestoreRequestSchema.parse(proposed);
    if (request.expectedScope.tenantId !== tenantId) throw new Error("CHECKPOINT_TENANT_DENIED");
    requireSame(this.policy.profilePins, request.expectedProfilePins, "CHECKPOINT_PROFILE_MISMATCH");
    const record = await this.store.read({ tenantId, checkpointId: request.checkpointId });
    if (!record) throw new Error("CHECKPOINT_NOT_FOUND");
    if (record.receipt.scopeId !== checkpointScopeId(request.expectedScope))
      throw new Error("CHECKPOINT_SCOPE_MISMATCH");
    const stored = await this.requireManifestArtifact(tenantId, record.receipt.manifestArtifact);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes);
    const manifest = CheckpointManifestSchema.parse(JSON.parse(text));
    if (text !== canonicalizeJson(manifest)) throw new Error("CHECKPOINT_MANIFEST_NOT_CANONICAL");
    if (manifest.mode !== record.receipt.mode) throw new Error("CHECKPOINT_RECEIPT_MODE_MISMATCH");
    requireSame(manifest.scope, request.expectedScope, "CHECKPOINT_SCOPE_MISMATCH");
    this.validateManifest(tenantId, manifest);
    const previous = manifest.parentCheckpointId
      ? await this.store.read({ tenantId, checkpointId: manifest.parentCheckpointId })
      : undefined;
    if (manifest.parentCheckpointId && (!previous || previous.receipt.scopeId !== record.receipt.scopeId))
      throw new Error("CHECKPOINT_PARENT_SCOPE_MISMATCH");
    const expectedParents = [
      ...new Set([
        ...manifestArtifacts(manifest).map((artifact) => artifact.artifactId),
        ...(previous ? [previous.receipt.manifestArtifact.artifactId] : []),
      ]),
    ].sort();
    requireSame(
      expectedParents,
      [...record.receipt.manifestArtifact.parentArtifactIds].sort(),
      "CHECKPOINT_MANIFEST_PARENT_MISMATCH",
    );
    if (previous) await this.requireManifestArtifact(tenantId, previous.receipt.manifestArtifact);
    await this.verifyClosure(
      tenantId,
      manifestArtifacts(manifest),
      new Set(previous ? [previous.receipt.manifestArtifact.artifactId] : []),
    );
    if (manifest.mode === "continuation") await this.validateContinuation(tenantId, manifest);
    return CheckpointRestoreResultSchema.parse({
      receipt: record.receipt,
      manifest,
      ready: manifest.mode === "continuation" && manifest.pendingOperations.length === 0,
      operationOutcomes: [],
      unresolved: manifest.pendingOperations,
    });
  }
  async restore(tenantId: string, request: CheckpointRestoreRequest): Promise<CheckpointRestoreResult> {
    const read = await this.read(tenantId, request);
    const outcomes = [];
    const reconciledRoots: VerificationArtifactHandle[] = [];
    for (const operation of read.manifest.pendingOperations) {
      const outcome = CheckpointOperationOutcomeSchema.parse(
        await this.reconciler.reconcile({ tenantId, scope: read.manifest.scope, operation }),
      );
      requireSame(
        operation,
        { owner: outcome.owner, operationId: outcome.operationId, requestDigest: outcome.requestDigest },
        "CHECKPOINT_OPERATION_BINDING",
      );
      reconciledRoots.push(...outcome.artifacts);
      outcomes.push(outcome);
    }
    const reconciledArtifacts = await this.verifyClosure(tenantId, reconciledRoots);
    await this.store.pinReconciledArtifacts({
      tenantId,
      checkpointId: read.receipt.checkpointId,
      artifactIds: reconciledArtifacts.map((artifact) => artifact.artifactId),
    });
    const unresolved = outcomes
      .filter((outcome) => outcome.state !== "settled")
      .map(({ owner, operationId, requestDigest }) => ({ owner, operationId, requestDigest }));
    return {
      ...read,
      operationOutcomes: outcomes,
      unresolved,
      ready: read.manifest.mode === "continuation" && unresolved.length === 0,
    };
  }
  async tombstone(tenantId: string, proposed: CheckpointTombstoneRequest): Promise<void> {
    const request = CheckpointTombstoneRequestSchema.parse(proposed);
    await this.store.tombstone({ tenantId, ...request });
  }
  private async validateContinuation(tenantId: string, manifest: CheckpointManifest): Promise<void> {
    await this.custody.validateExecutorState({
      tenantId,
      scope: manifest.scope,
      artifact: manifest.executorStateArtifact!,
    });
    await this.custody.validateSemanticHandoff({
      tenantId,
      scope: manifest.scope,
      artifact: manifest.semanticHandoffArtifact!,
      pendingOperations: manifest.pendingOperations,
    });
  }
  private validateManifest(tenantId: string, manifest: CheckpointManifest): void {
    if (manifest.scope.tenantId !== tenantId) throw new Error("CHECKPOINT_TENANT_DENIED");
    const pins = CheckpointProfilePinsSchema.parse({
      storageProfileVersion: manifest.storageProfileVersion,
      storageProfileDigest: manifest.storageProfileDigest,
      retentionPolicyVersion: manifest.retentionPolicyVersion,
      retentionPolicyDigest: manifest.retentionPolicyDigest,
      capabilityProfileVersion: manifest.capabilityProfileVersion,
      capabilityProfileDigest: manifest.capabilityProfileDigest,
    });
    requireSame(pins, this.policy.profilePins, "CHECKPOINT_PROFILE_MISMATCH");
    if (manifest.files.length > this.policy.maximumFiles) throw new Error("CHECKPOINT_FILE_LIMIT");
    if (manifest.files.reduce((total, file) => total + file.artifact.byteLength, 0) > this.policy.maximumBytes)
      throw new Error("CHECKPOINT_FILE_BYTE_LIMIT");
    for (const file of manifest.files) assertCheckpointPath(file.path, this.policy.allowedRoots);
    if (manifestArtifacts(manifest).length === 0) throw new Error("CHECKPOINT_EMPTY_ARCHIVE");
  }
  private async requireArtifact(tenantId: string, proposed: VerificationArtifactHandle) {
    const artifact = VerificationArtifactHandleSchema.parse(proposed);
    if (artifact.tenantId !== tenantId) throw new Error("CHECKPOINT_ARTIFACT_TENANT_DENIED");
    await this.store.assertLive({ tenantId, artifactIds: [artifact.artifactId] });
    const stored = await this.custody.resolve({ tenantId, artifactId: artifact.artifactId });
    if (!stored) throw new Error("CHECKPOINT_ARTIFACT_UNAVAILABLE");
    requireSame(artifact, stored.handle, "CHECKPOINT_ARTIFACT_IDENTITY_MISMATCH");
    if (stored.bytes.byteLength !== artifact.byteLength || sha256Digest(stored.bytes) !== artifact.digest)
      throw new Error("CHECKPOINT_ARTIFACT_DIGEST_MISMATCH");
    return stored;
  }
  private async requireManifestArtifact(tenantId: string, artifact: VerificationArtifactHandle) {
    if (artifact.byteLength > this.policy.maximumManifestBytes) throw new Error("CHECKPOINT_MANIFEST_BYTE_LIMIT");
    return this.requireArtifact(tenantId, artifact);
  }
  private async verifyClosure(
    tenantId: string,
    roots: readonly VerificationArtifactHandle[],
    historicalLeaves: ReadonlySet<string> = new Set(),
  ): Promise<VerificationArtifactHandle[]> {
    const queue = [...roots];
    const verified = new Map<string, VerificationArtifactHandle>();
    let bytes = 0;
    while (queue.length) {
      const artifact = queue.shift()!;
      const prior = verified.get(artifact.artifactId);
      if (prior) {
        requireSame(prior, artifact, "CHECKPOINT_ARTIFACT_IDENTITY_MISMATCH");
        continue;
      }
      if (verified.size >= this.policy.maximumClosureArtifacts) throw new Error("CHECKPOINT_CLOSURE_LIMIT");
      const stored = await this.requireArtifact(tenantId, artifact);
      bytes += stored.bytes.byteLength;
      if (bytes > this.policy.maximumClosureBytes) throw new Error("CHECKPOINT_CLOSURE_BYTE_LIMIT");
      verified.set(artifact.artifactId, artifact);
      if (historicalLeaves.has(artifact.artifactId)) continue;
      for (const parentId of [
        ...artifact.parentArtifactIds,
        ...(artifact.attestationArtifactId ? [artifact.attestationArtifactId] : []),
      ]) {
        if (verified.has(parentId)) continue;
        const parent = await this.custody.resolve({ tenantId, artifactId: parentId });
        if (!parent) throw new Error("CHECKPOINT_DEPENDENCY_UNAVAILABLE");
        queue.push(parent.handle);
      }
    }
    return [...verified.values()];
  }
}
