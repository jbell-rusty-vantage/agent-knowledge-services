export {
  parseCanonicalProjection,
  type CanonicalProjection,
  type CanonicalProjectionKind,
  type ProjectionAdmissionContext,
} from "./parse-canonical-projection.js";
export { resolveHtml, type DomNode, type HtmlDomProjection } from "./html.js";
export { resolvePdf, type PdfTextProjection } from "./pdf-text.js";
export { resolveGeometry, type GeometryProjection } from "./geometry.js";
export { resolveTable, type TableProjection } from "./table.js";
export { resolveMedia, type TranscriptProjection } from "./transcript.js";
export { resolveRepository, type RepositoryProjection } from "./repository.js";
export { resolveDataset, type DatasetProjection } from "./dataset.js";
export { resolveApi, type PaginatedApiProjection } from "./paginated-api.js";
