import { describe, expect, it } from "vitest";
import { IngestionIntentSchema, type ProposalOf } from "../intent.js";
import { admissionIssues, proposalEffect, type AuthoritativeClaim } from "../evidence-admission.js";
import { buildPlan } from "../plan.js";
import { recordIdentity } from "../records.js";
import { fixtureFacts } from "./test-fixtures.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const entityId = "00000000-0000-4000-8000-000000000002";
const claimId = "00000000-0000-4000-8000-000000000003";
function fixture() {
  const intent = IngestionIntentSchema.parse({
    schemaVersion: "knowledge-ingestion-intent.v1",
    intentId: "record-unit",
    context: { tenantId },
    subjects: [{ mode: "resolved", ref: "model", entityId, kind: "ai_model_version" }],
    proposals: [
      {
        kind: "record.materialize",
        proposalId: "restriction",
        recordKind: "compatibility_constraint",
        subjectRef: "model",
        title: "Preview restriction",
        constraintKind: "capability_restriction",
        expression: "preview_only",
        proposition: "The capability is in preview.",
        qualifiers: ["in preview"],
        evidence: [{ runId: "run", claimId: "restriction" }],
      },
    ],
  });
  const proposal = intent.proposals[0] as ProposalOf<"record.materialize">;
  const authoritative: AuthoritativeClaim = {
    statement: proposal.proposition!,
    claimType: "capability",
    qualifiers: [...proposal.qualifiers!],
    value: proposalEffect(intent, proposal),
    entityBindings: [{ role: "subject", canonicalId: entityId }],
    verdict: "directly_supported",
    manifestDigest: "sha256:fixture",
    policyVersion: "fixture",
    downstreamUse: ["knowledge_ingestion:record.materialize"],
  };
  const facts = {
    ...fixtureFacts(),
    subjects: { model: { ref: "model", kind: "ai_model_version", lifecycle: "active" as const } },
    claims: [
      { runId: "run", claimId: "restriction", sealed: true, eligible: true, claimRowId: claimId, authoritative },
    ],
  };
  return { intent, proposal, facts };
}

describe("bounded compatibility record admission", () => {
  it("plans all four canonical rows and reconciles a duplicate", () => {
    const f = fixture();
    const plan = buildPlan(f.intent, f.facts, { version: "unit", migrationHead: "unit" });
    expect(plan.errors).toEqual([]);
    expect(plan.proposals[0]!.actions.map((action) => action.table)).toEqual([
      "knowledge.record",
      "knowledge.compatibility_constraint",
      "evidence.claim_record",
      "knowledge.record_entity_link",
    ]);
    const duplicate = buildPlan(
      f.intent,
      { ...f.facts, existing: { ...f.facts.existing, records: { restriction: { recordId: claimId } } } },
      { version: "unit", migrationHead: "unit" },
    );
    expect(duplicate.proposals[0]).toMatchObject({
      outcome: "no_op_duplicate",
      existing: { recordId: claimId },
      actions: [],
    });
  });
  it.each(["title", "expression", "qualifiers", "proposition"])("rejects an unverified %s mutation", (field) => {
    const f = fixture();
    Object.assign(f.proposal, { [field]: field === "qualifiers" ? [] : "different" });
    expect(admissionIssues(f).map((issue) => issue.code)).toEqual(["PROPOSAL_REVERIFICATION_REQUIRED"]);
  });
  it.each(["supported_with_qualification", "derived_verified", "unsupported"])(
    "does not promote %s to a canonical verified record",
    (verdict) => {
      const f = fixture();
      Object.assign(f.facts.claims[0]!.authoritative, { verdict });
      expect(admissionIssues(f).map((issue) => issue.code)).toEqual(["RECORD_VERIFIED_SUBJECT_REQUIRED"]);
    },
  );
  it("requires the authenticated subject, intended use, and complete canonical claim", () => {
    const f = fixture();
    Object.assign(f.facts.claims[0]!.authoritative, { entityBindings: [] });
    expect(admissionIssues(f)[0]?.code).toBe("RECORD_VERIFIED_SUBJECT_REQUIRED");
    const missing = fixture();
    const facts = { ...missing.facts, claims: [{ ...missing.facts.claims[0]!, claimRowId: null }] };
    expect(buildPlan(missing.intent, facts, { version: "unit", migrationHead: "unit" }).proposals[0]).toMatchObject({
      outcome: "held",
      reason: "claim_row_required",
    });
  });
  it("rejects arbitrary record types, scopes, assurance and corroboration", () => {
    const f = fixture();
    for (const change of [
      { recordKind: "security_consideration" },
      { scope: {} },
      { assurance: "production_confirmation" },
      { evidence: [...f.proposal.evidence, ...f.proposal.evidence] },
      { belief: "disputed" },
    ]) {
      expect(IngestionIntentSchema.safeParse({ ...f.intent, proposals: [{ ...f.proposal, ...change }] }).success).toBe(
        false,
      );
    }
  });
  it("rejects boolean and fixture-only admission without authoritative bytes", () => {
    const f = fixture();
    const facts = {
      ...f.facts,
      claims: [
        { runId: "run", claimId: "restriction", sealed: true, eligible: true, fixtureOnly: true, claimRowId: claimId },
      ],
    };
    expect(admissionIssues({ ...f, facts }).map((issue) => issue.code)).toEqual(["AUTHORITATIVE_CLAIM_REQUIRED"]);
    Object.assign(f.facts.claims[0]!.authoritative, { downstreamUse: ["source_attributed_report"] });
    expect(admissionIssues(f).map((issue) => issue.code)).toEqual(["EVIDENCE_INTENDED_USE_MISMATCH"]);
  });
  it("keys canonical content and provenance independently of proposal identifiers", () => {
    const f = fixture(),
      binding = { tenantId, claimId, entityId, proposal: f.proposal };
    const id = recordIdentity(binding);
    f.proposal.proposalId = "renamed";
    expect(recordIdentity(binding)).toBe(id);
    f.proposal.qualifiers = [];
    expect(recordIdentity(binding)).not.toBe(id);
    expect(recordIdentity({ ...binding, tenantId: entityId })).not.toBe(id);
  });
});
