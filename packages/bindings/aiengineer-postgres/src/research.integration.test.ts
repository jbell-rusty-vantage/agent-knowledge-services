import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReportKindCatalog, ResearchCoordinator } from "@aiengineer/knowledge-application";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import { type Digest, bindEffect as bindEffectBinding, digestBytes } from "@aiengineer/knowledge-operation-protocol";
import { admitExactUseWithin, bindExactEffect, evaluateExactUse } from "@aiengineer/knowledge-db";
import {
  type AuthScope,
  normalizedValuesDigest,
  qualifiersDigest,
  recordRef,
  safeInteger,
} from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComponentDatabase } from "./client.js";
import {
  AT,
  fixtureAssertion,
  fixtureBody,
  fixtureFragment,
  fixtureOrigin,
  fixtureRef,
  fixtureSupportObservation,
  fixtureSupportSet,
  fixtureTask,
  FIXTURE_SEAL_KEYS,
} from "@aiengineer/knowledge-application/testing";
import { PostgresResearchBinding } from "./research-binding.js";
import { pinSealSigningKey } from "./seal-keys.js";
import { lookupEffectReceipt, recordEffectReceipt } from "./stores.js";

/**
 * T1-KS: the first complete evidence -> assertion -> verification -> seal -> decision -> exact-use admission ->
 * receipt fixture over the real component in a disposable database (SPRINT-V-PLAN W2 exit proof, engineering data).
 */
const ADMIN = process.env.KNOWLEDGE_DB_CONTRACT_ADMIN_DSN;
const describeDb = ADMIN ? describe : describe.skip;
const TENANT = "00000000-0000-7000-8000-0000000000aa";
const BINDING = "aiengineer-postgres";

describeDb("research coordinator over the PostgreSQL binding", () => {
  const database = `kvr_${randomBytes(4).toString("hex")}`;
  let db: ComponentDatabase;
  const dsn = () => {
    const url = new URL(ADMIN as string);
    url.pathname = `/${database}`;
    return url.toString();
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.end();
    await install(loadComponent(), {
      adminDsn: dsn(),
      installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
      applicationId: "ai-engineer",
      binding: BINDING,
    });
    await pinSealSigningKey(dsn(), { keyId: FIXTURE_SEAL_KEYS.signer.keyId, publicKey: FIXTURE_SEAL_KEYS.publicKey });
    db = new ComponentDatabase({ connectionString: dsn() });
  });

  afterAll(async () => {
    await db?.end();
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  it("runs the complete fixture: register, observe, seal, decide, admit in the native transaction, receipt", async () => {
    const origin = fixtureOrigin(TENANT);
    const scope: AuthScope = {
      tenant: TENANT,
      application: "ai-engineer",
      binding: BINDING,
      origin,
      grants: ["research.write"],
    };
    const binding = new PostgresResearchBinding(db, BINDING, { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
    const kinds = ReportKindCatalog.fromDirectory(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/report-kinds"),
    );
    const coordinator = new ResearchCoordinator(binding, { now: () => AT }, kinds, {
      signer: FIXTURE_SEAL_KEYS.signer,
    });

    const { runId } = await coordinator.openRun(scope, {
      task: fixtureTask(TENANT, BINDING),
      originatingOrigin: origin,
    });
    const fragment = fixtureFragment(TENANT, BINDING);
    const assertion = fixtureAssertion(TENANT, BINDING, origin);
    const set = fixtureSupportSet(TENANT, BINDING, assertion, fragment);
    await coordinator.registerEvidence(scope, { fragments: [fragment], assertions: [assertion], supportSets: [set] });
    const registered = await coordinator.registerReport(scope, {
      runId,
      reportId: "report-sv05",
      revision: 1,
      kind: kinds.ref(scope, "evidence_report"),
      structuredBody: fixtureBody(assertion, fragment),
      assertions: [recordRef("assertion", assertion)],
      timeCoverage: { world: null, observed: { from: AT, to: AT }, knowledgeHead: null },
      supersedes: null,
    });
    // Custody holds the exact frozen bytes.
    expect(await binding.custody.verify(scope, registered.revision.body)).toBe(true);
    const context = await binding.loadRunContext(scope, runId);
    expect(context.state).toBe("observing");
    expect(context.occurrences).toHaveLength(1);
    expect(context.supportSets).toHaveLength(1);

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
    await coordinator.observe(
      scope,
      runId,
      fixtureSupportObservation({
        tenant: TENANT,
        binding: BINDING,
        id: "obs-judge",
        set,
        fragment,
        role: "judge",
        verdict: "full_support",
        qualifiersDigest: qd,
      }),
    );
    const { sealed, run } = await coordinator.sealVerificationSnapshot(scope, {
      runId,
      build: { buildId: "build-sv05", runtime: "node24", dirty: true },
      signer: "ks-sealer",
    });
    expect((await binding.loadRunContext(scope, runId)).head).toBe(sealed.seal.manifestDigest);
    expect(sealed.manifest.run.digest).toBe(run.digest);

    // The exact effect: native intent bytes bound to the originating origin (K01), admitted and received in one transaction.
    const payload = Buffer.from(
      '{"schemaVersion":"knowledge-ingestion-intent.v1","proposals":[{"kind":"fact.assert_state"}]}',
    );
    const effect = bindEffectBinding({
      effectKey: "effect-sv05-apply",
      nativePayload: payload,
      originatingOrigin: origin,
    });
    const effectDigest = effect.boundEffectDigest as Digest;
    const decided = await coordinator.decideAssertionUse(scope, {
      runId,
      assertion: recordRef("assertion", assertion),
      use: "knowledge_ingestion.fact_assert_state",
      audience: "official",
      boundEffectDigest: effectDigest,
      targetSchema: "aiengineer-database-contract.v1",
      normalizedValues: { parameters: safeInteger(7000000000) },
      policy: fixtureRef("policy", "policy-ai-engineer", TENANT, BINDING, "research-policy.ai-engineer.v2"),
      rubric: fixtureRef("rubric", "rubric-engineering", TENANT, BINDING, "research-rubric.engineering.v2"),
    });
    expect(decided.decision.disposition).toBe("admitted");

    const normalized = normalizedValuesDigest({ parameters: 7000000000 });
    // ONE admission code path (knowledge-db exact-use-admission) on the native transaction's own client: bind,
    // admit under the epoch lock, write, receipt, commit together.
    // This database is the ai-engineer installation WITHOUT the AIDB projection: native admission refuses
    // AIDB_GUARD_REQUIRED (never a silent component-only fallback) and the whole transaction rolls back.
    await expect(
      db.transaction({ tenantId: TENANT, role: "knowledge_verification_writer" }, (c) =>
        admitExactUseWithin(
          c,
          TENANT,
          {
            useDecisionId: decided.decision.id,
            boundEffectDigest: effectDigest,
            processedEpoch: 0,
            normalizedValuesDigest: normalized,
          },
          {
            effect: {
              effectKey: effect.effectKey,
              semanticPayloadDigest: effect.semanticPayloadDigest,
              originatingOrigin: origin,
            },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "AIDB_GUARD_REQUIRED" });
    expect(
      await db.transaction(
        { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
        async (c) =>
          (
            await c.query("select count(*)::int n from knowledge_verification.effect where effect_key = $1", [
              effect.effectKey,
            ])
          ).rows[0]?.n,
      ),
    ).toBe(0);
    // The component-only diagnostic check (the same module) still answers, and the receipt is recorded under it.
    const receipt = await db.transaction({ tenantId: TENANT, role: "knowledge_verification_writer" }, async (c) => {
      await bindExactEffect(
        c,
        TENANT,
        { effectKey: effect.effectKey, semanticPayloadDigest: effect.semanticPayloadDigest, originatingOrigin: origin },
        effectDigest,
      );
      const admitted = await evaluateExactUse(c, TENANT, {
        useDecisionId: decided.decision.id,
        boundEffectDigest: effectDigest,
        processedEpoch: 0,
        normalizedValuesDigest: normalized,
      });
      expect(admitted).toMatchObject({ outcome: "admitted", reason: "OK" });
      // the AI Engineer domain write (temporal.begin_batch/assert_*/commit_batch) happens here in the real executor
      return recordEffectReceipt(c, TENANT, {
        effectKey: effect.effectKey,
        outcome: "applied",
        nativeReceiptRef: { table: "orchestration.operation_receipt", id: "native-sv05" },
        processedEpoch: 0,
        useDecisionId: decided.decision.id,
      });
    });
    expect(receipt.outcome).toBe("applied");
    expect(
      await coordinator.admitExactUse(scope, {
        decisionId: decided.decision.id,
        boundEffectDigest: effectDigest,
        processedEpoch: 0,
        normalizedValuesDigest: normalized,
      }),
    ).toMatchObject({ outcome: "admitted", reason: "OK" });
    const lookup = await db.transaction(
      { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
      (c) => lookupEffectReceipt(c, TENANT, effect.effectKey),
    );
    expect(lookup?.digest).toBe(receipt.digest);
    // An edited effect under the same decision is refused by the oracle.
    expect(
      await coordinator.admitExactUse(scope, {
        decisionId: decided.decision.id,
        boundEffectDigest: digestBytes("edited bytes"),
        processedEpoch: 0,
        normalizedValuesDigest: normalized,
      }),
    ).toMatchObject({ outcome: "rejected", reason: "EFFECT_DIGEST_MISMATCH" });
    // A normalized value mismatch is refused by the component (2.2.0).
    expect(
      await coordinator.admitExactUse(scope, {
        decisionId: decided.decision.id,
        boundEffectDigest: effectDigest,
        processedEpoch: 0,
        normalizedValuesDigest: normalizedValuesDigest({ parameters: 8000000000 }),
      }),
    ).toMatchObject({ outcome: "rejected", reason: "NORMALIZED_VALUES_MISMATCH" });
  });
});
