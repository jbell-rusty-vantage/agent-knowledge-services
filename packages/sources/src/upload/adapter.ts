import { sha256Digest } from "@aiengineer/knowledge-core";
import { digestBytes, type ArtifactStore } from "@aiengineer/knowledge-core";
import type {
  AcquisitionPlan,
  AcquisitionRequest,
  AcquisitionResult,
  AcquisitionVerification,
  AdmittedAcquisitionPlan,
  ManualUploadAttestation,
  SupportDecision,
  UploadAcquisitionAdapter,
} from "../types.js";
import { normalizeUploadPath, UPLOAD_ID_PATTERN } from "./path.js";

export interface ManualUploadRecord {
  uploadId: string;
  relativePath: string;
  mediaType: string;
  bytes: Uint8Array;
  declaredDigest?: string;
  attestation: ManualUploadAttestation;
}

export interface ManualUploadSource {
  get(uploadId: string): Promise<ManualUploadRecord | undefined>;
}

export interface ManualUploadPolicy {
  maximumBytes: number;
  maximumPathLength: number;
  allowedMediaTypes?: readonly string[];
}

export class BoundedManualUploadAdapter implements UploadAcquisitionAdapter {
  readonly adapterKey = "manual-upload";
  readonly version = "1.0.0";
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly source: ManualUploadSource,
    private readonly policy: ManualUploadPolicy,
  ) {}
  supports(request: AcquisitionRequest): SupportDecision {
    return request.target.kind === "upload"
      ? { supported: true, reason: "bounded manual upload" }
      : { supported: false, reason: "upload target required" };
  }
  async plan(request: AcquisitionRequest): Promise<AcquisitionPlan> {
    if (request.target.kind !== "upload") throw new Error("UNSUPPORTED_TARGET");
    if (!UPLOAD_ID_PATTERN.test(request.target.uploadId)) throw new Error("UPLOAD_ID_INVALID");
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.version,
      request,
      normalizedTarget: `upload:${request.target.uploadId}`,
      policyDigest: sha256Digest({
        maximumBytes: this.policy.maximumBytes,
        maximumPathLength: this.policy.maximumPathLength,
        allowedMediaTypes: [...(this.policy.allowedMediaTypes ?? [])],
      }),
    };
  }
  async execute(plan: AdmittedAcquisitionPlan): Promise<AcquisitionResult> {
    if (plan.request.target.kind !== "upload") throw new Error("UNSUPPORTED_TARGET");
    const record = await this.loadRecord(plan.request.target.uploadId);
    const path = this.admitRecord(record, plan.request.maximumBytes);
    if (!(await this.attestationBindsTo(record, plan.request.target.declaredOrigin)))
      throw new Error("UPLOAD_ATTESTATION_INVALID");
    const artifact = await this.artifacts.put({
      tenantId: plan.request.tenantId,
      mediaType: record.mediaType,
      bytes: record.bytes,
    });
    return {
      plan,
      artifacts: [artifact],
      contentDigests: [artifact.digest],
      observations: [
        { key: "path", value: path },
        { key: "origin", value: record.attestation.origin },
        { key: "acquired_at", value: record.attestation.acquiredAt },
        { key: "rights_context", value: record.attestation.accessAndRightsContext },
      ],
      discoveredCanonicalIdentifiers: [plan.normalizedTarget],
      captureMethod: `${this.adapterKey}@${this.version}`,
      retryAdvice: "none",
      costMicros: 0,
      errors: [],
    };
  }
  async verify(result: AcquisitionResult): Promise<AcquisitionVerification> {
    const findings = hasSingleSealedArtifact(result) ? [] : ["artifact_digest_mismatch"];
    return {
      accepted: findings.length === 0,
      checks: ["bounded_content", "safe_relative_path", "attestation", "digest"],
      findings,
    };
  }
  async verifyAttestation(value: ManualUploadAttestation): Promise<AcquisitionVerification> {
    const findings = attestationFindings(value);
    return {
      accepted: findings.length === 0,
      checks: ["origin", "method", "rights_context", "timestamp"],
      findings,
    };
  }
  private async loadRecord(uploadId: string): Promise<ManualUploadRecord> {
    const record = await this.source.get(uploadId);
    if (!record || record.uploadId !== uploadId) throw new Error("UPLOAD_NOT_FOUND");
    return record;
  }
  private admitRecord(record: ManualUploadRecord, requestMaximumBytes: number): string {
    const path = normalizeUploadPath(record.relativePath, this.policy.maximumPathLength);
    this.assertWithinByteLimit(record, requestMaximumBytes);
    this.assertAllowedMediaType(record);
    this.assertDeclaredDigest(record);
    return path;
  }
  private assertWithinByteLimit(record: ManualUploadRecord, requestMaximumBytes: number): void {
    if (record.bytes.byteLength > Math.min(requestMaximumBytes, this.policy.maximumBytes))
      throw new Error("BYTE_LIMIT_EXCEEDED");
  }
  private assertAllowedMediaType(record: ManualUploadRecord): void {
    if (this.policy.allowedMediaTypes && !this.policy.allowedMediaTypes.includes(record.mediaType))
      throw new Error("MEDIA_TYPE_DENIED");
  }
  private assertDeclaredDigest(record: ManualUploadRecord): void {
    if (record.declaredDigest && record.declaredDigest !== digestBytes(record.bytes))
      throw new Error("UPLOAD_DIGEST_MISMATCH");
  }
  private async attestationBindsTo(record: ManualUploadRecord, declaredOrigin: string): Promise<boolean> {
    const attestation = await this.verifyAttestation(record.attestation);
    return (
      attestation.accepted &&
      record.attestation.uploadId === record.uploadId &&
      record.attestation.origin === declaredOrigin
    );
  }
}

function hasSingleSealedArtifact(result: AcquisitionResult): boolean {
  return result.artifacts.length === 1 && result.artifacts[0]?.digest === result.contentDigests[0];
}

function attestationFindings(value: ManualUploadAttestation): string[] {
  const findings: string[] = [];
  if (!value.uploadId || !value.origin || !value.method || !value.accessAndRightsContext)
    findings.push("attestation_incomplete");
  if (!Number.isFinite(Date.parse(value.acquiredAt))) findings.push("acquired_at_invalid");
  if (value.automaticFailureReason) findings.push("automatic_failure_reported");
  return findings;
}
