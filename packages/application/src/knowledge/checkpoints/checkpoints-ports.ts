import type {
  CheckpointCommitRequest,
  CheckpointManifest,
  CheckpointOperationOutcome,
  CheckpointPendingOperation,
  CheckpointProfilePins,
  CheckpointReceipt,
  CheckpointScope,
  VerificationArtifactHandle,
} from "@aiengineer/knowledge-contracts";
export interface CheckpointCustody {
  validateExecutorState(input: {
    tenantId: string;
    scope: CheckpointScope;
    artifact: VerificationArtifactHandle;
  }): Promise<void>;
  validateSemanticHandoff(input: {
    tenantId: string;
    scope: CheckpointScope;
    artifact: VerificationArtifactHandle;
    pendingOperations: readonly CheckpointPendingOperation[];
  }): Promise<void>;
  resolve(input: { tenantId: string; artifactId: string }): Promise<
    | {
        handle: VerificationArtifactHandle;
        bytes: Uint8Array;
      }
    | undefined
  >;
  registerManifest(input: {
    tenantId: string;
    manifest: CheckpointManifest;
    bytes: Uint8Array;
    parentArtifactIds: readonly string[];
  }): Promise<VerificationArtifactHandle>;
}
export interface CheckpointOperationReconciler {
  reconcile(input: {
    tenantId: string;
    scope: CheckpointScope;
    operation: CheckpointPendingOperation;
  }): Promise<CheckpointOperationOutcome>;
}
export interface CheckpointPolicy {
  readonly profilePins: CheckpointProfilePins;
  readonly allowedRoots: readonly string[];
  readonly maximumFiles: number;
  readonly maximumBytes: number;
  readonly maximumClosureBytes: number;
  readonly maximumManifestBytes: number;
  readonly maximumClosureArtifacts: number;
}
export interface CheckpointStoredRecord {
  readonly receipt: CheckpointReceipt;
  readonly requestDigest: string;
}
export interface CheckpointStore {
  ensureScope(input: { tenantId: string; scopeId: string; scope: CheckpointScope }): Promise<void>;
  findScopeBySession(input: {
    tenantId: string;
    runId: string;
    producerAttemptId: string;
    sessionId: string;
  }): Promise<CheckpointScope | undefined>;
  findByKey(input: {
    tenantId: string;
    scopeId: string;
    idempotencyKey: string;
  }): Promise<CheckpointStoredRecord | undefined>;
  read(input: { tenantId: string; checkpointId: string }): Promise<CheckpointStoredRecord | undefined>;
  head(input: { tenantId: string; scopeId: string }): Promise<CheckpointReceipt | undefined>;
  commit(input: {
    tenantId: string;
    scopeId: string;
    request: CheckpointCommitRequest;
    requestDigest: string;
    manifestArtifact: VerificationArtifactHandle;
    closure: readonly VerificationArtifactHandle[];
  }): Promise<CheckpointReceipt>;
  pinReconciledArtifacts(input: {
    tenantId: string;
    checkpointId: string;
    artifactIds: readonly string[];
  }): Promise<void>;
  assertLive(input: { tenantId: string; artifactIds: readonly string[] }): Promise<void>;
  tombstone(input: { tenantId: string; artifactId: string; reason: string }): Promise<void>;
}
