import { z } from "zod";
import {
  VerificationArtifactHandleSchema,
  VerificationProviderReconciliationSchema,
  VerificationStructuredExtractionExecutionSchema,
  type VerificationArtifactHandle,
  type VerificationProviderReconciliation,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";
import {
  canonicalizeJson,
  digestCanonicalJson,
  sha256Digest,
  type TrustedArtifactResolver,
  type AuditBundleSignatureVerifier,
} from "@aiengineer/knowledge-verification";
import {
  structuredExtractionExecutionParentArtifactIds,
  structuredExtractionExecutionTransformationSignature,
} from "./verification-structured-extraction-publication.js";

const grantSchema = z.strictObject({
  tenantId: z.uuid(),
  providerId: z.enum(["gateway-structured-extraction.v1", "interfaze-extraction.v1"]),
  keyId: z.string().min(1).max(120),
  operatorId: z.string().min(1).max(120),
  basis: z.enum(["synthetic_fixture", "supplier_statement"]),
});
export type ProviderReconciliationAuthorityGrant = z.infer<typeof grantSchema>;
export interface AdmittedProviderReconciliation {
  readonly receipt: VerificationProviderReconciliation;
  readonly artifact: VerificationArtifactHandle;
}
export function providerReconciliationParents(receipt: VerificationProviderReconciliation) {
  return [
    receipt.executionArtifact.artifactId,
    receipt.requestArtifact.artifactId,
    receipt.billingEvidenceArtifact.artifactId,
  ];
}
export function providerReconciliationTransformationSignature(receipt: VerificationProviderReconciliation) {
  return digestCanonicalJson({
    schemaVersion: "verification-provider-reconciliation-artifact.v1",
    tenantId: receipt.tenantId,
    providerAttemptId: receipt.providerAttemptId,
    payloadDigest: receipt.seal.payloadDigest,
    parents: providerReconciliationParents(receipt),
  });
}

/** No accounting mutation or dispatch port. Persistence must recheck original durable identity under lock. */
export class ProviderReconciliationAdmission {
  readonly #grants: readonly ProviderReconciliationAuthorityGrant[];
  readonly #permits = new WeakSet<object>();
  constructor(
    grants: readonly ProviderReconciliationAuthorityGrant[],
    private readonly createResolver: () => TrustedArtifactResolver,
    private readonly verifier: AuditBundleSignatureVerifier,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#grants = deepFreeze(z.array(grantSchema).min(1).max(256).parse(grants));
    const keys = this.#grants.map((grant) => canonicalizeJson(grant));
    if (new Set(keys).size !== keys.length) throw new Error("PROVIDER_RECONCILIATION_DUPLICATE_GRANT");
  }
  assertPermit(value: AdmittedProviderReconciliation): AdmittedProviderReconciliation {
    if (!this.#permits.has(value)) throw new Error("PROVIDER_RECONCILIATION_ISSUER_REQUIRED");
    this.#time(value.receipt);
    return value;
  }
  /** Authenticate historical evidence at a durable application time. This never issues a mutation permit. */
  async verifyEvidenceAt(input: {
    tenantId: string;
    artifact: VerificationArtifactHandle;
    appliedAt: string;
    signal?: AbortSignal;
  }): Promise<AdmittedProviderReconciliation> {
    const appliedAt = z.iso.datetime().parse(input.appliedAt),
      instant = new Date(appliedAt),
      current = this.now().getTime();
    if (instant.toISOString() !== appliedAt || !Number.isFinite(current) || instant.getTime() > current)
      throw new Error("PROVIDER_RECONCILIATION_INVALID_APPLICATION_TIME");
    // A separate issuer keeps historical validation entirely outside this instance's mutation permits.
    const historical = new ProviderReconciliationAdmission(
      this.#grants,
      this.createResolver,
      this.verifier,
      () => instant,
    );
    const verified = await historical.admit(input);
    return deepFreeze({ receipt: verified.receipt, artifact: verified.artifact });
  }
  async admit(input: {
    tenantId: string;
    artifact: VerificationArtifactHandle;
    signal?: AbortSignal;
  }): Promise<AdmittedProviderReconciliation> {
    const tenantId = z.uuid().parse(input.tenantId),
      artifact = deepFreeze(VerificationArtifactHandleSchema.parse(input.artifact)),
      signal = input.signal;
    try {
      if (artifact.tenantId !== tenantId || !this.#grants.some((grant) => grant.tenantId === tenantId))
        throw new Error("TENANT");
      const bytes = await this.#hydrate(tenantId, artifact, 256_000, signal),
        receipt = VerificationProviderReconciliationSchema.parse(this.#decode(bytes));
      this.#time(receipt);
      if (
        receipt.tenantId !== tenantId ||
        !this.#grants.some(
          (grant) =>
            grant.tenantId === tenantId &&
            grant.providerId === receipt.providerId &&
            grant.keyId === receipt.seal.signature.keyId &&
            grant.operatorId === receipt.operatorId &&
            grant.basis === receipt.decision.basis,
        )
      )
        throw new Error("AUTHORITY");
      const { seal, ...body } = receipt;
      if (
        [receipt.executionArtifact, receipt.requestArtifact, receipt.billingEvidenceArtifact].some(
          (evidence) => Date.parse(evidence.createdAt) > Date.parse(receipt.issuedAt),
        )
      )
        throw new Error("EVIDENCE_TIME");
      if (
        digestCanonicalJson(body) !== seal.payloadDigest ||
        Buffer.from(seal.signature.signatureBase64, "base64").toString("base64") !== seal.signature.signatureBase64 ||
        !(await this.verifier.verify({
          keyId: seal.signature.keyId,
          payload: new TextEncoder().encode(canonicalizeJson(body)),
          signatureBase64: seal.signature.signatureBase64,
        }))
      )
        throw new Error("SIGNATURE");
      if (
        artifact.createdAt !== receipt.issuedAt ||
        artifact.producerActivityId !== "verification-service:provider-reconciliation" ||
        canonicalizeJson(artifact.parentArtifactIds) !== canonicalizeJson(providerReconciliationParents(receipt)) ||
        artifact.transformationSignature !== providerReconciliationTransformationSignature(receipt)
      )
        throw new Error("ARTIFACT_BINDING");
      const execution = VerificationStructuredExtractionExecutionSchema.parse(
        this.#decode(await this.#hydrate(tenantId, receipt.executionArtifact, 256_000, signal)),
      );
      const parents = structuredExtractionExecutionParentArtifactIds(execution);
      if (
        execution.tenantId !== tenantId ||
        execution.operationId !== receipt.operationId ||
        execution.operationStepId !== receipt.operationStepId ||
        (execution.execution.mode === "synthetic_transport") !== (receipt.decision.basis === "synthetic_fixture") ||
        receipt.executionArtifact.createdAt !== execution.createdAt ||
        canonicalizeJson(receipt.executionArtifact.parentArtifactIds) !== canonicalizeJson(parents) ||
        receipt.executionArtifact.transformationSignature !==
          structuredExtractionExecutionTransformationSignature({
            payloadDigest: receipt.executionArtifact.digest as `sha256:${string}`,
            tenantId,
            operationId: execution.operationId,
            operationStepId: execution.operationStepId,
            producerAttemptId: execution.producerAttemptId,
            requestDigest: execution.requestDigest as `sha256:${string}`,
            stepInputDigest: execution.stepInputDigest as `sha256:${string}`,
            profileDigest: execution.profileArtifact.digest as `sha256:${string}`,
            runtimeDigest: digestCanonicalJson(execution.runtime),
            mode: execution.execution.mode,
            createdAt: execution.createdAt,
            parentArtifactIds: parents,
          })
      )
        throw new Error("EXECUTION_BINDING");
      if (receipt.requestArtifact.digest !== receipt.requestDigest) throw new Error("REQUEST_BINDING");
      await this.#hydrate(tenantId, receipt.requestArtifact, 160_000, signal);
      await this.#hydrate(tenantId, receipt.billingEvidenceArtifact, 1_000_000, signal);
      this.#time(receipt);
      if (signal?.aborted) throw new Error("CANCELLED");
      const permit = deepFreeze({ receipt, artifact });
      this.#permits.add(permit);
      return permit;
    } catch {
      throw new Error("PROVIDER_RECONCILIATION_ADMISSION_DENIED");
    }
  }
  #time(receipt: VerificationProviderReconciliation) {
    const now = this.now().getTime();
    if (!Number.isFinite(now) || now < Date.parse(receipt.issuedAt) || now >= Date.parse(receipt.expiresAt))
      throw new Error("PROVIDER_RECONCILIATION_EXPIRED_OR_FUTURE");
  }
  #decode(bytes: Uint8Array): unknown {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      value: unknown = JSON.parse(raw);
    if (canonicalizeJson(value) !== raw) throw new Error("CANONICAL_BYTES");
    return value;
  }
  async #hydrate(tenantId: string, expected: VerificationArtifactHandle, limit: number, signal?: AbortSignal) {
    if (signal?.aborted || expected.tenantId !== tenantId || expected.byteLength > limit)
      throw new Error("SCOPE_OR_SIZE");
    const resolver = this.createResolver();
    await resolver.authorizeArtifact({ tenantId, artifactId: expected.artifactId, purpose: "verification_replay" });
    if (signal?.aborted) throw new Error("CANCELLED");
    const loaded = await resolver.hydrateRegisteredArtifact({ tenantId, artifactId: expected.artifactId }),
      bytes = loaded.bytes.slice();
    if (
      signal?.aborted ||
      bytes.byteLength !== expected.byteLength ||
      sha256Digest(bytes) !== expected.digest ||
      canonicalizeJson(VerificationArtifactHandleSchema.parse(loaded.registration)) !== canonicalizeJson(expected)
    )
      throw new Error("ARTIFACT_BYTES");
    return bytes;
  }
}
