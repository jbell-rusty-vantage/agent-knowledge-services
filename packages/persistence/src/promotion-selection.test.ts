import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContentLinkIntentSchema, PromotionSelectionSchema } from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-core";
import type { TenantSqlClient } from "./postgres.js";
import { validatePromotionSelection, type PromotionSelectionPorts } from "./promotion-selection.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = sha256Digest("pin"),
  text = "Cafe\u0301 supports beta only.";
function fixture(
  change?: (sql: string, rows: Record<string, unknown>[], values?: readonly unknown[]) => Record<string, unknown>[],
) {
  const source = {
    chunkId: id(4),
    chunkDigest: sha256Digest(text),
    representationId: id(5),
    representationDigest: digest,
    representationClass: "faithful_normalization",
    captureId: id(6),
    sourceFamilyId: "primary",
  };
  const selection = PromotionSelectionSchema.parse({
    schemaVersion: "promotion-selection.v1",
    tenantId: id(1),
    expectedKnowledgeHead: 4,
    runPinDigest: digest,
    policyDigest: digest,
    selected: [
      {
        memberId: "one",
        content: { kind: "chunk", id: id(4), digest: sha256Digest(text) },
        target: { kind: "claim", canonicalId: id(7), projectionTargetId: id(8) },
        targetSpaces: ["engineering_claims"],
        sourceChunks: [source],
        admittedClaims: [{ runId: id(9), claimId: "claim", claimDigest: digest, admissionDigest: digest }],
        contentLinkReceiptIds: [id(10)],
        reason: "Selected useful evidence",
        estimatedBytes: 1,
        estimatedTokens: 1,
        estimatedCostMicros: 1,
      },
    ],
    excluded: [
      { content: { kind: "chunk", id: id(99), digest }, targetSpaces: ["engineering_claims"], reason: "Unrelated" },
    ],
    budget: { maxMembers: 2, maxBytes: 1000, maxTokens: 100, maxCostMicros: 10, deadline: "2099-01-01T00:00:00Z" },
    proposedBy: "producer",
    requiredReviewer: "reviewer",
  });
  const reference = {
    id: id(4),
    digest: sha256Digest(text),
    documentVersionId: id(11),
    representation: { id: id(5), digest },
    captureId: id(6),
    sourceNodes: [{ id: id(12), digest, representationId: id(5) }],
  };
  const intent = ContentLinkIntentSchema.parse({
    schemaVersion: "content-link-intent.v1",
    intentId: "links",
    context: { tenantId: id(1), missionId: id(2), attemptId: id(3), actor: { kind: "agent", id: "producer" } },
    contract: { migrationHead: "20260914011000", workspaceFingerprint: digest, policyDigest: digest },
    inputSnapshot: { artifact: { id: id(13), digest }, knowledgeSeq: 3 },
    expectedKnowledgeHead: 3,
    asOf: "2026-01-01T00:00:00Z",
    operations: [
      {
        operationId: "link",
        kind: "projection.target.link",
        dependsOn: [],
        target: { kind: "claim", canonicalId: id(7) },
        sourceChunks: [reference],
        rationale: "Exact evidence",
        applicability: { validFrom: null, validTo: null, qualifiers: ["beta only"] },
        evidence: [
          {
            claimId: id(7),
            claimKey: "claim",
            claimDigest: digest,
            runId: id(9),
            manifest: { id: id(14), digest },
            assessment: { id: id(15), digest },
            locatorId: id(16),
            captureId: id(6),
            role: "supports",
          },
        ],
      },
    ],
  });
  const queried: string[] = [];
  const client: TenantSqlClient = {
    async query(sql, values) {
      queried.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("api.knowledge_head")) rows = [{ knowledge_seq: 4, within_deadline: true }];
      else if (sql.includes("from retrieval.projection_target"))
        rows = [{ target_kind: "claim", claim_id: id(7), retired_at: null }];
      else if (sql.includes("select representation_class"))
        rows = [{ representation_class: "faithful_normalization", content_sha256: digest.slice(7) }];
      else if (sql.includes("with latest"))
        rows = [
          {
            id: id(20),
            tenant_id: id(1),
            representation_id: id(5),
            decision: "accept",
            legacy_provenance: false,
            review_legacy: false,
            guarded_sha256: digest.slice(7),
            review_digest: digest.slice(7),
            subject_digest: digest.slice(7),
            representation_digest: digest.slice(7),
            review_id: id(21),
            knowledge_review_decision_id: id(21),
            review_decision: "approve",
            review_operation_id: id(22),
            decision_operation_id: id(22),
            operation_id: id(22),
            operation_kind: "representation_decision",
            operation_status: "succeeded",
            reviewer_identity: "reviewer",
            review_identity: "reviewer",
            operation_actor: "reviewer",
            producer_actor: "producer",
            reviewer_attempt_id: null,
            producing_operation_id: id(23),
            subject_operation_id: id(23),
            subject_kind: "representation",
            subject_ref: { representationId: id(5), artifactDigest: digest },
            quorum_required: 1,
            eligible_roles: ["human"],
            reviewer_role: "human",
            decision_current: true,
            subject_current: true,
          },
        ];
      return { rows: (change?.(sql, rows, values) ?? rows) as never[], rowCount: rows.length };
    },
  };
  const encode = () => new TextEncoder().encode(JSON.stringify(selection));
  const artifact = () => ({ id: id(24), digest: `sha256:${createHash("sha256").update(encode()).digest("hex")}` });
  const ports: PromotionSelectionPorts = {
    async readArtifact(received) {
      expect(received).toBe(client);
      return encode();
    },
    async reconcileContentLinkReceipt(received) {
      expect(received).toBe(client);
      return {
        tenantId: id(1),
        receiptId: id(10),
        intent,
        operations: [
          {
            operationId: "link",
            outcome: "applied",
            canonicalRefs: [{ schema: "retrieval", table: "projection_target", key: { tenant_id: id(1), id: id(8) } }],
          },
        ],
      };
    },
    async authenticateClaim(received, input) {
      expect(received).toBe(client);
      expect(input.references).toEqual(intent.operations[0]!.evidence);
      return {
        canonicalClaimId: id(7),
        runId: id(9),
        claimDigest: digest,
        admissionDigest: digest,
        statement: text,
        qualifiers: ["beta only"],
      };
    },
    async authenticateSource(received) {
      expect(received).toBe(client);
      return { text, sourceFamilyId: "primary" };
    },
    async measure() {
      return { tokens: 8, costMicros: 2 };
    },
  };
  const run = () =>
    validatePromotionSelection(client, {
      selection,
      artifact: artifact(),
      authority: {
        tenantId: id(1),
        runPinDigest: digest,
        policyDigest: digest,
        proposedBy: "producer",
        requiredReviewer: "reviewer",
        budget: selection.budget,
      },
      ports,
    });
  return { client, selection, ports, run, queried, intent };
}

function summaryFixture(rejected = false) {
  const summaryText = `${text}\nbeta only`,
    summaryDigest = sha256Digest(summaryText);
  const f = fixture((sql, rows, values) => {
    if (sql.includes("from retrieval.projection_target"))
      return [{ target_kind: "summary", summary_id: id(31), retired_at: null }];
    if (sql.includes("from content.document_summary"))
      return [{ id: id(31), lifecycle: "active", text: summaryText, representation_id: id(30) }];
    if (sql.includes("select artifact_id,content_sha256"))
      return [{ artifact_id: id(32), content_sha256: summaryDigest.slice(7) }];
    if (sql.includes("with latest") && values?.[1] === id(30))
      return [
        {
          ...rows[0],
          id: id(40),
          representation_id: id(30),
          decision: rejected ? "reject" : "accept",
          guarded_sha256: summaryDigest.slice(7),
          review_digest: summaryDigest.slice(7),
          subject_digest: summaryDigest.slice(7),
          representation_digest: summaryDigest.slice(7),
          representation_kind: "summary",
          transformation_kind: "summarize",
          producing_operation_id: null,
          producer_attempt_id: id(50),
          transformation_attempt_id: id(50),
          producer_deployment_id: "summary-producer",
          subject_ref: { representationId: id(30), artifactDigest: summaryDigest },
        },
      ];
    return rows;
  });
  f.selection.selected[0]!.content = { kind: "summary", id: id(31), digest: summaryDigest };
  f.selection.selected[0]!.target = { kind: "summary", canonicalId: id(31), projectionTargetId: id(8) };
  f.selection.selected[0]!.targetSpaces = ["engineering_claims"];
  const link = f.intent.operations[0]!;
  if (link.kind !== "projection.target.link") throw new Error("expected projection fixture");
  link.target = { kind: "summary", canonicalId: id(31) };
  const read = f.ports.readArtifact;
  f.ports.readArtifact = (client, input) =>
    input.artifact.id === id(32) ? Promise.resolve(new TextEncoder().encode(summaryText)) : read(client, input);
  return { ...f, summaryDigest };
}

describe("canonical PromotionSelection validation", () => {
  it("retains both the original source and independently reviewed summary representation", async () => {
    const f = summaryFixture(),
      result = await f.run();
    expect(result.members[0]!.representations).toEqual([
      { id: id(5), digest, decisionId: id(20) },
      { id: id(30), digest: f.summaryDigest, decisionId: id(40) },
    ]);
  });
  it("refuses a summary whose latest independent review rejects its output", async () => {
    await expect(summaryFixture(true).run()).rejects.toThrow("PROMOTION_SELECTION_SUMMARY_NOT_ADMITTED");
  });
  it("preserves exact Unicode and selected subset without expanding excluded chunks", async () => {
    const f = fixture(),
      result = await f.run();
    expect(result.members.map((member) => member.memberId)).toEqual(["one"]);
    expect(result.members[0]?.sourceText).toBe(text);
    expect(result.selection.excluded).toEqual(f.selection.excluded);
    expect(result.actual).toEqual({ bytes: Buffer.byteLength(text), tokens: 8, costMicros: 2 });
    expect(f.queried.some((sql) => /^insert|^update/i.test(sql))).toBe(false);
  });
  it.each([
    ["api.knowledge_head", { knowledge_seq: 5, within_deadline: true }, "PROMOTION_SELECTION_STALE_HEAD"],
    ["api.knowledge_head", { knowledge_seq: 4, within_deadline: false }, "PROMOTION_SELECTION_DEADLINE_EXCEEDED"],
    [
      "from retrieval.projection_target",
      { target_kind: "claim", claim_id: id(99), retired_at: null },
      "PROMOTION_SELECTION_TARGET_MISMATCH",
    ],
    ["with latest", { decision: "reject" }, "PROMOTION_SELECTION_REPRESENTATION_NOT_ADMITTED"],
  ] as const)("rejects changed canonical %s", async (fragment, row, error) => {
    const f = fixture((sql, rows) => (sql.includes(fragment) ? [{ ...rows[0], ...row }] : rows));
    await expect(f.run()).rejects.toThrow(error);
  });
  it("rejects a foreign tenant before reading artifact bytes", async () => {
    const f = fixture();
    f.selection.tenantId = id(99);
    f.ports.readArtifact = async () => {
      throw new Error("must not read");
    };
    await expect(f.run()).rejects.toThrow("PROMOTION_SELECTION_AUTHORITY_MISMATCH");
  });
  it("rejects changed raw artifact and source bytes", async () => {
    const a = fixture();
    a.ports.readArtifact = async () => new TextEncoder().encode("{}");
    await expect(a.run()).rejects.toThrow("PROMOTION_SELECTION_ARTIFACT_DIGEST_MISMATCH");
    const b = fixture();
    b.ports.authenticateSource = async () => ({ text: text.normalize("NFC"), sourceFamilyId: "primary" });
    await expect(b.run()).rejects.toThrow("PROMOTION_SELECTION_SOURCE_BYTES_MISMATCH");
  });
  it("uses measured bounds and retains unknown usage", async () => {
    const a = fixture();
    a.ports.measure = async () => ({ tokens: 101, costMicros: 0 });
    await expect(a.run()).rejects.toThrow("PROMOTION_SELECTION_BUDGET_EXCEEDED");
    const b = fixture();
    b.ports.measure = async () => ({ tokens: NaN, costMicros: 0 });
    await expect(b.run()).rejects.toThrow("PROMOTION_SELECTION_USAGE_UNKNOWN");
  });
  it("rejects unbound claims and missing authoritative receipt target", async () => {
    const a = fixture();
    a.ports.authenticateClaim = async () => ({
      canonicalClaimId: id(99),
      runId: id(9),
      claimDigest: digest,
      admissionDigest: digest,
      statement: text,
      qualifiers: [],
    });
    await expect(a.run()).rejects.toThrow("PROMOTION_SELECTION_CLAIM_MISMATCH");
    const b = fixture(),
      read = b.ports.reconcileContentLinkReceipt;
    b.ports.reconcileContentLinkReceipt = async (...args) => ({ ...(await read(...args)), operations: [] });
    await expect(b.run()).rejects.toThrow("PROMOTION_SELECTION_RECEIPT_TARGET_MISSING");
  });
});
