import { sha256Digest } from "@aiengineer/knowledge-core";
import type { ArtifactStore } from "@aiengineer/knowledge-core";
import type { PaperAcquisitionAdapter as PaperAdapterContract } from "../types.js";
import type {
  AcquisitionPlan,
  AcquisitionRequest,
  AcquisitionResult,
  AcquisitionVerification,
  AdmittedAcquisitionPlan,
  PaperResolution,
  SupportDecision,
} from "../types.js";
import { normalizePaperIdentifier } from "./identity.js";

export interface ResolvedPaper {
  resolution: PaperResolution;
  representations: readonly {
    mediaType: string;
    url: string;
    bytes: Uint8Array;
  }[];
}
export interface PaperProvider {
  resolve(
    identifierKind: "doi" | "arxiv" | "openreview",
    normalizedIdentifier: string,
  ): Promise<ResolvedPaper | undefined>;
}

// Library only: `execute` is unwired until the capture-cardinality decision
// (docs/operations/internal-fallbacks-and-application-order.md).
export class IdentityBoundPaperAcquisitionAdapter implements PaperAdapterContract {
  readonly adapterKey = "paper-resolver";
  readonly version = "1.0.0";
  #resolutions = new Map<string, PaperResolution>();
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly provider: PaperProvider,
  ) {}
  supports(request: AcquisitionRequest): SupportDecision {
    if (request.target.kind !== "paper") return { supported: false, reason: "paper target required" };
    try {
      normalizePaperIdentifier(request.target.identifierKind, request.target.identifier);
      return {
        supported: true,
        reason: "recognized immutable scholarly identity",
      };
    } catch {
      return {
        supported: false,
        reason: "invalid DOI, arXiv, or OpenReview identity",
      };
    }
  }
  async plan(request: AcquisitionRequest): Promise<AcquisitionPlan> {
    if (request.target.kind !== "paper") throw new Error("UNSUPPORTED_TARGET");
    const identifier = normalizePaperIdentifier(request.target.identifierKind, request.target.identifier);
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.version,
      request,
      normalizedTarget: `${request.target.identifierKind}:${identifier}`,
      policyDigest: sha256Digest({
        acceptedIdentityKinds: ["doi", "arxiv", "openreview"],
        version: this.version,
      }),
    };
  }
  async resolvePaper(request: AcquisitionRequest): Promise<PaperResolution> {
    if (request.target.kind !== "paper") throw new Error("UNSUPPORTED_TARGET");
    const identifier = normalizePaperIdentifier(request.target.identifierKind, request.target.identifier);
    const resolved = await this.provider.resolve(request.target.identifierKind, identifier);
    if (!resolved) throw new Error("PAPER_NOT_FOUND");
    this.assertIdentity(request.target.identifierKind, identifier, resolved.resolution);
    return resolved.resolution;
  }
  private assertIdentity(kind: "doi" | "arxiv" | "openreview", identifier: string, resolution: PaperResolution): void {
    if (resolution.identifierKind !== kind || normalizePaperIdentifier(kind, resolution.identifier) !== identifier)
      throw new Error("PAPER_IDENTITY_MISMATCH");
    if (
      !resolution.title.trim() ||
      resolution.authors.length === 0 ||
      !resolution.revision.trim() ||
      resolution.representations.length === 0
    )
      throw new Error("PAPER_RESOLUTION_INCOMPLETE");
  }
  async execute(plan: AdmittedAcquisitionPlan): Promise<AcquisitionResult> {
    if (plan.request.target.kind !== "paper") throw new Error("UNSUPPORTED_TARGET");
    const identifier = normalizePaperIdentifier(plan.request.target.identifierKind, plan.request.target.identifier);
    const resolved = await this.provider.resolve(plan.request.target.identifierKind, identifier);
    if (!resolved) throw new Error("PAPER_NOT_FOUND");
    this.assertIdentity(plan.request.target.identifierKind, identifier, resolved.resolution);
    if (resolved.representations.length !== resolved.resolution.representations.length)
      throw new Error("PAPER_REPRESENTATION_MISMATCH");
    let total = 0;
    const artifacts = [];
    for (let index = 0; index < resolved.representations.length; index++) {
      const representation = resolved.representations[index]!;
      const declared = resolved.resolution.representations[index]!;
      if (representation.mediaType !== declared.mediaType || representation.url !== declared.url)
        throw new Error("PAPER_REPRESENTATION_MISMATCH");
      total += representation.bytes.byteLength;
      if (total > plan.request.maximumBytes) throw new Error("BYTE_LIMIT_EXCEEDED");
      artifacts.push(
        await this.artifacts.put({
          tenantId: plan.request.tenantId,
          mediaType: representation.mediaType,
          bytes: representation.bytes,
        }),
      );
    }
    this.#resolutions.set(plan.admissionId, resolved.resolution);
    return {
      plan,
      artifacts,
      contentDigests: artifacts.map((item) => item.digest),
      observations: [
        { key: "identity_kind", value: plan.request.target.identifierKind },
        { key: "revision", value: resolved.resolution.revision },
        {
          key: "publication_state",
          value: resolved.resolution.publicationState,
        },
        { key: "correction_state", value: resolved.resolution.correctionState },
      ],
      discoveredCanonicalIdentifiers: [plan.normalizedTarget],
      captureMethod: `${this.adapterKey}@${this.version}`,
      retryAdvice: "none",
      costMicros: 0,
      errors: [],
    };
  }
  async verify(result: AcquisitionResult): Promise<AcquisitionVerification> {
    const findings: string[] = [];
    if (!this.#resolutions.has(result.plan.admissionId)) findings.push("resolution_missing");
    if (
      result.artifacts.length === 0 ||
      result.artifacts.some((item, index) => item.digest !== result.contentDigests[index])
    )
      findings.push("artifact_digest_mismatch");
    return {
      accepted: findings.length === 0,
      checks: ["canonical_identity", "revision", "representation_identity", "artifact_digest"],
      findings,
    };
  }
}
