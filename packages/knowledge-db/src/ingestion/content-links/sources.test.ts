import { describe, expect, it } from "vitest";
import { convertStructuralDocument } from "@aiengineer/knowledge-preparation";
import { chunkDocument, defaultChunkProfileRegistry } from "@aiengineer/knowledge-preparation";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { ArtifactLedger } from "../../db-read/index.js";
import type { KnowledgeSqlClient } from "../../ports.js";
// The reader runs the real persistence admission read against the fake client below.
import { postgresContentAdmission } from "@aiengineer/knowledge-persistence";
import { ContentSourceReader } from "./sources.js";
import type { DocumentNode } from "@aiengineer/knowledge-contracts";

type Row = Record<string, unknown>;
type Artifact = Awaited<ReturnType<ArtifactLedger["get"]>>;
const tenantId = "00000000-0000-4000-8000-000000000001";
const representationId = "00000000-0000-4000-8000-000000000002";
const documentVersionId = "00000000-0000-4000-8000-000000000003";
const captureId = "00000000-0000-4000-8000-000000000004";

function fixture(nodeDigest: (node: DocumentNode) => string = (node) => node.digest) {
  const blocks = [
    {
      localKey: "heading",
      ordinal: 0,
      kind: "heading" as const,
      text: "Qualified evidence",
      locator: { page: 1, sectionPath: ["Evidence"] },
    },
    {
      localKey: "body",
      parentKey: "heading",
      ordinal: 0,
      kind: "paragraph" as const,
      text: "Cafe\u0301 😀 works only under the stated conditions.",
      role: "finding",
      language: "en",
      locator: { page: 2, domPath: "main/p" },
    },
  ];
  const document = convertStructuralDocument({ tenantId, representationId, createdAt: "2026-09-14T00:00:00Z", blocks });
  const persistedNodes = document.nodes.map((node) => ({ ...node, digest: nodeDigest(node) }));
  const result = chunkDocument(persistedNodes, defaultChunkProfileRegistry.get("heading-sections-v1"));
  const prepared = result.chunks[0]!;
  const nodes: Row[] = persistedNodes.map((node, index) => ({
    id: node.id,
    representation_id: representationId,
    parent_id: node.parentId ?? null,
    parent_local_key: blocks[index]!.parentKey ?? null,
    parent_representation_id: node.parentId ? representationId : null,
    stable_local_key: blocks[index]!.localKey,
    ordinal: node.ordinal,
    node_kind: node.kind,
    role: node.role ?? null,
    language: node.language ?? null,
    inline_text: node.text,
    selector: node.locator,
    normalized_content_sha256: node.digest.slice(7),
  }));
  const digest = sha256Digest(JSON.stringify(document));
  const representation: Row = {
    id: representationId,
    document_version_id: documentVersionId,
    content_sha256: digest.slice(7),
    acceptance_state: "pending",
    correction_state: "current",
    representation_class: "structural_extraction",
    artifact_id: "representation-artifact",
    transformation_run_id: "transform",
  };
  const capture: Row = { artifact_id: "capture-artifact", content_sha256: sha256Digest("captured bytes").slice(7) };
  const representations = new Map<string, Row>([[representationId, representation]]);
  const inputs = new Map<string, Row[]>([["transform", [{ source_capture_id: captureId }]]]);
  const outputs = new Map<string, Row[]>([["transform", [{ id: "transform" }]]]);
  const artifacts = new Map<string, Artifact>();
  function artifact(id: string, value: string, content: { text?: string; json?: unknown }) {
    artifacts.set(id, {
      record: {
        artifactId: id,
        artifactType: "test",
        digest: value,
        bucket: "test",
        objectPath: id,
        storageState: "available",
        mediaType: "application/json",
        sizeBytes: 1,
        reused: false,
      },
      ...content,
    } as Artifact);
  }
  artifact("representation-artifact", digest, { json: document });
  artifact("capture-artifact", `sha256:${capture.content_sha256}`, { text: "captured bytes" });
  const chunk: Row = {
    id: prepared.id,
    ordinal: 0,
    chunk_set_id: "set",
    representation_id: representationId,
    lifecycle: "active",
    chunk_set_status: "succeeded",
    source_text: prepared.sourceText,
    source_text_sha256: prepared.sourceTextDigest.slice(7),
    embedding_text_sha256: prepared.embeddingTextDigest.slice(7),
  };
  const set: Row = {
    id: "set",
    representation_id: representationId,
    status: "succeeded",
    procedure_status: "admitted",
    input_manifest_sha256: result.inputDigest.slice(7),
    output_manifest_sha256: result.outputDigest.slice(7),
    chunk_set_sha256: result.outputDigest.slice(7),
  };
  const spans: Row[] = prepared.spans.map((span, ordinal) => ({
    chunk_id: prepared.id,
    ordinal,
    document_node_id: span.nodeId,
    start_offset: span.startOffset,
    end_offset: span.endOffset,
    representation_id: representationId,
    selected_text_sha256: sha256Digest(
      document.nodes.find((node) => node.id === span.nodeId)!.text.slice(span.startOffset, span.endOffset),
    ).slice(7),
    selector: document.nodes.find((node) => node.id === span.nodeId)!.locator,
  }));
  const denied = new Set<string>();
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const client: KnowledgeSqlClient = {
    async query<R extends Row>(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values: values ?? [] });
      expect(values?.[0]).toBe(tenantId);
      let rows: Row[];
      if (sql.includes("from content.representation_decision")) {
        const representationId = String(values?.[1]),
          guarded = String(representations.get(representationId)?.content_sha256);
        rows = denied.has(representationId)
          ? []
          : [
              {
                id: "decision",
                tenant_id: tenantId,
                representation_id: representationId,
                decision: "accept",
                legacy_provenance: false,
                guarded_sha256: guarded,
                knowledge_review_decision_id: "review",
                decision_operation_id: "decision-operation",
                reviewer_identity: "reviewer",
                review_id: "review",
                review_legacy: false,
                review_digest: guarded,
                review_decision: "approve",
                review_identity: "reviewer",
                reviewer_role: "human_reviewer",
                review_operation_id: "decision-operation",
                subject_kind: "representation",
                subject_ref: { representationId, artifactDigest: `sha256:${guarded}` },
                subject_digest: guarded,
                eligible_roles: ["human_reviewer"],
                quorum_required: 1,
                representation_digest: guarded,
                producing_operation_id: null,
                subject_operation_id: "producer-operation",
                decision_current: true,
                subject_current: true,
                representation_kind: "structural_document",
                transformation_kind: "convert",
                transformation_attempt_id: "producer-attempt",
                producer_attempt_id: "producer-attempt",
                producer_deployment_id: "producer-deployment",
                reviewer_attempt_id: null,
                reviewer_resolved_attempt_id: null,
                reviewer_deployment_id: null,
                operation_id: "decision-operation",
                operation_actor: "reviewer",
                operation_kind: "representation_decision",
                operation_status: "succeeded",
                producer_actor: "producer",
              },
            ];
      } else if (sql.includes("from content.document_representation"))
        rows = representations.has(String(values?.[1])) ? [representations.get(String(values?.[1]))!] : [];
      else if (sql.includes("from content.document_version_source_capture"))
        rows = values?.[1] === documentVersionId && values?.[2] === captureId ? [capture] : [];
      else if (sql.includes("from content.transformation_run")) rows = outputs.get(String(values?.[1])) ?? [];
      else if (sql.includes("from content.transformation_input")) rows = inputs.get(String(values?.[1])) ?? [];
      else if (sql.includes("from content.document_node n")) rows = nodes.filter((node) => node.id === values?.[1]);
      else if (sql.includes("from content.document_node")) rows = nodes;
      else if (sql.includes("from retrieval.chunk_set")) rows = [set];
      else if (sql.includes("from retrieval.retrieval_chunk")) rows = [chunk];
      else if (sql.includes("from retrieval.chunk_span"))
        rows = spans.map((span) => ({
          ...span,
          selector: nodes.find((node) => node.id === span.document_node_id)?.selector,
        }));
      else throw new Error(`Unexpected query: ${sql}`);
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  const ledger = {
    async get(tenant: string, id: string) {
      expect(tenant).toBe(tenantId);
      const value = artifacts.get(id);
      if (!value) throw new Error("Missing test artifact");
      return value;
    },
  } as ArtifactLedger;
  const reader = new ContentSourceReader({ client, tenantId, artifacts: ledger, admission: postgresContentAdmission });
  const reference = {
    id: prepared.id,
    digest: prepared.sourceTextDigest,
    documentVersionId,
    representation: { id: representationId, digest },
    captureId,
    sourceNodes: persistedNodes.map((node) => ({ id: node.id, digest: node.digest, representationId })),
  };
  return {
    reader,
    reference,
    denied,
    representation,
    capture,
    representations,
    inputs,
    outputs,
    artifacts,
    nodes,
    spans,
    chunk,
    set,
    artifact,
    queries,
    verify: () => reader.chunk(reference),
    lineage: () => reader.representationCapture(reference.representation, documentVersionId, captureId),
  };
}

describe("canonical content sources", () => {
  it("rejects a raw accepted label without independent review", async () => {
    const value = fixture();
    value.representation.acceptance_state = "accepted";
    value.denied.add(representationId);
    await expect(value.verify()).rejects.toThrow(/independent acceptance/);
  });
  it("reconstructs actual writer nodes and complete multi-node Unicode source spans", async () => {
    const value = fixture();
    expect(value.spans).toHaveLength(2);
    const source = await value.verify();
    expect(source.text).toBe(value.chunk.source_text);
    expect(source.text).toContain("Café 😀");
    expect(source.nodes).toHaveLength(2);
  });
  it("reconstructs nodes persisted by the worker's normalized-text digest mapping", async () => {
    const value = fixture((node) => sha256Digest(node.text));
    const source = await value.verify();
    expect(source.text).toBe(value.chunk.source_text);
    expect(source.nodes).toHaveLength(2);
    for (const node of value.nodes)
      expect(`sha256:${String(node.normalized_content_sha256)}`).toBe(sha256Digest(String(node.inline_text)));
  });

  const mutations: readonly [string, (value: ReturnType<typeof fixture>) => void][] = [
    [
      "representation bytes missing despite available metadata",
      (value) => {
        delete value.artifacts.get("representation-artifact")!.json;
      },
    ],
    [
      "capture bytes missing despite available metadata",
      (value) => {
        delete value.artifacts.get("capture-artifact")!.text;
      },
    ],
    [
      "representation custody digest drift",
      (value) => {
        const artifact = value.artifacts.get("representation-artifact")!;
        value.artifacts.set("representation-artifact", {
          ...artifact,
          record: { ...artifact.record, digest: sha256Digest("drift") },
        });
      },
    ],
    [
      "unaccepted representation",
      (value) => {
        value.denied.add(representationId);
      },
    ],
    [
      "retracted document",
      (value) => {
        value.representation.correction_state = "retracted";
      },
    ],
    [
      "foreign document version",
      (value) => {
        value.representation.document_version_id = "foreign";
      },
    ],
    [
      "same-key foreign representation parent",
      (value) => {
        value.nodes[1]!.parent_representation_id = "foreign";
      },
    ],
    [
      "node text drift",
      (value) => {
        value.nodes[1]!.inline_text = "Changed text";
      },
    ],
    [
      "locator embedded node ID drift",
      (value) => {
        value.nodes[1]!.selector = { ...(value.nodes[1]!.selector as Row), nodeId: value.nodes[0]!.id };
      },
    ],
    [
      "locator embedded representation drift",
      (value) => {
        value.nodes[1]!.selector = { ...(value.nodes[1]!.selector as Row), representationId: "foreign" };
      },
    ],
    [
      "locator quote digest drift",
      (value) => {
        value.nodes[1]!.selector = { ...(value.nodes[1]!.selector as Row), quoteDigest: sha256Digest("drift") };
      },
    ],
    [
      "locator page drift",
      (value) => {
        value.nodes[1]!.selector = { ...(value.nodes[1]!.selector as Row), page: 99 };
      },
    ],
    [
      "another capture on the same version",
      (value) => {
        value.inputs.set("transform", [{ source_capture_id: "another-capture" }]);
      },
    ],
    [
      "missing successful transformation output",
      (value) => {
        value.outputs.set("transform", []);
      },
    ],
    [
      "missing transformation input census",
      (value) => {
        value.inputs.set("transform", []);
      },
    ],
    [
      "oversized transformation input census",
      (value) => {
        value.inputs.set(
          "transform",
          Array.from({ length: 257 }, () => ({ source_capture_id: captureId })),
        );
      },
    ],
    [
      "cyclic representation lineage",
      (value) => {
        value.inputs.set("transform", [{ representation_id: representationId }]);
      },
    ],
    [
      "missing prior representation",
      (value) => {
        value.inputs.set("transform", [{ representation_id: "absent" }]);
      },
    ],
    [
      "selected span text digest drift",
      (value) => {
        value.spans[1]!.selected_text_sha256 = "a".repeat(64);
      },
    ],
    [
      "inactive chunk",
      (value) => {
        value.chunk.lifecycle = "withdrawn";
      },
    ],
    [
      "undeclared source node",
      (value) => {
        value.reference.sourceNodes.pop();
      },
    ],
  ];
  it.each(mutations)("rejects %s after validating the original source fixture", async (_name, mutate) => {
    const value = fixture();
    await value.verify();
    mutate(value);
    await expect(value.verify()).rejects.toThrow();
  });
  it.each(mutations)("rejects %s with worker-persisted text digests", async (_name, mutate) => {
    const value = fixture((node) => sha256Digest(node.text));
    await value.verify();
    mutate(value);
    await expect(value.verify()).rejects.toThrow();
  });
  it("rejects an arbitrary stored and declared node digest even when both agree", async () => {
    const value = fixture((node) => sha256Digest(node.text));
    await value.verify();
    value.nodes[1]!.normalized_content_sha256 = sha256Digest("unrelated").slice(7);
    value.reference.sourceNodes[1]!.digest = sha256Digest("unrelated");
    await expect(value.reader.node(value.reference.sourceNodes[1]!)).rejects.toThrow(/digest/);
  });

  it("accepts byte-identical native capture lineage and rejects its false identity flag", async () => {
    const value = fixture();
    await value.lineage();
    Object.assign(value.representation, {
      representation_class: "source_native",
      source_native_byte_identical: true,
      artifact_id: value.capture.artifact_id,
      content_sha256: value.capture.content_sha256,
    });
    value.reference.representation.digest = `sha256:${String(value.capture.content_sha256)}`;
    await value.lineage();
    value.representation.source_native_byte_identical = false;
    await expect(value.lineage()).rejects.toThrow(/does not derive/);
  });

  it("accepts an accepted intermediate representation with successful capture lineage", async () => {
    const value = fixture();
    await value.lineage();
    value.representations.set("prior", {
      ...value.representation,
      id: "prior",
      transformation_run_id: "prior-transform",
    });
    value.inputs.set("transform", [{ representation_id: "prior" }]);
    value.outputs.set("prior-transform", [{ id: "prior-transform" }]);
    value.inputs.set("prior-transform", [{ source_capture_id: captureId }]);
    await value.lineage();
    value.denied.add("prior");
    await expect(value.lineage()).rejects.toThrow(/acceptance/);
  });

  it("rejects an acyclic lineage exceeding the supported depth", async () => {
    const value = fixture();
    await value.lineage();
    value.inputs.set("transform", [{ representation_id: "prior-0" }]);
    for (let index = 0; index < 16; index++) {
      const id = `prior-${index}`,
        transform = `transform-${index}`;
      value.representations.set(id, { ...value.representation, id, transformation_run_id: transform });
      value.outputs.set(transform, [{ id: transform }]);
      value.inputs.set(
        transform,
        index === 15 ? [{ source_capture_id: captureId }] : [{ representation_id: `prior-${index + 1}` }],
      );
    }
    await expect(value.lineage()).rejects.toThrow(/depth limit/);
  });

  it("accepts exact capture artifact inputs and rejects an unrelated artifact", async () => {
    const value = fixture();
    await value.lineage();
    value.inputs.set("transform", [{ artifact_id: value.capture.artifact_id }]);
    await value.lineage();
    value.inputs.set("transform", [{ artifact_id: "unrelated-artifact" }]);
    await expect(value.lineage()).rejects.toThrow(/does not derive/);
  });

  it("accepts exactly 4096 lineage edges and rejects one extra edge across individually bounded branches", async () => {
    const value = fixture();
    value.inputs.set(
      "transform",
      Array.from({ length: 16 }, (_, index) => ({ representation_id: `branch-${index}` })),
    );
    for (let index = 0; index < 16; index++) {
      const id = `branch-${index}`,
        transform = `branch-transform-${index}`;
      value.representations.set(id, { ...value.representation, id, transformation_run_id: transform });
      value.outputs.set(transform, [{ id: transform }]);
      value.inputs.set(
        transform,
        Array.from({ length: 255 }, (_, edge) => ({
          source_capture_id: index === 15 && edge === 254 ? captureId : `unrelated-${index}-${edge}`,
        })),
      );
    }
    await expect(value.lineage()).resolves.toBe(value.representation);
    value.inputs.get("branch-transform-15")!.unshift({ source_capture_id: "one-extra-edge" });
    await expect(value.lineage()).rejects.toThrow(/total work limit/);
  });

  it("visits a shared six-layer DAG with linear work instead of expanding every path", async () => {
    const value = fixture();
    const width = 8,
      layers = 6;
    value.inputs.set("transform", [
      ...Array.from({ length: width }, (_, index) => ({ representation_id: `layer-0-${index}` })),
      { source_capture_id: captureId },
    ]);
    for (let layer = 0; layer < layers; layer++) {
      for (let index = 0; index < width; index++) {
        const id = `layer-${layer}-${index}`,
          transform = `transform-${id}`;
        value.representations.set(id, { ...value.representation, id, transformation_run_id: transform });
        value.outputs.set(transform, [{ id: transform }]);
        value.inputs.set(
          transform,
          layer === layers - 1
            ? [{ source_capture_id: "unrelated-capture" }]
            : Array.from({ length: width }, (_, next) => ({ representation_id: `layer-${layer + 1}-${next}` })),
        );
      }
    }
    await expect(value.lineage()).resolves.toBe(value.representation);
    const inspections = value.queries.filter((query) => query.sql.includes("from content.transformation_input"));
    expect(inspections).toHaveLength(1 + layers * width);
    const admissionReads = value.queries.filter((query) => query.sql.includes("from content.representation_decision"));
    const representationReads = value.queries.filter((query) => query.sql.includes("select r.*,d.correction_state"));
    expect(admissionReads).toHaveLength(representationReads.length);
    expect(value.queries.length - admissionReads.length).toBeLessThan(1000);
  });

  it("does not reuse cached negative lineage across independent reader requests", async () => {
    const value = fixture();
    value.representations.set("shared", {
      ...value.representation,
      id: "shared",
      transformation_run_id: "shared-transform",
    });
    value.outputs.set("shared-transform", [{ id: "shared-transform" }]);
    value.inputs.set("shared-transform", [{ source_capture_id: "unrelated-capture" }]);
    value.inputs.set("transform", [{ representation_id: "shared" }, { source_capture_id: captureId }]);
    await value.lineage();
    value.inputs.set("transform", [{ representation_id: "shared" }]);
    value.inputs.set("shared-transform", [{ source_capture_id: captureId }]);
    await expect(value.lineage()).resolves.toBe(value.representation);
    value.inputs.set("shared-transform", [{ source_capture_id: "unrelated-capture" }]);
    await expect(value.lineage()).rejects.toThrow(/does not derive/);
  });

  it("treats empty text and JSON null as present custody bytes", async () => {
    const value = fixture();
    value.artifacts.get("capture-artifact")!.text = "";
    value.artifacts.get("representation-artifact")!.json = null;
    await expect(value.lineage()).resolves.toBe(value.representation);
  });
});
