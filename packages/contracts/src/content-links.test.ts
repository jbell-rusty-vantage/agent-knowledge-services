import { describe, expect, it } from "vitest";
import { ContentLinkIntentSchema } from "./content-links.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const digest = (value = "a") => `sha256:${value.repeat(64)}`;
const reference = (value: number) => ({ id: id(value), digest: digest() });
const source = { ...reference(10), representationId: id(11) };
const chunk = {
  ...reference(12),
  documentVersionId: id(13),
  representation: reference(11),
  captureId: id(14),
  sourceNodes: [source],
};
const evidence = {
  claimId: id(15),
  claimKey: "capability",
  claimDigest: digest(),
  runId: id(16),
  manifest: reference(17),
  assessment: reference(18),
  locatorId: id(19),
  captureId: id(14),
  role: "supports",
};
const common = {
  operationId: "link",
  dependsOn: [],
  evidence: [evidence],
  rationale: "Exact retained source support.",
  applicability: { validFrom: null, validTo: null, qualifiers: ["in preview"] },
};
const claimLink = { ...common, kind: "chunk.claim.link", chunk, claimId: id(15), verb: "supports" };
const summary = {
  ...common,
  operationId: "summary",
  kind: "summary.materialize",
  summaryId: id(20),
  documentVersion: reference(13),
  representation: reference(21),
  derivedFrom: reference(11),
  transformationRunId: id(22),
  summaryKind: "technical",
  scope: "document",
  audience: "engineer",
  text: "A qualified capability.",
  tokenCount: 5,
  sources: [{ ...source, weight: 1 }],
};
const intent = () =>
  structuredClone({
    schemaVersion: "content-link-intent.v1",
    intentId: "closeout-links",
    context: { tenantId: id(1), missionId: id(2), attemptId: id(3), actor: { kind: "agent", id: "reconciler" } },
    contract: { migrationHead: "20260914010700", workspaceFingerprint: digest(), policyDigest: digest() },
    inputSnapshot: { artifact: reference(4), knowledgeSeq: 8 },
    expectedKnowledgeHead: 8,
    asOf: "2026-09-14T00:00:00Z",
    operations: [claimLink],
  });

describe("ContentLinkIntent typed canonical proposals", () => {
  it.each([
    claimLink,
    {
      ...common,
      kind: "document.entity.link",
      documentId: id(23),
      documentVersion: reference(13),
      entityId: id(24),
      role: "mention",
      method: "extraction",
      sourceNodes: [source],
    },
    { ...common, kind: "chunk.entity.link", chunk, entityId: id(24), verb: "mentions", method: "extraction" },
    { ...common, kind: "chunk.relationship.link", chunk, relationshipId: id(25), verb: "context" },
    summary,
    { ...common, kind: "summary.source.link", summaryId: id(20), source: { ...source, weight: 1 } },
    {
      ...common,
      kind: "projection.target.link",
      target: { kind: "claim", canonicalId: id(15) },
      sourceChunks: [chunk],
    },
  ])("accepts bounded $kind syntax without declaring admission", (operation) => {
    expect(ContentLinkIntentSchema.parse({ ...intent(), operations: [operation] }).onStale).toBe("fail");
  });

  it.each([
    { ...claimLink, table: "evidence.claim" },
    { ...claimLink, kind: "insert", table: "retrieval.chunk_claim_link" },
    { ...claimLink, admitted: true },
    { ...claimLink, evidence: [] },
    { ...claimLink, verb: "same_as" },
    { ...claimLink, claimId: id(999) },
    { ...claimLink, evidence: [{ ...evidence, role: "context" }] },
    { ...claimLink, evidence: [{ ...evidence, captureId: id(999) }] },
    { ...claimLink, chunk: { ...chunk, sourceNodes: [] } },
    { ...claimLink, chunk: { ...chunk, sourceNodes: [{ ...source, representationId: id(999) }] } },
    {
      ...claimLink,
      applicability: { validFrom: "2026-01-02T00:00:00Z", validTo: "2026-01-01T00:00:00Z", qualifiers: [] },
    },
  ])("rejects unsafe or unbound operation shape %#", (operation) => {
    expect(ContentLinkIntentSchema.safeParse({ ...intent(), operations: [operation] }).success).toBe(false);
  });

  it("binds the snapshot to the expected head and rejects unsupported rebasing", () => {
    expect(ContentLinkIntentSchema.safeParse({ ...intent(), expectedKnowledgeHead: 9 }).success).toBe(false);
    expect(ContentLinkIntentSchema.safeParse({ ...intent(), onStale: "rebase_if_disjoint" }).success).toBe(false);
  });

  it.each(
    [
      [claimLink, claimLink],
      [{ ...claimLink, dependsOn: ["absent"] }],
      [{ ...claimLink, dependsOn: ["link"] }],
      [
        { ...claimLink, dependsOn: ["second"] },
        { ...claimLink, operationId: "second", dependsOn: ["link"] },
      ],
      [
        { ...claimLink, operationId: "first" },
        { ...claimLink, dependsOn: ["first", "first"] },
      ],
    ].map((operations) => ({ operations })),
  )("rejects ambiguous or cyclic proposal dependencies %#", ({ operations }) => {
    expect(ContentLinkIntentSchema.safeParse({ ...intent(), operations }).success).toBe(false);
  });

  it.each([
    { ...summary, scope: "section" },
    { ...summary, scope: "entity_view" },
    { ...summary, representation: reference(11) },
    { ...summary, sources: [{ ...source, representationId: id(999), weight: 1 }] },
    {
      ...summary,
      sources: [
        { ...source, weight: 1 },
        { ...source, weight: 0.5 },
      ],
    },
    { ...summary, scope: "section", scopeNodeId: id(999) },
    { ...summary, supersedesId: id(20) },
    { ...summary, sources: [{ ...source, weight: 1.1 }] },
  ])("rejects malformed deferred summary lineage %#", (operation) => {
    expect(ContentLinkIntentSchema.safeParse({ ...intent(), operations: [operation] }).success).toBe(false);
  });

  it("rejects conflicting immutable references across operations", () => {
    for (const changed of [
      { ...claimLink, chunk: { ...chunk, digest: digest("b") } },
      { ...claimLink, evidence: [{ ...evidence, claimDigest: digest("b") }] },
      { ...claimLink, evidence: [{ ...evidence, manifest: { ...reference(17), digest: digest("b") } }] },
      { ...claimLink, evidence: [{ ...evidence, assessment: { ...reference(18), digest: digest("b") } }] },
      { ...claimLink, evidence: [{ ...evidence, captureId: id(999) }] },
    ]) {
      expect(
        ContentLinkIntentSchema.safeParse({
          ...intent(),
          operations: [claimLink, { ...changed, operationId: "second" }],
        }).success,
      ).toBe(false);
    }
  });

  it("requires a chunk projection to identify one of its source chunks", () => {
    const operation = {
      ...common,
      kind: "projection.target.link",
      target: { kind: "chunk", canonicalId: id(999) },
      sourceChunks: [chunk],
    };
    expect(ContentLinkIntentSchema.safeParse({ ...intent(), operations: [operation] }).success).toBe(false);
  });

  it("allows independent assessments of the same immutable canonical claim", () => {
    const second = {
      ...evidence,
      runId: id(30),
      claimKey: "independent-capability",
      manifest: reference(31),
      assessment: reference(32),
    };
    expect(
      ContentLinkIntentSchema.safeParse({ ...intent(), operations: [{ ...claimLink, evidence: [evidence, second] }] })
        .success,
    ).toBe(true);
    expect(
      ContentLinkIntentSchema.safeParse({
        ...intent(),
        operations: [{ ...claimLink, evidence: [evidence, { ...second, claimDigest: digest("b") }] }],
      }).success,
    ).toBe(false);
  });

  it.each([
    { target: { kind: "claim", canonicalId: id(999) }, sourceChunks: [chunk] },
    { target: { kind: "claim", canonicalId: id(15) }, sourceChunks: [{ ...chunk, captureId: id(999) }] },
    {
      target: { kind: "entity", canonicalId: id(24) },
      sourceChunks: [chunk, { ...chunk, id: id(33), captureId: id(999) }],
    },
  ])("rejects projection evidence inconsistent with its selected targets or captures %#", (projection) => {
    expect(
      ContentLinkIntentSchema.safeParse({
        ...intent(),
        operations: [{ ...common, kind: "projection.target.link", ...projection }],
      }).success,
    ).toBe(false);
  });

  it("retains temporal qualification and explicit dependency order", () => {
    const result = ContentLinkIntentSchema.parse({
      ...intent(),
      operations: [
        summary,
        {
          ...common,
          operationId: "target",
          dependsOn: ["summary"],
          kind: "projection.target.link",
          target: { kind: "summary", canonicalId: id(20) },
          sourceChunks: [chunk],
        },
      ],
    });
    expect(result.operations[1]?.dependsOn).toEqual(["summary"]);
    expect(result.operations[1]?.applicability.qualifiers).toEqual(["in preview"]);
  });
});
