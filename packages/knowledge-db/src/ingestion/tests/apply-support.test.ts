import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeSqlClient } from "../../ports.js";
import { applyPlan, type ApplyContext } from "../apply.js";
import { admissionIssues, proposalEffect, type AuthoritativeClaim } from "../evidence-admission.js";
import { IngestionIntentSchema } from "../intent.js";
import { buildPlan, type PlanFacts } from "../plan.js";
import { fixtureFacts } from "./test-fixtures.js";

function supportFixture() {
  const tenantId = randomUUID(),
    locatorId = randomUUID(),
    segmentId = randomUUID(),
    claimId = randomUUID();
  const intent = IngestionIntentSchema.parse({
    schemaVersion: "knowledge-ingestion-intent.v1",
    intentId: "challenge-admission",
    context: { tenantId, attemptId: randomUUID() },
    evidence: { verificationRuns: [] },
    subjects: [],
    proposals: [
      {
        kind: "support.admit",
        proposalId: "challenge",
        targetRef: segmentId,
        locatorId,
        supportRole: "challenges",
        proposition: "Independent evidence disputes this availability assertion.",
        qualifiers: [],
        evidence: [{ runId: "sealed", claimId: "challenge" }],
      },
    ],
  });
  const proposal = intent.proposals[0]!;
  const authoritative: AuthoritativeClaim = {
    statement: proposal.proposition!,
    claimType: "capability",
    qualifiers: [],
    entityBindings: [],
    value: proposalEffect(intent, proposal),
    verdict: "directly_supported",
    manifestDigest: "sha256:unit",
    policyVersion: "unit",
    downstreamUse: ["knowledge_ingestion:support.admit"],
  };
  const facts: PlanFacts = {
    ...fixtureFacts(),
    claims: [
      { runId: "sealed", claimId: "challenge", claimRowId: claimId, sealed: true, eligible: true, authoritative },
    ],
  };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("claim_evidence_link")
      ? [{ locator_id: locatorId }]
      : sql.includes("temporal.admit_support")
        ? [{ id: "support-id" }]
        : [{ id: segmentId }],
    rowCount: 1,
  }));
  const client = { query } as unknown as KnowledgeSqlClient;
  const plan = buildPlan(intent, facts, { version: "unit", migrationHead: "unit" });
  const context: ApplyContext = {
    client,
    tenantId,
    receiptId: randomUUID(),
    intent,
    plan,
    vocabulary: facts.vocabulary,
    artifacts: {} as ApplyContext["artifacts"],
  };
  return { context, query, locatorId, segmentId, claimId, intent, proposal, facts, authoritative };
}

describe("authoritative challenge source custody", () => {
  it("requires a locator supporting the admitted challenge while preserving its target relation", async () => {
    const f = supportFixture();
    expect(f.context.plan.errors).toEqual([]);
    const result = await applyPlan(f.context);
    expect(result.proposals[0]!.created).toEqual({ supportId: "support-id" });
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("claim_evidence_link"), [
      f.context.tenantId,
      f.claimId,
      "supports",
    ]);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("temporal.admit_support"), [
      f.segmentId,
      null,
      f.claimId,
      f.locatorId,
      "challenges",
    ]);
  });
  it("rejects a locator outside the claim's authenticated supporting evidence", async () => {
    const f = supportFixture();
    f.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("claim_evidence_link") ? [] : [{ id: f.segmentId }],
      rowCount: 0,
    }));
    await expect(applyPlan(f.context)).rejects.toMatchObject({ code: "SUPPORT_LOCATOR_NOT_AUTHORIZED" });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("temporal.admit_support"))).toBe(false);
  });
  it("rejects an unauthorized intended use and an altered target effect before apply", () => {
    const f = supportFixture();
    const reference = { intent: f.intent, proposal: f.proposal, facts: f.facts };
    Object.assign(f.authoritative, { downstreamUse: ["source_attributed_report"] });
    expect(admissionIssues(reference).map((issue) => issue.code)).toEqual(["EVIDENCE_INTENDED_USE_MISMATCH"]);
    Object.assign(f.authoritative, { downstreamUse: ["knowledge_ingestion:support.admit"] });
    Object.assign(f.proposal, { targetRef: randomUUID() });
    expect(admissionIssues(reference).map((issue) => issue.code)).toEqual(["PROPOSAL_REVERIFICATION_REQUIRED"]);
  });
});
