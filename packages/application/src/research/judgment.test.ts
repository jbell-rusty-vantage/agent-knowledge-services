import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Digest, digestBytes } from "@aiengineer/knowledge-operation-protocol";
import {
  type AssertionVersion,
  type AuthScope,
  REVIEW_CONDITION,
  admissible,
  normalizedValuesDigest,
  qualifiersDigest,
  recordRef,
} from "@aiengineer/knowledge-research-core";
import { describe, expect, it } from "vitest";
import { ScriptedAuditorDiscovery } from "./auditor.js";
import { ResearchCoordinator } from "./coordinator.js";
import {
  AT,
  EVIDENCE_REPORT_SCRIPT,
  FIXTURE_SEAL_KEYS,
  fixtureAssertion,
  fixtureBody,
  fixtureFragment,
  fixtureOrigin,
  fixtureSupportObservation,
  fixtureSupportSet,
  fixtureTask,
} from "./fixtures.js";
import { InMemoryResearchBinding } from "./in-memory.js";
import { ReportKindCatalog } from "./report-kinds.js";
import { ReviewService } from "./review.js";
import { SourceAuthorityCatalog } from "./source-authority.js";

/**
 * Sprint OC WI-03 (OC-D112/113): a recommendation can serve an official use only through an admitting judgment policy,
 * its typed basis, independent support and a qualified review; the decision records that it is not entailed.
 */
const TENANT = "00000000-0000-7000-8000-0000000000ab";
const BINDING = "in-memory";
const scope: AuthScope = {
  tenant: TENANT,
  application: "ai-engineer",
  binding: BINDING,
  origin: fixtureOrigin(TENANT),
  grants: ["research.write"],
};
let tick = 0;
const clock = { now: () => `2026-10-27T22:00:${String(tick++ % 60).padStart(2, "0")}Z` };
const CATALOG = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research");
const KINDS = ReportKindCatalog.fromDirectory(resolve(CATALOG, "report-kinds"));
const AUTHORITY = SourceAuthorityCatalog.fromDirectory(resolve(CATALOG, "source-authority"));
const WITHOUT_JUDGMENT = new SourceAuthorityCatalog([], AUTHORITY.useClasses, null);

async function decidedRecommendation(authority: SourceAuthorityCatalog, judgment: boolean) {
  const binding = new InMemoryResearchBinding(BINDING, { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
  const coordinator = new ResearchCoordinator(binding, clock, KINDS, { signer: FIXTURE_SEAL_KEYS.signer, authority });
  const origin = fixtureOrigin(TENANT);
  const fragment = fixtureFragment(TENANT, BINDING);
  const premise = fixtureAssertion(TENANT, BINDING, origin);
  const base: AssertionVersion = {
    ...premise,
    id: "asr-model-choice-v1",
    logicalId: "model-size",
    kind: "recommendation",
    premises: [recordRef("assertion", premise)],
  };
  const recommendation: AssertionVersion = judgment
    ? {
        ...base,
        judgment: {
          rationale: "Seven billion parameters fit the latency budget measured in the cited benchmark.",
          assumptions: ["the deployment keeps the benchmarked hardware"],
          uncertainty: { level: "medium", statement: "one benchmark series" },
          horizon: null,
        },
      }
    : base;
  const task = fixtureTask(TENANT, BINDING);
  const { runId } = await coordinator.openRun(scope, { task, originatingOrigin: origin });
  const set = { ...fixtureSupportSet(TENANT, BINDING, recommendation, fragment), id: "ss-model-choice" };
  await coordinator.registerEvidence(scope, {
    fragments: [fragment],
    assertions: [premise, recommendation],
    supportSets: [set],
  });
  await coordinator.registerReport(scope, {
    runId,
    reportId: "report-judgment",
    revision: 1,
    kind: KINDS.ref(scope, "evidence_report"),
    structuredBody: fixtureBody(recommendation, fragment),
    assertions: [recordRef("assertion", recommendation)],
    timeCoverage: { world: null, observed: { from: AT, to: AT }, knowledgeHead: null },
    supersedes: null,
  });
  await coordinator.observe(
    scope,
    runId,
    fixtureSupportObservation({
      tenant: TENANT,
      binding: BINDING,
      id: "obs-judge-choice",
      set,
      fragment,
      role: "judge",
      verdict: "full_support",
      qualifiersDigest: qualifiersDigest(recommendation.qualifiers),
    }),
  );
  await coordinator.auditReport(scope, { runId, auditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT) });
  await coordinator.sealVerificationSnapshot(scope, {
    runId,
    build: { buildId: "build-wi03", runtime: "node24", dirty: true },
    signer: "ks-sealer",
  });
  const decided = await coordinator.decideReportUse(scope, {
    runId,
    use: task.use,
    audience: "official",
    boundEffectDigest: digestBytes("effect-judgment"),
    targetSchema: "research-report.v2",
    normalizedValues: {},
    policy: task.policy,
    rubric: task.rubric,
  });
  return { binding, coordinator, decided, task };
}

describe("governed judgments (WI-03)", () => {
  it("without an admitting policy a recommendation never covers an official use (OQ4 preserved)", async () => {
    const { decided } = await decidedRecommendation(WITHOUT_JUDGMENT, true);
    expect(decided.decision.disposition).toBe("held");
    expect(decided.aggregate.holdsByReason.non_entailed).toBe(1);
    expect(decided.aggregate.judgmentCovered).toEqual([]);
  });

  it("an incomplete typed basis holds even under an admitting policy", async () => {
    const { decided } = await decidedRecommendation(AUTHORITY, false);
    expect(decided.decision.disposition).toBe("held");
    expect(decided.aggregate.holdsByReason.judgment_basis_incomplete).toBe(1);
  });

  it("a governed judgment is admitted only with review, and stays marked not entailed after approval", async () => {
    const { binding, coordinator, decided } = await decidedRecommendation(AUTHORITY, true);
    const { decision } = decided;
    expect(decision.disposition).toBe("admitted");
    expect(decision.conditions).toContain(REVIEW_CONDITION);
    expect(decision.conditions.some((condition) => condition.startsWith("judgment_not_entailed:"))).toBe(true);
    expect(decision.conditions).toContain("judgment_policy:governed-judgment@1.0.0");
    const context = {
      tenant: TENANT,
      use: decision.use,
      audience: decision.audience,
      authoritativeEpoch: 0,
      processedEpoch: 0,
      closureComplete: true,
      invalidated: new Set<string>(),
      now: "2026-10-27T23:00:00Z",
      boundEffectDigest: decision.boundEffectDigest as Digest,
      normalizedValuesDigest: normalizedValuesDigest(decision.normalizedValues),
    };
    expect(admissible(decision, context)).toEqual({ status: "held", reason: "review_required" });

    const review = new ReviewService(binding, coordinator, clock);
    await review.grantReviewer(scope, {
      reviewerId: "reviewer-1",
      scope: { uses: ["*"], audiences: ["official"], reportKinds: ["evidence_report"] },
      grantedBy: "operator",
    });
    const { successor, adjudication } = await review.adjudicate(scope, {
      decisionRef: decided.ref,
      reviewer: "reviewer-1",
      outcome: "approve",
      boundEffectDigest: decision.boundEffectDigest,
      qualifiersDigest: null,
      rationale: "premises, assumptions and uncertainty reviewed",
    });
    expect(successor.disposition).toBe("admitted");
    // Approval satisfies review only: the successor still says the judgment is not entailed.
    expect(successor.conditions.some((condition) => condition.startsWith("judgment_not_entailed:"))).toBe(true);
    expect(
      admissible(successor, {
        ...context,
        review: {
          adjudicationId: adjudication.id,
          outcome: "approve",
          boundEffectDigest: decision.boundEffectDigest,
          qualifiersDigest: null,
          grantLive: true,
        },
      }),
    ).toEqual({ status: "admitted" });
  });
});
