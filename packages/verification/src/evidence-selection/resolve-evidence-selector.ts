import { canonicalizeJson, digestCanonicalJson, sha256Digest } from "../canonical/index.js";
import { CORE_RESOLVER_VERSION } from "../versions.js";
import { resolveCoreEvidenceSelector } from "./core-resolver.js";
import {
  evidenceSelectionReporter,
  type EvidenceSelection,
  type EvidenceSelectionRequest,
  type EvidenceSelectorResolver,
} from "./selection.js";
import { decodeUtf8 } from "./utf8.js";

const report = evidenceSelectionReporter(CORE_RESOLVER_VERSION);

/**
 * The one entry point for locating evidence inside captured bytes.
 * Core kinds (text quote, character position, JSON pointer, multi-fragment text) resolve here.
 * Any other kind is delegated to the first resolver that supports it, and its claim is verified before it is returned.
 * `undefined` means no resolver owns this selector kind. It is not a failed locate; failures carry a status.
 */
export function resolveEvidenceSelector(
  request: EvidenceSelectionRequest,
  resolvers: readonly EvidenceSelectorResolver[] = [],
): EvidenceSelection | undefined {
  return resolveCoreEvidenceSelector(request) ?? delegateToResolver(request, resolvers);
}

function delegateToResolver(
  request: EvidenceSelectionRequest,
  resolvers: readonly EvidenceSelectorResolver[],
): EvidenceSelection | undefined {
  const resolver = resolvers.find((candidate) => candidate.supportedKinds.includes(request.selector.kind));
  if (!resolver) return undefined;
  return verifyClaimedSelection(request, resolver, resolver.resolve(request));
}

/** A resolver may locate bytes. It may not rebind them to another capture or claim a digest it did not produce. */
function verifyClaimedSelection(
  request: EvidenceSelectionRequest,
  resolver: EvidenceSelectorResolver,
  claimed: EvidenceSelection,
): EvidenceSelection {
  if (!isBoundToRequest(claimed, request, resolver.resolverVersion)) return report.unresolved(request, "invalid");
  if (!selectedDigestsReplay(claimed)) return report.unresolved(request, "invalid");
  return withDecodedText(claimed);
}

function isBoundToRequest(
  { resolution }: EvidenceSelection,
  request: EvidenceSelectionRequest,
  resolverVersion: string,
): boolean {
  return (
    resolution.captureId === request.captureId &&
    resolution.representationArtifactId === request.representationArtifactId &&
    resolution.representationDigest === request.representationDigest &&
    resolution.selectorDigest === digestCanonicalJson(request.selector) &&
    resolution.selectorKind === request.selector.kind &&
    resolution.resolverVersion === resolverVersion
  );
}

function selectedDigestsReplay({ resolution, selectedContent }: EvidenceSelection): boolean {
  const digest = sha256Digest(selectedContent);
  const contentReplays = resolution.status !== "resolved" || resolution.selectedContentDigest === digest;
  const valueReplays =
    resolution.selectedValue === undefined || sha256Digest(canonicalizeJson(resolution.selectedValue)) === digest;
  return contentReplays && valueReplays;
}

/** Attaches the UTF-8 text when the selected bytes decode; structured selections stay bytes-only. */
function withDecodedText({ resolution, selectedContent }: EvidenceSelection): EvidenceSelection {
  try {
    return {
      resolution,
      selectedContent,
      selectedText: decodeUtf8(selectedContent),
    };
  } catch {
    return { resolution, selectedContent };
  }
}
