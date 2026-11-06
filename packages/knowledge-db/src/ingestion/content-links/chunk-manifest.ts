import { SourceLocatorSchema } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { KnowledgeSqlClient } from "../../ports.js";
import { domainError } from "../../schema-workspace/index.js";

type Row = Record<string, unknown>;
const MAX_SET_CHUNKS = 512;
const MAX_REPRESENTATION_NODES = 4096;
const MAX_SET_SPANS = MAX_SET_CHUNKS * 256;
const digestOf = (value: unknown): string => `sha256:${String(value)}`;
function reject(): never {
  throw domainError(
    "CONTENT_CHUNK_MANIFEST_INVALID",
    "Chunk-set membership or procedure does not match its retained input/output manifests",
  );
}

/** The current preparation writer hashes an ordered manifest of chunks and source locators. */
export async function verifyContentChunkManifest(input: {
  client: KnowledgeSqlClient;
  tenantId: string;
  chunkSetId: string;
}): Promise<void> {
  const { client, tenantId, chunkSetId } = input;
  const set = (
    await client.query<Row>(
      `select s.*,p.status procedure_status from retrieval.chunk_set s
    join retrieval.chunking_procedure_version p on p.tenant_id=s.tenant_id and p.id=s.procedure_version_id
    where s.tenant_id=$1 and s.id=$2`,
      [tenantId, chunkSetId],
    )
  ).rows[0];
  if (
    !set ||
    set.status !== "succeeded" ||
    set.procedure_status !== "admitted" ||
    !set.output_manifest_sha256 ||
    set.chunk_set_sha256 !== set.output_manifest_sha256
  )
    reject();
  const nodes = (
    await client.query<Row>(
      `select id,normalized_content_sha256 from content.document_node where tenant_id=$1 and representation_id=$2
    order by parent_id nulls first,ordinal,id limit $3`,
      [tenantId, set.representation_id, MAX_REPRESENTATION_NODES + 1],
    )
  ).rows;
  if (
    !nodes.length ||
    nodes.length > MAX_REPRESENTATION_NODES ||
    sha256Digest(nodes.map((node) => ({ id: String(node.id), digest: digestOf(node.normalized_content_sha256) }))) !==
      digestOf(set.input_manifest_sha256)
  )
    reject();
  const chunks = (
    await client.query<Row>(
      `select id,ordinal,source_text_sha256,embedding_text_sha256 from retrieval.retrieval_chunk
    where tenant_id=$1 and chunk_set_id=$2 order by ordinal,id limit $3`,
      [tenantId, chunkSetId, MAX_SET_CHUNKS + 1],
    )
  ).rows;
  if (!chunks.length || chunks.length > MAX_SET_CHUNKS) reject();
  const spans = (
    await client.query<Row>(
      `select s.*,n.selector,n.representation_id from retrieval.chunk_span s
    join retrieval.retrieval_chunk c on c.tenant_id=s.tenant_id and c.id=s.chunk_id
    join content.document_node n on n.tenant_id=s.tenant_id and n.id=s.document_node_id
    where s.tenant_id=$1 and c.chunk_set_id=$2 order by c.ordinal,s.ordinal limit $3`,
      [tenantId, chunkSetId, MAX_SET_SPANS + 1],
    )
  ).rows;
  if (spans.length > MAX_SET_SPANS) reject();
  const spansByChunk = new Map<string, Row[]>();
  for (const span of spans) {
    const id = String(span.chunk_id);
    const members = spansByChunk.get(id) ?? [];
    members.push(span);
    spansByChunk.set(id, members);
  }
  const manifest = chunks.map((chunk, ordinal) => {
    if (Number(chunk.ordinal) !== ordinal) reject();
    const members = spansByChunk.get(String(chunk.id)) ?? [];
    if (!members.length) reject();
    return {
      id: String(chunk.id),
      sourceTextDigest: digestOf(chunk.source_text_sha256),
      embeddingTextDigest: digestOf(chunk.embedding_text_sha256),
      spans: members.map((span, index) => {
        if (
          span.representation_id !== set.representation_id ||
          Number(span.ordinal) !== index ||
          span.start_offset === null ||
          span.end_offset === null
        )
          reject();
        const startOffset = Number(span.start_offset),
          endOffset = Number(span.end_offset);
        if (
          !Number.isSafeInteger(startOffset) ||
          !Number.isSafeInteger(endOffset) ||
          startOffset < 0 ||
          endOffset <= startOffset
        )
          reject();
        return {
          nodeId: String(span.document_node_id),
          startOffset,
          endOffset,
          locator: { ...SourceLocatorSchema.parse(span.selector), startOffset, endOffset },
        };
      }),
    };
  });
  if (sha256Digest(JSON.stringify(manifest)) !== digestOf(set.output_manifest_sha256)) reject();
}
