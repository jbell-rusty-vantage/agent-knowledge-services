import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CorrectionService,
  ReportKindCatalog,
  ResearchCoordinator,
  ReviewService,
  ScriptedAuditorDiscovery,
  SourceAuthorityCatalog,
  StaticSealVerifier,
  testSealKeys,
} from "@aiengineer/knowledge-application";
import {
  EVIDENCE_REPORT_SCRIPT,
  FIXTURE_SEAL_KEYS,
  fixtureAssertion,
  fixtureBody,
  fixtureEvaluator,
  fixtureFragment,
  fixtureOrigin,
  fixtureRef,
  fixtureSupportObservation,
  fixtureSupportSet,
  fixtureTask,
} from "@aiengineer/knowledge-application/testing";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import { type Digest, digestBytes } from "@aiengineer/knowledge-operation-protocol";
import {
  type AssertionVersion,
  type AuthScope,
  type EvidenceFragment,
  type VerificationTaskContract,
  normalizedValuesDigest,
  qualifiersDigest,
  recordRef,
} from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComponentDatabase } from "./client.js";
import { PostgresResearchBinding } from "./research-binding.js";
import { pinSealSigningKey, setSealSigningKeyStatus } from "./seal-keys.js";

/**
 * SV-07 over the real component (2.2.0) on a disposable PostgreSQL 17 database: K07 Ed25519 seals verified before the
 * CAS and on every load (tampered manifest bytes / family bytes refuse), reviewer grant -> adjudication -> successor
 * decision with scoped grants enforced by SQL, and correction closure over dependency_edge.
 */
const ADMIN = process.env.KS_AIENG_DB_ADMIN_DSN;
const describeDb = ADMIN ? describe : describe.skip;
const TENANT = "00000000-0000-7000-8000-0000000000aa";
const BINDING = "aiengineer-postgres";
const here = dirname(fileURLToPath(import.meta.url));
const KINDS = ReportKindCatalog.fromDirectory(resolve(here, "../../../../catalog/research/report-kinds"));
const AUTHORITY = SourceAuthorityCatalog.fromDirectory(resolve(here, "../../../../catalog/research/source-authority"));
let tick = 0;
const clock = {
  now: () =>
    `2026-10-24T22:${String(Math.floor(tick / 60) % 60).padStart(2, "0")}:${String(tick++ % 60).padStart(2, "0")}Z`,
};

describeDb("SV-07 seals, review and correction over the PostgreSQL binding", () => {
  const database = `kv7_${randomBytes(4).toString("hex")}`;
  let db: ComponentDatabase;
  let binding: PostgresResearchBinding;
  let coordinator: ResearchCoordinator;
  const dsn = () => {
    const url = new URL(ADMIN as string);
    url.pathname = `/${database}`;
    return url.toString();
  };
  const scope: AuthScope = {
    tenant: TENANT,
    application: "ai-engineer",
    binding: BINDING,
    origin: fixtureOrigin(TENANT),
    grants: ["research.write"],
  };
  /** Superuser edits that bypass RLS and the immutability triggers: how an attacker with DB access would tamper. */
  const tamper = async (sql: string, values: unknown[]) => {
    const client = new Client({ connectionString: dsn() });
    await client.connect();
    try {
      await client.query("set session_replication_role = replica");
      await client.query(sql, values);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.end();
    const receipt = await install(loadComponent(), {
      adminDsn: dsn(),
      installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
      applicationId: "ai-engineer",
      binding: BINDING,
    });
    expect(receipt.componentVersion).toBe("2.5.0");
    await pinSealSigningKey(dsn(), { keyId: FIXTURE_SEAL_KEYS.signer.keyId, publicKey: FIXTURE_SEAL_KEYS.publicKey });
    db = new ComponentDatabase({ connectionString: dsn() });
    binding = new PostgresResearchBinding(db, BINDING, { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
    coordinator = new ResearchCoordinator(binding, clock, KINDS, {
      signer: FIXTURE_SEAL_KEYS.signer,
      authority: AUTHORITY,
    });
  });

  afterAll(async () => {
    await db?.end();
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  async function evidenceRun(suffix: string, task: Partial<VerificationTaskContract> = {}, judge = true) {
    const origin = fixtureOrigin(TENANT);
    const fullTask = { ...fixtureTask(TENANT, BINDING), id: `task-${suffix}`, ...task };
    const { runId } = await coordinator.openRun(scope, { task: fullTask, originatingOrigin: origin });
    const fragment: EvidenceFragment = {
      ...fixtureFragment(TENANT, BINDING),
      id: `frag-${suffix}`,
      capture: fixtureRef("artifact", `capture-${suffix}`, TENANT, BINDING, "artifact.v1"),
      selectedDigest: digestBytes(`7B parameters ${suffix}`),
    };
    const assertion: AssertionVersion = { ...fixtureAssertion(TENANT, BINDING, origin), id: `asr-${suffix}` };
    const set = { ...fixtureSupportSet(TENANT, BINDING, assertion, fragment), id: `ss-${suffix}` };
    await coordinator.registerEvidence(scope, { fragments: [fragment], assertions: [assertion], supportSets: [set] });
    const registered = await coordinator.registerReport(scope, {
      runId,
      reportId: `report-${suffix}`,
      revision: 1,
      kind: KINDS.ref(scope, "evidence_report"),
      structuredBody: fixtureBody(assertion, fragment),
      assertions: [recordRef("assertion", assertion)],
      timeCoverage: { world: null, observed: null, knowledgeHead: null },
      supersedes: null,
    });
    if (judge) {
      await coordinator.observe(
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
    await coordinator.auditReport(scope, { runId, auditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT) });
    const seal = () =>
      coordinator.sealVerificationSnapshot(scope, {
        runId,
        build: { buildId: "build-sv07", runtime: "node24", dirty: true },
        signer: "ks-sealer",
      });
    const decide = () =>
      coordinator.decideReportUse(scope, {
        runId,
        use: fullTask.use,
        audience: "official",
        boundEffectDigest: digestBytes(`effect-${suffix}`),
        targetSchema: "aiengineer-database-contract.v1",
        normalizedValues: {},
        policy: fullTask.policy,
        rubric: fullTask.rubric,
      });
    return { runId, fragment, assertion, set, registered, seal, decide };
  }

  const admit = (decisionId: string, effect: string, processedEpoch = 0) =>
    coordinator.admitExactUse(scope, {
      decisionId,
      boundEffectDigest: effect as Digest,
      processedEpoch,
      normalizedValuesDigest: normalizedValuesDigest({}),
    });

  it("stores the Ed25519 seal, verifies it on every load and refuses tampered manifest or family bytes", async () => {
    const run = await evidenceRun("tamper");
    const { sealed } = await run.seal();
    const loaded = await binding.loadRunContext(scope, run.runId);
    expect(loaded.manifests).toHaveLength(1);
    expect(loaded.manifests[0]?.seal).toEqual(sealed.seal);
    // Tampered manifest bytes in the database.
    await tamper(
      "update knowledge_verification.run_manifest set manifest = jsonb_set(manifest, '{createdAt}', '\"2026-10-24T23:59:59Z\"') where run_id = $1::uuid",
      [run.runId],
    );
    await expect(binding.loadRunContext(scope, run.runId)).rejects.toMatchObject({ code: "SEAL_INVALID" });
    await tamper("update knowledge_verification.run_manifest set manifest = $2::jsonb where run_id = $1::uuid", [
      run.runId,
      JSON.stringify(sealed.manifest),
    ]);
    expect((await binding.loadRunContext(scope, run.runId)).manifests).toHaveLength(1);
    // Swapped key id (the key id is covered by the signature; the SQL FK only accepts pinned keys).
    const other = testSealKeys("ks-other-key", "other");
    await pinSealSigningKey(dsn(), { keyId: "ks-other-key", publicKey: other.publicKey });
    await tamper(
      "update knowledge_verification.run_manifest set signing_key_id = 'ks-other-key' where run_id = $1::uuid",
      [run.runId],
    );
    await expect(binding.loadRunContext(scope, run.runId)).rejects.toMatchObject({ code: "SEAL_INVALID" });
    await tamper("update knowledge_verification.run_manifest set signing_key_id = $2 where run_id = $1::uuid", [
      run.runId,
      FIXTURE_SEAL_KEYS.signer.keyId,
    ]);
    // Tampered family bytes in custody.
    const observations = sealed.manifest.families.find((family) => family.family === "observations");
    await tamper(
      "update knowledge_verification.artifact_custody set inline_bytes = $2::bytea, byte_length = octet_length($2::bytea) where artifact_id = $1",
      [observations?.ref.id, Buffer.from("[]")],
    );
    await expect(binding.loadRunContext(scope, run.runId)).rejects.toMatchObject({ code: "FAMILY_TAMPERED" });
  });

  it("revoking a key in the SQL registry stops its old seals from loading (one revocation authority, R1 F7)", async () => {
    const revocable = testSealKeys("ks-revocable", "revocable");
    await pinSealSigningKey(dsn(), { keyId: "ks-revocable", publicKey: revocable.publicKey });
    // The binding pins both keys as active in TS: only the SQL registry changes below.
    const verifier = new StaticSealVerifier([
      { keyId: FIXTURE_SEAL_KEYS.signer.keyId, publicKey: FIXTURE_SEAL_KEYS.publicKey, status: "active" },
      { keyId: "ks-revocable", publicKey: revocable.publicKey, status: "active" },
    ]);
    const pinnedBoth = new PostgresResearchBinding(db, BINDING, { sealVerifier: verifier });
    const sealer = new ResearchCoordinator(pinnedBoth, clock, KINDS, {
      signer: revocable.signer,
      authority: AUTHORITY,
    });
    const run = await evidenceRun("revocable");
    const { sealed } = await sealer.sealVerificationSnapshot(scope, {
      runId: run.runId,
      build: { buildId: "build-sv07", runtime: "node24", dirty: true },
      signer: "ks-sealer",
    });
    expect(sealed.seal.keyId).toBe("ks-revocable");
    expect((await pinnedBoth.loadRunContext(scope, run.runId)).manifests).toHaveLength(1);
    // Retiring still verifies old seals.
    await setSealSigningKeyStatus(dsn(), "ks-revocable", "retiring");
    expect((await pinnedBoth.loadRunContext(scope, run.runId)).manifests).toHaveLength(1);
    // Revoked in SQL: refused although the TS pin still says active.
    await setSealSigningKeyStatus(dsn(), "ks-revocable", "revoked");
    await expect(pinnedBoth.loadRunContext(scope, run.runId)).rejects.toMatchObject({ code: "SEAL_INVALID" });
    // Seals under other keys are unaffected.
    const unaffected = await evidenceRun("revocable-other");
    await unaffected.seal();
    expect((await pinnedBoth.loadRunContext(scope, unaffected.runId)).manifests).toHaveLength(1);
  });

  it("refuses an unknown key, an importer replay and a cross-run replay; concurrent seals commit one head", async () => {
    const rogue = testSealKeys("ks-rogue", "rogue");
    const rogueCoordinator = new ResearchCoordinator(binding, clock, KINDS, { signer: rogue.signer });
    const run = await evidenceRun("replay");
    await expect(
      rogueCoordinator.sealVerificationSnapshot(scope, {
        runId: run.runId,
        build: { buildId: "b", runtime: "node24", dirty: true },
        signer: "ks-sealer",
      }),
    ).rejects.toMatchObject({ code: "SEAL_INVALID" });
    const results = await Promise.allSettled([run.seal(), run.seal()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("fixture");
    const { sealed } = winner.value;
    const context = await binding.loadRunContext(scope, run.runId);
    if (context.run === null) throw new Error("fixture");
    // Importer replay of the exact sealed bytes over the committed head.
    await expect(
      binding.seal(scope, {
        runId: run.runId,
        run: context.run,
        manifest: sealed.manifest,
        seal: sealed.seal,
        expectedHead: null,
      }),
    ).rejects.toThrow(/HEAD_MISMATCH/);
    // Replay into another run: the manifest names its own run.
    const other = await evidenceRun("replay-other");
    await expect(
      binding.seal(scope, {
        runId: other.runId,
        run: { ...context.run, id: other.runId },
        manifest: sealed.manifest,
        seal: sealed.seal,
        expectedHead: null,
      }),
    ).rejects.toThrow(/RUN_LINK_MISMATCH/);
  });

  it("reviewer grant -> adjudication -> successor decision: scope, exact digests, stale original, revoked grant", async () => {
    const review = new ReviewService(binding, coordinator, clock);
    const run = await evidenceRun("review", { minimumRisk: "high" });
    await run.seal();
    const decided = await run.decide();
    const effect = decided.decision.boundEffectDigest;
    expect(decided.decision.conditions).toContain("review_required");
    expect(await admit(decided.decision.id, effect)).toMatchObject({ outcome: "held", reason: "REVIEW_REQUIRED" });
    const input = {
      decisionRef: decided.ref,
      reviewer: "dr-okafor",
      outcome: "approve" as const,
      boundEffectDigest: effect,
      qualifiersDigest: null,
      rationale: "exact effect bytes reviewed",
    };
    await expect(review.adjudicate(scope, input)).rejects.toThrow(/REVIEWER_NOT_QUALIFIED/);
    await review.grantReviewer(scope, {
      reviewerId: "dr-okafor",
      scope: { uses: ["*"], audiences: ["official"], reportKinds: ["study_appraisal"] },
      grantedBy: "owner",
    });
    await expect(review.adjudicate(scope, input)).rejects.toThrow(/REVIEWER_NOT_QUALIFIED/);
    const grant = await review.grantReviewer(scope, {
      reviewerId: "dr-okafor",
      scope: {
        uses: ["knowledge_ingestion.fact_assert_state"],
        audiences: ["official"],
        reportKinds: ["evidence_report"],
      },
      grantedBy: "owner",
    });
    const adjudicated = await review.adjudicate(scope, input);
    expect(adjudicated.successor.disposition).toBe("admitted");
    expect(await admit(decided.decision.id, effect)).toMatchObject({ outcome: "held", reason: "STALE_DECISION" });
    expect(await admit(adjudicated.successor.id, effect)).toMatchObject({ outcome: "admitted" });
    expect(await admit(adjudicated.successor.id, digestBytes("edited"))).toMatchObject({
      reason: "EFFECT_DIGEST_MISMATCH",
    });
    const lineage = await binding.loadRunContext(scope, run.runId);
    expect(lineage.manifests.map((sealed) => sealed.manifest.snapshot)).toEqual([
      "verification_snapshot",
      "decision_snapshot",
    ]);
    expect(await binding.loadAdjudication(scope, adjudicated.adjudication.id)).toEqual(adjudicated.adjudication);
    await review.revokeGrant(scope, grant);
    expect(await admit(adjudicated.successor.id, effect)).toMatchObject({ outcome: "held", reason: "REVIEW_REQUIRED" });
  });

  it("approval cannot waive mechanics: a held decision stays held after approval", async () => {
    const review = new ReviewService(binding, coordinator, clock);
    const run = await evidenceRun("mechanics", { minimumRisk: "high" }, false);
    await run.seal();
    const decided = await run.decide();
    expect(decided.decision.disposition).toBe("held");
    await review.grantReviewer(scope, {
      reviewerId: "dr-wild",
      scope: { uses: ["*"], audiences: ["*"], reportKinds: ["*"] },
      grantedBy: "owner",
    });
    const approved = await review.adjudicate(scope, {
      decisionRef: decided.ref,
      reviewer: "dr-wild",
      outcome: "approve",
      boundEffectDigest: decided.decision.boundEffectDigest,
      qualifiersDigest: null,
      rationale: "approve",
    });
    expect(approved.successor.disposition).toBe("held");
    expect(await admit(approved.successor.id, decided.decision.boundEffectDigest)).toMatchObject({ outcome: "held" });
  });

  it("re-registering an identical fragment or task is idempotent; other bytes under the same id refuse typed", async () => {
    const fragment: EvidenceFragment = { ...fixtureFragment(TENANT, BINDING), id: "frag-idem-pg" };
    const first = await binding.putFragment(scope, fragment);
    expect(await binding.putFragment(scope, fragment)).toEqual(first);
    await expect(binding.putFragment(scope, { ...fragment, sourceVersion: "other" })).rejects.toThrow(
      /FRAGMENT_CONFLICT/,
    );
    const task = { ...fixtureTask(TENANT, BINDING), id: "task-idem-pg" };
    expect(await binding.freezeTask(scope, task)).toEqual(await binding.freezeTask(scope, task));
    await expect(binding.freezeTask(scope, { ...task, audience: "internal" })).rejects.toThrow(/TASK_CONFLICT/);
    const assertion: AssertionVersion = {
      ...fixtureAssertion(TENANT, BINDING, fixtureOrigin(TENANT)),
      id: "asr-idem-pg",
    };
    const assertionRef = await binding.putAssertion(scope, assertion);
    expect(await binding.putAssertion(scope, assertion)).toEqual(assertionRef);
    await expect(
      binding.putAssertion(scope, { ...assertion, proposition: "Model X has 8B parameters." }),
    ).rejects.toThrow(/ASSERTION_CONFLICT/);
    const set = { ...fixtureSupportSet(TENANT, BINDING, assertion, fragment), id: "ss-idem-pg" };
    const setRef = await binding.putSupportSet(scope, set);
    expect(await binding.putSupportSet(scope, set)).toEqual(setRef);
    await expect(binding.putSupportSet(scope, { ...set, contrary: [recordRef("fragment", fragment)] })).rejects.toThrow(
      /SUPPORT_SET_CONFLICT/,
    );
  });

  it("correction closure over dependency_edge invalidates dependents at once and preserves unrelated branches", async () => {
    const corrections = new CorrectionService(binding, coordinator, clock);
    const affected = await evidenceRun("aff");
    const unrelated = await evidenceRun("unr");
    await affected.seal();
    await unrelated.seal();
    const d1 = (await affected.decide()).decision;
    const d2 = (await unrelated.decide()).decision;
    const before = await binding.currentEpoch(scope);
    expect(await admit(d1.id, d1.boundEffectDigest, before)).toMatchObject({ outcome: "admitted" });
    const closure = await corrections.recordCorrection(scope, {
      corrected: { kind: "fragment", id: affected.fragment.id },
      reason: "the model card was corrected",
      evaluator: { ...fixtureEvaluator("auditor", "corrections"), kind: "deterministic" },
      method: fixtureRef("method", "source-correction", TENANT, BINDING, "correction.v1"),
    });
    expect(closure.epoch).toBe(before + 1);
    expect(closure.affected).toEqual(
      expect.arrayContaining([
        { kind: "support_set", id: affected.set.id },
        { kind: "assertion", id: affected.assertion.id },
        { kind: "report", id: affected.registered.revision.id },
        { kind: "use_decision", id: d1.id },
      ]),
    );
    expect(closure.affected.some((item) => item.id === d2.id)).toBe(false);
    expect(await admit(d1.id, d1.boundEffectDigest, closure.epoch)).toMatchObject({
      outcome: "rejected",
      reason: "DECISION_INVALIDATED",
    });
    expect(await admit(d2.id, d2.boundEffectDigest, before)).toMatchObject({
      outcome: "held",
      reason: "REVOCATION_EPOCH_STALE",
    });
    expect(await admit(d2.id, d2.boundEffectDigest, closure.epoch)).toMatchObject({ outcome: "admitted" });
    const context = await binding.loadRunContext(scope, affected.runId);
    expect(context.manifests.map((sealed) => sealed.manifest.snapshot)).toEqual([
      "verification_snapshot",
      "correction_snapshot",
    ]);
    const after = await affected.decide();
    expect(after.decision.disposition).toBe("rejected");
    expect((await binding.loadRunContext(scope, unrelated.runId)).manifests).toHaveLength(1);
  });
});
