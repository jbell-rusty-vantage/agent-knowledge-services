import { describe, expect, it } from "vitest";
import {
  admissionIssues,
  isOfficiallyAdmittedVerdict,
  proposalEffect,
  type AuthoritativeClaim,
} from "../evidence-admission.js";
import { IngestionIntentSchema, type Proposal } from "../intent.js";
import { buildPlan, deterministicId, type PlanFacts } from "../plan.js";
import { fixtureFacts } from "./test-fixtures.js";

const tenantId = "00000000-0000-4000-8000-000000000011";
const entityId = "00000000-0000-4000-8000-000000000022";
const claim: AuthoritativeClaim = {
  statement: "Synthetic system is in preview.",
  claimType: "capability",
  qualifiers: ["in preview"],
  entityBindings: [{ role: "subject", canonicalId: entityId }],
  verdict: "supported_with_qualification",
  manifestDigest: "sha256:test",
  policyVersion: "fixture.v1",
  downstreamUse: [
    "knowledge_ingestion:claim.materialize",
    "knowledge_ingestion:fact.assert_state",
    "source_attributed_report",
  ],
};
const materialize = { proposalId: "claims", kind: "claim.materialize", runId: "run-a", claimIds: ["c1"] };
function fixture(proposal: unknown = materialize) {
  const intent = IngestionIntentSchema.parse({
    schemaVersion: "knowledge-ingestion-intent.v1",
    intentId: "admission-unit",
    context: { tenantId, attemptId: tenantId },
    evidence: { verificationRuns: [], claims: [] },
    subjects: [{ mode: "resolved", ref: "system", kind: "ai_model_version", entityId }],
    proposals: [proposal],
  });
  const facts: PlanFacts = {
    ...fixtureFacts(),
    claims: [
      {
        runId: "run-a",
        claimId: "c1",
        sealed: true,
        eligible: true,
        authoritative: structuredClone(claim),
        claimRowId: null,
      },
    ],
  };
  return { intent, proposal: intent.proposals[0]!, facts };
}
const codes = (input: ReturnType<typeof fixture>) => admissionIssues(input).map((issue) => issue.code);

describe("official claim status admission", () => {
  it.each(["directly_supported", "supported_with_qualification", "derived_verified", "literal_extraction_verified"])(
    "promotes %s",
    (verdict) => {
      expect(isOfficiallyAdmittedVerdict(verdict)).toBe(true);
    },
  );
  it.each(["unsupported", "contradicted", "context_only", "held", "rejected", "retracted"])(
    "leaves %s unofficial",
    (verdict) => {
      expect(isOfficiallyAdmittedVerdict(verdict)).toBe(false);
    },
  );
  it.each(["supported_with_qualification", "derived_verified", "literal_extraction_verified"])(
    "admits %s claim.materialize and keeps the distinct verdict",
    (verdict) => {
      const f = fixture();
      Object.assign(f.facts.claims[0]!.authoritative!, { verdict });
      expect(codes(f)).toEqual([]);
      expect(f.facts.claims[0]!.authoritative!.verdict).toBe(verdict);
      expect(f.facts.claims[0]!.authoritative!.qualifiers).toEqual(["in preview"]);
    },
  );
});

describe("authoritative admission matrix", () => {
  it("allows hydrated claim materialization without caller inline text", () => {
    expect(codes(fixture())).toEqual([]);
  });
  it("rejects empty evidence on an accepted effect (F01)", () => {
    expect(
      codes(
        fixture({
          proposalId: "event",
          kind: "event.assert",
          eventKind: "founded",
          subjectRef: "system",
          occurredDuring: { from: "2026-01-01T00:00:00Z", to: null },
        }),
      ),
    ).toEqual(["EVIDENCE_REQUIRED"]);
  });
  it("permits evidence-free staging without canonical admission", () => {
    expect(
      codes(
        fixture({
          proposalId: "stage",
          kind: "candidate.stage",
          entityKind: "organization",
          displayName: "Synthetic",
          reason: "needs_human",
        }),
      ),
    ).toEqual([]);
  });
  it("rejects boolean-only evidence without authenticated bytes", () => {
    const f = fixture();
    delete (f.facts.claims[0] as { authoritative?: AuthoritativeClaim }).authoritative;
    expect(codes(f)).toEqual(["AUTHORITATIVE_CLAIM_REQUIRED"]);
  });
  it("requires policy intended use (F04)", () => {
    const f = fixture();
    Object.assign(f.facts.claims[0]!.authoritative!, { downstreamUse: ["source_attributed_report"] });
    expect(codes(f)).toEqual(["EVIDENCE_INTENDED_USE_MISMATCH"]);
  });
  it.each(["statement", "verdict", "qualifiers"])("rejects altered inline %s (F05/F08)", (field) => {
    const f = fixture();
    f.intent.evidence.claims.push({
      runId: "run-a",
      claimId: "c1",
      statement: claim.statement,
      claimType: "capability",
      qualifiers: [...claim.qualifiers],
      verdict: claim.verdict,
      subjects: [],
    });
    Object.assign(f.intent.evidence.claims[0]!, { [field]: field === "qualifiers" ? [] : "altered" });
    expect(codes(f)).toEqual(["INLINE_CLAIM_MISMATCH"]);
  });
  it("holds claim/new-entity links before materialization (F12)", () => {
    const f = fixture();
    f.intent.subjects = [
      {
        mode: "new",
        ref: "system",
        kind: "ai_model_version",
        displayName: "new",
        aliases: [],
        identifiers: [],
        typedPayload: {},
        onMatch: "review",
        evidence: [],
      },
    ];
    expect(codes(f)).toEqual(["CLAIM_SUBJECT_REVERIFICATION_REQUIRED"]);
  });
  it("admits a new subject only when its exact planned canonical identity was verified (F12)", () => {
    const f = fixture();
    f.intent.subjects = [
      {
        mode: "new",
        ref: "system",
        kind: "organization",
        displayName: "new",
        aliases: [],
        identifiers: [],
        typedPayload: {},
        onMatch: "review",
        evidence: [],
      },
    ];
    const canonicalId = deterministicId("corpus.entity", [tenantId, f.intent.intentId, "system"].join("\0"));
    Object.assign(f.facts.claims[0]!.authoritative!, { entityBindings: [{ role: "subject", canonicalId }] });
    expect(codes(f)).toEqual([]);
    f.intent.intentId = "different-intent";
    expect(codes(f)).toEqual(["CLAIM_SUBJECT_REVERIFICATION_REQUIRED"]);
  });
  it("holds materialized claim subjects when their creator is held, without creating an ordering cycle", () => {
    const f = fixture();
    f.intent.subjects = [
      {
        mode: "new",
        ref: "system",
        kind: "organization",
        displayName: "new",
        aliases: [],
        identifiers: [],
        typedPayload: {},
        onMatch: "review",
        evidence: [],
      },
    ];
    const canonicalId = deterministicId("corpus.entity", [tenantId, f.intent.intentId, "system"].join("\0"));
    Object.assign(f.facts.claims[0]!.authoritative!, { entityBindings: [{ role: "subject", canonicalId }] });
    f.intent.proposals.push(
      ...IngestionIntentSchema.parse({
        ...f.intent,
        proposals: [
          {
            proposalId: "create-system",
            kind: "entity.create",
            subjectRef: "system",
            dependsOn: ["stage"],
            evidence: [{ runId: "fixture", claimId: "identity" }],
          },
          {
            proposalId: "stage",
            kind: "candidate.stage",
            entityKind: "organization",
            displayName: "Review",
            reason: "needs_human",
          },
        ],
      }).proposals,
    );
    (f.facts.claims as Array<PlanFacts["claims"][number]>).push({
      runId: "fixture",
      claimId: "identity",
      sealed: true,
      eligible: true,
      fixtureOnly: true,
      claimRowId: null,
    });
    const plan = buildPlan(f.intent, f.facts, { version: "unit", migrationHead: "test" });
    expect(plan.errors).toEqual([]);
    expect(plan.proposals.find((item) => item.proposalId === "claims")).toMatchObject({
      outcome: "held",
      reason: "dependency_held:create-system",
    });
  });
  it("rejects prose-only authorization of a normalized effect", () => {
    const f = fixture({
      proposalId: "fact",
      kind: "fact.assert_state",
      subjectRef: "system",
      streamKind: "model_offering_availability",
      status: "ga",
      worldInterval: { from: "2026-01-01T00:00:00Z", to: null },
      temporalBasis: "explicit",
      proposition: claim.statement,
      qualifiers: [...claim.qualifiers],
      evidence: [{ runId: "run-a", claimId: "c1" }],
    });
    expect(codes(f)).toEqual(["PROPOSAL_REVERIFICATION_REQUIRED"]);
    Object.assign(f.facts.claims[0]!.authoritative!, { value: proposalEffect(f.intent, f.proposal) });
    expect(codes(f)).toEqual([]);
    (f.proposal as Extract<Proposal, { kind: "fact.assert_state" }>).status = "preview";
    expect(codes(f)).toEqual(["PROPOSAL_REVERIFICATION_REQUIRED"]);
  });
  it("requires exact run-qualified report references (F10)", () => {
    const f = fixture({
      proposalId: "report",
      kind: "report.publish",
      title: "Report",
      asOf: "2026",
      markdown: claim.statement,
      claimRefs: [{ runId: "run-b", claimId: "c1" }],
    });
    expect(codes(f)).toEqual(["EVIDENCE_NOT_ELIGIBLE"]);
  });
  it("requires complete verified report binding (F11)", () => {
    const f = fixture({
      proposalId: "report",
      kind: "report.publish",
      title: "Report",
      asOf: "2026",
      markdown: claim.statement,
      claimRefs: [{ runId: "run-a", claimId: "c1" }],
    });
    expect(codes(f)).toEqual(["REPORT_BINDING_REQUIRED"]);
  });
  it("rejects legacy report publication even when its fixture evidence is eligible", () => {
    const f = fixture({
      proposalId: "report",
      kind: "report.publish",
      title: "Report",
      asOf: "2026",
      markdown: claim.statement,
      claimRefs: [{ runId: "run-a", claimId: "c1" }],
    });
    const facts = {
      ...f.facts,
      reports: { report: { eligible: true } },
      subjects: { system: { ref: "system", kind: "ai_model_version", lifecycle: "active" as const } },
    };
    const plan = buildPlan(f.intent, facts, { version: "unit", migrationHead: "test" });
    expect(plan.proposals[0]).toMatchObject({
      outcome: "rejected",
      reason: "LEGACY_REPORT_PUBLISH_UNSUPPORTED",
      actions: [],
    });
  });
  it("holds a dependency chain transitively while admitting an independent closure", () => {
    const f = fixture({
      proposalId: "stage",
      kind: "candidate.stage",
      entityKind: "organization",
      displayName: "Review",
      reason: "needs_human",
    });
    f.intent.proposals.push(
      ...IngestionIntentSchema.parse({
        ...f.intent,
        proposals: [
          { ...materialize, proposalId: "dependent", dependsOn: ["stage"] },
          { ...materialize, proposalId: "transitive", dependsOn: ["dependent"] },
          { ...materialize, proposalId: "independent" },
        ],
      }).proposals,
    );
    const plan = buildPlan(
      f.intent,
      { ...f.facts, subjects: { system: { ref: "system", kind: "ai_model_version", lifecycle: "active" } } },
      { version: "unit", migrationHead: "test" },
    );
    expect(plan.errors).toEqual([]);
    expect(plan.plannedOutcome).toBe("partial");
    expect(plan.proposals.find((item) => item.proposalId === "dependent")).toMatchObject({
      outcome: "held",
      actions: [],
    });
    expect(plan.proposals.find((item) => item.proposalId === "transitive")).toMatchObject({
      outcome: "held",
      actions: [],
    });
    expect(plan.proposals.find((item) => item.proposalId === "independent")).toMatchObject({ outcome: "admitted" });
  });
});

describe("claim producer identity (AIDB 20261031010000: attempt or origin)", () => {
  const origin = {
    kind: "standalone" as const,
    installationId: "install-1",
    applicationId: "ai-engineer",
    tenantId,
    issuer: "mission-control",
    subject: "runtime",
    mission: null,
    recoveryAuthorityRef: null,
    invocationId: "inv-1",
    authenticatedAt: "2026-10-25T00:00:00Z",
  };
  const exactUse = {
    useDecisionId: "ud-1",
    boundEffectDigest: `sha256:${"1".repeat(64)}`,
    processedEpoch: 0,
    normalizedValuesDigest: `sha256:${"2".repeat(64)}`,
    effectKey: "effect-1",
    originatingOrigin: origin,
  };
  const planWith = (context: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const f = fixture();
    const intent = IngestionIntentSchema.parse({
      schemaVersion: "knowledge-ingestion-intent.v1",
      intentId: "producer-unit",
      context,
      evidence: { verificationRuns: [], claims: [] },
      subjects: [{ mode: "resolved", ref: "system", kind: "ai_model_version", entityId }],
      proposals: [materialize],
      ...extra,
    });
    return buildPlan(intent, f.facts, { version: "unit", migrationHead: "test" }).proposals[0];
  };
  it("admits claim.materialize with an exact-use origin and no attempt", () => {
    expect(planWith({ tenantId }, { exactUse })).toMatchObject({ outcome: "admitted" });
  });
  it("holds claim.materialize with neither an attempt nor an origin", () => {
    expect(planWith({ tenantId })).toMatchObject({ outcome: "held", reason: "attempt_or_origin_required" });
  });
  it("still admits claim.materialize with an attempt alone", () => {
    expect(planWith({ tenantId, attemptId: tenantId })).toMatchObject({ outcome: "admitted" });
  });
});
