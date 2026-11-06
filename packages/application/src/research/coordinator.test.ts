import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestBytes } from "@aiengineer/knowledge-operation-protocol";
import {
  type AuthScope,
  normalizedValuesDigest,
  qualifiersDigest,
  recordRef,
  safeInteger,
} from "@aiengineer/knowledge-research-core";
import { describe, expect, it } from "vitest";
import { type DiscoveryScript, ScriptedAuditorDiscovery } from "./auditor.js";
import { ResearchCoordinator, ResearchCoordinatorError, addDecimal, systemClock, toInstant } from "./coordinator.js";
import {
  AT,
  EVIDENCE_REPORT_SCRIPT,
  FIXTURE_SEAL_KEYS,
  fixtureAssertion,
  fixtureBody,
  fixtureFragment,
  fixtureOrigin,
  fixtureRef,
  fixtureStudyAppraisal,
  fixtureSupportObservation,
  fixtureSupportSet,
  fixtureTask,
  reportKindCases,
  reportKindRoundTrip,
} from "./fixtures.js";
import { InMemoryResearchBinding } from "./in-memory.js";
import { ReportKindCatalog } from "./report-kinds.js";

const TENANT = "00000000-0000-7000-8000-0000000000aa";
const BINDING = "in-memory";
const scope: AuthScope = {
  tenant: TENANT,
  application: "ai-engineer",
  binding: BINDING,
  origin: fixtureOrigin(TENANT),
  grants: ["research.write"],
};
const clock = { now: () => AT };
const KINDS = ReportKindCatalog.fromDirectory(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/report-kinds"),
);
const policy = fixtureRef("policy", "policy-ai-engineer", TENANT, BINDING, "research-policy.ai-engineer.v2");
const rubric = fixtureRef("rubric", "rubric-engineering", TENANT, BINDING, "research-rubric.engineering.v2");
const useInput = (runId: string) => ({
  runId,
  use: "knowledge_ingestion.fact_assert_state",
  audience: "official",
  boundEffectDigest: digestBytes("effect-bytes"),
  targetSchema: "aiengineer-database-contract.v1",
  normalizedValues: {},
  policy,
  rubric,
});

async function seededRun(binding: InMemoryResearchBinding) {
  const coordinator = new ResearchCoordinator(binding, clock, KINDS, { signer: FIXTURE_SEAL_KEYS.signer });
  const origin = fixtureOrigin(TENANT);
  const { runId } = await coordinator.openRun(scope, { task: fixtureTask(TENANT, BINDING), originatingOrigin: origin });
  const fragment = fixtureFragment(TENANT, BINDING);
  const assertion = fixtureAssertion(TENANT, BINDING, origin);
  const set = fixtureSupportSet(TENANT, BINDING, assertion, fragment);
  await coordinator.registerEvidence(scope, { fragments: [fragment], assertions: [assertion], supportSets: [set] });
  const registered = await coordinator.registerReport(scope, {
    runId,
    reportId: "report-sv05",
    revision: 1,
    kind: KINDS.ref(scope, "evidence_report"),
    structuredBody: fixtureBody(assertion, fragment),
    assertions: [recordRef("assertion", assertion)],
    timeCoverage: { world: null, observed: { from: AT, to: AT }, knowledgeHead: null },
    supersedes: null,
  });
  const judge = (id = "obs-judge") =>
    coordinator.observe(
      scope,
      runId,
      fixtureSupportObservation({
        tenant: TENANT,
        binding: BINDING,
        id,
        set,
        fragment,
        role: "judge",
        verdict: "full_support",
        qualifiersDigest: qualifiersDigest(assertion.qualifiers),
      }),
    );
  const seal = () =>
    coordinator.sealVerificationSnapshot(scope, {
      runId,
      build: { buildId: "build-1", runtime: "node24", dirty: false },
      signer: "ks-sealer",
    });
  return { coordinator, runId, fragment, assertion, set, registered, judge, seal };
}

describe("research coordinator (K04) over the in-memory binding", () => {
  it("renders, freezes and ledgers a report whose occurrence span points at the exact claim text", async () => {
    const { registered } = await seededRun(
      new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier }),
    );
    expect(registered.frozen.text).toContain("Model X has 7B parameters.");
    expect(registered.revision.bodyDigest).toBe(digestBytes(registered.frozen.bytes));
    expect(registered.revision.kind.id).toBe("evidence_report@1.0.0");
    expect(registered.ledger.entries).toHaveLength(1);
    const entry = registered.ledger.entries[0];
    expect(entry?.obligations).toEqual(["finding.size"]);
    expect(registered.frozen.text.slice(entry?.span.start, entry?.span.end)).toBe("Model X has 7B parameters.");
    expect(entry?.body.digest).toBe(registered.revision.bodyDigest);
  });

  it("holds a report whose only support is the producer's own observation (E03)", async () => {
    const binding = new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
    const { coordinator, runId, fragment, set, assertion, seal } = await seededRun(binding);
    const qd = qualifiersDigest(assertion.qualifiers);
    await coordinator.observe(
      scope,
      runId,
      fixtureSupportObservation({
        tenant: TENANT,
        binding: BINDING,
        id: "obs-producer",
        set,
        fragment,
        role: "producer",
        verdict: "full_support",
        qualifiersDigest: qd,
      }),
    );
    const sealed = await seal();
    expect(sealed.sealed.manifest.families.map((f) => f.family).sort()).toEqual([
      "capture",
      "claims",
      "observations",
      "report",
    ]);
    const held = await coordinator.decideReportUse(scope, useInput(runId));
    expect(held.decision.disposition).toBe("held");
    expect(held.aggregate.holdsByReason.producer_only_coverage).toBe(1);
    expect(held.census).toEqual({ status: "not_run" });
    expect(
      await coordinator.admitExactUse(scope, {
        decisionId: held.decision.id,
        boundEffectDigest: digestBytes("effect-bytes"),
        processedEpoch: 0,
        normalizedValuesDigest: normalizedValuesDigest({}),
      }),
    ).toMatchObject({ outcome: "held", reason: "DECISION_HELD" });
    // A sealed run refuses new observations: the judge's observation belongs to a successor run.
    await expect(
      coordinator.observe(
        scope,
        runId,
        fixtureSupportObservation({
          tenant: TENANT,
          binding: BINDING,
          id: "obs-late",
          set,
          fragment,
          role: "judge",
          verdict: "full_support",
          qualifiersDigest: qd,
        }),
      ),
    ).rejects.toThrow(/RUN_SEALED/);
    await expect(seal()).rejects.toBeInstanceOf(ResearchCoordinatorError);
    await expect(
      coordinator.auditReport(scope, { runId, auditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT) }),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_SEALED" });
  });

  it("admits an assertion use only from authoritative observations, binds qualifiers and refuses a changed effect", async () => {
    const binding = new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
    const { coordinator, runId, assertion, judge, seal } = await seededRun(binding);
    await judge();
    await seal();
    const effect = digestBytes("exact-effect-bytes");
    const decided = await coordinator.decideAssertionUse(scope, {
      ...useInput(runId),
      assertion: recordRef("assertion", assertion),
      boundEffectDigest: effect,
      normalizedValues: { parameters: safeInteger(7000000000) },
    });
    expect(decided.decision.disposition).toBe("admitted");
    expect(decided.decision.qualifiersDigest).toBe(qualifiersDigest(assertion.qualifiers));
    expect(decided.decision.supportSet?.id).toBe("ss-model-size");
    const admit = (boundEffectDigest = effect, processedEpoch = 0) =>
      coordinator.admitExactUse(scope, {
        decisionId: decided.decision.id,
        boundEffectDigest,
        processedEpoch,
        normalizedValuesDigest: normalizedValuesDigest({ parameters: 7000000000 }),
      });
    expect(await admit()).toMatchObject({ outcome: "admitted" });
    expect(await admit(digestBytes("edited"))).toMatchObject({ outcome: "rejected", reason: "EFFECT_DIGEST_MISMATCH" });
    binding.epoch = 1;
    expect(await admit()).toMatchObject({ outcome: "held", reason: "REVOCATION_EPOCH_STALE" });
    binding.invalidated.add(decided.decision.id);
    expect(await admit(effect, 1)).toMatchObject({ outcome: "rejected", reason: "DECISION_INVALIDATED" });
  });

  it("adds USD decimals without floats", () => {
    expect(addDecimal("0", "0.0009")).toBe("0.0009");
    expect(addDecimal("0.0009", "0.0001")).toBe("0.001");
    expect(addDecimal("1.5", "2")).toBe("3.5");
  });
});

describe("independent auditor census (SV-06)", () => {
  it("records one auditor census observation over the exact frozen bytes; the report decision derives it", async () => {
    const binding = new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
    const { coordinator, runId, registered, judge, seal } = await seededRun(binding);
    await judge();
    // Before any census the report is held even with judge support: the census is not caller-supplied any more.
    const auditor = new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT);
    const audited = await coordinator.auditReport(scope, { runId, auditor });
    expect(audited.observation).toMatchObject({
      property: "census",
      target: registered.report,
      evaluator: { role: "auditor", kind: "deterministic" },
    });
    expect(audited.observation.limitations[0]).toMatch(/^recall unmeasured/);
    expect(audited.census).toMatchObject({ status: "assessed", holds: [], holdsRequiredCoverage: false });
    if (audited.observation.property !== "census") throw new Error("census expected");
    expect(audited.observation.outcome.bodyDigest).toBe(registered.revision.bodyDigest);
    expect(audited.observation.outcome.producerInventory).toEqual(registered.revision.ledger);
    expect(await binding.custody.verify(scope, audited.inventory)).toBe(true);
    // Independence of the discovery pass: exact body bytes, structural units, no producer ledger or occurrences.
    const call = auditor.calls[0];
    expect(call && digestBytes(call.body.bytes)).toBe(registered.revision.bodyDigest);
    expect(Object.keys(call ?? {}).sort()).toEqual(["assertions", "body", "evidence", "report", "task", "units"]);
    const { sealed, run } = await seal();
    expect(sealed.manifest.run.digest).toBe(run.digest);
    const decided = await coordinator.decideReportUse(scope, useInput(runId));
    expect(decided.decision.disposition).toBe("admitted");
    expect(decided.census).toMatchObject({ status: "assessed", observation: audited.ref });
    expect(decided.decision.run.digest).toBe(run.digest);
    expect(decided.aggregate.coveredWeight).toBe(6000);
    expect(decided.aggregate.totalWeight).toBe(10000);
  });

  it("holds required coverage for an unexplained auditor-only claim, negation or question reading", async () => {
    const cases: [DiscoveryScript, string][] = [
      [
        {
          entries: [
            ...EVIDENCE_REPORT_SCRIPT.entries,
            // SV-09: the evidence summary is a kind-declared framing section (explained there); a find in the
            // factual findings section (its heading) still holds.
            { quote: "Model X", nth: 1, assertionLogicalId: null },
          ],
        },
        "census:unexplained_auditor_only",
      ],
      [
        { entries: [{ quote: "Model X has 7B parameters.", assertionLogicalId: "model-size", negated: true }] },
        "census:screening_flag",
      ],
      [
        { entries: [{ quote: "Model X has 7B parameters.", assertionLogicalId: "model-size", interrogative: true }] },
        "census:screening_flag",
      ],
      [{ entries: [] }, "census:unexplained_producer_only"],
    ];
    for (const [script, reason] of cases) {
      const { coordinator, runId, judge, seal } = await seededRun(
        new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier }),
      );
      await judge();
      await coordinator.auditReport(scope, { runId, auditor: new ScriptedAuditorDiscovery(script) });
      await seal();
      const decided = await coordinator.decideReportUse(scope, useInput(runId));
      expect(decided.decision.disposition).toBe("held");
      expect(decided.decision.conditions).toContain(reason);
      expect(decided.aggregate.holdsByReason.census_unexplained_difference).toBe(1);
    }
    // The same negation reading with an auditor explanation clears the hold.
    const { coordinator, runId, judge, seal } = await seededRun(
      new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier }),
    );
    await judge();
    await coordinator.auditReport(scope, {
      runId,
      auditor: new ScriptedAuditorDiscovery({
        entries: [
          {
            quote: "Model X has 7B parameters.",
            assertionLogicalId: "model-size",
            negated: true,
            explanation: "the cue is a unit name, not a negation",
          },
        ],
      }),
    });
    await seal();
    expect((await coordinator.decideReportUse(scope, useInput(runId))).decision.disposition).toBe("admitted");
  });

  it("refuses a post-freeze edit before the census and a post-seal edit before the decision", async () => {
    const binding = new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
    const { coordinator, runId, registered, judge, seal } = await seededRun(binding);
    await judge();
    const key = `${TENANT}/${registered.revision.body.id}`;
    const original = binding.custody.artifacts.get(key);
    if (original === undefined) throw new Error("body not in custody");
    const edited = new TextEncoder().encode(registered.frozen.text.replace("7B", "8B"));
    binding.custody.artifacts.set(key, { ...original, bytes: edited });
    await expect(
      coordinator.auditReport(scope, { runId, auditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT) }),
    ).rejects.toMatchObject({ code: "BODY_DIGEST_MISMATCH" });
    binding.custody.artifacts.set(key, original);
    await coordinator.auditReport(scope, { runId, auditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT) });
    await seal();
    binding.custody.artifacts.set(key, { ...original, bytes: edited });
    await expect(coordinator.decideReportUse(scope, useInput(runId))).rejects.toMatchObject({
      code: "BODY_DIGEST_MISMATCH",
    });
  });

  it("refuses a discovered inventory that does not quote the frozen bytes", async () => {
    const { coordinator, runId } = await seededRun(
      new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier }),
    );
    const lying = new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT);
    const forged = {
      discover: async (...args: Parameters<ScriptedAuditorDiscovery["discover"]>) => {
        const result = await lying.discover(...args);
        return {
          ...result,
          occurrences: result.occurrences.map((occurrence) => ({ ...occurrence, quoteDigest: digestBytes("x") })),
        };
      },
    };
    await expect(coordinator.auditReport(scope, { runId, auditor: forged })).rejects.toMatchObject({
      code: "DISCOVERY_INVALID",
    });
    const producerRole = {
      discover: async (...args: Parameters<ScriptedAuditorDiscovery["discover"]>) => {
        const result = await lying.discover(...args);
        return { ...result, evaluator: { ...result.evaluator, role: "producer" as const } };
      },
    };
    await expect(coordinator.auditReport(scope, { runId, auditor: producerRole })).rejects.toMatchObject({
      code: "AUDITOR_ROLE_REQUIRED",
    });
  });
});

describe("report-level disposition (checkpoint A finding 5)", () => {
  it("missing evidence and an ungrounded contradiction hold; an L0 integrity failure rejects", async () => {
    const decide = async (observe: (ctx: Awaited<ReturnType<typeof seededRun>>) => Promise<unknown>) => {
      const ctx = await seededRun(
        new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier }),
      );
      await observe(ctx);
      await ctx.coordinator.auditReport(scope, {
        runId: ctx.runId,
        auditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT),
      });
      await ctx.seal();
      return (await ctx.coordinator.decideReportUse(scope, useInput(ctx.runId))).decision;
    };
    expect((await decide(async () => undefined)).disposition).toBe("held");
    const contradicted = await decide(({ coordinator, runId, set, fragment, assertion }) =>
      coordinator.observe(
        scope,
        runId,
        fixtureSupportObservation({
          tenant: TENANT,
          binding: BINDING,
          id: "obs-contradiction",
          set,
          fragment,
          role: "judge",
          verdict: "contradiction",
          qualifiersDigest: qualifiersDigest(assertion.qualifiers),
        }),
      ),
    );
    // SV-09: a judge contradiction that cites no fragment the set retains as contrary is a dispute: it holds.
    // A rejection needs a contradiction grounded in retained contrary evidence (research-core aggregate test).
    expect(contradicted.disposition).toBe("held");
    expect(contradicted.conditions).toContain("disputed_verdict:1");
    const broken = await decide(async ({ coordinator, runId, set, judge }) => {
      await judge();
      const integrity = {
        ...fixtureSupportObservation({
          tenant: TENANT,
          binding: BINDING,
          id: "obs-integrity",
          set,
          fragment: fixtureFragment(TENANT, BINDING),
          role: "producer",
          verdict: "full_support",
          qualifiersDigest: qualifiersDigest(fixtureAssertion(TENANT, BINDING, fixtureOrigin(TENANT)).qualifiers),
        }),
        qualifiersDigest: null,
        property: "integrity" as const,
        outcome: { result: "fail" as const, failureCodes: ["capture_digest_mismatch" as const] },
      };
      await coordinator.observe(scope, runId, integrity);
    });
    expect(broken.disposition).toBe("rejected");
    expect(broken.conditions).toContain("integrity_failure:1");
  });
});

describe("K08 report kinds at registration", () => {
  it("refuses an unknown kind, a tampered kind digest and a draft that does not satisfy its kind", async () => {
    const binding = new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
    const coordinator = new ResearchCoordinator(binding, clock, KINDS, { signer: FIXTURE_SEAL_KEYS.signer });
    const origin = fixtureOrigin(TENANT);
    const { runId } = await coordinator.openRun(scope, {
      task: fixtureTask(TENANT, BINDING),
      originatingOrigin: origin,
    });
    const fragment = fixtureFragment(TENANT, BINDING);
    const assertion = fixtureAssertion(TENANT, BINDING, origin);
    await coordinator.registerEvidence(scope, { fragments: [fragment], assertions: [assertion] });
    const draft = {
      runId,
      reportId: "report-k",
      revision: 1,
      kind: KINDS.ref(scope, "evidence_report"),
      structuredBody: fixtureBody(assertion, fragment),
      assertions: [recordRef("assertion", assertion)],
      timeCoverage: { world: null, observed: null, knowledgeHead: null },
      supersedes: null,
    };
    await expect(
      coordinator.registerReport(scope, {
        ...draft,
        kind: fixtureRef("report_kind", "evidence_report", TENANT, BINDING, "report-kind.v2"),
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_UNSUPPORTED" });
    await expect(
      coordinator.registerReport(scope, { ...draft, kind: { ...draft.kind, digest: digestBytes("other kind bytes") } }),
    ).rejects.toMatchObject({ code: "SCHEMA_UNSUPPORTED" });
    const body = fixtureBody(assertion, fragment);
    const withoutEvidence = { ...body, sections: body.sections.filter((section) => section.id !== "evidence") };
    const refusal = coordinator.registerReport(scope, { ...draft, structuredBody: withoutEvidence });
    await expect(refusal).rejects.toMatchObject({
      code: "SCHEMA_UNSUPPORTED",
      violations: ["missing_section:evidence"],
    });
    // An engineering task cannot register a study appraisal, which also needs a single study and its domains.
    await expect(
      coordinator.registerReport(scope, { ...draft, kind: KINDS.ref(scope, "study_appraisal") }),
    ).rejects.toMatchObject({ code: "SCHEMA_UNSUPPORTED" });
  });

  it("refuses a study appraisal that rates a body of evidence", async () => {
    const binding = new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
    const coordinator = new ResearchCoordinator(binding, clock, KINDS, { signer: FIXTURE_SEAL_KEYS.signer });
    const appraisal = fixtureStudyAppraisal(TENANT, BINDING, fixtureOrigin(TENANT));
    const { runId } = await coordinator.openRun(scope, { task: appraisal.task, originatingOrigin: scope.origin });
    await coordinator.registerEvidence(scope, {
      fragments: [appraisal.fragment],
      assertions: appraisal.assertions,
      supportSets: appraisal.supportSets,
    });
    const rated = {
      ...appraisal.body,
      sections: [
        ...appraisal.body.sections,
        {
          id: "certainty_of_evidence",
          heading: [{ type: "text" as const, text: "Certainty: moderate" }],
          headingExcludedReason: null,
          blocks: [],
        },
      ],
    };
    await expect(
      coordinator.registerReport(scope, {
        runId,
        reportId: "report-rated",
        revision: 1,
        kind: KINDS.ref(scope, "study_appraisal"),
        structuredBody: rated,
        assertions: appraisal.assertions.map((assertion) => recordRef("assertion", assertion)),
        timeCoverage: { world: null, observed: null, knowledgeHead: null },
        supersedes: null,
      }),
    ).rejects.toMatchObject({ code: "SCHEMA_UNSUPPORTED", violations: ["forbidden_section:certainty_of_evidence"] });
  });

  it.each(["evidence_report", "study_appraisal"] as const)(
    "round-trips %s: register -> freeze -> ledger -> audit -> aggregate -> decide (in-memory)",
    async (kindId) => {
      const binding = new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
      const kase = reportKindCases(TENANT, BINDING, scope.origin).find((candidate) => candidate.kindId === kindId);
      if (kase === undefined) throw new Error("fixture");
      const result = await reportKindRoundTrip({
        scope,
        binding,
        operations: binding.operations,
        kinds: KINDS,
        kase,
        clock,
      });
      expect(result.registered.revision.kind).toEqual(KINDS.ref(scope, kindId));
      expect(result.queued).toMatchObject({ state: "queued", revision: 1, retryAfterMs: 1000 });
      expect(result.assessed).toMatchObject({ state: "partial", retryAfterMs: null });
      expect(result.assessed.revision).toBe(3);
      expect(result.assessed.resultRef?.kind).toBe("artifact");
      expect(result.decided.census).toMatchObject({ status: "assessed", holds: [] });
      expect(result.decided.decision.disposition).toBe("admitted");
      expect(result.decided.aggregate.unmetRequired).toEqual([]);
    },
  );
});

describe("atomic, deterministic seal (checkpoint A finding 1)", () => {
  it("formats wall-clock instants in the K01 form", () => {
    expect(toInstant(new Date("2026-10-25T10:00:00.120Z"))).toBe("2026-10-25T10:00:00.12Z");
    expect(toInstant(new Date("2026-10-25T10:00:00.000Z"))).toBe("2026-10-25T10:00:00Z");
    expect(toInstant(new Date("2026-10-25T10:00:00.123Z"))).toBe("2026-10-25T10:00:00.123Z");
  });

  it("a custody failure mid-seal leaves nothing behind; the retry with a real clock seals the same run record", async () => {
    const binding = new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
    const coordinator = new ResearchCoordinator(binding, systemClock, KINDS, { signer: FIXTURE_SEAL_KEYS.signer });
    const origin = fixtureOrigin(TENANT);
    const { runId } = await coordinator.openRun(scope, {
      task: fixtureTask(TENANT, BINDING),
      originatingOrigin: origin,
    });
    const opened = (await binding.loadRunContext(scope, runId)).openedAt;
    const put = binding.custody.put.bind(binding.custody);
    let failNextSignature = true;
    binding.custody.put = async (s, bytes, mediaType) => {
      // The signature is now an inline Ed25519 seal; fail the last family upload before the seal transaction instead.
      if (failNextSignature && Buffer.from(bytes).toString("utf8").includes('"family":"observations"')) {
        failNextSignature = false;
        throw new Error("CUSTODY_UNAVAILABLE");
      }
      return put(s, bytes, mediaType);
    };
    const fragment = fixtureFragment(TENANT, BINDING);
    const assertion = fixtureAssertion(TENANT, BINDING, origin);
    await coordinator.registerEvidence(scope, { fragments: [fragment], assertions: [assertion] });
    await coordinator.registerReport(scope, {
      runId,
      reportId: "report-seal",
      revision: 1,
      kind: KINDS.ref(scope, "evidence_report"),
      structuredBody: fixtureBody(assertion, fragment),
      assertions: [recordRef("assertion", assertion)],
      timeCoverage: { world: null, observed: null, knowledgeHead: null },
      supersedes: null,
    });
    const sealInput = { runId, build: { buildId: "b-1", runtime: "node24", dirty: false }, signer: "ks-sealer" };
    await expect(coordinator.sealVerificationSnapshot(scope, sealInput)).rejects.toThrow(/CUSTODY_UNAVAILABLE/);
    const afterFailure = await binding.loadRunContext(scope, runId);
    expect(afterFailure.head).toBeNull();
    expect(afterFailure.run).toBeNull();
    const { sealed, run } = await coordinator.sealVerificationSnapshot(scope, sealInput);
    expect(sealed.manifest.run).toEqual(run);
    const stored = await binding.loadRunContext(scope, runId);
    expect(stored.run?.startedAt).toBe(opened);
  });

  it("two truly concurrent seals of one run: exactly one succeeds", async () => {
    const { coordinator, runId } = await seededRun(
      new InMemoryResearchBinding("in-memory", { sealVerifier: FIXTURE_SEAL_KEYS.verifier }),
    );
    const input = { runId, build: { buildId: "b-1", runtime: "node24", dirty: false }, signer: "ks-sealer" };
    const results = await Promise.allSettled([
      coordinator.sealVerificationSnapshot(scope, input),
      coordinator.sealVerificationSnapshot(scope, input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
