import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReportKindCatalog, ScriptedAuditorDiscovery } from "@aiengineer/knowledge-application";
import { EVIDENCE_REPORT_SCRIPT, reportKindCases } from "@aiengineer/knowledge-application/testing";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import {
  type JsonValue,
  type OperationEnvelope,
  OperationHandleSchema,
  OperationReceiptSchema,
  OperationStatusSchema,
  ProtocolErrorSchema,
  ReceiptLookupSchema,
  BindingDescriptorSchema,
  type Origin,
} from "@aiengineer/knowledge-operation-protocol";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  staticJwksSource,
} from "@aiengineer/knowledge-host/knowledge-operation";
import { createAiEngineerPostgresBackend } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { handleKnowledgeOperation } from "./http.js";
import type { KnowledgeOperationBackend } from "@aiengineer/knowledge-host/knowledge-operation";
import { KnowledgeOperationService } from "@aiengineer/knowledge-host/knowledge-operation";
import {
  TEST_AUDIENCE,
  TEST_INSTALLATION,
  TEST_ISSUER,
  claimsFor,
  envelopeFor,
  generateIssuerKey,
  jwksOf,
  liveOrigin,
  recoveryOriginFor,
  signCredential,
} from "./tests/test-support.js";

/**
 * SV-16 T1-KS over the disposable PostgreSQL 17 (`KS_AIENG_DB_ADMIN_DSN`, container sprint-v-pg17): the K05
 * binding over component `knowledge_verification` 2.2.0, reached only through the K01 routes with K07 credentials.
 * report.register -> report.assess handle -> status terminal -> receipt.get, then a NEW service instance over the same
 * database (an executor restart) still answers the handle, the receipt and the exact read. Engineering fixtures only.
 */
const ADMIN = process.env.KS_AIENG_DB_ADMIN_DSN;
const describeDb = ADMIN ? describe : describe.skip;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const KINDS = ReportKindCatalog.fromDirectory(resolve(ROOT, "catalog/research/report-kinds"));
const TENANT = "00000000-0000-7000-8000-0000000000aa";
const BINDING = "aiengineer-postgres";

describeDb("ks.knowledge_operation.v2 over the AI Engineer PostgreSQL binding", () => {
  const database = `kvop_${randomBytes(4).toString("hex")}`;
  const key = generateIssuerKey("mc-issuer-pg");
  const dsn = () => {
    const url = new URL(ADMIN as string);
    url.pathname = `/${database}`;
    return url.toString();
  };
  const servers: { server: Server; service: KnowledgeOperationService; backend: KnowledgeOperationBackend }[] = [];

  async function start(): Promise<{ url: string; service: KnowledgeOperationService }> {
    const backend = await createAiEngineerPostgresBackend({
      application: "ai-engineer",
      binding: BINDING,
      installationId: TEST_INSTALLATION,
      connectionString: dsn(),
      kinds: KINDS,
      auditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT),
      retryAfterMs: 100,
    });
    const service = new KnowledgeOperationService({
      verifier: new KnowledgeCredentialVerifier({
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        jwks: new JwksCache(staticJwksSource(jwksOf([key]))),
      }),
      backends: [backend],
      installed: [
        { application: "ai-engineer", binding: BINDING, installationId: TEST_INSTALLATION, tenants: [TENANT] },
      ],
      dispatches: new DispatchRegistry(),
      signingIssuer: "knowledge-services",
      retryAfterMs: 100,
    });
    const server = createServer((request, response) => {
      void handleKnowledgeOperation(request, response, new URL(request.url ?? "/", "http://localhost"), service);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    servers.push({ server, service, backend });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/knowledge-operation/v2`, service };
  }

  async function stop(): Promise<void> {
    for (const { server, service, backend } of servers.splice(0)) {
      await service.settled();
      await new Promise<void>((done) => server.close(() => done()));
      await backend.close();
    }
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`create database ${database}`);
    await admin.end();
    const receipt = await install(loadComponent(), {
      adminDsn: dsn(),
      installationId: TEST_INSTALLATION,
      applicationId: "ai-engineer",
      binding: BINDING,
    });
    expect(receipt.componentVersion).toBe("2.5.0");
  });

  afterAll(async () => {
    await stop();
    const admin = new Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  const token = (
    envelope: OperationEnvelope | null,
    origin: Origin,
    extra: Partial<Parameters<typeof claimsFor>[0]> = {},
  ) =>
    signCredential(
      key,
      claimsFor({
        origin,
        operations: envelope ? [envelope.operation] : ["knowledge.describe"],
        dispatchId: envelope?.dispatchId ?? `dispatch-${randomBytes(6).toString("hex")}`,
        binding: BINDING,
        effect: envelope?.effect
          ? { effectKey: envelope.effect.effectKey, boundEffectDigest: envelope.effect.boundEffectDigest }
          : null,
        ...extra,
      }),
    );

  async function call(url: string, bearer: string, body?: unknown) {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  function payload(origin: Origin, reportId = "report-sv16-pg"): JsonValue {
    const kase = reportKindCases(TENANT, BINDING, origin).find((candidate) => candidate.kindId === "evidence_report");
    if (kase === undefined) throw new Error("fixture");
    return JSON.parse(
      JSON.stringify({
        task: kase.task,
        fragments: kase.fragments,
        assertions: kase.assertions,
        supportSets: kase.supportSets,
        report: {
          reportId,
          revision: 1,
          kind: "evidence_report",
          structuredBody: kase.body,
          timeCoverage: { world: null, observed: null, knowledgeHead: null },
          supersedes: null,
        },
      }),
    ) as JsonValue;
  }

  it("register -> assess handle -> terminal status -> receipt.get; a restarted executor answers the same records", async () => {
    const first = await start();
    const origin = liveOrigin(TENANT);
    const describeBody = BindingDescriptorSchema.parse((await call(`${first.url}/describe`, token(null, origin))).body);
    expect(describeBody.pinnedSchema.name).toBe("knowledge-verification-2.5.0");
    expect(describeBody.operations).toContain("report.assess");

    const register = envelopeFor({ operation: "report.register", origin, binding: BINDING, payload: payload(origin) });
    const registered = await call(`${first.url}/invoke`, token(register, origin), register);
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    const receipt = OperationReceiptSchema.parse(registered.body);
    expect(receipt.outcome).toBe("applied");
    const effectKey = register.effect?.effectKey as string;

    // Concurrent duplicate dispatches of the same effect by the originator: one receipt.
    const dupes = await Promise.all(
      [1, 2].map(async (n) => {
        const again = { ...register, dispatchId: `dispatch-dupe-${n}` };
        return call(`${first.url}/invoke`, token(again, origin), again);
      }),
    );
    for (const dupe of dupes) expect(OperationReceiptSchema.parse(dupe.body)).toEqual(receipt);
    // Integrator decision 2026-10-25: re-registering IDENTICAL K02 records (same id and digest) is idempotent (same ref),
    // so a second report over the same evidence is a new effect that succeeds (K05 change by helper B1b).
    const secondReport = envelopeFor({
      operation: "report.register",
      origin,
      binding: BINDING,
      payload: payload(origin, "report-sv16-pg-2"),
    });
    const secondResult = await call(`${first.url}/invoke`, token(secondReport, origin), secondReport);
    expect(secondResult.status, JSON.stringify(secondResult.body)).toBe(200);
    expect(OperationReceiptSchema.parse(secondResult.body).nativeReceiptRef.id).toBe("report-sv16-pg-2-r1");

    const report = receipt.nativeReceiptRef;
    const assess = envelopeFor({
      operation: "report.assess",
      origin,
      binding: BINDING,
      payload: { report, obligation: "evidence", submission: "sub-pg" } as unknown as JsonValue,
      upstream: [report],
      requestId: "assess:sub-pg",
    });
    const started = await call(`${first.url}/invoke`, token(assess, origin), assess);
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const handle = OperationHandleSchema.parse(started.body);
    await first.service.settled();
    let status = OperationStatusSchema.parse(
      (
        await call(
          `${first.url}/operations/${handle.operationId}`,
          token(null, origin, { operations: ["operation.get"] }),
        )
      ).body,
    );
    for (let i = 0; i < 20 && status.retryAfterMs !== null; i += 1) {
      await first.service.settled();
      await new Promise((done) => setTimeout(done, status.retryAfterMs ?? 100));
      status = OperationStatusSchema.parse(
        (
          await call(
            `${first.url}/operations/${handle.operationId}`,
            token(null, origin, { operations: ["operation.get"] }),
          )
        ).body,
      );
    }
    // No judge observation is registered by the producer: the independent census runs and missing support holds.
    expect(status.state).toBe("held");
    expect(status.resultRef).not.toBeNull();

    const lookup = await call(
      `${first.url}/receipts/${effectKey}`,
      token(null, origin, { operations: ["receipt.get"] }),
    );
    expect(ReceiptLookupSchema.parse(lookup.body)).toEqual({ disposition: "found", receipt });

    // A credential used once before the restart ...
    const usedOnce = token(null, origin, { operations: ["operation.get"] });
    expect((await call(`${first.url}/operations/${handle.operationId}`, usedOnce)).status).toBe(200);
    // Restart: a new executor over the same database.
    await stop();
    const second = await start();
    // ... is still single use after it (component 2.3.0 credential_use; the in-process cache is gone).
    const replayed = await call(`${second.url}/operations/${handle.operationId}`, usedOnce);
    expect(replayed.status).toBe(401);
    expect(ProtocolErrorSchema.parse(replayed.body).details).toEqual({ reason: "replay" });
    const afterRestart = OperationStatusSchema.parse(
      (
        await call(
          `${second.url}/operations/${handle.operationId}`,
          token(null, origin, { operations: ["operation.get"] }),
        )
      ).body,
    );
    expect(afterRestart).toEqual(status);
    const recovery = recoveryOriginFor(TENANT, "recovery-grant-pg");
    const recovered = await call(
      `${second.url}/receipts/${effectKey}`,
      token(null, recovery, {
        operations: ["receipt.get"],
        recovery: {
          scope: "read_only",
          authorityRef: "recovery-grant-pg",
          effectKey,
          boundEffectDigest: register.effect?.boundEffectDigest as string,
        },
      }),
    );
    expect(ReceiptLookupSchema.parse(recovered.body)).toEqual({ disposition: "found", receipt });
    // The retry after restart still deduplicates (receipt-first, durable).
    const late = { ...register, dispatchId: "dispatch-after-restart" };
    expect(OperationReceiptSchema.parse((await call(`${second.url}/invoke`, token(late, origin), late)).body)).toEqual(
      receipt,
    );
    // Same key, other bytes: EFFECT_CONFLICT from the component's bind_effect.
    const edited = envelopeFor({
      operation: "report.register",
      origin,
      binding: BINDING,
      effectKey,
      payload: { ...(payload(origin) as Record<string, JsonValue>), fragments: [] },
    });
    const conflict = await call(`${second.url}/invoke`, token(edited, origin), edited);
    expect(ProtocolErrorSchema.parse(conflict.body).code).toBe("EFFECT_CONFLICT");
    expect(conflict.status).toBe(409);

    // Exact read through the K05 report index and custody.
    const read = envelopeFor({
      operation: "knowledge.read",
      origin,
      binding: BINDING,
      payload: {
        report,
        exact: true,
        purpose: "dependent_input",
        selection: { mode: "revision" },
      } as unknown as JsonValue,
      upstream: [report],
      requestId: "read:pg",
    });
    const readHandle = OperationHandleSchema.parse(
      (await call(`${second.url}/invoke`, token(read, origin), read)).body,
    );
    const readStatus = OperationStatusSchema.parse(
      (
        await call(
          `${second.url}/operations/${readHandle.operationId}`,
          token(null, origin, { operations: ["operation.get"] }),
        )
      ).body,
    );
    expect(readStatus.state).toBe("succeeded");
    expect(readStatus.resultRef?.version).toBe("research-report-package.v2");

    // Durable rows: one effect, one receipt, operations for the assessment and the read.
    const admin = new Client({ connectionString: dsn() });
    await admin.connect();
    try {
      const counts = await admin.query<{ effects: string; receipts: string; operations: string }>(
        `select (select count(*) from knowledge_verification.effect where tenant_id = $1)::text as effects,
                (select count(*) from knowledge_verification.effect_receipt where tenant_id = $1)::text as receipts,
                (select count(*) from knowledge_verification.operation where tenant_id = $1)::text as operations,
                (select count(*) from knowledge_verification.protocol_receipt where tenant_id = $1)::text as protocol_receipts,
                (select (count(*) > 10)::text from knowledge_verification.credential_use where tenant_id = $1) as nonces`,
        [TENANT],
      );
      // Two effects (two registrations over the same evidence), each with its receipt.
      expect(counts.rows[0]).toEqual({
        effects: "2",
        receipts: "2",
        operations: "2",
        protocol_receipts: "2",
        nonces: "true",
      });
    } finally {
      await admin.end();
    }
  });
});
