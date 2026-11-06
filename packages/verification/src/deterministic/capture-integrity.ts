import type { VerificationBundle, VerificationCheck, VerificationSourceCapture } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "../canonical/index.js";
import type { DeterministicVerificationOptions, HydratedVerificationArtifact } from "./bundle-verification.js";
import { CHECK, Checks } from "./checks.js";

/** Identifier indexes over the parsed bundle plus the checks that found duplicate ids. */
export interface BundleIndex {
  readonly sources: ReadonlySet<string>;
  readonly captures: ReadonlyMap<string, VerificationSourceCapture>;
  readonly artifactPayloads: ReadonlyMap<string, Uint8Array>;
  readonly duplicateChecks: readonly VerificationCheck[];
}

/** Capture checks plus every artifact whose bytes proved identical to their registration. */
export interface VerifiedCaptures {
  readonly checks: readonly VerificationCheck[];
  readonly verifiedArtifacts: ReadonlyMap<string, Uint8Array>;
}

type LineageAdmission = NonNullable<DeterministicVerificationOptions["isProjectionLineageAdmitted"]>;

const bytes = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;

export function indexBundle(
  bundle: VerificationBundle,
  artifacts: readonly HydratedVerificationArtifact[],
): BundleIndex {
  const sources = new Set(bundle.sources.map((source) => source.sourceId));
  const artifactPayloads = new Map(artifacts.map((artifact) => [artifact.artifactId, bytes(artifact.content)]));
  const captures = new Map(bundle.captures.map((capture) => [capture.captureId, capture]));
  const checks = new Checks();
  if (sources.size !== bundle.sources.length) checks.fail(CHECK.SOURCE_IDS_UNIQUE, "Source IDs must be unique.");
  if (artifactPayloads.size !== artifacts.length)
    checks.fail(CHECK.ARTIFACT_IDS_UNIQUE, "Hydrated artifact IDs must be unique.");
  if (captures.size !== bundle.captures.length) checks.fail(CHECK.CAPTURE_IDS_UNIQUE, "Capture IDs must be unique.");
  return { sources, captures, artifactPayloads, duplicateChecks: checks.items };
}

export function verifyCaptures(
  bundle: VerificationBundle,
  index: BundleIndex,
  isProjectionLineageAdmitted: LineageAdmission | undefined,
): VerifiedCaptures {
  const checks: VerificationCheck[] = [];
  const verifiedArtifacts = new Map<string, Uint8Array>();
  for (const capture of bundle.captures) {
    const verified = verifyCapture(capture, index, isProjectionLineageAdmitted);
    checks.push(...verified.checks);
    for (const [artifactId, content] of verified.verifiedArtifacts) verifiedArtifacts.set(artifactId, content);
  }
  return { checks, verifiedArtifacts };
}

/** Source binding, hydration, digest and byte length of the capture, then its projection lineage. */
function verifyCapture(
  capture: VerificationSourceCapture,
  index: BundleIndex,
  isProjectionLineageAdmitted: LineageAdmission | undefined,
): VerifiedCaptures {
  const checks = new Checks(capture.captureId);
  const verifiedArtifacts = new Map<string, Uint8Array>();
  const artifact = capture.contentArtifact;
  const content = index.artifactPayloads.get(artifact.artifactId);
  checks.require(CHECK.CAPTURE_SOURCE_PRESENT, index.sources.has(capture.sourceId), {
    pass: `Capture ${capture.captureId} is bound to source ${capture.sourceId}.`,
    fail: `Source ${capture.sourceId} is absent.`,
  });
  checks.require(CHECK.CAPTURE_ARTIFACT_PRESENT, content !== undefined, {
    pass: `Artifact ${artifact.artifactId} is hydrated.`,
    fail: `Artifact ${artifact.artifactId} is not hydrated.`,
  });
  if (!content) return { checks: checks.items, verifiedArtifacts };

  const digestMatches = sha256Digest(content) === artifact.digest;
  const sizeMatches = artifact.byteLength === undefined || artifact.byteLength === content.byteLength;
  checks.require(CHECK.CAPTURE_DIGEST_MATCH, digestMatches, {
    pass: "Capture bytes match the registered digest.",
    fail: "Capture bytes differ from the registered digest.",
  });
  checks.require(CHECK.CAPTURE_BYTE_LENGTH_MATCH, sizeMatches, {
    pass: "Capture byte length matches.",
    fail: `Expected ${artifact.byteLength} bytes; hydrated ${content.byteLength}.`,
  });
  if (digestMatches && sizeMatches) verifiedArtifacts.set(artifact.artifactId, content);

  const projection = capture.canonicalProjectionArtifact;
  if (projection) {
    const projectionContent = index.artifactPayloads.get(projection.artifactId);
    const digestMatches = projectionContent !== undefined && sha256Digest(projectionContent) === projection.digest;
    const sizeMatches = projectionContent !== undefined && projectionContent.byteLength === projection.byteLength;
    const directParentBound =
      projection.parentArtifactIds.includes(artifact.artifactId) && projection.transformationSignature !== undefined;
    const envelopeBound =
      isProjectionLineageAdmitted?.({
        captureId: capture.captureId,
        sourceArtifact: artifact,
        projectionArtifact: projection,
      }) === true;
    const parentBound = directParentBound || envelopeBound;
    checks.require(CHECK.PROJECTION_DIGEST_MATCH, digestMatches, {
      pass: "Projection bytes match the registered digest.",
      fail: "Projection is missing or changed.",
    });
    checks.require(CHECK.PROJECTION_BYTE_LENGTH_MATCH, sizeMatches, {
      pass: "Projection byte length matches.",
      fail: "Projection byte length differs from its registration.",
    });
    checks.require(
      CHECK.PROJECTION_LINEAGE_BOUND,
      parentBound,
      envelopeBound
        ? "Trusted runtime admission binds the projection to its capture-specific transformation envelope."
        : directParentBound
          ? "Projection declares its capture parent and transformation signature."
          : "Projection lacks capture parent or transformation signature.",
    );
    if (projectionContent && digestMatches && sizeMatches && parentBound)
      verifiedArtifacts.set(projection.artifactId, projectionContent);
  }
  return { checks: checks.items, verifiedArtifacts };
}
