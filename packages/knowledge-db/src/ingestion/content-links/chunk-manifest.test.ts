import { describe, expect, it } from "vitest";
import { convertStructuralDocument } from "@aiengineer/knowledge-preparation";
import { chunkDocument, defaultChunkProfileRegistry } from "@aiengineer/knowledge-preparation";
import type { KnowledgeSqlClient } from "../../ports.js";
import { verifyContentChunkManifest } from "./chunk-manifest.js";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { DocumentNode } from "@aiengineer/knowledge-contracts";

type Row = Record<string, unknown>;
const tenantId = "00000000-0000-4000-8000-000000000001";
const representationId = "00000000-0000-4000-8000-000000000002";

function fixture(nodeDigest: (node: DocumentNode) => string = (node) => node.digest) {
  const document = convertStructuralDocument({
    tenantId,
    representationId,
    createdAt: "2026-09-14T00:00:00Z",
    blocks: [
      {
        localKey: "heading",
        ordinal: 0,
        kind: "heading",
        text: "Unicode",
        locator: { page: 1, sectionPath: ["Unicode"] },
      },
      {
        localKey: "body",
        parentKey: "heading",
        ordinal: 0,
        kind: "paragraph",
        text: "Cafe\u0301 😀 is retained. Another assertion remains qualified.",
        locator: { page: 1, sectionPath: ["Unicode"], domPath: "main/p" },
      },
    ],
  });
  const persistedNodes = document.nodes.map((node) => ({ ...node, digest: nodeDigest(node) }));
  const result = chunkDocument(persistedNodes, defaultChunkProfileRegistry.get("atomic-claims-v1"));
  const set: Row = {
    id: "set",
    representation_id: representationId,
    status: "succeeded",
    procedure_status: "admitted",
    input_manifest_sha256: result.inputDigest.slice(7),
    output_manifest_sha256: result.outputDigest.slice(7),
    chunk_set_sha256: result.outputDigest.slice(7),
  };
  const nodes: Row[] = persistedNodes.map((node) => ({ id: node.id, normalized_content_sha256: node.digest.slice(7) }));
  const chunks: Row[] = result.chunks.map((chunk) => ({
    id: chunk.id,
    ordinal: chunk.ordinal,
    source_text_sha256: chunk.sourceTextDigest.slice(7),
    embedding_text_sha256: chunk.embeddingTextDigest.slice(7),
  }));
  const spans: Row[] = result.chunks.flatMap((chunk) =>
    chunk.spans.map((span, ordinal) => ({
      chunk_id: chunk.id,
      ordinal,
      document_node_id: span.nodeId,
      start_offset: span.startOffset,
      end_offset: span.endOffset,
      representation_id: representationId,
      selector: document.nodes.find((node) => node.id === span.nodeId)!.locator,
    })),
  );
  const client: KnowledgeSqlClient = {
    async query<R extends Row>(sql: string, values?: readonly unknown[]) {
      expect(values?.[0]).toBe(tenantId);
      let rows: Row[];
      if (sql.includes("from retrieval.chunk_set")) rows = [set];
      else if (sql.includes("from content.document_node")) rows = nodes;
      else if (sql.includes("from retrieval.retrieval_chunk")) rows = chunks;
      else if (sql.includes("from retrieval.chunk_span")) rows = spans;
      else throw new Error(`Unexpected query: ${sql}`);
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  return {
    set,
    nodes,
    chunks,
    spans,
    result,
    verify: () => verifyContentChunkManifest({ client, tenantId, chunkSetId: "set" }),
  };
}

describe("retained chunk manifests", () => {
  it("reconstructs the actual writer manifest including Unicode, partial node spans and contextual headings", async () => {
    const value = fixture();
    expect(value.result.chunks.some((chunk) => chunk.contextualPrefix.length > 0)).toBe(true);
    expect(value.result.chunks.some((chunk) => chunk.spans.some((span) => span.startOffset > 0))).toBe(true);
    await expect(value.verify()).resolves.toBeUndefined();
  });
  it("reconstructs a full chunk manifest built from the worker's persisted text-digest nodes", async () => {
    const worker = fixture((node) => sha256Digest(node.text));
    const directDocument = fixture();
    expect(worker.result.inputDigest).not.toBe(directDocument.result.inputDigest);
    await expect(worker.verify()).resolves.toBeUndefined();
    worker.set.input_manifest_sha256 = directDocument.result.inputDigest.slice(7);
    await expect(worker.verify()).rejects.toThrow(/Chunk-set membership/);
  });

  const mutations: readonly [string, (value: ReturnType<typeof fixture>) => void][] = [
    [
      "missing output digest",
      (value) => {
        value.set.output_manifest_sha256 = null;
      },
    ],
    [
      "set digest mismatch",
      (value) => {
        value.set.chunk_set_sha256 = "a".repeat(64);
      },
    ],
    [
      "unadmitted procedure",
      (value) => {
        value.set.procedure_status = "candidate";
      },
    ],
    [
      "unfinished chunk set",
      (value) => {
        value.set.status = "running";
      },
    ],
    [
      "changed input node digest",
      (value) => {
        value.nodes[0]!.normalized_content_sha256 = "a".repeat(64);
      },
    ],
    [
      "missing input node",
      (value) => {
        value.nodes.pop();
      },
    ],
    [
      "missing chunk",
      (value) => {
        value.chunks.pop();
      },
    ],
    [
      "changed chunk text digest",
      (value) => {
        value.chunks[0]!.source_text_sha256 = "a".repeat(64);
      },
    ],
    [
      "noncontiguous chunk ordinals",
      (value) => {
        value.chunks[0]!.ordinal = 5;
      },
    ],
    [
      "missing span",
      (value) => {
        value.spans.pop();
      },
    ],
    [
      "foreign representation span",
      (value) => {
        value.spans[0]!.representation_id = "foreign";
      },
    ],
    [
      "changed locator",
      (value) => {
        value.spans[0]!.selector = { ...(value.spans[0]!.selector as Row), page: 9 };
      },
    ],
    [
      "changed span offset",
      (value) => {
        value.spans[0]!.end_offset = Number(value.spans[0]!.end_offset) - 1;
      },
    ],
    [
      "null span offset",
      (value) => {
        value.spans[0]!.start_offset = null;
      },
    ],
    [
      "fractional span offset",
      (value) => {
        value.spans[0]!.start_offset = 0.5;
      },
    ],
    [
      "oversized node census",
      (value) => {
        value.nodes.push(...Array.from({ length: 4096 }, () => ({ ...value.nodes[0] })));
      },
    ],
    [
      "oversized chunk census",
      (value) => {
        value.chunks.push(...Array.from({ length: 512 }, () => ({ ...value.chunks[0] })));
      },
    ],
  ];
  it.each(mutations)("rejects %s after validating the original writer fixture", async (_name, mutate) => {
    const value = fixture();
    await value.verify();
    mutate(value);
    await expect(value.verify()).rejects.toThrow(/Chunk-set membership/);
  });
  it.each(mutations)("rejects %s in a worker-persisted text-digest manifest", async (_name, mutate) => {
    const value = fixture((node) => sha256Digest(node.text));
    await value.verify();
    mutate(value);
    await expect(value.verify()).rejects.toThrow(/Chunk-set membership/);
  });
});
