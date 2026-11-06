import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OperationStoreError,
  ReportAssessmentService,
  ReportKindCatalog,
  ResearchCoordinator,
  ScriptedAuditorDiscovery,
  systemClock,
} from "@aiengineer/knowledge-application";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import { OPERATION_STATES, canTransition, digestBytes } from "@aiengineer/knowledge-operation-protocol";
import { type AuthScope, recordRef } from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComponentDatabase } from "./client.js";
import {
  AT,
  EVIDENCE_REPORT_SCRIPT,
  fixtureAssertion,
  fixtureBody,
  fixtureFragment,
  fixtureOrigin,
  fixtureRef,
  fixtureTask,
  reportKindCases,
  reportKindRoundTrip,
  FIXTURE_SEAL_KEYS,
} from "@aiengineer/knowledge-application/testing";
import { PostgresResearchBinding } from "./research-binding.js";
import { pinSealSigningKey } from "./seal-keys.js";

/**
 * SV-06 over the real component (2.1.0) in a disposable database: both K08 report kinds round-trip through the
 * independent census and the durable `report.assess` operation; operation compare-and-set under concurrency; the
 * atomic, deterministic seal under failure injection and concurrency. Engineering fixtures only.
 */
const ADMIN = process.env.KNOWLEDGE_DB_CONTRACT_ADMIN_DSN;
const describeDb = ADMIN ? describe : describe.skip;
const TENANT = "00000000-0000-7000-8000-0000000000aa";
const OTHER_TENANT = "00000000-0000-7000-8000-0000000000bb";
const BINDING = "aiengineer-postgres";
const KINDS = ReportKindCatalog.fromDirectory(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../catalog/research/report-kinds"),
);

function scopeFor(tenant: string): AuthScope {
  return {
    tenant,
    application: "ai-engineer",
    binding: BINDING,
    origin: fixtureOrigin(tenant),
    grants: ["research.write"],
  };
}

describeDb("SV-06 report assessment over the PostgreSQL binding", () => {
  const database = `kvs6_${randomBytes(4).toString("hex")}`;
  let db: ComponentDatabase;
  let binding: PostgresResearchBinding;
  const scope = scopeFor(TENANT);
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
    const receipt = await install(loadComponent(), {
      adminDsn: dsn(),
      installationId: "0192a4f0-0000-7000-8000-0000000a1e00",
      applicationId: "ai-engineer",
      binding: BINDING,
    });
    await pinSealSigningKey(dsn(), { keyId: FIXTURE_SEAL_KEYS.signer.keyId, publicKey: FIXTURE_SEAL_KEYS.publicKey });
    expect(receipt.componentVersion).toBe("2.5.0");
    db = new ComponentDatabase({ connectionString: dsn() });
    binding = new PostgresResearchBinding(db, BINDING, { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
  });

  afterAll(async () => {
    await db?.end();
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  it.each(["evidence_report", "study_appraisal"] as const)(
    "round-trips %s: register -> freeze -> ledger -> audit -> aggregate -> decide",
    async (kindId) => {
      const kase = reportKindCases(TENANT, BINDING, scope.origin).find((candidate) => candidate.kindId === kindId);
      if (kase === undefined) throw new Error("fixture");
      const result = await reportKindRoundTrip({
        scope,
        binding,
        operations: binding.operations,
        kinds: KINDS,
        kase,
        clock: { now: () => AT },
      });
      expect(result.queued).toMatchObject({ state: "queued", revision: 1, retryAfterMs: 1000 });
      expect(result.assessed).toMatchObject({ state: "partial", revision: 3, retryAfterMs: null });
      expect(result.decided.census).toMatchObject({ status: "assessed", holds: [] });
      expect(result.decided.decision.disposition).toBe("admitted");
      const rows = await db.transaction(
        { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
        (c) =>
          c.query<{
            report_kind: string;
            report_kind_ref_id: string;
            report_kind_version: string;
            report_kind_digest: string;
            outcome: string;
            census_status: string;
            census_role: string;
          }>(
            `select rr.report_kind, rr.report_kind_ref_id, rr.report_kind_version, rr.report_kind_digest,
                  ra.outcome, ra.census_status, o.evaluator_role as census_role
             from knowledge_verification.report_revision rr
             join knowledge_verification.report_assessment ra on ra.tenant_id = rr.tenant_id and ra.report_revision_id = rr.report_revision_id
             join knowledge_verification.observation o on o.tenant_id = ra.tenant_id and o.observation_id = ra.census_observation_id
            where rr.tenant_id = $1 and rr.run_id = $2::uuid`,
            [TENANT, result.runId],
          ),
      );
      const kindRef = KINDS.ref(scope, kindId);
      expect(rows.rows).toEqual([
        {
          report_kind: kindId,
          report_kind_ref_id: `${kindId}@1.0.0`,
          report_kind_version: "1.0.0",
          report_kind_digest: kindRef.digest,
          outcome: "partial",
          census_status: "assessed",
          census_role: "auditor",
        },
      ]);
    },
  );

  it("the component's operation transition table equals K01's for every state pair", async () => {
    const pairs = OPERATION_STATES.flatMap((from) => OPERATION_STATES.map((to) => [from, to] as const));
    const result = await db.transaction(
      { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
      (c) =>
        c.query<{ from_state: string; to_state: string; allowed: boolean }>(
          `select f as from_state, t as to_state, knowledge_verification.operation_transition_allowed(f, t) as allowed
           from unnest($1::text[], $2::text[]) as p(f, t)`,
          [pairs.map(([from]) => from), pairs.map(([, to]) => to)],
        ),
    );
    for (const row of result.rows) {
      expect([row.from_state, row.to_state, row.allowed]).toEqual([
        row.from_state,
        row.to_state,
        canTransition(row.from_state as never, row.to_state as never),
      ]);
    }
    expect(result.rows).toHaveLength(OPERATION_STATES.length ** 2);
  });

  /** Fragments/assertions are tenant-wide immutable records shared by these cases: register each once. */
  async function ensureEvidence(
    coordinator: ResearchCoordinator,
    fragment: ReturnType<typeof fixtureFragment>,
    assertion: ReturnType<typeof fixtureAssertion>,
  ) {
    await coordinator.registerEvidence(scope, { fragments: [fragment] }).catch(() => undefined);
    await coordinator.registerEvidence(scope, { assertions: [assertion] }).catch(() => undefined);
  }

  async function startedOperation(requestId: string) {
    const coordinator = new ResearchCoordinator(binding, { now: () => AT }, KINDS, {
      signer: FIXTURE_SEAL_KEYS.signer,
    });
    const origin = fixtureOrigin(TENANT);
    const task = { ...fixtureTask(TENANT, BINDING), id: `task-${requestId}` };
    const { runId } = await coordinator.openRun(scope, { task, originatingOrigin: origin });
    const fragment = fixtureFragment(TENANT, BINDING);
    const assertion = fixtureAssertion(TENANT, BINDING, origin);
    await ensureEvidence(coordinator, fragment, assertion);
    const registered = await coordinator.registerReport(scope, {
      runId,
      reportId: `report-${requestId}`,
      revision: 1,
      kind: KINDS.ref(scope, "evidence_report"),
      structuredBody: fixtureBody(assertion, fragment),
      assertions: [recordRef("assertion", assertion)],
      timeCoverage: { world: null, observed: null, knowledgeHead: null },
      supersedes: null,
    });
    const auditor = new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT);
    const service = new ReportAssessmentService({
      binding,
      coordinator,
      operations: binding.operations,
      auditor,
      clock: systemClock,
    });
    const handle = await service.start(scope, { runId, reportRef: registered.report, requestId });
    return { coordinator, service, auditor, handle, runId, registered };
  }

  it("two concurrent transitions with the same expected revision: exactly one wins, the other is REVISION_MISMATCH", async () => {
    const { handle, service, registered, runId } = await startedOperation("req-cas");
    const attempt = () =>
      binding.operations.transition(scope, {
        operationId: handle.operationId,
        expectedRevision: 1,
        to: "running",
        at: systemClock.now(),
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]?.reason).toBeInstanceOf(OperationStoreError);
    expect(lost[0]?.reason).toMatchObject({ code: "REVISION_MISMATCH" });
    expect(await service.status(scope, handle)).toMatchObject({ state: "running", revision: 2 });
    await expect(
      binding.operations.transition(scope, {
        operationId: handle.operationId,
        expectedRevision: 2,
        to: "queued",
        at: systemClock.now(),
      }),
    ).rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
    // Idempotent start by request id; other input under the same request id conflicts.
    expect(await service.start(scope, { runId, reportRef: registered.report, requestId: "req-cas" })).toEqual(handle);
    await expect(
      binding.operations.start(scope, {
        operationId: handle.operationId,
        operation: "report.assess",
        requestId: "req-cas",
        request: { other: true },
        requestDigest: digestBytes("other"),
        runId,
        subject: null,
        retryAfterMs: 1000,
        at: systemClock.now(),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    // Tenant isolation: the other tenant cannot see the operation.
    expect(await binding.operations.get(scopeFor(OTHER_TENANT), handle.operationId)).toBeNull();
  });

  it("cancel during waiting_review is idempotent and the runner settles cancelled without new work", async () => {
    const { handle, service, auditor } = await startedOperation("req-review");
    await binding.operations.transition(scope, {
      operationId: handle.operationId,
      expectedRevision: 1,
      to: "running",
      at: systemClock.now(),
    });
    const review = fixtureRef("adjudication", "adj-review-1", TENANT, BINDING, "research-core.adjudication.v1");
    await binding.operations.transition(scope, {
      operationId: handle.operationId,
      expectedRevision: 2,
      to: "waiting_review",
      at: systemClock.now(),
      pendingReviewRef: review,
    });
    const [first, second] = await Promise.all([
      service.cancel(scope, handle, "cancel-a"),
      service.cancel(scope, handle, "cancel-b"),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ state: "cancelling", revision: 4, pendingReviewRef: review });
    expect(["cancel-a", "cancel-b"]).toContain(first.cancelRequestId);
    const settled = await service.run(scope, handle);
    expect(settled).toMatchObject({ state: "cancelled", revision: 5, retryAfterMs: null });
    expect(await service.cancel(scope, handle, "cancel-c")).toEqual(settled);
    expect(auditor.calls).toHaveLength(0);
  });

  it("a seal that fails before or inside its transaction leaves the run sealable; the real-clock retry succeeds", async () => {
    const coordinator = new ResearchCoordinator(binding, systemClock, KINDS, { signer: FIXTURE_SEAL_KEYS.signer });
    const failing = new PostgresResearchBinding(db, BINDING, { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
    const put = failing.custody.put.bind(failing.custody);
    let failSignature = true;
    failing.custody.put = async (s, bytes, mediaType) => {
      // The seal is an inline Ed25519 signature now: fail the last family upload before the seal transaction.
      if (failSignature && Buffer.from(bytes).toString("utf8").includes('"family":"observations"')) {
        failSignature = false;
        throw new Error("CUSTODY_UNAVAILABLE");
      }
      return put(s, bytes, mediaType);
    };
    const failingCoordinator = new ResearchCoordinator(failing, systemClock, KINDS, {
      signer: FIXTURE_SEAL_KEYS.signer,
    });
    const origin = fixtureOrigin(TENANT);
    const { runId } = await coordinator.openRun(scope, {
      task: { ...fixtureTask(TENANT, BINDING), id: "task-seal-retry" },
      originatingOrigin: origin,
    });
    const fragment = fixtureFragment(TENANT, BINDING);
    const assertion = fixtureAssertion(TENANT, BINDING, origin);
    await ensureEvidence(coordinator, fragment, assertion);
    await coordinator.registerReport(scope, {
      runId,
      reportId: "report-seal-retry",
      revision: 1,
      kind: KINDS.ref(scope, "evidence_report"),
      structuredBody: fixtureBody(assertion, fragment),
      assertions: [recordRef("assertion", assertion)],
      timeCoverage: { world: null, observed: null, knowledgeHead: null },
      supersedes: null,
    });
    const input = { runId, build: { buildId: "b-retry", runtime: "node24", dirty: false }, signer: "ks-sealer" };
    await expect(failingCoordinator.sealVerificationSnapshot(scope, input)).rejects.toThrow(/CUSTODY_UNAVAILABLE/);
    const afterCustodyFailure = await binding.loadRunContext(scope, runId);
    expect(afterCustodyFailure.head).toBeNull();
    expect(afterCustodyFailure.run).toBeNull();
    const context = await binding.loadRunContext(scope, runId);
    const probe = await coordinator
      .sealVerificationSnapshot(scope, input)
      .then((sealed) => ({ sealed }))
      .catch((error: unknown) => ({ error }));
    expect("sealed" in probe).toBe(true);
    if (!("sealed" in probe)) return;
    const sealedContext = await binding.loadRunContext(scope, runId);
    expect(sealedContext.run?.startedAt).toBe(context.openedAt);
    await expect(
      binding.seal(scope, {
        runId,
        run: {
          ...(sealedContext.run as NonNullable<typeof sealedContext.run>),
          cost: { providerCalls: 9, tokens: 9, costUsd: "9" },
        },
        manifest: probe.sealed.sealed.manifest,
        seal: probe.sealed.sealed.seal,
        expectedHead: probe.sealed.sealed.seal.manifestDigest as `sha256:${string}`,
      }),
    ).rejects.toThrow(/RUN_IDENTITY_IMMUTABLE/);
    expect((await binding.loadRunContext(scope, runId)).run).toEqual(sealedContext.run);
  });

  it("a failure inside the seal transaction after writing the run record rolls the record back", async () => {
    const coordinator = new ResearchCoordinator(binding, systemClock, KINDS, { signer: FIXTURE_SEAL_KEYS.signer });
    const origin = fixtureOrigin(TENANT);
    const { runId } = await coordinator.openRun(scope, {
      task: { ...fixtureTask(TENANT, BINDING), id: "task-seal-rollback" },
      originatingOrigin: origin,
    });
    const fragment = fixtureFragment(TENANT, BINDING);
    const assertion = fixtureAssertion(TENANT, BINDING, origin);
    await ensureEvidence(coordinator, fragment, assertion);
    await coordinator.registerReport(scope, {
      runId,
      reportId: "report-seal-rollback",
      revision: 1,
      kind: KINDS.ref(scope, "evidence_report"),
      structuredBody: fixtureBody(assertion, fragment),
      assertions: [recordRef("assertion", assertion)],
      timeCoverage: { world: null, observed: null, knowledgeHead: null },
      supersedes: null,
    });
    // Intercept the binding seal: first call is forced to fail in seal_run (wrong expected head) after the record update.
    const original = binding.seal.bind(binding);
    let injected = false;
    const injecting = Object.create(binding) as PostgresResearchBinding;
    injecting.seal = async (s, sealInput) => {
      if (!injected) {
        injected = true;
        await original(s, { ...sealInput, expectedHead: digestBytes("not-the-head") });
      }
      return original(s, sealInput);
    };
    const injectingCoordinator = new ResearchCoordinator(injecting, systemClock, KINDS, {
      signer: FIXTURE_SEAL_KEYS.signer,
    });
    const input = { runId, build: { buildId: "b-rb", runtime: "node24", dirty: false }, signer: "ks-sealer" };
    await expect(injectingCoordinator.sealVerificationSnapshot(scope, input)).rejects.toThrow(/HEAD_MISMATCH/);
    const rolledBack = await binding.loadRunContext(scope, runId);
    expect(rolledBack.run).toBeNull();
    expect(rolledBack.head).toBeNull();
    const { sealed } = await injectingCoordinator.sealVerificationSnapshot(scope, input);
    expect((await binding.loadRunContext(scope, runId)).head).toBe(sealed.seal.manifestDigest);
  });

  it("two truly concurrent seals of one run: exactly one commits a head", async () => {
    const coordinator = new ResearchCoordinator(binding, systemClock, KINDS, { signer: FIXTURE_SEAL_KEYS.signer });
    const origin = fixtureOrigin(TENANT);
    const { runId } = await coordinator.openRun(scope, {
      task: { ...fixtureTask(TENANT, BINDING), id: "task-seal-race" },
      originatingOrigin: origin,
    });
    const fragment = fixtureFragment(TENANT, BINDING);
    const assertion = fixtureAssertion(TENANT, BINDING, origin);
    await ensureEvidence(coordinator, fragment, assertion);
    await coordinator.registerReport(scope, {
      runId,
      reportId: "report-seal-race",
      revision: 1,
      kind: KINDS.ref(scope, "evidence_report"),
      structuredBody: fixtureBody(assertion, fragment),
      assertions: [recordRef("assertion", assertion)],
      timeCoverage: { world: null, observed: null, knowledgeHead: null },
      supersedes: null,
    });
    const input = { runId, build: { buildId: "b-race", runtime: "node24", dirty: false }, signer: "ks-sealer" };
    const results = await Promise.allSettled([
      coordinator.sealVerificationSnapshot(scope, input),
      coordinator.sealVerificationSnapshot(scope, input),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(String(lost[0]?.reason)).toMatch(/HEAD_MISMATCH/);
    const manifests = await db.transaction(
      { tenantId: TENANT, role: "knowledge_verification_reader", readOnly: true },
      (c) =>
        c.query<{ n: string }>(
          "select count(*)::text as n from knowledge_verification.run_manifest where tenant_id = $1 and run_id = $2::uuid",
          [TENANT, runId],
        ),
    );
    expect(manifests.rows[0]?.n).toBe("1");
  });
});
