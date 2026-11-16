import type { DocumentNode } from "@aiengineer/knowledge-contracts";

/**
 * A prepared document node as a typed unit of the AI Engineer database (`content.document_node.unit_kind`, a code of
 * `content.unit_kind`, whose attributes the database validates against the kind's schema). The map is one to one, so
 * a stored unit reads back as the node kind it was written from. A node kind with no faithful unit kind is refused,
 * never written as another kind.
 */
const UNIT_KIND_OF: Readonly<Partial<Record<DocumentNode["kind"], string>>> = {
  heading: "section",
  paragraph: "paragraph",
  list: "list",
  table: "table",
  figure: "figure",
  code_block: "code_block",
  transcript_segment: "transcript_segment",
};
const NODE_KIND_OF: Readonly<Record<string, DocumentNode["kind"]>> = Object.fromEntries(
  Object.entries(UNIT_KIND_OF).map(([nodeKind, unitKind]) => [unitKind, nodeKind as DocumentNode["kind"]]),
);

export interface DocumentNodeUnit {
  readonly unitKind: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly startMs: number | null;
  readonly endMs: number | null;
}

export function documentNodeUnit(node: { readonly kind: string; readonly locator: unknown }): DocumentNodeUnit {
  const unitKind = UNIT_KIND_OF[node.kind as DocumentNode["kind"]];
  if (!unitKind) throw new Error(`DOCUMENT_NODE_KIND_UNSUPPORTED:${node.kind}`);
  const locator = (node.locator ?? {}) as Partial<DocumentNode["locator"]>;
  const path = Array.isArray(locator.sectionPath) ? locator.sectionPath.join(" > ") : undefined;
  if (unitKind !== "transcript_segment")
    return { unitKind, attributes: path ? { path } : {}, startMs: null, endMs: null };
  // A transcript segment is located by its time code; the unit kind requires it (t0_ms).
  const { startTimeMs, endTimeMs } = locator;
  if (startTimeMs === undefined) throw new Error("DOCUMENT_NODE_TIMECODE_REQUIRED:transcript_segment");
  return {
    unitKind,
    attributes: { t0_ms: startTimeMs, ...(endTimeMs === undefined ? {} : { t1_ms: endTimeMs }) },
    startMs: startTimeMs,
    endMs: endTimeMs ?? null,
  };
}

export function documentNodeKindOf(unitKind: string): DocumentNode["kind"] {
  const kind = NODE_KIND_OF[unitKind];
  if (!kind) throw new Error(`DOCUMENT_NODE_UNIT_KIND_UNREADABLE:${unitKind}`);
  return kind;
}
