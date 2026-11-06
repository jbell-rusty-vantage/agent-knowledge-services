import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedAuditorDiscovery } from "@aiengineer/knowledge-application";
import {
  EVIDENCE_REPORT_SCRIPT,
  fixtureSupportObservation,
  reportKindCases,
} from "@aiengineer/knowledge-application/testing";
import { ComponentDatabase, pinSealSigningKey } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import {
  BIOTECH_SCHEMA_RELEASE_V2_2_0,
  type FrozenReportBinding,
  biotechEffect,
  biotechReportKind,
  reportPublishFields,
} from "@aiengineer/knowledge-binding-biotech-graph";
import { StubBksExecutor } from "@aiengineer/knowledge-binding-biotech-graph/testing";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import {
  BindingDescriptorSchema,
  type JsonValue,
  type OperationEnvelope,
  OperationHandleSchema,
  OperationReceiptSchema,
  OperationStatusSchema,
  ProtocolErrorSchema,
  ReceiptLookupSchema,
  type Ref,
  digestBytes,
} from "@aiengineer/knowledge-operation-protocol";
import { type AuthScope, normalizedValuesDigest, qualifiersDigest } from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type KnowledgeOperationSurface,
  createKnowledgeOperationSurfaceFromEnv,
} from "@aiengineer/knowledge-host/knowledge-operation";
import { KNOWLEDGE_BACKENDS } from "../serve.js";
import { handleKnowledgeOperation } from "./http.js";
import {
  TEST_AUDIENCE,
  TEST_ISSUER,
  claimsFor,
  envelopeFor,
  generateIssuerKey,
  jwksOf,
  liveOrigin,
  signCredential,
} from "./tests/test-support.js";

/**
 * SV-16 follow-up A: the K06 Biotech graph binding wired into the executor's binding factory (env composition), over a
 * throwaway Biotech component install (2.4.0) on the disposable PostgreSQL 17. Over the wire with K07 credentials:
 * describe advertises biotech-graph; report.register -> report.assess -> receipt.get; knowledge.apply admits the
 * exact use and enqueues the dispatch (receipt outcome `pending_dispatch`), then D2's stub BKS consumer (in process,
 * on the real component as the outbox worker; NOT a graph qualification) consumes and acknowledges the row.
 * Trusted in-process setup only where K01 has no operation: the independent judge observation, the seal and the
 * report use decision. Engineering fixtures only; no model calls.
 */
const ADMIN = process.env.KNOWLEDGE_DB_CONTRACT_ADMIN_DSN;
const describeDb = ADMIN ? describe : describe.skip;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const TENANT = randomUUID();
const INSTALLATION = "6b0c2f4e-1d3a-4c5b-9e7f-8a9b0c1d2e3f";
const BINDING = "biotech-graph";

describeDb("ks.knowledge_operation.v2 over the Biotech graph binding (K06, stub consumer)", () => {
  const database = `kvopbg_${randomBytes(4).toString("hex")}`;
  const key = generateIssuerKey("mc-issuer-biotech");
  let surface: KnowledgeOperationSurface;
  let server: Server;
  let url = "";
  let adminDb: Client;
  const origin = liveOrigin(TENANT, { application: "biotech", installationId: INSTALLATION });
  const scope: AuthScope = { tenant: TENANT, application: "biotech", binding: BINDING, origin, grants: [] };
  const dsn = () => {
    const target = new URL(ADMIN as string);
    target.pathname = `/${database}`;
    return target.toString();
  };

  beforeAll(async () => {
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
    expect(receipt.componentVersion).toBe("2.5.0");
    const directory = mkdtempSync(join(tmpdir(), "ks-kop-biotech-"));
    const seal = generateKeyPairSync("ed25519");
    const spki = seal.publicKey.export({ format: "der", type: "spki" });
    const sealFile = join(directory, "seal.pem");
    writeFileSync(sealFile, seal.privateKey.export({ format: "pem", type: "pkcs8" }));
    await pinSealSigningKey(dsn(), { keyId: "ks-sv16-biotech-seal", publicKey: spki.subarray(spki.length - 32) });
    const jwksFile = join(directory, "jwks.json");
    writeFileSync(jwksFile, JSON.stringify(jwksOf([key])));
    surface = (await createKnowledgeOperationSurfaceFromEnv(
      {
        KS_KNOWLEDGE_ISSUER: TEST_ISSUER,
        KS_KNOWLEDGE_AUDIENCE: TEST_AUDIENCE,
        KS_KNOWLEDGE_JWKS_FILE: jwksFile,
        KS_BIOTECH_COMPONENT_DSN: dsn(),
        KS_KNOWLEDGE_SEAL_KEY_ID: "ks-sv16-biotech-seal",
        KS_KNOWLEDGE_SEAL_KEY_FILE: sealFile,
        KS_KNOWLEDGE_REPORT_KINDS_DIR: resolve(ROOT, "catalog/research/report-kinds"),
        KS_KNOWLEDGE_BINDINGS_JSON: JSON.stringify([
          {
            application: "biotech",
            binding: BINDING,
            installationId: INSTALLATION,
            databaseUrlEnv: "KS_BIOTECH_COMPONENT_DSN",
          },
        ]),
      },
      { registry: KNOWLEDGE_BACKENDS, auditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT) },
    )) as KnowledgeOperationSurface;
    server = createServer((request, response) => {
      void handleKnowledgeOperation(
        request,
        response,
        new URL(request.url ?? "/", "http://localhost"),
        surface.service,
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/knowledge-operation/v2`;
    adminDb = new Client({ connectionString: dsn() });
    await adminDb.connect();
  }, 60_000);

  afterAll(async () => {
    await adminDb?.end();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    await surface?.close();
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  const token = (envelope: OperationEnvelope | null, operations?: Parameters<typeof claimsFor>[0]["operations"]) =>
    signCredential(
      key,
      claimsFor({
        origin,
        operations: operations ?? (envelope ? [envelope.operation] : ["knowledge.describe"]),
        dispatchId: envelope?.dispatchId ?? `dispatch-${randomBytes(6).toString("hex")}`,
        binding: BINDING,
        effect: envelope?.effect
          ? { effectKey: envelope.effect.effectKey, boundEffectDigest: envelope.effect.boundEffectDigest }
          : null,
      }),
    );

  async function call(path: string, bearer: string, body?: unknown) {
    const response = await fetch(`${url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

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

  function intentFor(frozen: FrozenReportBinding, runId: string, n: string): Record<string, unknown> {
    return {
      schemaVersion: "biotech-knowledge-intent.v2",
      intentId: `kop-bg-${n}`,
      pins: { schemaReleaseDigest: BIOTECH_SCHEMA_RELEASE_V2_2_0, policyVersion: "bks-admission-policy/v1" },
      context: {
        actor: { kind: "agent", id: "ks-knowledge-operation", model: "synthetic" },
        run: { system: "ks-verification", runId: `${runId}/${n}`, operationId: `op-${n}` },
        activityKind: "EVIDENCE_MISSION",
      },
      basis: { creationOnly: { reason: "SV-16 synthetic dispatch fixture" } },
      sources: [],
      subjects: [
        {
          ref: "claim",
          mode: "new",
          nodeType: "Claim",
          name: `Synthetic claim ${n}`,
          properties: { proposition: `Synthetic proposition ${n}`, claimType: "RELATIONSHIP" },
          onMatch: "use_existing",
        },
      ],
      proposals: [
        {
          proposalId: "report",
          kind: "report.publish",
          name: `Synthetic evidence report ${n}`,
          policyVersion: "bks-admission-policy/v1",
          ...reportPublishFields(frozen),
          verdict: "NOT_SUPPORTED",
          about: ["claim"],
        },
      ],
    };
  }

  it("describe -> register -> assess -> receipt.get -> apply (pending_dispatch) -> stub consumer acknowledges", async () => {
    const described = BindingDescriptorSchema.parse((await call("/describe", token(null))).body);
    expect(described).toMatchObject({ binding: BINDING, application: "biotech" });
    expect(described.operations).toEqual(
      expect.arrayContaining(["report.register", "report.assess", "knowledge.apply"]),
    );
    expect(described.guarantees).toMatchObject({
      writeAtomicity: "marker_plus_outbox",
      nativeCancellation: "stop_dispatch_and_reconcile",
      admission: "exact_use_decision",
    });
    expect(described.pinnedSchema.name).toBe("knowledge-verification-2.5.0");

    const kase = reportKindCases(TENANT, BINDING, origin).find((candidate) => candidate.kindId === "evidence_report");
    if (kase === undefined) throw new Error("fixture");
    const register = envelopeFor({
      operation: "report.register",
      origin,
      binding: BINDING,
      payload: JSON.parse(
        JSON.stringify({
          task: kase.task,
          fragments: kase.fragments,
          assertions: kase.assertions,
          supportSets: kase.supportSets,
          report: {
            reportId: "report-sv16-biotech",
            revision: 1,
            kind: "evidence_report",
            structuredBody: kase.body,
            timeCoverage: { world: null, observed: null, knowledgeHead: null },
            supersedes: null,
          },
        }),
      ) as JsonValue,
    });
    const registered = await call("/invoke", token(register), register);
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    const receipt = OperationReceiptSchema.parse(registered.body);
    const runId = (receipt.details as { runId: string }).runId;
    const report = receipt.nativeReceiptRef as Ref<"report">;

    // Trusted setup (no K01 operation): an independent judge's support observation on the run.
    const backend = surface.backends[0];
    if (!backend?.capabilities.has("research")) throw new Error("biotech backend has no research services");
    const research = backend.research();
    const set = kase.supportSets[0] as (typeof kase.supportSets)[number];
    const assertion = kase.assertions[0] as (typeof kase.assertions)[number];
    await research.coordinator.observe(
      scope,
      runId,
      fixtureSupportObservation({
        tenant: TENANT,
        binding: BINDING,
        id: "obs-judge-biotech",
        set,
        fragment: kase.fragments[0] as (typeof kase.fragments)[number],
        role: "judge",
        verdict: "full_support",
        qualifiersDigest: qualifiersDigest(assertion.qualifiers),
      }),
    );

    const assess = envelopeFor({
      operation: "report.assess",
      origin,
      binding: BINDING,
      payload: { report } as unknown as JsonValue,
      upstream: [report],
      requestId: "assess:biotech",
    });
    const started = await call("/invoke", token(assess), assess);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const handle = OperationHandleSchema.parse(started.body);
    let status = OperationStatusSchema.parse(
      (await call(`/operations/${handle.operationId}`, token(null, ["operation.get"]))).body,
    );
    for (let i = 0; i < 40 && status.retryAfterMs !== null; i += 1) {
      await surface.service.settled();
      await new Promise((done) => setTimeout(done, 100));
      status = OperationStatusSchema.parse(
        (await call(`/operations/${handle.operationId}`, token(null, ["operation.get"]))).body,
      );
    }
    expect(["succeeded", "partial"]).toContain(status.state);

    const lookup = await call(`/receipts/${register.effect?.effectKey}`, token(null, ["receipt.get"]));
    expect(ReceiptLookupSchema.parse(lookup.body)).toEqual({ disposition: "found", receipt });

    // Trusted setup: seal the verification snapshot and decide the report use for the exact native effect.
    await research.coordinator.sealVerificationSnapshot(scope, {
      runId,
      build: { buildId: "build-sv16-biotech", runtime: "node24", dirty: true },
      signer: "ks-sealer",
    });
    const context = await research.binding.loadRunContext(scope, runId);
    const revision = context.report?.revision;
    if (!revision) throw new Error("revision missing");
    const frozen: FrozenReportBinding = {
      reportRevisionId: revision.id,
      reportKind: biotechReportKind(revision.kind.id),
      reportKindRef: revision.kind.id,
      reportSchema: revision.schemaVersion,
      bodyDigest: revision.bodyDigest,
      ledgerDigest: revision.ledger.digest,
      structuredBodyDigest: revision.structuredBody.digest,
    };
    const intent = intentFor(frozen, runId, "a");
    const native = biotechEffect(intent, origin);
    const decided = await research.coordinator.decideReportUse(scope, {
      runId,
      use: kase.task.use,
      audience: "official",
      boundEffectDigest: native.boundEffectDigest,
      targetSchema: "biotech-knowledge-intent.v2",
      normalizedValues: {},
      policy: kase.task.policy,
      rubric: kase.task.rubric,
    });
    expect(decided.decision.disposition).toBe("admitted");
    const epoch = await asTenant<{ e: string }>(
      "select knowledge_verification.current_revocation_epoch($1)::text as e",
      [TENANT],
    );
    const applyEnvelope = (body: Record<string, unknown>, bound: string, effectKey?: string) =>
      envelopeFor({
        operation: "knowledge.apply",
        origin,
        binding: BINDING,
        payload: body as JsonValue,
        nativeContract: { name: "biotech-knowledge-apply", version: "v1" },
        boundEffectDigest: bound,
        ...(effectKey ? { effectKey } : {}),
      });
    const request = {
      schemaVersion: "biotech-knowledge-apply.v1",
      intent,
      exactUse: {
        useDecisionId: decided.decision.id,
        processedEpoch: Number(epoch[0]?.e),
        normalizedValuesDigest: normalizedValuesDigest({}),
      },
    };
    const apply = applyEnvelope(request, native.boundEffectDigest);
    const applied = await call("/invoke", token(apply), apply);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const pending = OperationReceiptSchema.parse(applied.body);
    expect(pending.outcome).toBe("pending_dispatch");
    expect(pending.effect.boundEffectDigest).toBe(native.boundEffectDigest);
    const details = pending.details as { receiptState: string; dispatchId: string; expectedMarkerDigest: string };
    expect(details.receiptState).toBe("pending_dispatch");
    // The duplicate dispatch of the same effect answers the same receipt (receipt-first, protocol_receipt).
    const again = { ...apply, dispatchId: `dispatch-${randomUUID()}` };
    expect(OperationReceiptSchema.parse((await call("/invoke", token(again), again)).body)).toEqual(pending);
    const effectLookup = await call(`/receipts/${apply.effect?.effectKey}`, token(null, ["receipt.get"]));
    // receipt.get composes the delivery state at read time (the receipt stays immutable): not delivered yet.
    expect(ReceiptLookupSchema.parse(effectLookup.body)).toMatchObject({
      disposition: "found",
      receipt: pending,
      delivery: { state: "pending", dispatchId: details.dispatchId, nativeState: "pending", ackDigest: null },
    });
    // Edited bytes under a new key: the decision binds other bytes -> EFFECT_CONFLICT; a bound digest that does not
    // bind the intent -> EFFECT_CONFLICT before admission.
    const edited = intentFor(frozen, runId, "edited");
    const editedEnvelope = applyEnvelope(
      { ...request, intent: edited },
      biotechEffect(edited, origin).boundEffectDigest,
    );
    const refused = await call("/invoke", token(editedEnvelope), editedEnvelope);
    expect(ProtocolErrorSchema.parse(refused.body).code, JSON.stringify(refused.body)).toBe("EFFECT_CONFLICT");
    const forged = applyEnvelope(request, digestBytes("not the plan-level digest"));
    expect(ProtocolErrorSchema.parse((await call("/invoke", token(forged), forged)).body).code).toBe("EFFECT_CONFLICT");

    // The outbox row and D2's stub consumer (in process, real component, outbox worker role).
    const before = await asTenant<{ state: string; expected_marker_digest: string }>(
      "select state, expected_marker_digest from knowledge_verification.dispatch_outbox where tenant_id = $1 and dispatch_id = $2",
      [TENANT, details.dispatchId],
    );
    expect(before).toEqual([{ state: "pending", expected_marker_digest: details.expectedMarkerDigest }]);
    const db = new ComponentDatabase({ connectionString: dsn() });
    const stub = new StubBksExecutor(db, { installationId: INSTALLATION, applicationId: "biotech", tenantId: TENANT });
    const consumed = await stub.fetch("http://stub.bks.invalid/kg/admission/dispatch/consume", {
      method: "POST",
      headers: { authorization: "Bearer stub-service-token", "content-type": "application/json" },
      body: JSON.stringify({ tenantId: TENANT, limit: 10 }),
    });
    expect(consumed.status).toBe(200);
    const after = await asTenant<{ state: string; ack_digest: string }>(
      "select state, ack_digest from knowledge_verification.dispatch_outbox where tenant_id = $1 and dispatch_id = $2",
      [TENANT, details.dispatchId],
    );
    expect(after).toEqual([{ state: "acknowledged", ack_digest: details.expectedMarkerDigest }]);
    // pending -> applied: the same immutable receipt, delivery now from the verified acknowledgment.
    const delivered = ReceiptLookupSchema.parse(
      (await call(`/receipts/${apply.effect?.effectKey}`, token(null, ["receipt.get"]))).body,
    );
    expect(delivered).toMatchObject({
      disposition: "found",
      receipt: pending,
      delivery: {
        state: "applied",
        nativeState: "acknowledged",
        ackDigest: details.expectedMarkerDigest,
        targetBinding: "biotech-graph",
      },
    });
    expect(delivered.disposition === "found" && delivered.delivery?.ackedAt).toBeTruthy();
    await db.end();
    const rows = await asTenant<{ n: number }>(
      "select count(*)::int as n from knowledge_verification.protocol_receipt where tenant_id = $1",
      [TENANT],
    );
    expect(rows[0]?.n).toBe(2);
  }, 120_000);
});
