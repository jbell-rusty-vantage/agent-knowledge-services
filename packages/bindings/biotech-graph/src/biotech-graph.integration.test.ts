import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReportKindCatalog, type ResearchCoordinator } from "@aiengineer/knowledge-application";
import {
  AT,
  FIXTURE_SEAL_KEYS,
  type ReportKindCase,
  fixtureOrigin,
  reportKindCases,
  reportKindRoundTrip,
} from "@aiengineer/knowledge-application/testing";
import { ComponentDatabase, pinSealSigningKey } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import { type AuthScope, normalizedValuesDigest } from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BiotechGraphAdmission, biotechEffect, expectedMarkerDigest } from "./admission.js";
import { BksExecutorClient } from "./client.js";
import { BiotechGraphDelivery, PostgresOutboxReader } from "./delivery.js";
import { BIOTECH_SCHEMA_RELEASE_V2_2_0 } from "./descriptor.js";
import { BiotechOfficialReads } from "./read.js";
import { type FrozenReportBinding, biotechReportKind, reportPublishFields } from "./report.js";
import { biotechResearchBinding } from "./research-binding.js";
import { StubBksExecutor } from "./testing.js";

/**
 * SV-11 (KS half) / SV-12 cross-store proofs of the Biotech graph binding over the REAL knowledge_verification
 * component in a throwaway PostgreSQL database (installation `biotech`, binding `biotech-graph`).
 *
 * Two consumer modes, same cases:
 *   stub  (T1-KS conformance; NOT a graph qualification): `StubBksExecutor` plays the BKS executor in process.
 *   bks   (T1 graph proof): the BKS native executor over HTTP against the disposable Neo4j; selected by
 *         BIOTECH_GRAPH_T1_EXECUTOR_URL / _TOKEN (service) / _READ_TOKEN (reader) and a pre-installed database
 *         BIOTECH_GRAPH_T1_DATABASE + BIOTECH_GRAPH_T1_TENANT + BIOTECH_GRAPH_T1_INSTALLATION (the executor's
 *         BKS_BIOTECH_DB_VERIFICATION_DSN must point at that database). BIOTECH_GRAPH_T1_EXECUTOR_DOWN_URL: a second executor
 *         whose Neo4j is unreachable (graph-unavailable case).
 * Requires KS_AIENG_DB_ADMIN_DSN (disposable admin DSN). Engineering fixtures only; no model calls.
 */
const ADMIN = process.env.KS_AIENG_DB_ADMIN_DSN;
const describeDb = ADMIN ? describe : describe.skip;
const EXECUTOR_URL = process.env.BIOTECH_GRAPH_T1_EXECUTOR_URL;
const MODE: "stub" | "bks" = EXECUTOR_URL ? "bks" : "stub";
const PREPARED_DB = process.env.BIOTECH_GRAPH_T1_DATABASE;
const TENANT = process.env.BIOTECH_GRAPH_T1_TENANT ?? randomUUID();
const INSTALLATION = process.env.BIOTECH_GRAPH_T1_INSTALLATION ?? "6b0c2f4e-1d3a-4c5b-9e7f-8a9b0c1d2e3f";
const BINDING = "biotech-graph";
const STAMP = `bg${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
const here = dirname(fileURLToPath(import.meta.url));
const KINDS = ReportKindCatalog.fromDirectory(resolve(here, "../../../../catalog/research/report-kinds"));
const EVIDENCE_DIR =
  process.env.BIOTECH_GRAPH_T1_EVIDENCE ?? resolve(here, "../../../../.scratch/sprint-v/proofs/SV-12", `run-${MODE}`);
const evidence: { case: string; detail: unknown }[] = [];
const record = (name: string, detail: unknown) => evidence.push({ case: name, detail });
const clock = { now: () => AT };
const SNAPSHOT_AT = "2026-10-24T20:00:00Z";
const dig = (s: string) => `sha256:${Buffer.from(s).toString("hex").padEnd(64, "0").slice(0, 64)}`;

/** biotech-knowledge-intent.v2 of a report effect (shapes from the BKS SV-11 fixtures), bound to a frozen revision. */
function reportIntent(frozen: FrozenReportBinding, n: string, runId: string): Record<string, unknown> {
  const pins = { schemaReleaseDigest: BIOTECH_SCHEMA_RELEASE_V2_2_0, policyVersion: "bks-admission-policy/v1" };
  const context = {
    actor: { kind: "agent", id: "ks-biotech-graph", model: "synthetic" },
    run: { system: "ks-verification", runId: `${runId}/${n}`, operationId: `op-${n}` },
    activityKind: "EVIDENCE_MISSION",
  };
  const publish = {
    proposalId: "report",
    kind: "report.publish",
    name: `Synthetic ${frozen.reportKind} ${n}`,
    policyVersion: "bks-admission-policy/v1",
    ...reportPublishFields(frozen),
  };
  if (frozen.reportKind === "evidence_report") {
    return {
      schemaVersion: "biotech-knowledge-intent.v2",
      intentId: `bg-ev-${n}`,
      pins,
      context,
      basis: {
        creationOnly: { reason: "SV-12 synthetic dispatch fixture: first capture of these synthetic entities" },
      },
      sources: [
        {
          ref: "post",
          source: { canonicalUri: `https://fixtures.bks.test/sv12/${n}/post`, sourceKind: "WEB_PAGE" },
          snapshot: {
            retrievedAt: SNAPSHOT_AT,
            observedAt: SNAPSHOT_AT,
            contentHash: dig(`post-${n}`),
            contentHashBasis: "SYNTHETIC_FIXTURE",
            captureMethod: "bks-fixture/1",
            captureCompleteness: "COMPLETE",
          },
          locators: [
            {
              ref: "l-claim",
              selectorKind: "TEXT_QUOTE",
              selector: {
                basis: "raw-capture/v1",
                type: "TextQuoteSelector",
                exact: "Synthetic NR activates synthetic protein SP1",
                refinedBy: { type: "TextPositionSelector", start: 100, end: 144 },
              },
              exact: "Synthetic NR activates synthetic protein SP1",
              startOffset: 100,
              endOffset: 144,
            },
          ],
        },
      ],
      subjects: [
        {
          ref: "org",
          mode: "new",
          nodeType: "Organization",
          name: `Synthetic Claimant ${n}`,
          uidSegment: `sv12-org-${n}`,
          properties: { entityKind: "LEGAL_ENTITY" },
          onMatch: "use_existing",
        },
        {
          ref: "nr",
          mode: "new",
          nodeType: "ChemicalSubstance",
          name: `Synthetic NR ${n}`,
          uidSegment: `sv12-nr-${n}`,
          properties: {},
          onMatch: "use_existing",
        },
        {
          ref: "sp1",
          mode: "new",
          nodeType: "MolecularEntity",
          name: `Synthetic protein SP1 ${n}`,
          uidSegment: `sv12-sp1-${n}`,
          properties: {},
          onMatch: "use_existing",
        },
        {
          ref: "claim",
          mode: "new",
          nodeType: "Claim",
          name: `Synthetic NR activates SP1 (${n})`,
          properties: {
            proposition: `Synthetic NR ${n} directly activates synthetic protein SP1`,
            claimType: "RELATIONSHIP",
          },
          onMatch: "use_existing",
        },
      ],
      proposals: [
        { proposalId: "lineage", kind: "lineage.start", about: ["claim"] },
        {
          proposalId: "occurrence",
          kind: "assertion.relate",
          subjectRef: "nr",
          objectRef: "sp1",
          asserterRef: "org",
          evidence: ["l-claim"],
          assertion: {
            predicate: "ACTIVATES",
            assertionKind: "CLAIM",
            claimType: "RELATIONSHIP",
            occurrenceOf: { claimRef: "claim" },
            speechAct: "STATES",
            basisKind: "MANUFACTURER_CLAIM",
            validity: { validObservedAt: "2026-10-24T00:00:00Z" },
          },
        },
        {
          ...publish,
          verdict: "NOT_SUPPORTED",
          about: ["claim"],
          citesAssertions: [{ proposal: "occurrence" }],
          evidence: ["l-claim"],
        },
      ],
    };
  }
  return {
    schemaVersion: "biotech-knowledge-intent.v2",
    intentId: `bg-sa-${n}`,
    pins,
    context,
    basis: { creationOnly: { reason: "SV-12 synthetic dispatch fixture: first capture of this synthetic study" } },
    sources: [
      {
        ref: "pub",
        source: { canonicalUri: `https://fixtures.bks.test/sv12/${n}/trial`, sourceKind: "WEB_PAGE" },
        snapshot: {
          retrievedAt: SNAPSHOT_AT,
          contentHash: dig(`trial-${n}`),
          contentHashBasis: "SYNTHETIC_FIXTURE",
          captureMethod: "bks-fixture/1",
          captureCompleteness: "COMPLETE",
        },
        locators: [
          {
            ref: "l-study",
            selectorKind: "TEXT_QUOTE",
            selector: {
              basis: "raw-capture/v1",
              type: "TextQuoteSelector",
              exact: "a randomized trial of synthetic NR in 40 adults",
              refinedBy: { type: "TextPositionSelector", start: 10, end: 57 },
            },
            exact: "a randomized trial of synthetic NR in 40 adults",
            startOffset: 10,
            endOffset: 57,
          },
        ],
      },
    ],
    subjects: [
      {
        ref: "study",
        mode: "new",
        nodeType: "Study",
        name: `Synthetic NR randomized trial ${n}`,
        uidSegment: `sv12-study-${n}`,
        properties: { studyKind: "INTERVENTIONAL_RANDOMIZED" },
        onMatch: "use_existing",
      },
    ],
    proposals: [
      {
        proposalId: "appraisal",
        kind: "assessment.record",
        assessmentKind: "QUALITY",
        assessmentSubkind: "D3.evidence-strength",
        about: ["study"],
        methodVersion: "d3-evidence-strength/v1",
        summary: "Synthetic appraisal: small sample, unclear allocation concealment",
        facets: ["downgrade=imprecision"],
        evidence: ["l-study"],
      },
      { ...publish, about: ["study"], citesAssessments: [{ proposal: "appraisal" }], evidence: ["l-study"] },
    ],
  };
}

interface KindRun {
  readonly kase: ReportKindCase;
  readonly runId: string;
  readonly frozen: FrozenReportBinding;
  readonly coordinator: ResearchCoordinator;
}

describeDb(`SV-11/SV-12 biotech-graph binding over the component (${MODE} consumer)`, () => {
  const database = PREPARED_DB ?? `kvbg_${randomBytes(4).toString("hex")}`;
  let db: ComponentDatabase;
  let adminDb: Client;
  let stub: StubBksExecutor | null = null;
  let executor: BksExecutorClient;
  let admission: BiotechGraphAdmission;
  let delivery: BiotechGraphDelivery;
  let reads: BiotechOfficialReads;
  let componentVersion = "";
  const binding = () => biotechResearchBinding(db, { sealVerifier: FIXTURE_SEAL_KEYS.verifier });
  const origin = { ...fixtureOrigin(TENANT), applicationId: "biotech", installationId: INSTALLATION };
  const scope: AuthScope = {
    tenant: TENANT,
    application: "biotech",
    binding: BINDING,
    origin,
    grants: ["research.write"],
  };
  const runs = new Map<string, KindRun>();
  const dsn = () => {
    const url = new URL(ADMIN as string);
    url.pathname = `/${database}`;
    return url.toString();
  };
  const asTenant = async <T>(sql: string, values: unknown[]): Promise<T[]> => {
    await adminDb.query("begin");
    try {
      await adminDb.query("select set_config('app.tenant_id', $1, true)", [TENANT]);
      const rows = (await adminDb.query(sql, values)).rows as T[];
      await adminDb.query("commit");
      return rows;
    } catch (error) {
      await adminDb.query("rollback");
      throw error;
    }
  };
  const outboxRow = async (dispatchId: string) =>
    (
      await asTenant<Record<string, unknown>>(
        "select state, attempts, ack_digest, expected_marker_digest, marker_scheme, last_error, settled_at from knowledge_verification.dispatch_outbox where tenant_id = $1 and dispatch_id = $2",
        [TENANT, dispatchId],
      )
    )[0];
  /** Lease expiry / retry time without waiting (the component clocks are wall-clock; tests move the row forward). */
  const makeAvailable = (dispatchId: string) =>
    asTenant(
      "update knowledge_verification.dispatch_outbox set available_at = now() - interval '1 second' where tenant_id = $1 and dispatch_id = $2",
      [TENANT, dispatchId],
    );
  const markerOf = async (effectKey: string) =>
    (
      await executor.marker(
        { effectKey },
        { schemaReleaseDigest: BIOTECH_SCHEMA_RELEASE_V2_2_0 },
        `t-${STAMP}-${randomBytes(3).toString("hex")}`,
      )
    ).marker;

  /** One new exact effect of a kind's sealed report: intent -> bound digest -> report use decision (admitted). */
  async function newEffect(kind: "evidence_report" | "study_appraisal", n: string) {
    const run = runs.get(kind) as KindRun;
    const intent = reportIntent(run.frozen, `${STAMP}${n}`, run.runId);
    const effect = biotechEffect(intent, origin);
    const decided = await run.coordinator.decideReportUse(scope, {
      runId: run.runId,
      use: run.kase.task.use,
      audience: "official",
      boundEffectDigest: effect.boundEffectDigest,
      targetSchema: "biotech-knowledge-intent.v2",
      normalizedValues: {},
      policy: run.kase.task.policy,
      rubric: run.kase.task.rubric,
    });
    expect(decided.decision.disposition).toBe("admitted");
    return { intent, effect, decision: decided.decision, effectKey: `ks:sv12/${STAMP}/${n}` };
  }

  async function admit(e: Awaited<ReturnType<typeof newEffect>>, dispatchId?: string) {
    const result = await admission.admitExactUse(scope, {
      effectKey: e.effectKey,
      useDecisionId: e.decision.id,
      normalizedValuesDigest: normalizedValuesDigest({}),
      intent: e.intent,
      processedEpoch: await binding().currentEpoch(scope),
      ...(dispatchId ? { dispatchId } : {}),
    });
    if (result.outcome !== "admitted") throw new Error(`not admitted: ${result.outcome}/${result.reason}`);
    return result.receipt;
  }

  beforeAll(async () => {
    if (!PREPARED_DB) {
      const admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await admin.query(`create database ${database}`);
      await admin.end();
      const receipt = await install(loadComponent(), {
        adminDsn: dsn(),
        installationId: INSTALLATION,
        applicationId: "biotech",
        binding: BINDING,
      });
      componentVersion = receipt.componentVersion;
    }
    await pinSealSigningKey(dsn(), { keyId: FIXTURE_SEAL_KEYS.signer.keyId, publicKey: FIXTURE_SEAL_KEYS.publicKey });
    adminDb = new Client({ connectionString: dsn() });
    await adminDb.connect();
    if (componentVersion === "") {
      const v = await adminDb
        .query("select component_version from knowledge_verification.installation order by installed_at desc limit 1")
        .catch(() => ({ rows: [] as { component_version: string }[] }));
      componentVersion = (v.rows[0] as { component_version?: string } | undefined)?.component_version ?? "prepared";
    }
    db = new ComponentDatabase({ connectionString: dsn() });
    if (MODE === "stub") {
      stub = new StubBksExecutor(db, { installationId: INSTALLATION, applicationId: "biotech", tenantId: TENANT });
      executor = new BksExecutorClient({
        baseUrl: "http://stub.bks.invalid",
        token: "stub-service-token",
        fetch: stub.fetch,
      });
    } else {
      executor = new BksExecutorClient({
        baseUrl: EXECUTOR_URL as string,
        token: process.env.BIOTECH_GRAPH_T1_EXECUTOR_TOKEN as string,
        ...(process.env.BIOTECH_GRAPH_T1_EXECUTOR_READ_TOKEN
          ? { readToken: process.env.BIOTECH_GRAPH_T1_EXECUTOR_READ_TOKEN }
          : {}),
      });
    }
    admission = new BiotechGraphAdmission(db, { installationId: INSTALLATION });
    delivery = new BiotechGraphDelivery({
      outbox: new PostgresOutboxReader(db),
      executor,
      schemaReleaseDigest: BIOTECH_SCHEMA_RELEASE_V2_2_0,
    });
    reads = new BiotechOfficialReads(executor, BIOTECH_SCHEMA_RELEASE_V2_2_0);
    // register -> audit (independent census) -> seal (K07) -> report decision, once per kind.
    for (const kase of reportKindCases(TENANT, BINDING, origin)) {
      const trip = await reportKindRoundTrip({
        scope,
        binding: binding(),
        operations: binding().operations,
        kinds: KINDS,
        kase,
        clock,
      });
      const context = await binding().loadRunContext(scope, trip.runId);
      const revision = context.report?.revision;
      if (!revision) throw new Error("report revision missing");
      runs.set(kase.kindId, {
        kase,
        runId: trip.runId,
        coordinator: trip.coordinator,
        frozen: {
          reportRevisionId: revision.id,
          reportKind: biotechReportKind(revision.kind.id),
          reportKindRef: revision.kind.id,
          reportSchema: revision.schemaVersion,
          bodyDigest: revision.bodyDigest,
          ledgerDigest: revision.ledger.digest,
          structuredBodyDigest: revision.structuredBody.digest,
        },
      });
    }
  }, 120_000);

  afterAll(async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(
      resolve(EVIDENCE_DIR, `biotech-graph-${MODE}-${STAMP}.json`),
      `${JSON.stringify({ mode: MODE, stamp: STAMP, componentVersion, database, tenant: TENANT, finishedAt: new Date().toISOString(), evidence }, null, 2)}\n`,
    );
    await adminDb?.end();
    await db?.end();
    if (!PREPARED_DB && ADMIN) {
      const admin = new Client({ connectionString: ADMIN });
      await admin.connect();
      await admin.query(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  });

  it.each(["evidence_report", "study_appraisal"] as const)(
    "%s end to end: decide -> admit (one PG transaction, pending_dispatch, graph untouched) -> consume -> marker -> verified ack -> official read eligible",
    async (kind) => {
      const e = await newEffect(kind, `e2e-${kind}`);
      const receipt = await admit(e);
      // PostgreSQL committed alone: the receipt is pending and the graph holds nothing for this effect yet.
      expect(receipt).toMatchObject({
        state: "pending_dispatch",
        targetBinding: "biotech-graph",
        markerScheme: "ks-intent-marker.v1",
      });
      expect(receipt.expectedMarkerDigest).toBe(
        expectedMarkerDigest({
          tenantId: TENANT,
          dispatchId: receipt.dispatchId,
          effectKey: e.effectKey,
          boundEffectDigest: e.effect.boundEffectDigest,
          useDecisionId: e.decision.id,
          revocationEpoch: receipt.revocationEpoch,
        }),
      );
      expect(await markerOf(e.effectKey)).toBeNull();
      expect(await outboxRow(receipt.dispatchId)).toMatchObject({ state: "pending", attempts: 0, ack_digest: null });
      const payload = await asTenant<{ media_type: string; custody_kind: string }>(
        "select media_type, custody_kind from knowledge_verification.artifact_custody where tenant_id = $1 and digest = $2",
        [TENANT, receipt.payloadDigest],
      );
      expect(payload).toEqual([
        { media_type: "application/vnd.belllabs.biotech-knowledge-admission.v1+json", custody_kind: "inline" },
      ]);
      const delivered = await delivery.deliver(scope, receipt.dispatchId);
      record(`e2e-${kind}`, {
        receipt,
        ack: delivered.ack,
        state: delivered.state,
        findings: delivered.findings,
        row: delivered.row,
        marker: delivered.marker,
      });
      expect(delivered.ack?.outcome).toBe("applied");
      expect(delivered).toMatchObject({ state: "applied", verified: true, findings: [], graphApplied: true });
      expect(delivered.row.ackDigest).toBe(receipt.expectedMarkerDigest);
      expect(delivered.marker).toMatchObject({
        dispatchId: receipt.dispatchId,
        payloadDigest: receipt.payloadDigest,
        boundEffectDigest: e.effect.boundEffectDigest,
        useDecisionRef: e.decision.id,
      });
      const run = runs.get(kind) as KindRun;
      const official = await reads.report(scope, {
        expected: run.frozen,
        useName: run.kase.task.use,
        audience: "official",
      });
      record(`official-read-${kind}`, official);
      expect(official.state).toBe("eligible");
      expect(official.reports.filter((r) => r.state === "eligible").every((r) => r.mismatches.length === 0)).toBe(true);
    },
  );

  it("held or rejected admission writes nothing: no effect, no payload, no dispatch", async () => {
    const e = await newEffect("evidence_report", "held");
    const counts = async () =>
      (
        await asTenant<{ e: string; d: string }>(
          "select (select count(*) from knowledge_verification.effect where tenant_id = $1)::text as e, (select count(*) from knowledge_verification.dispatch_outbox where tenant_id = $1)::text as d",
          [TENANT],
        )
      )[0];
    const before = await counts();
    const stale = await admission.admitExactUse(scope, {
      effectKey: e.effectKey,
      useDecisionId: e.decision.id,
      normalizedValuesDigest: normalizedValuesDigest({}),
      intent: e.intent,
      processedEpoch: -1,
    });
    const edited = await admission.admitExactUse(scope, {
      effectKey: e.effectKey,
      useDecisionId: e.decision.id,
      normalizedValuesDigest: normalizedValuesDigest({}),
      intent: { ...e.intent, intentId: "edited-after-decision" },
      processedEpoch: await binding().currentEpoch(scope),
    });
    record("held-and-rejected", { stale, edited });
    expect(stale).toMatchObject({ outcome: "held", reason: "REVOCATION_EPOCH_STALE", receipt: null });
    expect(edited).toMatchObject({ outcome: "rejected", reason: "EFFECT_DIGEST_MISMATCH", receipt: null });
    expect(await counts()).toEqual(before);
  });

  it("duplicate delivery: a redelivery of an applied effect acknowledges its own row; one marker, graph unchanged", async () => {
    const e = await newEffect("evidence_report", "dup");
    const first = await admit(e);
    expect((await delivery.deliver(scope, first.dispatchId)).state).toBe("applied");
    const markerBefore = await markerOf(e.effectKey);
    const again = await admit(e, `${first.dispatchId}-redelivery`);
    const delivered = await delivery.deliver(scope, again.dispatchId);
    record("duplicate-delivery", { ack: delivered.ack, state: delivered.state, findings: delivered.findings });
    expect(delivered.ack?.outcome).toBe("duplicate");
    expect(delivered).toMatchObject({ state: "applied", verified: true });
    const markerAfter = await markerOf(e.effectKey);
    expect(markerAfter).toEqual(markerBefore);
    expect(markerAfter?.dispatchId).toBe(first.dispatchId);
  });

  it("reordered delivery: the later dispatch of one effect is consumed first; applied once, both acknowledged", async () => {
    const e = await newEffect("study_appraisal", "reorder");
    const late = await admit(e, `dsp-${STAMP}-reorder-2`);
    const early = await admit(e, `dsp-${STAMP}-reorder-1`);
    const report = await executor.consume(TENANT, 10);
    const a = await delivery.reconcile(scope, late.dispatchId);
    const b = await delivery.reconcile(scope, early.dispatchId);
    record("reordered-delivery", {
      results: report.results.map((r) => [r.dispatchId, r.outcome, r.acknowledged]),
      states: [a.state, b.state],
    });
    expect(report.results.map((r) => [r.dispatchId, r.outcome])).toEqual([
      [late.dispatchId, "applied"],
      [early.dispatchId, "duplicate"],
    ]);
    expect([a.state, b.state]).toEqual(["applied", "applied"]);
    expect((await markerOf(e.effectKey))?.dispatchId).toBe(late.dispatchId);
  });

  it("lost acknowledgment response: the consume answer never reaches KS; reconciliation finds the verified ack", async () => {
    const e = await newEffect("evidence_report", "lostresp");
    const receipt = await admit(e);
    await executor.consume(TENANT, 10); // response discarded (lost on the wire)
    const reconciled = await delivery.reconcile(scope, receipt.dispatchId);
    record("lost-ack-response", { state: reconciled.state, findings: reconciled.findings });
    expect(reconciled).toMatchObject({ state: "applied", verified: true, ack: null });
  });

  it.runIf(MODE === "stub")(
    "lost acknowledgment after the graph commit: row stays dispatched; redelivery acknowledges from the marker",
    async () => {
      const e = await newEffect("evidence_report", "lostack");
      const receipt = await admit(e);
      (stub as StubBksExecutor).faults.loseNextAck = true;
      const lost = await delivery.deliver(scope, receipt.dispatchId);
      expect(lost).toMatchObject({ state: "pending_dispatch", graphApplied: true, verified: false });
      expect(await outboxRow(receipt.dispatchId)).toMatchObject({ state: "dispatched", ack_digest: null });
      await makeAvailable(receipt.dispatchId);
      const redelivered = await delivery.deliver(scope, receipt.dispatchId);
      record("lost-ack-after-commit", {
        lost: { state: lost.state, findings: lost.findings },
        redelivered: { ack: redelivered.ack?.outcome, state: redelivered.state },
      });
      expect(redelivered.ack?.outcome).toBe("duplicate");
      expect(redelivered).toMatchObject({ state: "applied", verified: true });
    },
  );

  it("graph unavailable: fail_dispatch (row pending, attempt counted, no marker), retry applies", async () => {
    const e = await newEffect("study_appraisal", "graphdown");
    const receipt = await admit(e);
    let down: BiotechGraphDelivery = delivery;
    if (MODE === "stub") (stub as StubBksExecutor).faults.graphUnavailable = true;
    else if (process.env.BIOTECH_GRAPH_T1_EXECUTOR_DOWN_URL) {
      const downExecutor = new BksExecutorClient({
        baseUrl: process.env.BIOTECH_GRAPH_T1_EXECUTOR_DOWN_URL,
        timeoutMs: 110_000,
        token: process.env.BIOTECH_GRAPH_T1_EXECUTOR_TOKEN as string,
        ...(process.env.BIOTECH_GRAPH_T1_EXECUTOR_READ_TOKEN
          ? { readToken: process.env.BIOTECH_GRAPH_T1_EXECUTOR_READ_TOKEN }
          : {}),
      });
      // The down executor cannot answer the marker read either; reconcile through the healthy one.
      down = {
        deliver: async (s: AuthScope, id: string) => {
          const r = await downExecutor.consume(s.tenant, 10);
          return { ...(await delivery.reconcile(s, id, r.results.find((x) => x.dispatchId === id) ?? null)) };
        },
      } as unknown as BiotechGraphDelivery;
    } else {
      throw new Error("BIOTECH_GRAPH_T1_EXECUTOR_DOWN_URL is required in bks mode");
    }
    const failed = await down.deliver(scope, receipt.dispatchId);
    const row = await outboxRow(receipt.dispatchId);
    expect(failed).toMatchObject({ state: "pending_dispatch", graphApplied: false });
    expect(row).toMatchObject({ state: "pending", attempts: 1 });
    expect(String(row?.last_error)).toMatch(/GRAPH_UNAVAILABLE/);
    if (stub) stub.faults.graphUnavailable = false;
    await makeAvailable(receipt.dispatchId);
    const retried = await delivery.deliver(scope, receipt.dispatchId);
    record("graph-unavailable", {
      failed: { ack: failed.ack, row },
      retried: { ack: retried.ack?.outcome, state: retried.state },
    });
    expect(retried).toMatchObject({ state: "applied", verified: true });
    expect((await outboxRow(receipt.dispatchId))?.attempts).toBe(2);
  });

  it.runIf(MODE === "stub")(
    "native rollback inside the consumer: no marker, dispatch retried, then applied",
    async () => {
      const e = await newEffect("evidence_report", "rollback");
      const receipt = await admit(e);
      (stub as StubBksExecutor).faults.rollbackNextApply = true;
      const rolled = await delivery.deliver(scope, receipt.dispatchId);
      expect(rolled).toMatchObject({ state: "pending_dispatch", graphApplied: false, marker: null });
      await makeAvailable(receipt.dispatchId);
      const retried = await delivery.deliver(scope, receipt.dispatchId);
      record("native-rollback", { rolled: { ack: rolled.ack?.reason, row: rolled.row.state }, retried: retried.state });
      expect(retried).toMatchObject({ state: "applied", verified: true });
    },
  );

  it("stop-dispatch (no native cancellation): a revoked pending dispatch is never applied", async () => {
    const e = await newEffect("study_appraisal", "stop");
    const receipt = await admit(e);
    expect(await admission.stopDispatch(scope, e.effectKey)).toBe(1);
    const delivered = await delivery.deliver(scope, receipt.dispatchId);
    record("stop-dispatch", { state: delivered.state, ack: delivered.ack, findings: delivered.findings });
    expect(delivered).toMatchObject({ state: "revoked", graphApplied: false, marker: null });
  });

  // Last: the correction invalidates every evidence-report decision of this run (the earlier applied effects too).
  it("revoked in transit (epoch advanced after claim): consumer settles revoked, graph untouched; official read excludes the applied projection", async () => {
    const e = await newEffect("evidence_report", "revoked");
    const receipt = await admit(e);
    const run = runs.get("evidence_report") as KindRun;
    const fragment = run.kase.fragments[0];
    if (!fragment) throw new Error("fixture");
    const correct = async () => {
      const closure = await binding().recordCorrection(scope, {
        corrected: { kind: "fragment", id: fragment.id },
        reason: "SV-12 synthetic source correction",
      });
      record("correction-closure", closure);
    };
    let delivered: Awaited<ReturnType<BiotechGraphDelivery["deliver"]>>;
    if (MODE === "stub") {
      (stub as StubBksExecutor).faults.afterClaim = correct;
      delivered = await delivery.deliver(scope, receipt.dispatchId);
      expect(delivered.ack).toMatchObject({ outcome: "revoked" });
    } else {
      // A worker claimed the row and crashed (row `dispatched`); the correction lands; the next consume pass runs.
      await asTenant("select * from knowledge_verification.claim_dispatches($1, 100, now(), 'biotech-graph')", [
        TENANT,
      ]);
      await correct();
      delivered = await delivery.deliver(scope, receipt.dispatchId);
    }
    record("revoked-in-transit", {
      state: delivered.state,
      ack: delivered.ack,
      row: delivered.row,
      findings: delivered.findings,
    });
    expect(delivered).toMatchObject({ state: "revoked", graphApplied: false, marker: null });
    const official = await reads.report(scope, {
      expected: run.frozen,
      useName: run.kase.task.use,
      audience: "official",
    });
    record("official-read-after-revocation", official);
    expect(official.reports.length).toBeGreaterThan(0);
    expect(official.reports.every((r) => r.state === "revoked" && r.report === null)).toBe(true);
    expect(official.state).toBe("revoked");
  });
});
