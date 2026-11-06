import { canonicalizeJson } from "../../canonical/index.js";
import { parseDataset, type DatasetProjection } from "./dataset.js";
import { parseGeometry, type GeometryProjection } from "./geometry.js";
import { parseHtml, type HtmlDomProjection } from "./html.js";
import { parseApi, type PaginatedApiProjection } from "./paginated-api.js";
import { parsePdf, type PdfTextProjection } from "./pdf-text.js";
import { parseRepository, type RepositoryProjection } from "./repository.js";
import { fail, isRecord, MAX_BYTES, MAX_NATIVE_PROJECTION_BYTES, string, type UnknownRecord } from "./shared.js";
import { parseTable, type TableProjection } from "./table.js";
import { parseTranscript, type TranscriptProjection } from "./transcript.js";

/**
 * Selector-only projection input. Admission, raw parsing, sandboxing, and
 * parent-artifact registration are deliberately outside this module. The
 * application layer must establish those facts before calling a resolver.
 */
export interface ProjectionAdmissionContext {
  readonly parentArtifactDigest: `sha256:${string}`;
  readonly transformationSignature: `sha256:${string}`;
  readonly parserVersion: string;
}

export type CanonicalProjection =
  | HtmlDomProjection
  | PdfTextProjection
  | GeometryProjection
  | TableProjection
  | TranscriptProjection
  | RepositoryProjection
  | DatasetProjection
  | PaginatedApiProjection;

export type CanonicalProjectionKind = CanonicalProjection["kind"];

const parsers: Record<CanonicalProjectionKind, (input: UnknownRecord) => CanonicalProjection> = {
  html_dom: parseHtml,
  pdf_text: parsePdf,
  geometry: parseGeometry,
  table: parseTable,
  transcript: parseTranscript,
  repository: parseRepository,
  dataset: parseDataset,
  paginated_api: parseApi,
};

/** Kinds whose native parser output may legitimately exceed the 1MB single-projection envelope. */
const nativeKinds: ReadonlySet<string> = new Set<CanonicalProjectionKind>(["geometry", "html_dom"]);

const isProjectionKind = (value: string): value is CanonicalProjectionKind => Object.hasOwn(parsers, value);

/** Parses only canonical JSON projections. It does not assert they were safely produced or registered. */
export function parseCanonicalProjection(content: Uint8Array): CanonicalProjection {
  if (content.byteLength > MAX_NATIVE_PROJECTION_BYTES) fail("BYTES");
  let text = "";
  let value: unknown = undefined;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    value = JSON.parse(text);
  } catch {
    fail("JSON_PARSE");
  }
  if (canonicalizeJson(value) !== text) fail("JSON_NOT_CANONICAL");
  if (!isRecord(value) || !string(value.kind)) fail("KIND");
  const kind = value.kind;
  if (!nativeKinds.has(kind) && content.byteLength > MAX_BYTES) fail("BYTES");
  if (!isProjectionKind(kind)) fail("KIND");
  return parsers[kind](value);
}
