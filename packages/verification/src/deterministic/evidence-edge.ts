import type {
  EvidenceEdge,
  EvidenceMechanicalResult,
  VerificationSourceCapture,
} from "@aiengineer/knowledge-contracts";
import { digestCanonicalJson, sha256Digest, ZERO_SHA256_DIGEST } from "../canonical/index.js";
import {
  resolveEvidenceSelector,
  type EvidenceSelection,
  type EvidenceSelectionRequest,
  type EvidenceSelectorResolver,
} from "../evidence-selection/index.js";
import { CORE_RESOLVER_VERSION } from "../versions.js";
import { CHECK, Checks, verificationCheck, type CheckCode } from "./checks.js";

/** What an evidence edge may be resolved against: verified bytes of captures in this bundle. */
export interface EvidenceEdgeContext {
  readonly captures: ReadonlyMap<string, VerificationSourceCapture>;
  readonly verifiedArtifacts: ReadonlyMap<string, Uint8Array>;
  readonly selectorResolvers: readonly EvidenceSelectorResolver[];
}

/** The retained contract result plus the live selection (for metric facet comparison). */
export interface EvidenceEdgeResult {
  readonly contract: EvidenceMechanicalResult;
  readonly selection?: EvidenceSelection;
}

export type EvidenceEdgeVerifier = (edge: EvidenceEdge) => EvidenceEdgeResult;

/**
 * Locates the edge's representation among the bundle's verified artifacts, runs
 * the admitted resolver, then binds the resolver's claim back to the request.
 * A resolver's word is never taken: the selected bytes are re-hashed here.
 */
export function verifyEvidenceEdge(context: EvidenceEdgeContext, edge: EvidenceEdge): EvidenceEdgeResult {
  const { fragment } = edge;
  const capture = context.captures.get(fragment.captureId);
  if (!capture) return unresolvedEvidence(edge, CHECK.CAPTURE_PRESENT, `Capture ${fragment.captureId} is missing.`);
  const handle = [
    capture.contentArtifact,
    ...(capture.canonicalProjectionArtifact ? [capture.canonicalProjectionArtifact] : []),
  ].find((artifact) => artifact.artifactId === fragment.representationArtifactId);
  if (!handle)
    return unresolvedEvidence(
      edge,
      CHECK.REPRESENTATION_BOUND_TO_CAPTURE,
      `Artifact ${fragment.representationArtifactId} is not a representation of capture ${capture.captureId}.`,
    );
  const content = context.verifiedArtifacts.get(handle.artifactId);
  if (!content)
    return unresolvedEvidence(
      edge,
      CHECK.REPRESENTATION_ARTIFACT_VERIFIED,
      `Artifact ${handle.artifactId} did not pass digest and lineage checks.`,
    );
  const request: EvidenceSelectionRequest = {
    captureId: capture.captureId,
    representationArtifactId: handle.artifactId,
    representationDigest: handle.digest,
    selector: fragment.selector,
    content,
  };
  const selection = resolveEvidenceSelector(request, context.selectorResolvers);
  if (!selection)
    return unresolvedEvidence(
      edge,
      CHECK.SELECTOR_RESOLVER_ADMITTED,
      `No admitted deterministic resolver handles ${fragment.selector.kind}.`,
    );
  const checks = bindResolutionToRequest(edge, request, selection);
  return {
    contract: {
      evidenceId: edge.evidenceId,
      status: checks.status(),
      resolution: selection.resolution,
      checks: [...checks.items],
    },
    selection,
  };
}

/** The resolver's claim must name this capture, these bytes, this selector, one occurrence, and replay its digest. */
function bindResolutionToRequest(
  edge: EvidenceEdge,
  request: EvidenceSelectionRequest,
  selection: EvidenceSelection,
): Checks {
  const { resolution } = selection;
  const checks = new Checks(edge.evidenceId)
    .require(
      CHECK.SELECTOR_CAPTURE_BOUND,
      resolution.captureId === request.captureId,
      "Selector resolution must bind to the requested capture.",
    )
    .require(
      CHECK.SELECTOR_REPRESENTATION_BOUND,
      resolution.representationArtifactId === request.representationArtifactId &&
        resolution.representationDigest === request.representationDigest,
      "Selector resolution must bind to verified representation bytes.",
    )
    .require(
      CHECK.SELECTOR_DEFINITION_BOUND,
      resolution.selectorDigest === digestCanonicalJson(edge.fragment.selector),
      "Selector resolution must bind to the canonical selector definition.",
    )
    .require(
      CHECK.LOCATOR_UNIQUE,
      resolution.status === "resolved" && resolution.occurrenceCount === 1,
      `Selector status is ${resolution.status} with ${resolution.occurrenceCount} occurrence(s).`,
    )
    .require(
      CHECK.SELECTED_CONTENT_DIGEST_REPLAYED,
      resolution.selectedContentDigest === sha256Digest(selection.selectedContent),
      "Selected bytes must replay to the resolution digest.",
    )
    .require(
      CHECK.EXPECTED_SELECTED_CONTENT_DIGEST_MATCH,
      edge.expectedSelectedContentDigest === undefined ||
        edge.expectedSelectedContentDigest === resolution.selectedContentDigest,
      "Resolved content must match the producer-declared evidence digest when supplied.",
    );
  if (
    edge.fragment.selector.kind === "text_quote" &&
    edge.fragment.selector.normalization === "casefold_whitespace_filler_removed"
  )
    checks.review(CHECK.LOSSY_TEXT_NORMALIZATION, "Filler removal and case folding require mechanical review.");
  return checks;
}

/** A failed edge still reports a resolution shape so consumers can address it by selector; the digest is the zero sentinel. */
function unresolvedEvidence(edge: EvidenceEdge, code: CheckCode, detail: string): EvidenceEdgeResult {
  const { fragment } = edge;
  return {
    contract: {
      evidenceId: edge.evidenceId,
      status: "failed",
      resolution: {
        captureId: fragment.captureId,
        representationArtifactId: fragment.representationArtifactId,
        representationDigest: ZERO_SHA256_DIGEST,
        selectorDigest: digestCanonicalJson(fragment.selector),
        selectorKind: fragment.selector.kind,
        status: "invalid",
        occurrenceCount: 0,
        resolvedRanges: [],
        normalization: "none",
        resolverVersion: CORE_RESOLVER_VERSION,
      },
      checks: [verificationCheck(code, "failed", "hard", detail, edge.evidenceId)],
    },
  };
}
