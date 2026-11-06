import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import { isSha256Digest, sha256Digest } from "../canonical/index.js";
import { PROJECTION_RESOLVER_VERSION } from "../versions.js";
import {
  parseCanonicalProjection,
  resolveApi,
  resolveDataset,
  resolveGeometry,
  resolveHtml,
  resolveMedia,
  resolvePdf,
  resolveRepository,
  resolveTable,
  type CanonicalProjection,
} from "./projections/index.js";
import { unresolved } from "./projections/report.js";
import type { EvidenceSelection, EvidenceSelectionRequest, EvidenceSelectorResolver } from "./selection.js";

type ProjectionSelectorKind =
  | "html"
  | "pdf_text"
  | "bounding_box"
  | "table"
  | "media_timecode"
  | "repository"
  | "dataset"
  | "api_record";

type ProjectionOf<Kind extends CanonicalProjection["kind"]> = Extract<CanonicalProjection, { kind: Kind }>;

/** Which projection kind a selector kind reads, and the resolver that applies it. */
interface ProjectionRoute {
  readonly projectionKind: CanonicalProjection["kind"];
  readonly resolve: (
    request: EvidenceSelectionRequest,
    projection: CanonicalProjection,
    selector: VerificationSelector,
  ) => EvidenceSelection;
}

/**
 * Pairs a kind-specific resolver with the projection kind it reads. The table stores the
 * erased signature; `ProjectionSelectorResolver.resolve` re-establishes the pairing at runtime
 * (projection kind equality, selector kind lookup) before calling, so this is the only widening.
 */
const route = <ProjectionKind extends CanonicalProjection["kind"], Selector extends VerificationSelector>(
  projectionKind: ProjectionKind,
  resolve: (
    request: EvidenceSelectionRequest,
    projection: ProjectionOf<ProjectionKind>,
    selector: Selector,
  ) => EvidenceSelection,
): ProjectionRoute => ({
  projectionKind,
  resolve: resolve as ProjectionRoute["resolve"],
});

const routes: Readonly<Record<ProjectionSelectorKind, ProjectionRoute>> = {
  html: route("html_dom", resolveHtml),
  pdf_text: route("pdf_text", resolvePdf),
  bounding_box: route("geometry", resolveGeometry),
  table: route("table", resolveTable),
  media_timecode: route("transcript", resolveMedia),
  repository: route("repository", resolveRepository),
  dataset: route("dataset", resolveDataset),
  api_record: route("paginated_api", resolveApi),
};

const isProjectionSelectorKind = (kind: VerificationSelector["kind"]): kind is ProjectionSelectorKind =>
  Object.hasOwn(routes, kind);

/** Projection bytes must hash to the declared digest and parse as a canonical projection before any locator runs. */
function requireProjection(request: EvidenceSelectionRequest): CanonicalProjection | EvidenceSelection {
  if (!isSha256Digest(request.representationDigest) || sha256Digest(request.content) !== request.representationDigest)
    return unresolved(request, "invalid");
  try {
    return parseCanonicalProjection(request.content);
  } catch {
    return unresolved(request, "parse_error");
  }
}

const isSelection = (value: CanonicalProjection | EvidenceSelection): value is EvidenceSelection =>
  "resolution" in value;

/**
 * Resolves selectors over canonical media projections (HTML DOM, PDF text, geometry, tables,
 * transcripts, repositories, datasets, paginated APIs). Each selector kind reads exactly one
 * projection kind; a mismatch is an invalid locator, not a parse failure.
 */
export class ProjectionSelectorResolver implements EvidenceSelectorResolver {
  readonly resolverVersion = PROJECTION_RESOLVER_VERSION;
  readonly supportedKinds = Object.keys(routes) as readonly ProjectionSelectorKind[];

  resolve(request: EvidenceSelectionRequest): EvidenceSelection {
    const projection = requireProjection(request);
    if (isSelection(projection)) return projection;
    const { selector } = request;
    if (!isProjectionSelectorKind(selector.kind)) return unresolved(request, "invalid");
    const { projectionKind, resolve } = routes[selector.kind];
    if (projection.kind !== projectionKind) return unresolved(request, "invalid");
    return resolve(request, projection, selector);
  }
}

export const projectionSelectorResolver = new ProjectionSelectorResolver();
