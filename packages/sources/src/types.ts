import type { StoredArtifact } from "@aiengineer/knowledge-core";
export type AcquisitionTarget =
  | { kind: "http"; url: string }
  | { kind: "upload"; uploadId: string; declaredOrigin: string }
  | {
      kind: "repository";
      host: string;
      owner: string;
      repository: string;
      commitSha: string;
      sparsePaths?: readonly string[];
    }
  | { kind: "paper"; identifierKind: "doi" | "arxiv" | "openreview"; identifier: string };
export interface AcquisitionRequest {
  tenantId: string;
  purpose: string;
  target: AcquisitionTarget;
  expectedSourceClass: string;
  preferredMediaTypes: readonly string[];
  authenticationReference?: string;
  egressProfile: string;
  maximumBytes: number;
  maximumPages?: number;
  maximumDepth?: number;
  renderingPolicy: "none" | "allowed" | "required";
  interactionPolicy: "none" | "bounded";
  freshnessRequirement?: string;
  classification: "public" | "restricted" | "confidential" | "sensitive";
  expectedOutputs: readonly string[];
}
export interface SupportDecision {
  supported: boolean;
  reason: string;
}
export interface AcquisitionPlan {
  adapterKey: string;
  adapterVersion: string;
  request: AcquisitionRequest;
  normalizedTarget: string;
  policyDigest: string;
}
export interface AdmittedAcquisitionPlan extends AcquisitionPlan {
  admissionId: string;
}
export interface AcquisitionObservation {
  key: string;
  value: string;
}
export interface AcquisitionResult {
  plan: AdmittedAcquisitionPlan;
  artifacts: readonly StoredArtifact[];
  contentDigests: readonly string[];
  observations: readonly AcquisitionObservation[];
  discoveredCanonicalIdentifiers: readonly string[];
  captureMethod: string;
  retryAdvice: "none" | "retry" | "manual_review";
  costMicros: number;
  errors: readonly { code: string; message: string }[];
}
export interface AcquisitionVerification {
  accepted: boolean;
  checks: readonly string[];
  findings: readonly string[];
}
export interface AcquisitionAdapter {
  readonly adapterKey: string;
  readonly version: string;
  supports(request: AcquisitionRequest): SupportDecision;
  plan(request: AcquisitionRequest): Promise<AcquisitionPlan>;
  execute(plan: AdmittedAcquisitionPlan): Promise<AcquisitionResult>;
  verify(result: AcquisitionResult): Promise<AcquisitionVerification>;
}

export interface RepositoryManifest {
  host: string;
  owner: string;
  repository: string;
  commitSha: string;
  archiveDigest: string;
  submodulePolicy: string;
  sparsePaths: readonly string[];
  lfsObjects: readonly string[];
  licenseFiles: readonly string[];
  lockfiles: readonly string[];
  excludedPaths: readonly string[];
  languages: Readonly<Record<string, number>>;
  sourcePaths: readonly string[];
  secretLikeFindings?: readonly { path: string; kind: string }[];
}
export interface PaperResolution {
  identifierKind: "doi" | "arxiv" | "openreview";
  identifier: string;
  title: string;
  authors: readonly string[];
  revision: string;
  publicationState: string;
  correctionState: string;
  representations: readonly { mediaType: string; url: string }[];
}
export interface ManualUploadAttestation {
  uploadId: string;
  origin: string;
  method: string;
  acquiredAt: string;
  accessAndRightsContext: string;
  automaticFailureReason: string;
}
export interface RepositoryAcquisitionAdapter extends AcquisitionAdapter {
  inspectManifest(plan: AdmittedAcquisitionPlan): Promise<RepositoryManifest>;
}
export interface PaperAcquisitionAdapter extends AcquisitionAdapter {
  resolvePaper(request: AcquisitionRequest): Promise<PaperResolution>;
}
export interface UploadAcquisitionAdapter extends AcquisitionAdapter {
  verifyAttestation(attestation: ManualUploadAttestation): Promise<AcquisitionVerification>;
}
