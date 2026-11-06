import {
  UuidSchema,
  VerificationStructuredExtractionResultSchema,
  VerificationStructuredExtractionFailureResultSchema,
  VerificationStructuredExtractionResourceSchema,
  VerificationStructuredExtractionPublicationSchema,
  VerificationStructuredExtractionFailureSchema,
  type VerificationStructuredExtractionResource,
} from "@aiengineer/knowledge-contracts";
import { deepFreeze } from "@aiengineer/knowledge-core";

/** Implementations must authenticate canonical terminal receipts and original signed Storage bytes. */
export interface VerifiedStructuredExtractionReadPort {
  loadVerifiedExtraction(
    tenantId: string,
    operationId: string,
  ): Promise<{ readonly kind: "accepted" | "failed"; readonly result: unknown; readonly manifest: unknown }>;
}
export class VerificationStructuredExtractionReadError extends Error {
  constructor(readonly code: "INVALID" | "NOT_FOUND" | "INTEGRITY") {
    super(`VERIFICATION_STRUCTURED_EXTRACTION_READ_${code}`);
  }
}
export class VerificationStructuredExtractionReadService {
  constructor(private readonly publications: VerifiedStructuredExtractionReadPort) {}
  async getExtraction(input: {
    tenantId: unknown;
    operationId: unknown;
  }): Promise<VerificationStructuredExtractionResource> {
    const tenant = UuidSchema.safeParse(input.tenantId),
      operation = UuidSchema.safeParse(input.operationId);
    if (!tenant.success || !operation.success) throw new VerificationStructuredExtractionReadError("INVALID");
    const snapshot = await this.publications.loadVerifiedExtraction(tenant.data, operation.data);
    try {
      const result =
        snapshot.kind === "accepted"
          ? VerificationStructuredExtractionResultSchema.parse(snapshot.result)
          : VerificationStructuredExtractionFailureResultSchema.parse(snapshot.result);
      const manifest =
        snapshot.kind === "accepted"
          ? VerificationStructuredExtractionPublicationSchema.parse(snapshot.manifest)
          : VerificationStructuredExtractionFailureSchema.parse(snapshot.manifest);
      if (
        result.operationId !== operation.data ||
        manifest.operationId !== operation.data ||
        manifest.tenantId !== tenant.data ||
        result.resultArtifact.tenantId !== tenant.data ||
        result.requestDigest !== manifest.requestDigest ||
        result.output.manifestDigest !== manifest.seal.payloadDigest ||
        result.output.providerCallDigest !== manifest.providerCallDigest
      )
        throw new Error("BINDING");
      return deepFreeze(
        VerificationStructuredExtractionResourceSchema.parse({
          verificationContractVersion: "verification.v1",
          tenantId: tenant.data,
          operationId: operation.data,
          requestDigest: result.requestDigest,
          publication: {
            artifact: { artifactId: result.resultArtifact.artifactId, digest: result.resultArtifact.digest },
            signatureStatus: "verified",
            purpose: "artifact_custody_only",
          },
          output: result.output,
        }),
      );
    } catch {
      throw new VerificationStructuredExtractionReadError("INTEGRITY");
    }
  }
}
