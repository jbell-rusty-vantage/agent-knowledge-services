/** Report/source foundation: real local K01 HTTP and component persistence, scripted judgments.
 * No native entity/graph writes, external search or model calls. Independent observations use
 * the application service directly; this is deliberately not proof of evaluator HTTP transport.
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { ReportKindCatalog, ScriptedAuditorDiscovery, SourceAuthorityCatalog } from "@aiengineer/knowledge-application";
import {
  AT,
  FIXTURE_SEAL_KEYS,
  EVIDENCE_REPORT_SCRIPT,
  fixtureSupportObservation,
  fixtureScientificQualifiers,
  fixtureBody,
  fixtureSupportSet,
  reportKindCases,
} from "@aiengineer/knowledge-application/testing";
import { createAiEngineerPostgresBackend, pinSealSigningKey } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { createBiotechGraphPostgresBackend } from "@aiengineer/knowledge-binding-biotech-graph";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  KnowledgeOperationService,
  staticJwksSource,
  type KnowledgeOperationBackend,
} from "@aiengineer/knowledge-host/knowledge-operation";
import {
  digestBytes,
  type JsonValue,
  type Digest,
  refOf,
  type OperationEnvelope,
  OperationHandleSchema,
  OperationReceiptSchema,
  OperationStatusSchema,
  ResearchReportPackageSchema,
  type Origin,
  type Ref,
} from "@aiengineer/knowledge-operation-protocol";
import { type AuthScope, qualifiersDigest, SCIENTIFIC_RUBRIC_VERSION } from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleKnowledgeOperation } from "./http.js";
import { requireLoopback } from "./tests/proof-guards.js";
import {
  claimsFor,
  envelopeFor,
  generateIssuerKey,
  jwksOf,
  liveOrigin,
  signCredential,
  TEST_AUDIENCE,
  TEST_INSTALLATION,
  TEST_ISSUER,
} from "./tests/test-support.js";

// Selecting this proof without its explicit local target fails, never silently skips.
const ADMIN = () => requireLoopback("KS_AIENG_DB_ADMIN_DSN", process.env.KS_AIENG_DB_ADMIN_DSN);
const TENANT = "00000000-0000-7000-8000-0000000000aa";
const ROOT = resolve(import.meta.dirname, "../../../..");
const KINDS = ReportKindCatalog.fromDirectory(resolve(ROOT, "catalog/research/report-kinds"));
const AUTHORITY = SourceAuthorityCatalog.fromDirectory(resolve(ROOT, "catalog/research/source-authority"));

describe.each(["ai-engineer", "biotech"] as const)("report-source foundation %s", (application) => {
  const binding = application === "ai-engineer" ? "aiengineer-postgres" : "biotech-graph";
  const database = `foundation_${randomBytes(5).toString("hex")}`;
  const key = generateIssuerKey("foundation-local");
  const origin = liveOrigin(TENANT, { application });
  const scope: AuthScope = { tenant: TENANT, application, binding, origin, grants: [] };
  let backend: KnowledgeOperationBackend;
  let service: KnowledgeOperationService;
  let server: Server | undefined;
  let url: string;
  let created = false;
  const dsn = () => {
    const value = new URL(ADMIN());
    value.pathname = `/${database}`;
    return value.toString();
  };

  async function start() {
    const options = {
      application,
      binding,
      installationId: TEST_INSTALLATION,
      connectionString: dsn(),
      kinds: KINDS,
      authority: AUTHORITY,
      seal: FIXTURE_SEAL_KEYS,
      clock: { now: () => AT },
      auditor: new ScriptedAuditorDiscovery({
        entries: [
          ...EVIDENCE_REPORT_SCRIPT.entries,
          { quote: "Model X has 9B parameters.", assertionLogicalId: "model-size" },
          { quote: "Product A label lists cellulose.", assertionLogicalId: "model-size" },
          { quote: "Product A label lists caffeine.", assertionLogicalId: "model-size" },
        ],
      }),
    };
    backend = await (application === "ai-engineer"
      ? createAiEngineerPostgresBackend(options)
      : createBiotechGraphPostgresBackend(options));
    service = new KnowledgeOperationService({
      verifier: new KnowledgeCredentialVerifier({
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        jwks: new JwksCache(staticJwksSource(jwksOf([key]))),
      }),
      backends: [backend],
      installed: [{ application, binding, installationId: TEST_INSTALLATION, tenants: [TENANT] }],
      dispatches: new DispatchRegistry(),
      signingIssuer: "foundation-local",
    });
    server = createServer((request, response) => {
      void handleKnowledgeOperation(request, response, new URL(request.url ?? "/", "http://localhost"), service);
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/knowledge-operation/v2`;
  }
  async function stop() {
    if (!server) return;
    await service.settled();
    await new Promise<void>((done, reject) => server!.close((error) => (error ? reject(error) : done())));
    server = undefined;
    await backend.close();
  }
  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN() });
    await admin.connect();
    try {
      await admin.query(`create database ${database}`);
      created = true;
    } finally {
      await admin.end();
    }
    await install(loadComponent(), {
      adminDsn: dsn(),
      installationId: TEST_INSTALLATION,
      applicationId: application,
      binding,
    });
    await pinSealSigningKey(dsn(), { keyId: FIXTURE_SEAL_KEYS.signer.keyId, publicKey: FIXTURE_SEAL_KEYS.publicKey });
    await start();
  });
  afterAll(async () => {
    await stop();
    if (!created) return;
    const admin = new Client({ connectionString: ADMIN() });
    await admin.connect();
    try {
      await admin.query(`drop database ${database} with (force)`);
    } finally {
      await admin.end();
    }
  });

  async function invoke(envelope: OperationEnvelope, actor: Origin = origin) {
    const token = signCredential(
      key,
      claimsFor({
        origin: actor,
        binding,
        operations: [envelope.operation],
        dispatchId: envelope.dispatchId,
        effect: envelope.effect
          ? { effectKey: envelope.effect.effectKey, boundEffectDigest: envelope.effect.boundEffectDigest }
          : null,
      }),
    );
    const response = await fetch(`${url}/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    return { status: response.status, body: await response.json() };
  }
  async function status(operationId: string) {
    await service.settled();
    const token = signCredential(
      key,
      claimsFor({
        origin,
        binding,
        operations: ["operation.get"],
        dispatchId: `status-${randomBytes(6).toString("hex")}`,
      }),
    );
    const response = await fetch(`${url}/operations/${operationId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    return OperationStatusSchema.parse(await response.json());
  }

  it("keeps unsupported report unmet, accepts repaired evidence, and preserves exact bytes and receipts after restart", async () => {
    const kase = reportKindCases(TENANT, binding, origin).find((item) => item.kindId === "evidence_report")!;
    const scientific = application === "biotech";
    const task = {
      ...kase.task,
      domain: scientific ? "scientific" : "engineering",
      use: scientific ? "label_reference.ingredients" : "engineering_reference.model_facts",
      audience: "internal",
      rubric: scientific
        ? { ...kase.task.rubric, id: "rubric-scientific", version: SCIENTIFIC_RUBRIC_VERSION }
        : kase.task.rubric,
    };
    const correct = scientific ? "Product A label lists cellulose." : "Model X has 7B parameters.";
    const incorrect = scientific ? "Product A label lists caffeine." : "Model X has 9B parameters.";
    // Synthetic replay capture, explicitly local; actual immutable bytes in component custody.
    const source = Buffer.from(scientific ? "Product A label: cellulose." : "Model X card: 7B parameters.");
    const capture = await backend.research().binding.custody.put(scope, source, "text/plain");
    const quote = scientific ? "cellulose" : "7B parameters";
    const fragment = {
      ...kase.fragments[0]!,
      capture,
      representation: capture,
      selector: { ...kase.fragments[0]!.selector, value: quote },
      selectedDigest: digestBytes(quote),
      selectedSize: Buffer.byteLength(quote),
    };
    function records(revision: number) {
      const proposition = revision === 1 ? incorrect : correct;
      const assertion = {
        ...kase.assertions[0]!,
        id: `foundation-asr-r${revision}`,
        proposition,
        value: scientific
          ? { type: "text" as const, value: revision === 1 ? "caffeine" : "cellulose" }
          : { type: "quantity" as const, amount: revision === 1 ? "9000000000" : "7000000000", unit: "parameters" },
        qualifiers: scientific
          ? {
              ...fixtureScientificQualifiers(),
              entity: "product-a",
              population: null,
              studyDesign: null,
              species: null,
              intervention: null,
              comparator: null,
              sampleSize: null,
            }
          : kase.assertions[0]!.qualifiers,
      };
      const set = { ...fixtureSupportSet(TENANT, binding, assertion, fragment), id: `foundation-set-r${revision}` };
      const body = JSON.parse(
        JSON.stringify(fixtureBody(assertion, fragment))
          .replaceAll("Model X has 7B parameters.", proposition)
          .replaceAll(
            "Parameter count of Model X for official ingestion, as of 2026-10-24.",
            "Synthetic replay source comparison; no native ingestion or clinical inference.",
          )
          .replaceAll(
            "The vendor model card states the parameter count.",
            "The captured replay document is the sole source.",
          ),
      );
      return { assertion, set, body };
    }
    function registrationEnvelope(revision: number, supersedes: Ref | null) {
      return envelopeFor({
        operation: "report.register",
        origin,
        binding,
        payload: JSON.parse(
          JSON.stringify({
            task,
            fragments: [fragment],
            assertions: [records(revision).assertion],
            supportSets: [records(revision).set],
            report: {
              reportId: "foundation-report",
              revision,
              kind: "evidence_report",
              structuredBody: records(revision).body,
              timeCoverage: { world: null, observed: null, knowledgeHead: null },
              supersedes,
            },
          }),
        ) as JsonValue,
      });
    }
    async function register(revision: number, supersedes: Ref | null) {
      const envelope = registrationEnvelope(revision, supersedes);
      const result = await invoke(envelope);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      return { envelope, receipt: OperationReceiptSchema.parse(result.body) };
    }
    const first = await register(1, null);
    const research = backend.research();
    async function assess(report: Ref) {
      const envelope = envelopeFor({
        operation: "report.assess",
        origin,
        binding,
        payload: { report, obligation: "root.report", submission: `sub-${report.id}` } as unknown as JsonValue,
        upstream: [report],
        requestId: `assess-${report.id}`,
      });
      const response = await invoke(envelope);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      return status(OperationHandleSchema.parse(response.body).operationId);
    }
    const firstRun = await research.locator.runOf(scope, refOf("report").parse(first.receipt.nativeReceiptRef));
    const refusal = fixtureSupportObservation({
      tenant: TENANT,
      binding,
      id: "foundation-refutation",
      set: records(1).set,
      fragment,
      role: "judge",
      verdict: "contradiction",
      qualifiersDigest: qualifiersDigest(records(1).assertion.qualifiers),
    });
    await research.coordinator.observe(scope, firstRun!, {
      ...refusal,
      usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
      rationale: "Scripted local comparator: the proposed property contradicts the captured bytes.",
    });
    const failed = await assess(first.receipt.nativeReceiptRef);
    expect(failed.state).toBe("held");
    const unknown = await invoke(
      registrationEnvelope(2, { ...first.receipt.nativeReceiptRef, id: "unknown-report-r1" }),
    );
    expect(unknown.status).toBe(404);
    expect(JSON.stringify(unknown.body)).toContain("supersedes_unknown");
    for (const predecessor of [
      { ...first.receipt.nativeReceiptRef, digest: digestBytes("wrong predecessor") },
      { ...first.receipt.nativeReceiptRef, version: "research-report.v999" },
    ]) {
      const rejected = await invoke(registrationEnvelope(2, predecessor));
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(rejected.body)).toContain("EXACT_REVISION_UNAVAILABLE");
      expect(JSON.stringify(rejected.body)).toContain("supersedes_mismatch");
    }
    const repaired = await register(2, first.receipt.nativeReceiptRef);
    const report = refOf("report").parse(repaired.receipt.nativeReceiptRef);
    const runId = await research.locator.runOf(scope, report);
    expect(runId).not.toBeNull();
    const set = records(2).set;
    const observation = fixtureSupportObservation({
      tenant: TENANT,
      binding,
      id: "foundation-independent-judge",
      set,
      fragment,
      role: "judge",
      verdict: "full_support",
      qualifiersDigest: qualifiersDigest(records(2).assertion.qualifiers),
    });
    await research.coordinator.observe(scope, runId!, {
      ...observation,
      usage: { providerCalls: 0, tokens: 0, costUsd: "0" },
      rationale: "Scripted local evidence check; not model qualification.",
    });
    const assessed = await assess(report);
    expect(assessed.state).not.toBe("held");
    await research.coordinator.sealVerificationSnapshot(scope, {
      runId: runId!,
      build: { buildId: "foundation-local", runtime: "node", dirty: true },
      signer: "foundation-sealer",
    });
    const decision = await research.coordinator.decideReportUse(scope, {
      runId: runId!,
      use: task.use,
      audience: task.audience,
      boundEffectDigest: report.digest as Digest,
      targetSchema: "research-report.v2",
      normalizedValues: {},
      policy: task.policy,
      rubric: task.rubric,
    });
    expect(decision.decision.disposition).toBe("admitted");
    const context = await research.binding.loadRunContext(scope, runId!);
    const body = await research.binding.custody.get(scope, context.report!.revision.body);
    expect(digestBytes(body)).toBe(context.report!.revision.bodyDigest);
    expect(Buffer.from(body).toString("utf8")).toContain(correct);
    expect(Buffer.from(body).toString("utf8")).not.toContain(incorrect);
    expect(await research.binding.custody.get(scope, capture)).toEqual(source);
    const read = envelopeFor({
      operation: "knowledge.read",
      origin,
      binding,
      payload: {
        report,
        exact: true,
        purpose: "dependent_input",
        selection: { mode: "revision" },
      } as unknown as JsonValue,
      upstream: [report],
      requestId: "foundation-consumer",
    });
    const reading = await invoke(read);
    expect(reading.status, JSON.stringify(reading.body)).toBe(202);
    const handle = OperationHandleSchema.parse(reading.body);
    const readStatus = await status(handle.operationId);
    expect(readStatus.state).toBe("succeeded");
    expect(readStatus.resultRef?.kind).toBe("artifact");
    const packageBytes = await research.binding.custody.get(scope, readStatus.resultRef as Ref<"artifact">);
    expect(digestBytes(packageBytes)).toBe(readStatus.resultRef!.digest);
    const selectedPackage = ResearchReportPackageSchema.parse(JSON.parse(Buffer.from(packageBytes).toString("utf8")));
    expect(selectedPackage.report).toEqual(report);
    expect(selectedPackage.purpose).toBe("dependent_input");
    expect(selectedPackage.body!.digest).toBe(context.report!.revision.bodyDigest);
    expect(await research.binding.custody.get(scope, selectedPackage.body!.artifact)).toEqual(body);
    await stop();
    await start();
    expect(await status(handle.operationId)).toEqual(readStatus);
    expect(await backend.research().binding.custody.get(scope, readStatus.resultRef as Ref<"artifact">)).toEqual(
      packageBytes,
    );
    expect(await backend.research().binding.custody.get(scope, selectedPackage.body!.artifact)).toEqual(body);
    const replay = { ...repaired.envelope, dispatchId: `replay-${randomBytes(6).toString("hex")}` };
    expect(OperationReceiptSchema.parse((await invoke(replay)).body)).toEqual(repaired.receipt);
    const restored = await backend.research().binding.loadRunContext(scope, runId!);
    expect(await backend.research().binding.custody.get(scope, restored.report!.revision.body)).toEqual(body);
    const wrong = { ...report, digest: digestBytes("wrong") };
    const substituted = envelopeFor({
      operation: "knowledge.read",
      origin,
      binding,
      payload: {
        report: wrong,
        exact: true,
        purpose: "dependent_input",
        selection: { mode: "revision" },
      } as unknown as JsonValue,
      upstream: [wrong],
      requestId: "foundation-wrong",
    });
    const refused = await invoke(substituted);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const other = liveOrigin("00000000-0000-7000-8000-0000000000bb", { application });
    const unauthorized = envelopeFor({
      operation: "knowledge.read",
      origin: other,
      binding,
      payload: {
        report,
        exact: true,
        purpose: "dependent_input",
        selection: { mode: "revision" },
      } as unknown as JsonValue,
      upstream: [report],
    });
    expect((await invoke(unauthorized, other)).status).toBeGreaterThanOrEqual(400);
    // The failed revision has not been repaired in place or rewritten by the successful successor.
    expect(await status(failed.handle.operationId)).toEqual(failed);
    const admin = new Client({ connectionString: dsn() });
    await admin.connect();
    try {
      const counts = await admin.query(
        "select count(*)::int as n from knowledge_verification.protocol_receipt where tenant_id=$1",
        [TENANT],
      );
      expect(counts.rows[0].n).toBe(2);
    } finally {
      await admin.end();
    }
  });
});
