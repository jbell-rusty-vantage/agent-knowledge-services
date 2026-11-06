import type { VERIFICATION_CONTRACT_VERSION } from "../versions.js";
import type {
  DeterministicVerificationResult,
  SemanticAssessmentRecord,
  VerificationArtifactHandle,
  VerificationBundle,
  VerificationRecordedPolicyInputs,
  VerificationRunManifest,
} from "@aiengineer/knowledge-contracts";

export interface VerificationPolicyBinding {
  readonly policyVersion: string;
  readonly policyArtifact: VerificationArtifactHandle;
  readonly recordedPolicyInputsArtifact: VerificationArtifactHandle;
}

/** Detached fields are excluded from the payload they authenticate. */
export interface DetachedAuditSeal {
  readonly payloadDigest: `sha256:${string}`;
  readonly signatureAlgorithm?: "Ed25519";
  readonly keyId?: string;
  readonly signatureBase64?: string;
}

export interface VerificationAuditBundle {
  readonly verificationContractVersion: typeof VERIFICATION_CONTRACT_VERSION;
  readonly tenantId: string;
  readonly verificationBundle: VerificationBundle;
  readonly manifest: VerificationRunManifest;
  readonly policyBinding: VerificationPolicyBinding;
  readonly deterministicResultDigest: `sha256:${string}`;
  readonly policyDecisionDigest: `sha256:${string}`;
  readonly seal: DetachedAuditSeal;
}

export interface AuditBundleInspection {
  readonly valid: boolean;
  readonly payloadDigest: `sha256:${string}`;
  readonly manifestDigest: `sha256:${string}`;
  readonly signatureStatus: "unsigned" | "verified" | "unverified" | "invalid";
  readonly errors: readonly string[];
}

export interface AuthorizedArtifactHydration {
  readonly registration: VerificationArtifactHandle;
  readonly bytes: Uint8Array;
}

/** Application composition must authorize before hydrateRegisteredArtifact is called. */
export interface TrustedArtifactResolver {
  authorizeArtifact(input: {
    readonly tenantId: string;
    readonly artifactId: string;
    readonly purpose: "verification_replay" | "policy_replay" | "verification_admission";
  }): Promise<void>;
  hydrateRegisteredArtifact(input: {
    readonly tenantId: string;
    readonly artifactId: string;
  }): Promise<AuthorizedArtifactHydration>;
}

export interface AuditBundleSigner {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  sign(payload: Uint8Array): Promise<string>;
}

export interface AuditBundleSignatureVerifier {
  verify(input: {
    readonly keyId: string;
    readonly payload: Uint8Array;
    readonly signatureBase64: string;
  }): Promise<boolean>;
}

export interface VerificationPolicyReplayPort {
  replay(input: {
    readonly tenantId: string;
    readonly policyVersion: string;
    readonly policyArtifact: VerificationArtifactHandle;
    readonly policyBytes: Uint8Array;
    readonly recordedPolicyInputsArtifact: VerificationArtifactHandle;
    readonly recordedPolicyInputsBytes: Uint8Array;
    readonly recordedPolicyInputs: VerificationRecordedPolicyInputs;
    readonly verificationBundle: VerificationBundle;
    readonly deterministicResult: DeterministicVerificationResult;
  }): Promise<{
    readonly outcome: VerificationRunManifest["policyOutcome"];
    readonly decision: unknown;
  }>;
}

export interface VerificationReplayResult {
  readonly inspection: AuditBundleInspection;
  readonly deterministicResult: DeterministicVerificationResult;
  readonly deterministicResultDigest: `sha256:${string}`;
  readonly policyOutcome: VerificationRunManifest["policyOutcome"];
  readonly policyDecisionDigest: `sha256:${string}`;
  readonly replayedArtifactIds: readonly string[];
}

export interface VerificationSemanticReplayPort {
  replay(input: {
    readonly auditBundle: VerificationAuditBundle;
    readonly deterministicResult: DeterministicVerificationResult;
    readonly recordedPolicyInputs: VerificationRecordedPolicyInputs;
    readonly verifiedRepresentationBytes: ReadonlyMap<string, Uint8Array>;
  }): Promise<{
    readonly assessments: readonly SemanticAssessmentRecord[];
    readonly replayedArtifactIds: readonly string[];
  }>;
}
