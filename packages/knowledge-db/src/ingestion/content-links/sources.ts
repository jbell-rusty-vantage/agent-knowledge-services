import type { ContentLinkOperation, JsonValue } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { ArtifactLedger } from "../../db-read/index.js";
import type { ContentAdmission, KnowledgeSqlClient } from "../../ports.js";
import { domainError } from "../../schema-workspace/index.js";
import { verifyContentChunkManifest } from "./chunk-manifest.js";

type Row = Record<string, unknown>;
type ChunkReference = Extract<ContentLinkOperation, { kind: "chunk.claim.link" }>["chunk"];
type NodeReference = ChunkReference["sourceNodes"][number];
type RepresentationReference = ChunkReference["representation"];
export interface ContentSourceContext {
  readonly client: KnowledgeSqlClient;
  readonly tenantId: string;
  readonly artifacts: ArtifactLedger;
}
/** Source reads also need canonical representation admission, which persistence implements. */
export interface ContentSourceReaderContext extends ContentSourceContext {
  readonly admission: ContentAdmission;
}
export interface ContentSourceNode {
  readonly id: string;
  readonly representationId: string;
  readonly text: string;
  readonly kind: string;
}
export interface ContentSourceChunk {
  readonly id: string;
  readonly text: string;
  readonly nodes: readonly ContentSourceNode[];
}

const FAITHFUL_CLASSES = new Set(["source_native", "faithful_normalization", "structural_extraction"]);
const LOCATOR_FIELDS = [
  "page",
  "sectionPath",
  "startOffset",
  "endOffset",
  "startTimeMs",
  "endTimeMs",
  "domPath",
  "symbol",
] as const;
const MAX_CHUNK_SPANS = 256;
const MAX_TRANSFORMATION_DEPTH = 16;
const MAX_LINEAGE_EDGES = 4096;
const MAX_TRANSFORMATION_INPUTS = 256;
interface LineageTraversal {
  edges: number;
  readonly completed: Map<string, boolean>;
}

function reject(message: string): never {
  throw domainError("CONTENT_SOURCE_BINDING_INVALID", message);
}
const digestOf = (value: unknown): string => `sha256:${String(value)}`;
function hasBytes(artifact: Awaited<ReturnType<ArtifactLedger["get"]>>): boolean {
  return artifact.record.storageState === "available" && (artifact.text !== undefined || artifact.json !== undefined);
}

/** Reconstructs selected source spans from canonical nodes and verifies their retained byte custody. */
export class ContentSourceReader {
  constructor(private readonly context: ContentSourceReaderContext) {}

  async representation(reference: RepresentationReference, documentVersionId: string): Promise<Row> {
    const row = (
      await this.context.client.query<Row>(
        `select r.*,d.correction_state from content.document_representation r
      join content.document_version d on d.tenant_id=r.tenant_id and d.id=r.document_version_id
      where r.tenant_id=$1 and r.id=$2`,
        [this.context.tenantId, reference.id],
      )
    ).rows[0];
    if (
      !row ||
      row.document_version_id !== documentVersionId ||
      digestOf(row.content_sha256) !== reference.digest ||
      ["retracted", "withdrawn"].includes(String(row.correction_state))
    )
      reject("Representation is missing, changed or unaccepted");
    const admission = await this.context.admission.readRepresentationAdmission(this.context.client, {
      tenantId: this.context.tenantId,
      representationId: reference.id,
      guardedDigest: reference.digest,
    });
    if (!admission.accepted) reject("Representation has no current independent acceptance");
    const artifact = await this.context.artifacts.get(this.context.tenantId, String(row.artifact_id));
    if (!hasBytes(artifact) || artifact.record.digest !== reference.digest)
      reject("Representation custody differs from its canonical digest");
    return row;
  }

  async documentVersion(
    reference: { readonly id: string; readonly digest: string },
    documentId?: string,
  ): Promise<Row> {
    const row = (
      await this.context.client.query<Row>("select * from content.document_version where tenant_id=$1 and id=$2", [
        this.context.tenantId,
        reference.id,
      ])
    ).rows[0];
    if (
      !row ||
      digestOf(row.manifest_sha256) !== reference.digest ||
      (documentId !== undefined && row.document_id !== documentId) ||
      ["retracted", "withdrawn"].includes(String(row.correction_state))
    )
      reject("Document version identity differs from the proposal");
    return row;
  }

  async capture(documentVersionId: string, captureId: string): Promise<Row> {
    const row = (
      await this.context.client.query<Row>(
        `select c.artifact_id,c.content_sha256 from content.document_version_source_capture d
      join evidence.source_capture c on c.tenant_id=d.tenant_id and c.id=d.source_capture_id
      where d.tenant_id=$1 and d.document_version_id=$2 and c.id=$3`,
        [this.context.tenantId, documentVersionId, captureId],
      )
    ).rows[0];
    if (!row) reject("The capture is not a source of this document version");
    const artifact = await this.context.artifacts.get(this.context.tenantId, String(row.artifact_id));
    if (!hasBytes(artifact) || artifact.record.digest !== digestOf(row.content_sha256))
      reject("Source capture bytes are unavailable or changed");
    return row;
  }

  async representationCapture(
    reference: RepresentationReference,
    documentVersionId: string,
    captureId: string,
  ): Promise<Row> {
    const representation = await this.representation(reference, documentVersionId);
    const capture = await this.capture(documentVersionId, captureId);
    if (
      !(await this.derivesFromCapture(
        { representation, capture, captureId, visited: [] },
        { edges: 0, completed: new Map() },
      ))
    )
      reject("Representation does not derive from the selected capture");
    return representation;
  }

  private async derivesFromCapture(
    input: { representation: Row; capture: Row; captureId: string; visited: readonly string[] },
    traversal: LineageTraversal,
  ): Promise<boolean> {
    const { representation, capture, captureId, visited } = input;
    const id = String(representation.id);
    if (visited.includes(id) || visited.length >= MAX_TRANSFORMATION_DEPTH)
      reject("Representation lineage is cyclic or exceeds its depth limit");
    const completed = traversal.completed.get(id);
    if (completed !== undefined) return completed;
    const result = await this.inspectTransformation(input, traversal);
    traversal.completed.set(id, result);
    return result;
  }

  private async inspectTransformation(
    input: { representation: Row; capture: Row; captureId: string; visited: readonly string[] },
    traversal: LineageTraversal,
  ): Promise<boolean> {
    const { representation, capture, captureId, visited } = input;
    const id = String(representation.id);
    if (representation.representation_class === "source_native")
      return (
        representation.source_native_byte_identical === true &&
        representation.artifact_id === capture.artifact_id &&
        representation.content_sha256 === capture.content_sha256
      );
    const outputs = (
      await this.context.client.query<Row>(
        `select t.id from content.transformation_run t
      join content.transformation_output o on o.tenant_id=t.tenant_id and o.transformation_run_id=t.id
      where t.tenant_id=$1 and t.id=$2 and t.status='succeeded' and o.representation_id=$3 limit 2`,
        [this.context.tenantId, representation.transformation_run_id, id],
      )
    ).rows;
    if (outputs.length !== 1) return false;
    const inputs = (
      await this.context.client.query<Row>(
        `select source_capture_id,artifact_id,representation_id from content.transformation_input
      where tenant_id=$1 and transformation_run_id=$2 order by ordinal limit ${MAX_TRANSFORMATION_INPUTS + 1}`,
        [this.context.tenantId, representation.transformation_run_id],
      )
    ).rows;
    if (!inputs.length || inputs.length > MAX_TRANSFORMATION_INPUTS)
      reject("Transformation input census is missing or exceeds its limit");
    traversal.edges += inputs.length;
    if (traversal.edges > MAX_LINEAGE_EDGES) reject("Representation lineage exceeds its total work limit");
    for (const source of inputs) {
      if (source.source_capture_id === captureId || source.artifact_id === capture.artifact_id) return true;
      if (!source.representation_id) continue;
      const prior = (
        await this.context.client.query<Row>(
          "select id,content_sha256 from content.document_representation where tenant_id=$1 and id=$2",
          [this.context.tenantId, source.representation_id],
        )
      ).rows[0];
      if (!prior) reject("Transformation input representation is missing");
      const hydrated = await this.representation(
        { id: String(prior.id), digest: digestOf(prior.content_sha256) },
        String(representation.document_version_id),
      );
      if (
        await this.derivesFromCapture(
          { representation: hydrated, capture, captureId, visited: [...visited, id] },
          traversal,
        )
      )
        return true;
    }
    return false;
  }

  async node(reference: NodeReference): Promise<ContentSourceNode> {
    const row = (
      await this.context.client.query<Row>(
        `select n.*,p.stable_local_key parent_local_key,p.representation_id parent_representation_id from content.document_node n
      left join content.document_node p on p.tenant_id=n.tenant_id and p.id=n.parent_id
      where n.tenant_id=$1 and n.id=$2`,
        [this.context.tenantId, reference.id],
      )
    ).rows[0];
    if (
      !row ||
      row.representation_id !== reference.representationId ||
      digestOf(row.normalized_content_sha256) !== reference.digest ||
      (row.parent_id !== null && row.parent_representation_id !== row.representation_id) ||
      !matchesNodeDigest(row, reference.digest)
    )
      reject("Source node identity, text or locator differs from its digest");
    const selector = row.selector as Record<string, unknown>;
    if (
      selector.representationId !== reference.representationId ||
      selector.nodeId !== reference.id ||
      selector.quoteDigest !== sha256Digest(String(row.inline_text ?? ""))
    )
      reject("Node locator identity or quote digest differs from its text");
    return {
      id: reference.id,
      representationId: reference.representationId,
      text: String(row.inline_text ?? ""),
      kind: String(row.node_kind),
    };
  }

  async chunk(reference: ChunkReference): Promise<ContentSourceChunk> {
    const representation = await this.representationCapture(
      reference.representation,
      reference.documentVersionId,
      reference.captureId,
    );
    if (!FAITHFUL_CLASSES.has(String(representation.representation_class)))
      reject("Source chunks require a faithful representation");
    const row = (
      await this.context.client.query<Row>(
        `select c.*,s.representation_id,s.status chunk_set_status from retrieval.retrieval_chunk c
      join retrieval.chunk_set s on s.tenant_id=c.tenant_id and s.id=c.chunk_set_id
      where c.tenant_id=$1 and c.id=$2`,
        [this.context.tenantId, reference.id],
      )
    ).rows[0];
    if (
      !row ||
      row.representation_id !== reference.representation.id ||
      row.lifecycle !== "active" ||
      row.chunk_set_status !== "succeeded" ||
      digestOf(row.source_text_sha256) !== reference.digest ||
      sha256Digest(String(row.source_text)) !== reference.digest
    )
      reject("Chunk identity, source bytes or lifecycle differ from the proposal");
    await verifyContentChunkManifest({
      client: this.context.client,
      tenantId: this.context.tenantId,
      chunkSetId: String(row.chunk_set_id),
    });
    const nodes = await Promise.all(reference.sourceNodes.map((source) => this.node(source)));
    const spans = (
      await this.context.client.query<Row>(
        `select ordinal,document_node_id,start_offset,end_offset,selected_text_sha256 from retrieval.chunk_span
      where tenant_id=$1 and chunk_id=$2 order by ordinal limit $3`,
        [this.context.tenantId, reference.id, MAX_CHUNK_SPANS + 1],
      )
    ).rows;
    const text = reconstructChunk(spans, nodes);
    if (text !== row.source_text) reject("Chunk source spans do not reconstruct its exact source text");
    return { id: reference.id, text, nodes };
  }
}

/** The worker persists normalized text hashes; direct document adapters retain structural hashes. */
function matchesNodeDigest(row: Row, digest: string): boolean {
  return sha256Digest(String(row.inline_text ?? "")) === digest || structuralNodeDigest(row) === digest;
}

function structuralNodeDigest(row: Row): string {
  const selector = row.selector as Record<string, JsonValue>;
  const locator: Record<string, JsonValue> = {};
  for (const field of LOCATOR_FIELDS) if (selector[field] !== undefined) locator[field] = selector[field]!;
  return sha256Digest({
    representationId: String(row.representation_id),
    localKey: String(row.stable_local_key),
    parentKey: row.parent_local_key === null ? null : String(row.parent_local_key),
    ordinal: Number(row.ordinal),
    kind: String(row.node_kind),
    role: row.role === null ? null : String(row.role),
    language: row.language === null ? null : String(row.language),
    text: String(row.inline_text ?? ""),
    locator,
  });
}

function reconstructChunk(spans: Row[], nodes: readonly ContentSourceNode[]): string {
  if (!spans.length || spans.length > MAX_CHUNK_SPANS)
    reject("Chunk span count is missing or exceeds the bounded reader");
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const used = new Set<string>();
  const fragments = spans.map((span, ordinal) => {
    const node = byId.get(String(span.document_node_id));
    const start = Number(span.start_offset),
      end = Number(span.end_offset);
    if (
      !node ||
      Number(span.ordinal) !== ordinal ||
      span.start_offset === null ||
      span.end_offset === null ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > node.text.length
    )
      reject("Chunk span does not bind a declared source node and range");
    const selected = node.text.slice(start, end);
    if (sha256Digest(selected) !== digestOf(span.selected_text_sha256))
      reject("Chunk selected text differs from its retained span digest");
    used.add(node.id);
    return selected;
  });
  if (used.size !== nodes.length) reject("Declared source nodes must exactly cover the canonical chunk spans");
  return fragments.join("\n\n");
}
