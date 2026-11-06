export { resolveEvidenceSelector } from "./resolve-evidence-selector.js";
export type {
  EvidenceSelection,
  EvidenceSelectionRequest,
  EvidenceSelectorResolver,
} from "./selection.js";
export {
  ProjectionSelectorResolver,
  projectionSelectorResolver,
} from "./projection-resolver.js";
export {
  parseCanonicalProjection,
  type CanonicalProjection,
  type DatasetProjection,
  type DomNode,
  type GeometryProjection,
  type HtmlDomProjection,
  type PaginatedApiProjection,
  type PdfTextProjection,
  type ProjectionAdmissionContext,
  type RepositoryProjection,
  type TableProjection,
  type TranscriptProjection,
} from "./projections/index.js";
