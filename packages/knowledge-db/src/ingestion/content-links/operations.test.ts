import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContentLinkOperationSchema, type ContentLinkOperation } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { KnowledgeSqlClient } from "../../ports.js";
import { ContentSourceReader } from "./sources.js";
import type { AuthenticatedContentEvidence } from "./types.js";
import {
  applyPreparedContentOperation,
  contentLinkEffect,
  prepareContentOperation,
  reconcileContentOperationRefs,
  type ContentOperationContext,
  type PreparedContentOperation,
} from "./operations.js";

const ids = Object.fromEntries(
  [
    "tenant",
    "attempt",
    "receipt",
    "document",
    "version",
    "entity",
    "object",
    "chunk",
    "node",
    "representation",
    "artifact",
    "capture",
    "claim",
    "run",
    "manifest",
    "assessment",
    "locator",
    "relationship",
    "summary",
    "output",
    "transformation",
  ].map((key) => [key, randomUUID()]),
) as Record<string, string>;
const digest = sha256Digest("immutable"),
  selectedText = "The library works on beta only.",
  qualifiers = ["beta only"];
const node = { id: ids.node!, digest, representationId: ids.representation! };
const chunk = {
  id: ids.chunk!,
  digest: sha256Digest(selectedText),
  documentVersionId: ids.version!,
  representation: { id: ids.representation!, digest },
  captureId: ids.capture!,
  sourceNodes: [node],
};
const evidenceRef = {
  claimId: ids.claim!,
  claimKey: "claim",
  claimDigest: digest,
  runId: ids.run!,
  manifest: { id: ids.manifest!, digest },
  assessment: { id: ids.assessment!, digest },
  locatorId: ids.locator!,
  captureId: ids.capture!,
  role: "supports" as const,
};
const common = {
  operationId: "op",
  dependsOn: [],
  evidence: [evidenceRef],
  rationale: "Admit exact supported content",
  applicability: { validFrom: null, validTo: null, qualifiers },
};
const operations = [
  {
    ...common,
    kind: "document.entity.link",
    documentId: ids.document,
    documentVersion: { id: ids.version, digest },
    entityId: ids.entity,
    role: "primary",
    method: "extraction",
    confidence: 0.9,
    sourceNodes: [node],
  },
  {
    ...common,
    kind: "chunk.entity.link",
    chunk,
    entityId: ids.entity,
    verb: "recommends",
    method: "verified",
    confidence: 0.9,
  },
  { ...common, kind: "chunk.claim.link", chunk, claimId: ids.claim, verb: "supports" },
  { ...common, kind: "chunk.relationship.link", chunk, relationshipId: ids.relationship, verb: "supports" },
  {
    ...common,
    kind: "summary.materialize",
    summaryId: ids.summary,
    documentVersion: { id: ids.version, digest },
    representation: { id: ids.output, digest: sha256Digest(`${selectedText}\n${qualifiers[0]}`) },
    derivedFrom: { id: ids.representation, digest },
    transformationRunId: ids.transformation,
    summaryKind: "technical",
    scope: "document",
    audience: "engineer",
    text: `${selectedText}\n${qualifiers[0]}`,
    tokenCount: 12,
    sources: [{ ...node, weight: 1 }],
  },
  { ...common, kind: "summary.source.link", summaryId: ids.summary, source: { ...node, weight: 1 } },
  {
    ...common,
    kind: "projection.target.link",
    target: { kind: "entity", canonicalId: ids.entity },
    sourceChunks: [chunk],
  },
].map((value) => ContentLinkOperationSchema.parse(value));

type Query = (sql: string, values: readonly unknown[]) => Record<string, unknown>[] | undefined;
function fixture(operation: ContentLinkOperation, override: Query = () => undefined) {
  const writes: { sql: string; values: readonly unknown[] }[] = [];
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      if (/^(insert|update)/.test(sql)) {
        writes.push({ sql, values });
        return { rows: [] };
      }
      const custom = override(sql, values);
      if (custom) return { rows: custom };
      if (sql.includes("from corpus.entity")) return { rows: [{ id: ids.entity }] };
      if (sql.includes("from corpus.relationship"))
        return {
          rows: [
            {
              id: ids.relationship,
              primary_claim_id: ids.claim,
              from_entity_id: ids.entity,
              to_entity_id: ids.object,
              qualifier: "beta only",
            },
          ],
        };
      if (sql.includes("from content.transformation_run")) return { rows: [{ id: ids.transformation }] };
      if (sql.includes("from content.document_representation"))
        return { rows: [{ content_sha256: digest.slice(7), artifact_id: ids.artifact }] };
      if (sql.includes("count(*)")) return { rows: [{ count: 2 }] };
      if (sql.startsWith("select verb from retrieval.chunk_")) return { rows: [{ verb: "supports" }] };
      return { rows: [] };
    },
  } as unknown as KnowledgeSqlClient;
  const sources = {
    async documentVersion() {
      return {};
    },
    async node() {
      return { id: ids.node!, representationId: ids.representation!, text: selectedText, kind: "paragraph" };
    },
    async chunk() {
      return { id: ids.chunk!, text: selectedText, nodes: [] };
    },
    async representation(reference: { id: string }) {
      return reference.id === ids.output
        ? {
            representation_class: "semantic_projection",
            representation_kind: "summary",
            transformation_run_id: ids.transformation,
          }
        : { representation_class: "source_native", artifact_id: ids.artifact };
    },
    async representationCapture() {
      return {};
    },
  } as unknown as ContentSourceReader;
  const evidence: AuthenticatedContentEvidence = {
    reference: evidenceRef,
    statement: selectedText,
    qualifiers,
    entityBindings: [
      { canonicalId: ids.entity!, role: "subject" },
      { canonicalId: ids.object!, role: "object" },
    ],
    downstreamUse: [`content_link:${operation.kind}`],
    value: contentLinkEffect(operation),
    verdict: "directly_supported",
    policyOutcome: "pass",
    policyDigest: digest,
    eligible: true,
    selectedText,
    selectedContentDigest: sha256Digest(selectedText),
    representationArtifactId: ids.artifact!,
    captureArtifactId: randomUUID(),
  };
  const context: ContentOperationContext = {
    client,
    tenantId: ids.tenant!,
    attemptId: ids.attempt!,
    receiptId: ids.receipt!,
    sources,
    evidence: [evidence],
  };
  return { context, writes, evidence };
}
function forOperation(context: ContentOperationContext, operation: ContentLinkOperation): ContentOperationContext {
  return {
    ...context,
    evidence: context.evidence.map((evidence) => ({
      ...evidence,
      value: contentLinkEffect(operation),
      downstreamUse: [`content_link:${operation.kind}`],
    })),
  };
}
const summary = operations[4]!;

describe("typed content operation admission", () => {
  it.each(operations.map((operation) => [operation.kind, operation] as const))(
    "prepares %s without writing, then applies typed canonical rows",
    async (_kind, operation) => {
      const { context, writes } = fixture(operation);
      let scoped = context;
      if (operation.kind === "summary.source.link") {
        const prior = await prepareContentOperation(forOperation(context, summary), summary);
        operation = { ...operation, dependsOn: [summary.operationId] };
        scoped = { ...context, priorPrepared: new Map([[summary.operationId, prior]]) };
      }
      const prepared = await prepareContentOperation(scoped, operation);
      expect(prepared.result.outcome).toBe(operation.kind === "summary.source.link" ? "no_op" : "applied");
      expect(writes).toHaveLength(0);
      const result = await applyPreparedContentOperation(scoped, prepared);
      expect(result.canonicalRefs.length).toBeGreaterThan(0);
      if (operation.kind === "summary.source.link") expect(writes).toHaveLength(0);
      else expect(writes.length).toBeGreaterThan(0);
      expect(
        writes.every(
          (write) => write.sql.startsWith("insert into content.") || write.sql.startsWith("insert into retrieval."),
        ),
      ).toBe(true);
      expect(writes.every((write) => write.values.includes(ids.tenant))).toBe(true);
    },
  );

  it("requires exact verified effects and intended use for stronger semantic verbs and confidence", async () => {
    const operation = operations[1]!,
      { context } = fixture(operation);
    expect(
      (await prepareContentOperation(context, { ...operation, confidence: 0.1 } as ContentLinkOperation)).result
        .reasons,
    ).toEqual(["CONTENT_VERIFIED_EFFECT_MISMATCH"]);
    expect(
      (
        await prepareContentOperation(
          { ...context, evidence: [{ ...context.evidence[0]!, downstreamUse: ["source_attributed_report"] }] },
          operation,
        )
      ).result.reasons,
    ).toEqual(["CONTENT_EVIDENCE_INTENDED_USE_MISMATCH"]);
    expect(
      contentLinkEffect({ ...operation, operationId: "other", rationale: "different", dependsOn: ["prior"] }),
    ).toBe(contentLinkEffect(operation));
  });

  it("links already admitted canonical facts without a self-referential future claim ID effect", async () => {
    const operation = operations[2]!,
      { context } = fixture(operation);
    const existingFact = {
      ...context,
      evidence: [{ ...context.evidence[0]!, value: "original independently verified value" }],
    };
    expect((await prepareContentOperation(existingFact, operation)).result.outcome).toBe("applied");
    expect(
      (await prepareContentOperation(existingFact, { ...operation, verb: "explains" } as ContentLinkOperation)).result
        .reasons,
    ).toEqual(["CONTENT_LINK_VERB_REQUIRES_EFFECT"]);
    expect(
      (await prepareContentOperation(existingFact, { ...operation, verb: "context" } as ContentLinkOperation)).result
        .reasons,
    ).toEqual(["CONTENT_CLAIM_ROLE_MISMATCH"]);
  });

  it.each([
    ["unknown policy", { policyOutcome: "review_required" }, "CONTENT_EVIDENCE_NOT_ADMITTED"],
    ["wrong selected digest", { selectedContentDigest: digest }, "CONTENT_EVIDENCE_NOT_ADMITTED"],
    ["wrong representation", { representationArtifactId: randomUUID() }, "CONTENT_CHUNK_EVIDENCE_REQUIRED"],
    [
      "different bytes",
      { selectedText: "Invented", selectedContentDigest: sha256Digest("Invented") },
      "CONTENT_SELECTED_SOURCE_MISMATCH",
    ],
    ["missing entity binding", { entityBindings: [] }, "CONTENT_ENTITY_BINDING_REQUIRED"],
  ] as const)("holds %s before mutation", async (_name, amendment, reason) => {
    const operation = operations[1]!,
      { context, writes } = fixture(operation);
    const prepared = await prepareContentOperation(
      { ...context, evidence: [{ ...context.evidence[0]!, ...amendment }] },
      operation,
    );
    expect(prepared.result).toMatchObject({ outcome: "held", reasons: [reason], canonicalRefs: [] });
    expect(writes).toHaveLength(0);
  });

  it("rejects dropped qualifiers and arbitrary caller intervals even with a matching effect", async () => {
    for (const applicability of [
      { validFrom: null, validTo: null, qualifiers: [] },
      { validFrom: "2026-01-01T00:00:00Z", validTo: null, qualifiers },
    ]) {
      const operation = { ...operations[2]!, applicability },
        { context } = fixture(operation);
      expect((await prepareContentOperation(context, operation)).result.outcome).toBe("held");
    }
  });

  it("requires relationship provenance, endpoint roles and exact canonical temporal interval", async () => {
    const operation = {
      ...operations[3]!,
      applicability: { qualifiers, validFrom: "2026-01-01T00:00:00Z", validTo: "2027-01-01T00:00:00Z" },
    };
    const { context } = fixture(operation, (sql) =>
      sql.includes("from temporal.segment")
        ? [{ primary_claim_id: ids.claim, valid_from: "2026-01-01T00:00:00Z", valid_to: "2027-01-01T00:00:00Z" }]
        : undefined,
    );
    expect((await prepareContentOperation(context, operation)).result.outcome).toBe("applied");
    const widened = { ...operation, applicability: { ...operation.applicability, validTo: null } };
    expect((await prepareContentOperation(forOperation(context, widened), widened)).result.reasons).toEqual([
      "CONTENT_TEMPORAL_AUTHORITY_REQUIRED",
    ]);
    const unrelated = fixture(operation, (sql) =>
      sql.includes("from corpus.relationship") ? [{ primary_claim_id: randomUUID() }] : undefined,
    );
    expect((await prepareContentOperation(unrelated.context, operation)).result.reasons).toEqual([
      "CONTENT_RELATIONSHIP_EVIDENCE_REQUIRED",
    ]);
  });

  it.each([
    { from: "2026-01-01 00:00:00.123456+00", to: "2027-01-01 00:00:00.654321+00", outcome: "applied" },
    { from: "2025-12-31 19:00:00.123456-05", to: "2027-01-01 05:30:00.654321+05:30", outcome: "applied" },
    { from: "2026-01-01 00:00:00.123457+00", to: "2027-01-01 00:00:00.654321+00", outcome: "held" },
    { from: "2026-01-01 00:00:00.123456+00", to: "2027-01-01 00:00:00.654322+00", outcome: "held" },
    { from: new Date("2026-01-01T00:00:00.123Z"), to: "2027-01-01 00:00:00.654321+00", outcome: "held" },
    { from: "2026-01-01 00:00:00.1234560001+00", to: "2027-01-01 00:00:00.654321+00", outcome: "held" },
    { from: "2026-01-01 00:00:00.123456+00", to: null, outcome: "held" },
  ])("compares relationship intervals losslessly %#", async ({ from, to, outcome }) => {
    const operation = {
      ...operations[3]!,
      applicability: { qualifiers, validFrom: "2026-01-01T00:00:00.123456Z", validTo: "2027-01-01T00:00:00.654321Z" },
    };
    const { context } = fixture(operation, (sql) => {
      if (!sql.includes("from temporal.segment")) return undefined;
      expect(sql).toContain("lower(s.valid_during)::text");
      expect(sql).toContain("upper(s.valid_during)::text");
      return [{ primary_claim_id: ids.claim, valid_from: from, valid_to: to }];
    });
    const { result } = await prepareContentOperation(context, operation);
    expect(result.outcome).toBe(outcome);
    if (outcome === "held") expect(result.reasons).toEqual(["CONTENT_TEMPORAL_AUTHORITY_REQUIRED"]);
  });

  it("requires exact null for unbounded relationship endpoints", async () => {
    const operation = { ...operations[3]!, applicability: { qualifiers, validFrom: null, validTo: null } };
    for (const [to, outcome] of [
      [null, "applied"],
      [undefined, "held"],
      ["infinity", "held"],
    ] as const) {
      const { context } = fixture(operation, (sql) =>
        sql.includes("from temporal.segment")
          ? [{ primary_claim_id: ids.claim, valid_from: null, valid_to: to }]
          : undefined,
      );
      expect((await prepareContentOperation(context, operation)).result.outcome).toBe(outcome);
    }
  });

  it("returns no_op for identical rows and holds changed attributes", async () => {
    const operation = operations[1]!;
    for (const [confidence, outcome] of [
      [0.9, "no_op"],
      [0.1, "held"],
    ] as const) {
      const { context, writes } = fixture(operation, (sql) =>
        sql.includes("from retrieval.chunk_entity_mention")
          ? [{ method: "verified", confidence: String(confidence) }]
          : undefined,
      );
      expect((await prepareContentOperation(context, operation)).result.outcome).toBe(outcome);
      expect(writes).toHaveLength(0);
    }
  });

  it("does not accept invented summary prose or nonexistent summarize transformations", async () => {
    const invented = {
      ...summary,
      text: `${selectedText}\n${qualifiers[0]}\nAn invented conclusion.`,
    } as ContentLinkOperation;
    expect((await prepareContentOperation(fixture(invented).context, invented)).result.reasons).toEqual([
      "CONTENT_SUMMARY_RENDERING_MISMATCH",
    ]);
    const missing = fixture(summary, (sql) => (sql.includes("from content.transformation_run") ? [] : undefined));
    expect((await prepareContentOperation(missing.context, summary)).result.reasons).toEqual([
      "CONTENT_SUMMARY_TRANSFORMATION_REQUIRED",
    ]);
  });

  it("allows only an admitted declared summary producer during read-only planning", async () => {
    const projection = {
      ...operations[6]!,
      target: { kind: "summary", canonicalId: ids.summary! },
      dependsOn: [summary.operationId],
    } as ContentLinkOperation;
    const { context } = fixture(projection);
    const prior = await prepareContentOperation(forOperation(context, summary), summary);
    const preparedContext = { ...context, priorPrepared: new Map([[summary.operationId, prior]]) };
    expect((await prepareContentOperation(preparedContext, projection)).result.outcome).toBe("applied");
    expect((await prepareContentOperation(preparedContext, { ...projection, dependsOn: [] })).result.reasons).toEqual([
      "CONTENT_SUMMARY_REQUIRED",
    ]);
    const forged = { result: prior.result } as PreparedContentOperation;
    expect(
      (
        await prepareContentOperation(
          { ...context, priorPrepared: new Map([[summary.operationId, forged]]) },
          projection,
        )
      ).result.reasons,
    ).toEqual(["CONTENT_SUMMARY_REQUIRED"]);
  });

  it("binds prepared writes to their actual transaction client and requires a receipt", async () => {
    const operation = operations[2]!,
      { context } = fixture(operation),
      prepared = await prepareContentOperation(context, operation);
    const { receiptId: _receiptId, ...withoutReceipt } = context;
    await expect(applyPreparedContentOperation(withoutReceipt, prepared)).rejects.toThrow(
      "CONTENT_PREPARATION_TRANSACTION_REQUIRED",
    );
    await expect(applyPreparedContentOperation(fixture(operation).context, prepared)).rejects.toThrow(
      "CONTENT_PREPARATION_TRANSACTION_REQUIRED",
    );
    await expect(applyPreparedContentOperation(context, { result: prepared.result })).rejects.toThrow(
      "CONTENT_PREPARATION_TRANSACTION_REQUIRED",
    );
  });

  it("requires actual or explicitly ordered source bridges before creating projection targets", async () => {
    const operation = operations[6]!,
      { context } = fixture(operation, (sql) => (sql.startsWith("select verb from retrieval.chunk_") ? [] : undefined));
    expect((await prepareContentOperation(context, operation)).result.reasons).toEqual([
      "CONTENT_PROJECTION_SOURCE_BRIDGE_REQUIRED",
    ]);
    const producer = { ...operations[1]!, operationId: "entity-source" };
    const prior = await prepareContentOperation(forOperation(context, producer), producer);
    const dependent = { ...operation, dependsOn: [producer.operationId] };
    expect(
      (
        await prepareContentOperation(
          { ...context, priorPrepared: new Map([[producer.operationId, prior]]) },
          dependent,
        )
      ).result.outcome,
    ).toBe("applied");
  });

  it("does not silently ignore unrelated evidence from another capture", async () => {
    const operation = operations[2]!,
      { context } = fixture(operation);
    const extra = {
      ...context.evidence[0]!,
      reference: { ...evidenceRef, captureId: randomUUID(), locatorId: randomUUID() },
    };
    const amended = { ...operation, evidence: [...operation.evidence, extra.reference] };
    expect(
      (await prepareContentOperation({ ...context, evidence: [...context.evidence, extra] }, amended)).result.reasons,
    ).toEqual(["CONTENT_CHUNK_EVIDENCE_CENSUS_MISMATCH"]);
  });

  it("accepts exact captured bytes carried through an authenticated faithful representation", async () => {
    const operation = operations[2]!,
      { context } = fixture(operation);
    const original = context.evidence[0]!;
    const captured = { ...context, evidence: [{ ...original, representationArtifactId: original.captureArtifactId }] };
    expect((await prepareContentOperation(captured, operation)).result.outcome).toBe("applied");
    expect(
      (
        await prepareContentOperation(
          { ...captured, evidence: [{ ...captured.evidence[0]!, representationArtifactId: randomUUID() }] },
          operation,
        )
      ).result.outcome,
    ).toBe("held");
  });

  it("does not treat null confidence as the explicitly verified numeric zero", async () => {
    const operation = { ...operations[1]!, confidence: 0 } as ContentLinkOperation;
    const { context } = fixture(operation, (sql) =>
      sql.includes("from retrieval.chunk_entity_mention") ? [{ method: "verified", confidence: null }] : undefined,
    );
    expect((await prepareContentOperation(context, operation)).result.reasons).toEqual([
      "CONTENT_EXISTING_ROW_CONFLICT",
    ]);
  });

  it("holds confidence and source weights that canonical numeric columns would round", async () => {
    const document = operations[0]!;
    const sourceLink = operations[5]!;
    if (
      document.kind !== "document.entity.link" ||
      summary.kind !== "summary.materialize" ||
      sourceLink.kind !== "summary.source.link"
    )
      throw new Error("PRECISION_FIXTURES_REQUIRED");
    const proposals = [
      { ...document, confidence: 0.12345 },
      { ...summary, sources: [{ ...summary.sources[0]!, weight: 0.12345 }] },
      { ...sourceLink, source: { ...sourceLink.source, weight: 0.12345 } },
    ];
    for (const operation of proposals) {
      const { context, writes } = fixture(operation);
      expect((await prepareContentOperation(context, operation)).result).toMatchObject({
        outcome: "held",
        reasons: ["CONTENT_CANONICAL_NUMERIC_PRECISION"],
        canonicalRefs: [],
      });
      expect(writes).toHaveLength(0);
    }
  });

  it.each([0, 0.0001, 0.1234, 0.9, 1])(
    "preserves exactly representable four-decimal confidence %s",
    async (confidence) => {
      const operation = { ...operations[0]!, confidence } as ContentLinkOperation;
      expect((await prepareContentOperation(fixture(operation).context, operation)).result.outcome).toBe("applied");
    },
  );

  it("preserves higher precision for chunk confidence, whose canonical column is unconstrained numeric", async () => {
    const operation = { ...operations[1]!, confidence: 0.12345 } as ContentLinkOperation;
    expect((await prepareContentOperation(fixture(operation).context, operation)).result.outcome).toBe("applied");
  });

  it("reconciles immutable summary content after legitimate lifecycle supersession", async () => {
    if (summary.kind !== "summary.materialize") throw new Error("SUMMARY_FIXTURE_REQUIRED");
    const prepared = await prepareContentOperation(fixture(summary).context, summary);
    const retainedRow = {
      document_version_id: summary.documentVersion.id,
      representation_id: summary.representation.id,
      derived_from_representation_id: summary.derivedFrom.id,
      transformation_run_id: summary.transformationRunId,
      summary_kind: summary.summaryKind,
      scope: summary.scope,
      scope_node_id: null,
      focus_entity_id: null,
      audience: summary.audience,
      text: summary.text,
      language: null,
      token_count: summary.tokenCount,
      content_sha256: summary.representation.digest.slice(7),
      supersedes_id: null,
      lifecycle: "superseded",
    };
    const retained = fixture(summary, (sql) =>
      sql.includes("from content.document_summary_source")
        ? [{ weight: "1.0000" }]
        : sql.includes("from content.document_summary")
          ? [retainedRow]
          : undefined,
    );
    await expect(
      reconcileContentOperationRefs(retained.context.client, {
        tenantId: ids.tenant!,
        result: prepared.result,
        operation: summary,
      }),
    ).resolves.toBeUndefined();
    retainedRow.text = "Altered historical prose";
    await expect(
      reconcileContentOperationRefs(retained.context.client, {
        tenantId: ids.tenant!,
        result: prepared.result,
        operation: summary,
      }),
    ).rejects.toThrow("CONTENT_RECEIPT_ROW_MISMATCH");
  });

  it("reconciles exact immutable row effects and rejects arbitrary or substituted receipt keys", async () => {
    const operation = operations[1]!,
      original = fixture(operation),
      prepared = await prepareContentOperation(original.context, operation);
    const retained = fixture(operation, (sql) =>
      sql.includes("from retrieval.chunk_entity_mention") ? [{ method: "verified", confidence: "0.9" }] : undefined,
    );
    await expect(
      reconcileContentOperationRefs(retained.context.client, {
        tenantId: ids.tenant!,
        result: prepared.result,
        operation,
      }),
    ).resolves.toBeUndefined();
    await expect(
      reconcileContentOperationRefs(retained.context.client, {
        tenantId: ids.tenant!,
        result: {
          ...prepared.result,
          canonicalRefs: [{ schema: "content", table: "arbitrary", key: { id: randomUUID() } }],
        },
        operation,
      }),
    ).rejects.toThrow("CONTENT_RECEIPT_ROW_MISMATCH");
    const changed = fixture(operation, (sql) =>
      sql.includes("from retrieval.chunk_entity_mention") ? [{ method: "verified", confidence: "0.1" }] : undefined,
    );
    await expect(
      reconcileContentOperationRefs(changed.context.client, {
        tenantId: ids.tenant!,
        result: prepared.result,
        operation,
      }),
    ).rejects.toThrow("CONTENT_RECEIPT_ROW_MISMATCH");
  });
});
