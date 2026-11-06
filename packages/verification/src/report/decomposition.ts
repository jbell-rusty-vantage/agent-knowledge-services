import { sha256Digest } from "../canonical/index.js";
import { CLAIM_DECOMPOSITION_SCHEMA_VERSION } from "../versions.js";

export const claimClassifications = [
  "externally_verifiable_fact",
  "source_summary",
  "calculation",
  "inference",
  "opinion",
  "recommendation",
  "citation_not_required",
] as const;
export type ClaimClassification = (typeof claimClassifications)[number];

export interface DecompositionSegmentProposal {
  readonly segmentId: string;
  readonly start: number;
  readonly end: number;
  readonly exactText: string;
  readonly classification: ClaimClassification;
  readonly atomizationBasis: "semantic_proposition" | "non_claim";
  readonly atomic: boolean;
  readonly qualifiers: readonly string[];
}

export interface ClaimDecompositionProposal {
  readonly schemaVersion: typeof CLAIM_DECOMPOSITION_SCHEMA_VERSION;
  readonly annotationVersion: string;
  readonly offsetUnit: "utf16_code_unit";
  readonly reportDigest: `sha256:${string}`;
  readonly segments: readonly DecompositionSegmentProposal[];
}

export interface AcceptedClaimDecomposition extends ClaimDecompositionProposal {
  readonly reconstructedReport: string;
  readonly externallyVerifiableSegmentIds: readonly string[];
}

const MAX_REPORT_CHARS = 100_000;
const MAX_SEGMENTS = 512;
const MAX_QUALIFIERS = 32;

export function acceptClaimDecomposition(
  report: string,
  proposal: ClaimDecompositionProposal,
): AcceptedClaimDecomposition {
  if (report.length > MAX_REPORT_CHARS) throw new Error("DECOMPOSITION_REPORT_TOO_LARGE");
  if (proposal.schemaVersion !== CLAIM_DECOMPOSITION_SCHEMA_VERSION)
    throw new Error("DECOMPOSITION_VERSION_UNSUPPORTED");
  if (proposal.offsetUnit !== "utf16_code_unit") throw new Error("DECOMPOSITION_OFFSET_UNIT_INVALID");
  if (!proposal.annotationVersion.trim() || proposal.annotationVersion.length > 160)
    throw new Error("DECOMPOSITION_ANNOTATION_VERSION_INVALID");
  if (proposal.reportDigest !== sha256Digest(report)) throw new Error("DECOMPOSITION_REPORT_DIGEST_MISMATCH");
  if (proposal.segments.length === 0 || proposal.segments.length > MAX_SEGMENTS)
    throw new Error("DECOMPOSITION_SEGMENT_COUNT_INVALID");
  const ids = new Set<string>();
  let cursor = 0;
  let reconstructed = "";
  for (const segment of proposal.segments) {
    if (!segment.segmentId.trim() || segment.segmentId.length > 255 || ids.has(segment.segmentId))
      throw new Error("DECOMPOSITION_SEGMENT_ID_INVALID");
    ids.add(segment.segmentId);
    if (!claimClassifications.includes(segment.classification)) throw new Error("DECOMPOSITION_CLASSIFICATION_INVALID");
    if ((segment.classification === "citation_not_required") !== (segment.atomizationBasis === "non_claim"))
      throw new Error("DECOMPOSITION_ATOMIZATION_BASIS_INVALID");
    if (
      !Number.isInteger(segment.start) ||
      !Number.isInteger(segment.end) ||
      segment.start !== cursor ||
      segment.end <= segment.start ||
      segment.end > report.length
    )
      throw new Error("DECOMPOSITION_OFFSETS_INVALID");
    if (report.slice(segment.start, segment.end) !== segment.exactText) throw new Error("DECOMPOSITION_TEXT_MISMATCH");
    if (segment.qualifiers.length > MAX_QUALIFIERS || new Set(segment.qualifiers).size !== segment.qualifiers.length)
      throw new Error("DECOMPOSITION_QUALIFIERS_INVALID");
    for (const qualifier of segment.qualifiers) {
      if (!qualifier.trim() || qualifier.length > 240 || !segment.exactText.includes(qualifier))
        throw new Error("DECOMPOSITION_QUALIFIER_NOT_PRESERVED");
    }
    if (segment.classification === "citation_not_required" && segment.qualifiers.length > 0)
      throw new Error("DECOMPOSITION_NONCLAIM_QUALIFIER_INVALID");
    if (segment.classification !== "citation_not_required" && !segment.atomic)
      throw new Error("DECOMPOSITION_NON_ATOMIC_CLAIM");
    reconstructed += segment.exactText;
    cursor = segment.end;
  }
  if (cursor !== report.length || reconstructed !== report) throw new Error("DECOMPOSITION_RECONSTRUCTION_FAILED");
  return Object.freeze({
    ...proposal,
    segments: Object.freeze(
      proposal.segments.map((segment) =>
        Object.freeze({
          ...segment,
          qualifiers: Object.freeze([...segment.qualifiers]),
        }),
      ),
    ),
    reconstructedReport: reconstructed,
    externallyVerifiableSegmentIds: Object.freeze(
      proposal.segments
        .filter((segment) => segment.classification !== "citation_not_required")
        .map((segment) => segment.segmentId),
    ),
  });
}

export interface DecompositionAnnotationCase {
  readonly caseId: string;
  readonly reportDigest: `sha256:${string}`;
  readonly expectedClaimRanges: readonly {
    readonly start: number;
    readonly end: number;
  }[];
  readonly provenance: "declared_synthetic" | "human_adjudicated";
}

export function evaluateDecompositionProposal(
  accepted: AcceptedClaimDecomposition,
  annotation: DecompositionAnnotationCase,
): {
  readonly status: "measured" | "pending_human_gold";
  readonly exactRangePrecision?: number;
  readonly exactRangeRecall?: number;
} {
  if (annotation.reportDigest !== accepted.reportDigest) throw new Error("DECOMPOSITION_ANNOTATION_REPORT_MISMATCH");
  if (annotation.provenance !== "human_adjudicated") return Object.freeze({ status: "pending_human_gold" });
  const proposed = accepted.segments
    .filter((segment) => segment.classification !== "citation_not_required")
    .map(({ start, end }) => `${start}:${end}`);
  const expected = annotation.expectedClaimRanges.map(({ start, end }) => `${start}:${end}`);
  const expectedSet = new Set(expected);
  const matches = proposed.filter((range) => expectedSet.has(range)).length;
  return Object.freeze({
    status: "measured",
    exactRangePrecision: proposed.length === 0 ? (expected.length === 0 ? 1 : 0) : matches / proposed.length,
    exactRangeRecall: expected.length === 0 ? 1 : matches / expected.length,
  });
}
