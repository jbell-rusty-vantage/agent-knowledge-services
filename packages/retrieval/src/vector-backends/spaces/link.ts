// The relational row binding a retrieval.vector_item to its projection target
// and admission does not exist in the pinned database contract 0.4.16. This
// type is the Knowledge Services side of that shape — a cross-repository
// proposal to ai-engineer-db-contract (Phase 2 memo §6.5c) — not a second
// storage authority. No caller exists yet; the S2 publication host and the
// F8 space_manifest are expected to agree on this shape once one lands.

/** Pure, storage-free. Mirrors contracts/src/promotion-selection.ts's TargetReference and SourceReference shapes. */
export interface VectorItemEntityLink {
  readonly tenantId: string;
  readonly vectorSpaceVersionId: string;
  readonly vectorItemId: string;
  readonly searchProjectionId: string;
  readonly target: {
    readonly projectionTargetId: string;
    readonly kind: "entity" | "claim" | "record" | "summary" | "chunk";
    readonly canonicalId: string;
  };
  readonly lineage: {
    readonly chunkId: string;
    readonly chunkDigest: string;
    readonly representationId: string;
    readonly representationDigest: string;
    readonly captureId: string;
    readonly sourceFamilyId: string;
  };
  readonly admission:
    | { readonly admissionDigest: string; readonly admittedAt: string }
    | { readonly state: "not_admitted" };
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function blank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Reports completeness; never throws. A `not_admitted` link is a valid,
 * incomplete link — callers decide whether an incomplete link blocks them.
 */
export function validateVectorItemEntityLink(link: VectorItemEntityLink): {
  complete: boolean;
  issues: readonly string[];
} {
  const issues: string[] = [];
  const requireIdentity = (label: string, value: string) => {
    if (blank(value)) issues.push(`${label} is empty`);
  };
  const requireDigest = (label: string, value: string) => {
    if (!DIGEST_PATTERN.test(value)) issues.push(`${label} is not a sha256 digest`);
  };

  requireIdentity("tenantId", link.tenantId);
  requireIdentity("vectorSpaceVersionId", link.vectorSpaceVersionId);
  requireIdentity("vectorItemId", link.vectorItemId);
  requireIdentity("searchProjectionId", link.searchProjectionId);
  requireIdentity("target.projectionTargetId", link.target.projectionTargetId);
  requireIdentity("target.canonicalId", link.target.canonicalId);
  requireIdentity("lineage.chunkId", link.lineage.chunkId);
  requireIdentity("lineage.representationId", link.lineage.representationId);
  requireIdentity("lineage.captureId", link.lineage.captureId);
  requireIdentity("lineage.sourceFamilyId", link.lineage.sourceFamilyId);

  if (link.target.kind === "chunk" && link.target.canonicalId !== link.lineage.chunkId) {
    issues.push("chunk target canonicalId must equal lineage.chunkId");
  }

  requireDigest("lineage.chunkDigest", link.lineage.chunkDigest);
  requireDigest("lineage.representationDigest", link.lineage.representationDigest);

  if ("state" in link.admission) {
    issues.push("admission is not_admitted");
  } else {
    requireDigest("admission.admissionDigest", link.admission.admissionDigest);
    requireIdentity("admission.admittedAt", link.admission.admittedAt);
  }

  return { complete: issues.length === 0, issues: Object.freeze(issues) };
}
