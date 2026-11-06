import { generateKeyPairSync } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Digest, digestBytes } from "@aiengineer/knowledge-operation-protocol";
import {
  type AssertionVersion,
  type AuthScope,
  type EvidenceFragment,
  type SourceDescription,
  type VerificationTaskContract,
  evaluateSupport,
  normalizedValuesDigest,
  qualifiersDigest,
  recordRef,
  withFramingExclusions,
} from "@aiengineer/knowledge-research-core";
import { describe, expect, it } from "vitest";
import { CrossrefRevisionFrontier, type FetchLike } from "./adapters/crossref.js";
import { ReportAssessmentService } from "./assessment.js";
import { ScriptedAuditorDiscovery } from "./auditor.js";
import { AuthorityChallengeService } from "./authority.js";
import { ResearchCoordinator } from "./coordinator.js";
import {
  EVIDENCE_REPORT_SCRIPT,
  FIXTURE_SEAL_KEYS,
  type ReportKindCase,
  fixtureAssertion,
  fixtureBody,
  fixtureEvaluator,
  fixtureFragment,
  fixtureOrigin,
  fixtureRef,
  fixtureSupportObservation,
  fixtureSupportSet,
  fixtureTask,
  reportKindCases,
} from "./fixtures.js";
import { InMemoryResearchBinding } from "./in-memory.js";
import { SealVerificationError } from "./lineage.js";
import type { CounterevidenceSearch, SourceAuthorityResolver } from "./ports.js";
import { ReportKindCatalog } from "./report-kinds.js";
import { CorrectionService, ReviewService } from "./review.js";
import { Ed25519SealSigner, StaticSealVerifier, testSealKeys } from "./signing.js";
import { SourceAuthorityCatalog } from "./source-authority.js";

const TENANT = "00000000-0000-7000-8000-0000000000aa";
const BINDING = "in-memory";
const scope: AuthScope = {
  tenant: TENANT,
  application: "ai-engineer",
  binding: BINDING,
  origin: fixtureOrigin(TENANT),
  grants: ["research.write"],
};
const here = dirname(fileURLToPath(import.meta.url));
const KINDS = ReportKindCatalog.fromDirectory(resolve(here, "../../../../catalog/research/report-kinds"));
const AUTHORITY = SourceAuthorityCatalog.fromDirectory(resolve(here, "../../../../catalog/research/source-authority"));
let tick = 0;
const clock = {
  now: () =>
    `2026-10-24T22:${String(Math.floor(tick / 60) % 60).padStart(2, "0")}:${String(tick++ % 60).padStart(2, "0")}Z`,
};
const ADMISSION_NOW = "2026-10-25T00:00:00Z";

function harness(options: { authority?: boolean; signer?: Ed25519SealSigner; verifier?: StaticSealVerifier } = {}) {
  const binding = new InMemoryResearchBinding(BINDING, {
    sealVerifier: options.verifier ?? FIXTURE_SEAL_KEYS.verifier,
    now: () => ADMISSION_NOW,
  });
  const coordinator = new ResearchCoordinator(binding, clock, KINDS, {
    signer: options.signer ?? FIXTURE_SEAL_KEYS.signer,
    authority: options.authority === false ? null : AUTHORITY,
  });
  return { binding, coordinator };
}

/** One evidence report run up to (and including) the independent census; not sealed. */
async function evidenceRun(
  h: ReturnType<typeof harness>,
  input: { reportId: string; task?: Partial<VerificationTaskContract>; suffix?: string; judge?: boolean | undefined },
) {
  const suffix = input.suffix ?? input.reportId;
  const origin = fixtureOrigin(TENANT);
  const task = { ...fixtureTask(TENANT, BINDING), id: `task-${suffix}`, ...input.task };
  const { runId } = await h.coordinator.openRun(scope, { task, originatingOrigin: origin });
  const fragment: EvidenceFragment = {
    ...fixtureFragment(TENANT, BINDING),
    id: `frag-${suffix}`,
    capture: fixtureRef("artifact", `capture-${suffix}`, TENANT, BINDING, "artifact.v1"),
  };
  const assertion: AssertionVersion = { ...fixtureAssertion(TENANT, BINDING, origin), id: `asr-${suffix}` };
  const set = { ...fixtureSupportSet(TENANT, BINDING, assertion, fragment), id: `ss-${suffix}` };
  await h.coordinator.registerEvidence(scope, { fragments: [fragment], assertions: [assertion], supportSets: [set] });
  const registered = await h.coordinator.registerReport(scope, {
    runId,
    reportId: input.reportId,
    revision: 1,
    kind: KINDS.ref(scope, "evidence_report"),
    structuredBody: fixtureBody(assertion, fragment),
    assertions: [recordRef("assertion", assertion)],
    timeCoverage: { world: null, observed: null, knowledgeHead: null },
    supersedes: null,
  });
  if (input.judge !== false) {
    await h.coordinator.observe(
      scope,
      runId,
      fixtureSupportObservation({
        tenant: TENANT,
        binding: BINDING,
        id: `obs-judge-${suffix}`,
        set,
        fragment,
        role: "judge",
        verdict: "full_support",
        qualifiersDigest: qualifiersDigest(assertion.qualifiers),
      }),
    );
  }
  await h.coordinator.auditReport(scope, { runId, auditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT) });
  const seal = () =>
    h.coordinator.sealVerificationSnapshot(scope, {
      runId,
      build: { buildId: "build-sv07", runtime: "node24", dirty: true },
      signer: "ks-sealer",
    });
  const decide = (
    extra: { expiresAt?: string | null; effect?: string; normalizedValues?: Record<string, string> } = {},
  ) =>
    h.coordinator.decideReportUse(scope, {
      runId,
      use: task.use,
      audience: "official",
      boundEffectDigest: digestBytes(extra.effect ?? `effect-${suffix}`),
      targetSchema: "aiengineer-database-contract.v1",
      normalizedValues: extra.normalizedValues ?? {},
      policy: task.policy,
      rubric: task.rubric,
      expiresAt: extra.expiresAt ?? null,
    });
  return { runId, task, fragment, assertion, set, registered, seal, decide };
}

describe("K07 Ed25519 seal signatures (design §6)", () => {
  it("signs the canonical {manifestDigest, signer, signedAt, keyId} bytes and verifies only with the pinned key", async () => {
    const h = harness({ authority: false });
    const run = await evidenceRun(h, { reportId: "report-sign" });
    const { sealed } = await run.seal();
    expect(sealed.seal).toMatchObject({ algorithm: "Ed25519", keyId: "ks-fixture-seal-1", signer: "ks-sealer" });
    expect(sealed.seal.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(FIXTURE_SEAL_KEYS.verifier.verify(sealed.seal, sealed.seal.manifestDigest)).toEqual({ ok: true });
    // A swapped key id (covered by the signature) and an unknown key never verify.
    const swapped = { ...sealed.seal, keyId: "ks-other-key" };
    expect(FIXTURE_SEAL_KEYS.verifier.verify(swapped, sealed.seal.manifestDigest)).toMatchObject({
      reason: "unknown_key",
    });
    const both = new StaticSealVerifier([
      { keyId: "ks-fixture-seal-1", publicKey: FIXTURE_SEAL_KEYS.publicKey, status: "active" },
      { keyId: "ks-other-key", publicKey: FIXTURE_SEAL_KEYS.publicKey, status: "active" },
    ]);
    expect(both.verify(swapped, sealed.seal.manifestDigest)).toMatchObject({ ok: false, reason: "signature" });
    expect(both.verify(sealed.seal, digestBytes("another manifest"))).toMatchObject({ reason: "digest_mismatch" });
    const loaded = await h.binding.loadRunContext(scope, run.runId);
    expect(loaded.manifests).toHaveLength(1);
    expect(loaded.run?.id).toBe(run.runId);
  });

  it("refuses to seal with a key the binding does not pin, and loads PEM keys from a file or an env NAME", async () => {
    const rogue = testSealKeys("ks-rogue", "rogue");
    const h = harness({ authority: false, signer: rogue.signer });
    const run = await evidenceRun(h, { reportId: "report-rogue" });
    // W1 D25: a key the registry does not pin is a typed, named refusal (not an untyped SEAL_INVALID).
    await expect(run.seal()).rejects.toMatchObject({ code: "SEAL_KEY_UNREGISTERED", keyId: "ks-rogue" });
    expect((await h.binding.loadRunContext(scope, run.runId)).head).toBeNull();
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const fromEnv = Ed25519SealSigner.fromEnv("ks-env-key", "SV07_TEST_SEAL_PEM", { SV07_TEST_SEAL_PEM: pem });
    const verifier = new StaticSealVerifier([
      { keyId: "ks-env-key", publicKey: fromEnv.publicKeyRaw(), status: "active" },
    ]);
    const seal = await fromEnv.sign(digestBytes("m"), { signer: "ks-sealer", signedAt: "2026-10-25T00:00:00Z" });
    expect(verifier.verify(seal, digestBytes("m"))).toEqual({ ok: true });
    expect(() => Ed25519SealSigner.fromEnv("k", "SV07_UNSET_VARIABLE", {})).toThrow(/SV07_UNSET_VARIABLE is not set/);
    expect(() => Ed25519SealSigner.fromPem("k", "not a pem")).toThrow(/SEAL_KEY_UNAVAILABLE/);
    const revoked = new StaticSealVerifier([
      { keyId: "ks-env-key", publicKey: fromEnv.publicKeyRaw(), status: "revoked" },
    ]);
    expect(revoked.verify(seal, digestBytes("m"))).toMatchObject({ reason: "retired_key" });
  });

  it("refuses a tampered stored manifest, a tampered family, an importer replay and a cross-run replay", async () => {
    const h = harness({ authority: false });
    const run = await evidenceRun(h, { reportId: "report-tamper" });
    const { sealed } = await run.seal();
    const stored = h.binding.runs.get(run.runId);
    if (!stored) throw new Error("fixture");
    // Tampered manifest bytes: the recomputed digest no longer matches the signed one.
    const original = stored.manifests[0];
    if (!original) throw new Error("fixture");
    stored.manifests[0] = { ...original, manifest: { ...original.manifest, createdAt: "2026-10-24T23:59:59Z" } };
    await expect(h.binding.loadRunContext(scope, run.runId)).rejects.toMatchObject({ code: "SEAL_INVALID" });
    stored.manifests[0] = original;
    // Tampered family bytes in custody.
    const observations = original.manifest.families.find((binding) => binding.family === "observations");
    const key = `${TENANT}/${observations?.ref.id}`;
    const bytes = h.binding.custody.artifacts.get(key);
    if (!bytes) throw new Error("fixture");
    h.binding.custody.artifacts.set(key, { ...bytes, bytes: Buffer.from("[]") });
    await expect(h.binding.loadRunContext(scope, run.runId)).rejects.toBeInstanceOf(SealVerificationError);
    await expect(h.binding.loadRunContext(scope, run.runId)).rejects.toMatchObject({ code: "FAMILY_TAMPERED" });
    h.binding.custody.artifacts.set(key, bytes);
    // Importer replay of the exact sealed bytes over the committed head, and into another run.
    await expect(
      h.binding.seal(scope, {
        runId: run.runId,
        run: sealed.manifest.run as never,
        manifest: sealed.manifest,
        seal: sealed.seal,
        expectedHead: null,
      }),
    ).rejects.toThrow(/HEAD_MISMATCH/);
    const other = await evidenceRun(h, { reportId: "report-other" });
    const context = await h.binding.loadRunContext(scope, run.runId);
    await expect(
      h.binding.seal(scope, {
        runId: other.runId,
        run: context.run as never,
        manifest: sealed.manifest,
        seal: sealed.seal,
        expectedHead: null,
      }),
    ).rejects.toThrow(/RUN_LINK_MISMATCH|RUN_IDENTITY_IMMUTABLE/);
  });
});

/** Recorded Crossref responses (never the network). */
const recorded = (bodies: Record<string, { status: number; body?: unknown }>): FetchLike & { calls: string[] } => {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    const doi = decodeURIComponent(url.slice(url.indexOf("/works/") + 7));
    const entry = bodies[doi] ?? { status: 404 };
    return { status: entry.status, json: async () => entry.body };
  }) as unknown as FetchLike & { calls: string[] };
  fetch.calls = calls;
  return fetch;
};

describe("on-demand Crossref revision frontier", () => {
  it("maps update relations to a revision status; failures are unknown, never current", async () => {
    const fetch = recorded({
      "10.1000/current": { status: 200, body: { message: { DOI: "10.1000/current" } } },
      "10.1000/retracted": {
        status: 200,
        body: {
          message: { "updated-by": [{ type: "retraction", DOI: "10.1000/NOTICE", source: "retraction-watch" }] },
        },
      },
      "10.1000/corrected": {
        status: 200,
        body: { message: { "updated-by": [{ type: "correction", DOI: "10.1000/fix" }] } },
      },
      "10.1000/broken": { status: 200, body: "not json" },
    });
    const frontier = new CrossrefRevisionFrontier({ fetch, mailto: "ops@example.test" });
    expect(await frontier.check(scope, "10.1000/current")).toEqual({ status: "current", notices: [] });
    expect(await frontier.check(scope, "10.1000/retracted")).toEqual({
      status: "retracted",
      notices: ["10.1000/notice"],
    });
    expect((await frontier.check(scope, "10.1000/corrected")).status).toBe("corrected");
    expect((await frontier.check(scope, "10.1000/missing")).status).toBe("unknown");
    expect((await frontier.check(scope, "10.1000/broken")).status).toBe("unknown");
    expect((await frontier.check(scope, "not-a-doi")).status).toBe("unknown");
    expect(fetch.calls).toHaveLength(5);
    const failing = new CrossrefRevisionFrontier({ fetch: async () => Promise.reject(new Error("offline")) });
    expect((await failing.check(scope, "10.1000/current")).status).toBe("unknown");
  });
});

const resolver = (overrides: Partial<SourceDescription> = {}): SourceAuthorityResolver => ({
  evaluator: fixtureEvaluator("auditor", "registry"),
  method: fixtureRef("method", "source-registry", TENANT, BINDING, "source-authority.v1"),
  describe: async () => ({
    verifiedOriginFamily: "trial-alpha",
    doi: "10.1000/alpha",
    sourceKind: "peer_reviewed_article",
    studyDesign: "randomized_controlled_trial",
    directness: "direct",
    freshness: "current",
    qualifiers: { species: "human", population: "adults with condition c" },
    ...overrides,
  }),
});

const search = (input: { conflict?: boolean; notSearched?: boolean } = {}): CounterevidenceSearch => ({
  evaluator: fixtureEvaluator("auditor", "search"),
  method: fixtureRef("method", "bounded-counterevidence", TENANT, BINDING, "challenge.v1"),
  search: async (_scope, { assertion }) => ({
    status: input.notSearched ? "not_searched" : "searched",
    reason: "budget exhausted",
    queries: [`"${assertion.subject}" contradicting evidence`],
    counterevidence: input.conflict
      ? [
          {
            ...fixtureFragment(TENANT, BINDING),
            id: `frag-contra-${assertion.id}`.slice(0, 120),
            sourceVersion: "contra-v1",
            selectedDigest: digestBytes(`contra-${assertion.id}`),
          },
        ]
      : [],
    materialConflict: input.conflict ?? false,
    frontier: {
      exhausted: true,
      searchedScopes: ["fixture-index"],
      limits: ["fixture"],
      unsearchedScopes: ["paywalled journals"],
    },
    rationale: input.conflict ? "a contrary report was found" : "no contrary report within the bound",
    usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
  }),
});

async function appraisalRun(
  h: ReturnType<typeof harness>,
  kase: ReportKindCase,
  before?: (runId: string) => Promise<void>,
) {
  const { runId } = await h.coordinator.openRun(scope, { task: kase.task, originatingOrigin: scope.origin });
  await h.coordinator.registerEvidence(scope, {
    fragments: kase.fragments,
    assertions: kase.assertions,
    supportSets: kase.supportSets,
  });
  await h.coordinator.registerReport(scope, {
    runId,
    reportId: `report-${kase.kindId}-${tick}`,
    revision: 1,
    kind: KINDS.ref(scope, kase.kindId),
    structuredBody: kase.body,
    assertions: kase.assertions.map((assertion) => recordRef("assertion", assertion)),
    timeCoverage: { world: null, observed: null, knowledgeHead: null },
    supersedes: null,
  });
  for (const set of kase.supportSets) {
    const assertion = kase.assertions.find((candidate) => candidate.id === set.assertion.id) as AssertionVersion;
    await h.coordinator.observe(
      scope,
      runId,
      fixtureSupportObservation({
        tenant: TENANT,
        binding: BINDING,
        id: `obs-judge-${set.id}`,
        set,
        fragment: kase.fragments[0] as EvidenceFragment,
        role: "judge",
        verdict: "full_support",
        qualifiersDigest: qualifiersDigest(assertion.qualifiers),
      }),
    );
  }
  await h.coordinator.auditReport(scope, { runId, auditor: new ScriptedAuditorDiscovery(kase.script) });
  if (before) await before(runId);
  await h.coordinator.sealVerificationSnapshot(scope, {
    runId,
    build: { buildId: "b", runtime: "node24", dirty: true },
    signer: "ks-sealer",
  });
  const decided = await h.coordinator.decideReportUse(scope, {
    runId,
    use: kase.task.use,
    audience: "official",
    boundEffectDigest: digestBytes(`effect-${runId}`),
    targetSchema: "aiengineer-database-contract.v1",
    normalizedValues: {},
    policy: kase.task.policy,
    rubric: kase.task.rubric,
  });
  return { runId, decided };
}

describe("SV-07 authority, revision frontier and bounded challenge (scientific, official use)", () => {
  const appraisal = () => reportKindCases(TENANT, BINDING, scope.origin)[1] as ReportKindCase;

  it("holds a study appraisal for official use until authority and challenge are recorded", async () => {
    const h = harness();
    const { decided } = await appraisalRun(h, appraisal());
    expect(decided.decision.disposition).toBe("held");
    expect(decided.aggregate.authorityGate).toBe(true);
    expect(decided.aggregate.holdsByReason).toMatchObject({ authority_missing: 2, challenge_missing: 2 });
    // Without the K08 catalogue the same run is internal use: no gate.
    const internal = harness({ authority: false });
    expect((await appraisalRun(internal, appraisal())).decided.decision.disposition).toBe("admitted");
  });

  it("admits after non-adverse authority (one verified study, current revision) and a completed bounded challenge", async () => {
    const h = harness();
    const service = new AuthorityChallengeService(h.binding, clock, AUTHORITY);
    const fetch = recorded({ "10.1000/alpha": { status: 200, body: { message: {} } } });
    const { decided, runId } = await appraisalRun(h, appraisal(), async (id) => {
      await service.recordAuthority(scope, {
        runId: id,
        resolver: resolver(),
        frontier: new CrossrefRevisionFrontier({ fetch }),
      });
      await service.recordChallenge(scope, { runId: id, search: search(), maxQueries: 2 });
    });
    expect(decided.decision.disposition).toBe("admitted");
    const context = await h.binding.loadRunContext(scope, runId);
    const authority = context.observations.filter((observation) => observation.property === "authority");
    expect(authority).toHaveLength(2);
    const outcome = authority[0]?.property === "authority" ? authority[0].outcome : null;
    expect(outcome).toMatchObject({
      fitness: "fit",
      fitnessRule: "source-report-any-design",
      applicability: "applicable",
      distinctOrigins: 1,
      revisionFrontier: { status: "current", checked: [{ identifier: "10.1000/alpha", status: "current" }] },
    });
    expect(fetch.calls.length).toBe(2);
    const challenge = context.observations.find((observation) => observation.property === "challenge");
    expect(challenge?.outcome).toMatchObject({
      status: "searched",
      materialConflict: false,
      frontier: { unsearchedScopes: ["paywalled journals"] },
    });
  });

  it("three reports of one study are one verified origin; an unverified family stays unknown", async () => {
    const h = harness();
    const service = new AuthorityChallengeService(h.binding, clock, AUTHORITY);
    const kase = appraisal();
    const unknown = resolver({ verifiedOriginFamily: null, doi: null });
    const { runId } = await appraisalRun(h, kase, async (id) => {
      await service.recordAuthority(scope, { runId: id, resolver: unknown, frontier: null });
    });
    const context = await h.binding.loadRunContext(scope, runId);
    const outcome = context.observations.find((o) => o.property === "authority");
    expect(outcome?.property === "authority" && outcome.outcome).toMatchObject({
      distinctOrigins: 0,
      originFamilies: [{ family: null }],
      revisionFrontier: { status: "unknown" },
    });
  });

  it("a retraction is adverse; an unsearched challenge or an unresolved material conflict holds; contrary evidence is retained", async () => {
    const h = harness();
    const service = new AuthorityChallengeService(h.binding, clock, AUTHORITY);
    const retracted = recorded({
      "10.1000/alpha": { status: 200, body: { message: { "updated-by": [{ type: "retraction", DOI: "10.1000/r" }] } } },
    });
    const adverse = await appraisalRun(h, appraisal(), async (id) => {
      await service.recordAuthority(scope, {
        runId: id,
        resolver: resolver(),
        frontier: new CrossrefRevisionFrontier({ fetch: retracted }),
      });
      await service.recordChallenge(scope, { runId: id, search: search() });
    });
    expect(adverse.decided.aggregate.holdsByReason).toMatchObject({ authority_adverse: 2 });
    const current = recorded({ "10.1000/alpha": { status: 200, body: { message: {} } } });
    const conflicted = await appraisalRun(h, appraisal(), async (id) => {
      await service.recordAuthority(scope, {
        runId: id,
        resolver: resolver(),
        frontier: new CrossrefRevisionFrontier({ fetch: current }),
      });
      await service.recordChallenge(scope, { runId: id, search: search({ conflict: true }) });
    });
    expect(conflicted.decided.decision.disposition).toBe("held");
    expect(conflicted.decided.aggregate.holdsByReason).toMatchObject({ challenge_unresolved: 2 });
    const context = await h.binding.loadRunContext(scope, conflicted.runId);
    const assertion = context.assertions[0] as AssertionVersion;
    const evaluation = evaluateSupport({
      scope: { tenant: TENANT, binding: BINDING },
      assertion,
      assertions: context.assertions,
      supportSets: context.supportSets,
      observations: context.observations,
    });
    expect(evaluation.ok && evaluation.contraryRetained.map((ref) => ref.id)).toContain(`frag-contra-${assertion.id}`);
    const unsearched = await appraisalRun(h, appraisal(), async (id) => {
      await service.recordAuthority(scope, {
        runId: id,
        resolver: resolver(),
        frontier: new CrossrefRevisionFrontier({ fetch: current }),
      });
      await service.recordChallenge(scope, { runId: id, search: search({ notSearched: true }) });
    });
    expect(unsearched.decided.aggregate.holdsByReason).toMatchObject({ challenge_missing: 2 });
  });
});

describe("reviewer grant -> adjudication -> exact-use decision (design §7, §9 K05 admission + review)", () => {
  async function reviewed(options: { judge?: boolean; expiresAt?: string | null } = {}) {
    const h = harness();
    const review = new ReviewService(h.binding, h.coordinator, clock);
    const run = await evidenceRun(h, {
      reportId: `report-review-${tick}`,
      task: { minimumRisk: "high" },
      judge: options.judge,
    });
    await run.seal();
    const decided = await run.decide({
      expiresAt: options.expiresAt ?? null,
      normalizedValues: { parameters: "7000000000" },
    });
    return { h, review, run, decided };
  }
  const admit = (
    h: ReturnType<typeof harness>,
    decisionId: string,
    extra: { effect?: string; epoch?: number; values?: Record<string, string> } = {},
  ) =>
    h.coordinator.admitExactUse(scope, {
      decisionId,
      boundEffectDigest: (extra.effect ?? digestBytes(`unset-${decisionId}`)) as Digest,
      processedEpoch: extra.epoch ?? 0,
      normalizedValuesDigest: normalizedValuesDigest(extra.values ?? { parameters: "7000000000" }),
    });

  it("requires a qualified, in-scope reviewer; the successor admits only the exact reviewed bindings", async () => {
    const { h, review, run, decided } = await reviewed();
    const decision = decided.decision;
    const effect = decision.boundEffectDigest;
    expect(decision.disposition).toBe("admitted");
    expect(decision.conditions).toContain("review_required");
    expect(await admit(h, decision.id, { effect })).toMatchObject({ outcome: "held", reason: "REVIEW_REQUIRED" });
    const input = {
      decisionRef: decided.ref,
      reviewer: "dr-okafor",
      outcome: "approve" as const,
      boundEffectDigest: effect,
      qualifiersDigest: null,
      rationale: "exact effect bytes reviewed",
    };
    // Wrong reviewer: no grant, then a grant whose scope does not cover the report kind.
    await expect(review.adjudicate(scope, input)).rejects.toThrow(/REVIEWER_NOT_QUALIFIED/);
    await review.grantReviewer(scope, {
      reviewerId: "dr-okafor",
      scope: { uses: ["*"], audiences: ["official"], reportKinds: ["study_appraisal"] },
      grantedBy: "owner",
    });
    await expect(review.adjudicate(scope, input)).rejects.toThrow(/REVIEWER_NOT_QUALIFIED/);
    // The reviewer must sign the decision's exact digests.
    await expect(
      review.adjudicate(scope, { ...input, boundEffectDigest: digestBytes("edited") }),
    ).rejects.toMatchObject({
      code: "REVIEW_BINDING_MISMATCH",
    });
    const grant = await review.grantReviewer(scope, {
      reviewerId: "dr-okafor",
      scope: { uses: [run.task.use], audiences: ["official"], reportKinds: ["evidence_report"] },
      grantedBy: "owner",
    });
    const adjudicated = await review.adjudicate(scope, input);
    expect(adjudicated.successor).toMatchObject({ disposition: "admitted", reviewer: adjudicated.adjudicationRef });
    expect(await admit(h, decision.id, { effect })).toMatchObject({ outcome: "held", reason: "STALE_DECISION" });
    expect(await admit(h, adjudicated.successor.id, { effect })).toMatchObject({ outcome: "admitted" });
    // Edited effect after review, normalized value mismatch.
    expect(await admit(h, adjudicated.successor.id, { effect: digestBytes("edited") })).toMatchObject({
      reason: "EFFECT_DIGEST_MISMATCH",
    });
    expect(await admit(h, adjudicated.successor.id, { effect, values: { parameters: "8000000000" } })).toMatchObject({
      outcome: "rejected",
      reason: "NORMALIZED_VALUES_MISMATCH",
    });
    // The review appended a signed decision snapshot to the sealed lineage (verified on load).
    const context = await h.binding.loadRunContext(scope, run.runId);
    expect(context.manifests.map((sealed) => sealed.manifest.snapshot)).toEqual([
      "verification_snapshot",
      "decision_snapshot",
    ]);
    // A revoked grant withdraws the authority at admission.
    await review.revokeGrant(scope, grant);
    expect(await admit(h, adjudicated.successor.id, { effect })).toMatchObject({
      outcome: "held",
      reason: "REVIEW_REQUIRED",
    });
    // An adjudicated decision is stale for a second review.
    await expect(review.adjudicate(scope, input)).rejects.toMatchObject({ code: "STALE_DECISION" });
  });

  it("approval cannot waive mechanics, and an expired or invalidated decision is refused", async () => {
    const { h, review, decided } = await reviewed({ judge: false });
    expect(decided.decision.disposition).toBe("held");
    await review.grantReviewer(scope, {
      reviewerId: "dr-okafor",
      scope: { uses: ["*"], audiences: ["*"], reportKinds: ["*"] },
      grantedBy: "owner",
    });
    const approved = await review.adjudicate(scope, {
      decisionRef: decided.ref,
      reviewer: "dr-okafor",
      outcome: "approve",
      boundEffectDigest: decided.decision.boundEffectDigest,
      qualifiersDigest: null,
      rationale: "approve",
    });
    expect(approved.successor.disposition).toBe("held");
    expect(await admit(h, approved.successor.id, { effect: decided.decision.boundEffectDigest })).toMatchObject({
      outcome: "held",
    });
    const expiring = await reviewed({ expiresAt: "2026-10-24T23:30:00Z" });
    await expiring.review.grantReviewer(scope, {
      reviewerId: "dr-okafor",
      scope: { uses: ["*"], audiences: ["*"], reportKinds: ["*"] },
      grantedBy: "owner",
    });
    const successor = await expiring.review.adjudicate(scope, {
      decisionRef: expiring.decided.ref,
      reviewer: "dr-okafor",
      outcome: "approve",
      boundEffectDigest: expiring.decided.decision.boundEffectDigest,
      qualifiersDigest: null,
      rationale: "approve",
    });
    expect(
      await admit(expiring.h, successor.successor.id, { effect: expiring.decided.decision.boundEffectDigest }),
    ).toMatchObject({
      outcome: "held",
      reason: "DECISION_EXPIRED",
    });
    expiring.h.binding.invalidated.add(successor.successor.id);
    expect(
      await admit(expiring.h, successor.successor.id, { effect: expiring.decided.decision.boundEffectDigest }),
    ).toMatchObject({
      outcome: "rejected",
      reason: "DECISION_INVALIDATED",
    });
  });

  it("stop during review: cancelling a waiting_review assessment leaves the decision held; an approval resumes", async () => {
    const { h, review, decided, run } = await reviewed();
    const service = new ReportAssessmentService({
      binding: h.binding,
      coordinator: h.coordinator,
      operations: h.binding.operations,
      auditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT),
      clock,
    });
    const reportRef = recordRef("report", run.registered.revision);
    const start = async (requestId: string) => {
      const handle = await service.start(scope, { runId: run.runId, reportRef, requestId });
      const queued = await h.binding.operations.get(scope, handle.operationId);
      const running = await h.binding.operations.transition(scope, {
        operationId: handle.operationId,
        expectedRevision: queued?.status.revision ?? 1,
        to: "running",
        at: clock.now(),
      });
      await h.binding.operations.transition(scope, {
        operationId: handle.operationId,
        expectedRevision: running.status.revision,
        to: "waiting_review",
        at: clock.now(),
        pendingReviewRef: fixtureRef(
          "adjudication",
          `adj-pending-${requestId}`,
          TENANT,
          BINDING,
          "research-core.adjudication.v1",
        ),
      });
      return handle;
    };
    const stopped = await start("req-stop");
    expect((await service.run(scope, stopped)).state).toBe("waiting_review");
    expect((await service.cancel(scope, stopped, "cancel-1")).state).toBe("cancelling");
    expect((await service.run(scope, stopped)).state).toBe("cancelled");
    expect(await admit(h, decided.decision.id, { effect: decided.decision.boundEffectDigest })).toMatchObject({
      outcome: "held",
      reason: "REVIEW_REQUIRED",
    });
    expect((await h.binding.loadDecision(scope, decided.decision.id))?.supersededBy).toBeNull();
    // A pending review that is approved resumes the operation (waiting_review -> running -> terminal).
    await review.grantReviewer(scope, {
      reviewerId: "dr-okafor",
      scope: { uses: ["*"], audiences: ["*"], reportKinds: ["*"] },
      grantedBy: "owner",
    });
    const adjudicated = await review.adjudicate(scope, {
      decisionRef: decided.ref,
      reviewer: "dr-okafor",
      outcome: "approve",
      boundEffectDigest: decided.decision.boundEffectDigest,
      qualifiersDigest: null,
      rationale: "approve",
    });
    const resumedHandle = await service.start(scope, { runId: run.runId, reportRef, requestId: "req-resume" });
    const queued = await h.binding.operations.get(scope, resumedHandle.operationId);
    const running = await h.binding.operations.transition(scope, {
      operationId: resumedHandle.operationId,
      expectedRevision: queued?.status.revision ?? 1,
      to: "running",
      at: clock.now(),
    });
    await h.binding.operations.transition(scope, {
      operationId: resumedHandle.operationId,
      expectedRevision: running.status.revision,
      to: "waiting_review",
      at: clock.now(),
      pendingReviewRef: adjudicated.adjudicationRef,
    });
    const resumed = await service.run(scope, resumedHandle);
    expect(["succeeded", "partial"]).toContain(resumed.state);
  });
});

describe("correction/revocation closure (design §7)", () => {
  it("invalidates dependent decisions at once, rechecks by appending observations, preserves unrelated branches", async () => {
    const h = harness({ authority: false });
    const corrections = new CorrectionService(h.binding, h.coordinator, clock);
    const affected = await evidenceRun(h, { reportId: "report-affected", suffix: "aff" });
    const unrelated = await evidenceRun(h, { reportId: "report-unrelated", suffix: "unr" });
    await affected.seal();
    await unrelated.seal();
    const d1 = (await affected.decide()).decision;
    const d2 = (await unrelated.decide()).decision;
    const admitAt = (decisionId: string, effect: string, epoch: number) =>
      h.coordinator.admitExactUse(scope, {
        decisionId,
        boundEffectDigest: effect as Digest,
        processedEpoch: epoch,
        normalizedValuesDigest: normalizedValuesDigest({}),
      });
    expect(await admitAt(d1.id, d1.boundEffectDigest, 0)).toMatchObject({ outcome: "admitted" });
    const closure = await corrections.recordCorrection(scope, {
      corrected: { kind: "fragment", id: affected.fragment.id },
      reason: "the model card was corrected",
      evaluator: { ...fixtureEvaluator("auditor", "corrections"), kind: "deterministic" },
      method: fixtureRef("method", "source-correction", TENANT, BINDING, "correction.v1"),
    });
    expect(closure.epoch).toBe(1);
    expect(closure.affected).toEqual(
      expect.arrayContaining([
        { kind: "support_set", id: affected.set.id },
        { kind: "assertion", id: affected.assertion.id },
        { kind: "report", id: affected.registered.revision.id },
        { kind: "use_decision", id: d1.id },
      ]),
    );
    expect(closure.affected.some((item) => item.id === d2.id || item.id === unrelated.set.id)).toBe(false);
    expect(await admitAt(d1.id, d1.boundEffectDigest, 1)).toMatchObject({
      outcome: "rejected",
      reason: "DECISION_INVALIDATED",
    });
    expect(await admitAt(d2.id, d2.boundEffectDigest, 0)).toMatchObject({
      outcome: "held",
      reason: "REVOCATION_EPOCH_STALE",
    });
    expect(await admitAt(d2.id, d2.boundEffectDigest, 1)).toMatchObject({ outcome: "admitted" });
    // The sealed affected run got a signed correction snapshot whose recheck observation now fails the premise.
    const context = await h.binding.loadRunContext(scope, affected.runId);
    expect(context.manifests.map((sealed) => sealed.manifest.snapshot)).toEqual([
      "verification_snapshot",
      "correction_snapshot",
    ]);
    expect(closure.rechecked).toHaveLength(1);
    const after = await affected.decide();
    expect(after.decision.id).not.toBe(d1.id);
    expect(after.decision.disposition).toBe("rejected");
    expect(after.aggregate.obligations[0]?.reasons).toContain("integrity_failure");
    const untouched = await h.binding.loadRunContext(scope, unrelated.runId);
    expect(untouched.manifests).toHaveLength(1);
  });
});

describe("framing sections are outside the factual census inventory (SV-09, design §3.2)", () => {
  it("records framing exclusions with reasons and explains auditor finds there; factual sections stay covered", async () => {
    const h = harness({ authority: false });
    const origin = fixtureOrigin(TENANT);
    const { runId } = await h.coordinator.openRun(scope, {
      task: { ...fixtureTask(TENANT, BINDING), id: "task-framing" },
      originatingOrigin: origin,
    });
    const fragment = { ...fixtureFragment(TENANT, BINDING), id: "frag-framing" };
    const assertion = { ...fixtureAssertion(TENANT, BINDING, origin), id: "asr-framing" };
    const set = { ...fixtureSupportSet(TENANT, BINDING, assertion, fragment), id: "ss-framing" };
    await h.coordinator.registerEvidence(scope, { fragments: [fragment], assertions: [assertion], supportSets: [set] });
    const registered = await h.coordinator.registerReport(scope, {
      runId,
      reportId: "report-framing",
      revision: 1,
      kind: KINDS.ref(scope, "evidence_report"),
      structuredBody: fixtureBody(assertion, fragment),
      assertions: [recordRef("assertion", assertion)],
      timeCoverage: { world: null, observed: null, knowledgeHead: null },
      supersedes: null,
    });
    // The auditor reads a limitation line as a fact: inside a framing section it is explained, not a hold.
    const script = {
      entries: [
        ...EVIDENCE_REPORT_SCRIPT.entries,
        { quote: "The license was not assessed.", assertionLogicalId: null },
      ],
    };
    const audited = await h.coordinator.auditReport(scope, { runId, auditor: new ScriptedAuditorDiscovery(script) });
    expect(audited.census.status).toBe("assessed");
    if (audited.census.status !== "assessed") throw new Error("fixture");
    expect(audited.census.holds).toEqual([]);
    expect(audited.census.outcome.reconciliation.unexplainedAuditorOnly).toEqual([]);
    expect(audited.census.outcome.reconciliation.explained.map((item) => item.reason)).toContain(
      "framing section limitations (kind-declared non-factual)",
    );
    // Units of a framing section become non-factual with the reason; findings units are untouched.
    const framed = withFramingExclusions(registered.frozen, ["scope", "evidence", "limitations"]);
    const findings = (units: typeof framed.units) => units.filter((unit) => unit.path.startsWith("findings"));
    expect(findings(framed.units)).toEqual(findings(registered.frozen.units));
    expect(framed.units.filter((unit) => unit.path.startsWith("limitations")).every((unit) => !unit.factual)).toBe(
      true,
    );
    // Without the framing declaration the same auditor find holds required coverage (OQ3 default).
    const without = await import("@aiengineer/knowledge-research-core").then((core) =>
      core.reconcileCensus(
        [],
        [
          {
            id: "x",
            body: { digest: "d" },
            blockPath: "limitations/l1/i0",
            span: { basis: "utf16-code-units-v1", start: 0, end: 4 },
            assertion: null,
          },
        ],
      ),
    );
    expect(without.ok && without.holdsRequiredCoverage).toBe(true);
  });
});

describe("idempotent registration (SV-09)", () => {
  it("re-registering an identical fragment or task returns the same ref; other bytes under the same id conflict", async () => {
    const h = harness({ authority: false });
    const fragment = { ...fixtureFragment(TENANT, BINDING), id: "frag-idem" };
    const first = await h.coordinator.registerEvidence(scope, { fragments: [fragment] });
    const again = await h.coordinator.registerEvidence(scope, { fragments: [fragment] });
    expect(again.fragments).toEqual(first.fragments);
    await expect(h.binding.putFragment(scope, { ...fragment, sourceVersion: "other" })).rejects.toThrow(
      /FRAGMENT_CONFLICT/,
    );
    const task = { ...fixtureTask(TENANT, BINDING), id: "task-idem" };
    expect(await h.binding.freezeTask(scope, task)).toEqual(await h.binding.freezeTask(scope, task));
    await expect(h.binding.freezeTask(scope, { ...task, audience: "internal" })).rejects.toThrow(/TASK_CONFLICT/);
    const assertion = { ...fixtureAssertion(TENANT, BINDING, fixtureOrigin(TENANT)), id: "asr-idem" };
    const assertionRef = await h.binding.putAssertion(scope, assertion);
    expect(await h.binding.putAssertion(scope, assertion)).toEqual(assertionRef);
    await expect(h.binding.putAssertion(scope, { ...assertion, proposition: "Other." })).rejects.toThrow(
      /ASSERTION_CONFLICT/,
    );
    const set = { ...fixtureSupportSet(TENANT, BINDING, assertion, fragment), id: "ss-idem" };
    const setRef = await h.binding.putSupportSet(scope, set);
    expect(await h.binding.putSupportSet(scope, set)).toEqual(setRef);
    await expect(
      h.binding.putSupportSet(scope, { ...set, contrary: [recordRef("fragment", fragment)] }),
    ).rejects.toThrow(/SUPPORT_SET_CONFLICT/);
  });
});
