/** Real local K01 fixture host. Stdin is a trusted controller; no scripted judgments or automatic graph dispatch. */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import {
  Ed25519SealSigner,
  StaticSealVerifier,
  ReportKindCatalog,
  SourceAuthorityCatalog,
} from "@aiengineer/knowledge-application";
import { pinSealSigningKey } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import {
  createBiotechGraphPostgresBackend,
  biotechEffect,
  assertReportBinding,
} from "@aiengineer/knowledge-binding-biotech-graph";
import { install, loadComponent } from "@aiengineer/knowledge-db-contract";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  KnowledgeOperationService,
  staticJwksSource,
} from "@aiengineer/knowledge-host/knowledge-operation";
import {
  DecisionResolutionSchema,
  digestBytes,
  digestCanonical,
  OperationHandleSchema,
  OperationStatusSchema,
  OriginSchema,
  type Origin,
  type Ref,
  type OperationName,
  type JsonValue,
} from "@aiengineer/knowledge-operation-protocol";
import { normalizedValuesDigest, type AuthScope } from "@aiengineer/knowledge-research-core";
import { Client } from "pg";
import { handleKnowledgeOperation } from "../http.js";
import { requireLoopback, requireBksRoot } from "./proof-guards.js";
import { envelopeFor, generateIssuerKey, jwksOf, TEST_AUDIENCE, TEST_ISSUER } from "./test-support.js";
import type { QualiaK01Host } from "./qualia-host.js";
import { prepareQualiaReport, type CapturedSource } from "./qualia-report.js";
import { qualiaEvaluationRequest, qualiaEvaluationSubmission } from "./qualia-evaluation.js";
import { qualiaAssessmentPreview } from "./qualia-assessment.js";
import { qualiaCredential, qualiaRoles } from "./qualia-credentials.js";
import { assertQualiaCaptureId, bindQualiaNativeCaptures, retainQualiaCapture } from "./qualia-captures.js";
import {
  hydrateQualiaFrozenReport,
  retainQualiaFragmentBinding,
  type QualiaFragmentCaptureBinding,
} from "./qualia-frozen.js";

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  origin: Origin;
  keyPath: string;
  evidenceRoot: string;
  bksRoot?: string;
};
const origin = OriginSchema.parse(config.origin);
if (origin.applicationId !== "biotech") throw new Error("Qualia requires biotech application");
const root = resolve(import.meta.dirname, "../../../../..");
const binding = "biotech-graph";
const scope: AuthScope = { tenant: origin.tenantId, application: "biotech", binding, origin, grants: [] };
const database = `qualia_fixture_${randomBytes(6).toString("hex")}`;
const adminDsn = requireLoopback("KNOWLEDGE_DB_CONTRACT_ADMIN_DSN", process.env.KNOWLEDGE_DB_CONTRACT_ADMIN_DSN);
const connection = new URL(adminDsn);
connection.pathname = `/${database}`;
mkdirSync(config.evidenceRoot, { recursive: true });
mkdirSync(dirname(config.keyPath), { recursive: true });
const record = async (kind: string, value: unknown) =>
  appendFileSync(
    resolve(config.evidenceRoot, "ks-host.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), kind, value })}\n`,
  );
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const admin = new Client({ connectionString: adminDsn });
await admin.connect();
await admin.query(`create database ${database}`);
await admin.end();
await install(loadComponent(), {
  adminDsn: connection.toString(),
  installationId: origin.installationId,
  applicationId: "biotech",
  binding,
});
const key = generateIssuerKey(`qualia-${randomBytes(4).toString("hex")}`);
writeFileSync(config.keyPath, JSON.stringify(key.privateJwk), { mode: 0o600, flag: "wx" });
const signer = Ed25519SealSigner.fromSeed(`qualia-seal-${randomBytes(4).toString("hex")}`, randomBytes(32));
const publicKey = signer.publicKeyRaw();
await pinSealSigningKey(connection.toString(), { keyId: signer.keyId, publicKey });
const backend = await createBiotechGraphPostgresBackend({
  application: "biotech",
  binding,
  installationId: origin.installationId,
  connectionString: connection.toString(),
  kinds: ReportKindCatalog.fromDirectory(resolve(root, "catalog/research/report-kinds")),
  authority: SourceAuthorityCatalog.fromDirectory(resolve(root, "catalog/research/source-authority")),
  seal: { signer, verifier: new StaticSealVerifier([{ keyId: signer.keyId, publicKey, status: "active" }]) },
  auditor: null,
});
const service = new KnowledgeOperationService({
  verifier: new KnowledgeCredentialVerifier({
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    jwks: new JwksCache(staticJwksSource(jwksOf([key]))),
  }),
  backends: [backend],
  installed: [{ application: "biotech", binding, installationId: origin.installationId, tenants: [origin.tenantId] }],
  dispatches: new DispatchRegistry(),
  signingIssuer: "qualia-fixture-host",
});
const server = createServer((req, res) => {
  void handleKnowledgeOperation(req, res, new URL(req.url ?? "/", "http://localhost"), service).then((handled) => {
    if (!handled) {
      res.statusCode = 404;
      res.end();
    }
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const research = backend.research();
const captures = new Map<string, CapturedSource>();
const fragmentCaptureBindings = new Map<string, QualiaFragmentCaptureBinding>();
const evaluationRequests = new Map<string, ReturnType<typeof qualiaEvaluationRequest>>();
const roles = qualiaRoles(origin);
function token(
  actor: keyof typeof roles,
  operations: OperationName[],
  dispatchId: string,
  effect: { effectKey: string; boundEffectDigest: string } | null = null,
) {
  return qualiaCredential({ key, roles, actor, operations, dispatchId, effect }).token;
}
async function http(
  actor: keyof typeof roles,
  path: string,
  operations: OperationName[],
  dispatchId: string,
  body?: unknown,
  effect?: { effectKey: string; boundEffectDigest: string } | null,
) {
  const response = await fetch(`${url}/knowledge-operation/v2${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token(actor, operations, dispatchId, effect)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`K01 ${response.status}: ${text}`);
  return { text, headers: response.headers };
}
const host: QualiaK01Host = {
  record,
  async frozenReport(report) {
    const runId = await research.locator.runOf(scope, report);
    if (!runId) throw new Error("Unknown registered report");
    const context = await research.binding.loadRunContext(scope, runId);
    return hydrateQualiaFrozenReport({
      report,
      context,
      sources: captures.values(),
      fragmentBindings: fragmentCaptureBindings,
      loadFragments: (refs) => research.binding.loadFragments(scope, refs),
      readArtifact: (ref) => research.binding.custody.get(scope, ref),
    });
  },
  async call(request) {
    const envelope = envelopeFor({
      operation: request.operation as OperationName,
      origin: roles[request.actor],
      binding,
      payload: request.payload as JsonValue,
      nativeContract: request.nativeContract,
      requestId: request.requestId,
      upstream: request.upstream,
      effectKey: request.effectKey,
      boundEffectDigest: request.boundEffectDigest,
    });
    envelope.issuedAt = new Date().toISOString().replace(/\.(\d*?)0+Z$/, (_m, d: string) => (d ? `.${d}Z` : "Z"));
    await record("request", envelope);
    const response = JSON.parse(
      (await http(request.actor, "/invoke", [envelope.operation], envelope.dispatchId, envelope, envelope.effect)).text,
    ) as Record<string, unknown>;
    const parsedHandle = OperationHandleSchema.safeParse(response);
    if (!parsedHandle.success) return response;
    const handle = parsedHandle.data;
    for (let i = 0; i < 120; i++) {
      await service.settled();
      const status = OperationStatusSchema.parse(
        JSON.parse(
          (
            await http(
              request.actor,
              `/operations/${encodeURIComponent(handle.operationId)}`,
              ["operation.get"],
              `${request.requestId}:status-${i}`,
            )
          ).text,
        ),
      );
      await record("status", status);
      if (status.resultRef) {
        const artifact = await http(
          request.actor,
          `/artifacts/${encodeURIComponent(status.resultRef.id)}?digest=${encodeURIComponent(status.resultRef.digest)}`,
          ["knowledge.read"],
          `${request.requestId}:result-${i}`,
        );
        if (digestBytes(Buffer.from(artifact.text, "utf8")) !== status.resultRef.digest)
          throw new Error("K01 result artifact digest mismatch");
        return JSON.parse(artifact.text) as Record<string, unknown>;
      }
      if (["failed", "cancelled", "rejected"].includes(status.state))
        throw new Error(`K01 terminal failure ${JSON.stringify(status)}`);
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error("Bounded K01 poll budget exhausted");
  },
};
send({
  ready: true,
  url,
  issuer: TEST_ISSUER,
  audience: TEST_AUDIENCE,
  keyPath: config.keyPath,
  database,
  roles,
  qualified: false,
});
await record("ready", { url, database, roles, qualified: false });
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const command = JSON.parse(line) as Record<string, any>;
    try {
      if (command.action === "stop") {
        send({ stopped: true, databasePreserved: database });
        break;
      }
      if (command.action === "capture") {
        if (typeof command.text !== "string" || typeof command.sourceUrl !== "string")
          throw new Error("Capture requires actual text and sourceUrl");
        const bytes = Buffer.from(command.text, "utf8");
        const captureId =
          command.captureId ??
          digestCanonical({ sourceUrl: command.sourceUrl, contentDigest: digestBytes(bytes) }).slice(7, 39);
        assertQualiaCaptureId(captureId);
        const ref = await research.binding.custody.put(scope, bytes, command.mediaType ?? "text/plain");
        const captured = retainQualiaCapture(captures, {
          captureId,
          url: command.sourceUrl,
          text: command.text,
          ref,
          title: command.title,
          retrievedAt: new Date().toISOString(),
          completeness: command.completeness ?? "unknown",
        });
        await record("capture", { captureId, ref: captured.ref, sourceUrl: captured.url });
        send({ captureId, sourceUrl: captured.url, ref: captured.ref });
      } else if (command.action === "prepare_report") {
        const registration = await prepareQualiaReport({
          authored: command.input,
          sources: [...captures.values()],
          origin,
          put: (bytes, mediaType) => research.binding.custody.put(scope, bytes, mediaType),
          bindFragment: (fragment, source) => retainQualiaFragmentBinding(fragmentCaptureBindings, fragment, source),
        });
        await record("prepared_registration", registration);
        send({ registration });
      } else if (command.action === "eval_request") {
        if (!["judge", "auditor"].includes(command.role)) throw new Error("Unknown evaluator role");
        const context = await host.call({
          actor: command.role,
          operation: "knowledge.read",
          nativeContract: { name: "evaluation-context-read", version: "v1" },
          payload: { schema: "evaluation-context-read.v1", report: command.report },
          requestId: `${command.report.id}:${command.role}:context`,
          upstream: [command.report],
        });
        const request = qualiaEvaluationRequest(context);
        evaluationRequests.set(`${command.report.digest}:${command.role}`, request);
        await record("evaluation_request", request);
        send(request);
      } else if (command.action === "eval_submit") {
        if (!["judge", "auditor"].includes(command.role)) throw new Error("Unknown evaluator role");
        const request = evaluationRequests.get(`${command.report.digest}:${command.role}`);
        if (!request) throw new Error("Read isolated evaluator context before submitting");
        const payload = await qualiaEvaluationSubmission({
          request,
          answer: command.answer,
          model: command.model,
          rawResponse: command.rawResponse,
          usage: command.usage,
          put: (bytes, mediaType) => research.binding.custody.put(scope, bytes, mediaType),
        });
        await record("actual_model_submission", {
          role: command.role,
          model: command.model,
          answer: command.answer,
          usage: command.usage,
          payload,
        });
        const result = await host.call({
          actor: command.role,
          operation: "report.observe",
          nativeContract: { name: "report-observation", version: "v1" },
          payload,
          requestId: `${command.report.id}:${command.role}:observe`,
          upstream: [command.report],
        });
        send({ result });
      } else if (command.action === "assessment_preview") {
        const preview = await qualiaAssessmentPreview({ report: command.report, scope, research });
        await record("assessment_preview", preview);
        send(preview);
      } else if (command.action === "native_intent") {
        const bks = requireBksRoot(config.bksRoot);
        const fixture = await import(pathToFileURL(resolve(bks, "scripts/fixtures/qualia/native-intent.ts")).href);
        const frozen = await host.frozenReport(command.report);
        const captureInputs = bindQualiaNativeCaptures(captures.values(), command.input.captures, true);
        const built = await fixture.validatedBuildQualiaIntent({
          ...command.input,
          captures: captureInputs,
          report: frozen,
        });
        if (built.offlinePlanCheck) await record("offline_plan_check", built.offlinePlanCheck);
        await record("native_intent", built.intent);
        send({
          intent: built.intent,
          boundEffectDigest: biotechEffect(built.intent, origin).boundEffectDigest,
          ...(built.offlinePlanCheck ? { offlinePlanCheck: built.offlinePlanCheck } : {}),
          admitted: false,
          qualified: false,
        });
      } else if (command.action === "finalize_report") {
        const report = command.report as Ref<"report">;
        const runId = await research.locator.runOf(scope, report);
        if (!runId) throw new Error("Unknown report");
        const context = await research.binding.loadRunContext(scope, runId);
        const frozen = await host.frozenReport(report);
        assertReportBinding(command.intent, frozen);
        const effect = biotechEffect(command.intent, origin);
        await host.call({
          actor: "producer",
          operation: "report.seal",
          nativeContract: { name: "report-seal", version: "v1" },
          payload: {
            schema: "report-seal.v1",
            report,
            build: { buildId: "qualia-live-fixture", runtime: "node24", dirty: true },
          },
          requestId: `${report.id}:seal`,
          upstream: [report],
        });
        const decision = await host.call({
          actor: "producer",
          operation: "report.decide",
          nativeContract: { name: "report-use", version: "v1" },
          payload: {
            schema: "report-use.v1",
            report,
            subject: report,
            use: context.task.use,
            audience: context.task.audience,
            purpose: "official",
            boundEffectDigest: effect.boundEffectDigest,
            targetSchema: "biotech-knowledge-intent.v2",
            normalizedValues: {},
            policy: context.task.policy,
            rubric: context.task.rubric,
            expiresAt: null,
          },
          requestId: `${report.id}:decide`,
          upstream: [report],
        });
        const resolved = DecisionResolutionSchema.parse(
          await host.call({
            actor: "producer",
            operation: "decision.resolve",
            nativeContract: { name: "decision-resolve", version: "v1" },
            payload: { schema: "decision-resolve.v1", decision: decision.decision },
            requestId: `${report.id}:resolve`,
          }),
        );
        await record("resolved_decision", resolved);
        if (
          resolved.disposition !== "admitted" ||
          resolved.admissibility.status !== "admitted" ||
          resolved.reviewPending
        ) {
          send({ report, decision: resolved, dispatched: false, qualified: false });
          continue;
        }
        const effectKey = command.effectKey ?? `${report.id}:native`;
        const admission = await host.call({
          actor: "producer",
          operation: "knowledge.apply",
          nativeContract: { name: "biotech-knowledge-apply", version: "v1" },
          payload: {
            schemaVersion: "biotech-knowledge-apply.v1",
            intent: command.intent,
            exactUse: {
              useDecisionId: resolved.current.id,
              processedEpoch: resolved.revocationEpoch,
              normalizedValuesDigest: normalizedValuesDigest({}),
            },
          },
          requestId: `${report.id}:apply`,
          effectKey,
          boundEffectDigest: effect.boundEffectDigest,
          upstream: [report],
        });
        await record("native_admission", admission);
        send({ report, decision: resolved, admission, effectKey, dispatched: true, qualified: false });
      } else if (command.action === "call") {
        const result = await host.call(command.request);
        await record("call_result", result);
        send({ result });
      } else if (command.action === "frozen") send({ frozen: await host.frozenReport(command.report) });
      else if (command.action === "context") {
        const runId = await research.locator.runOf(scope, command.report);
        if (!runId) throw new Error("Unknown report");
        send({ context: await research.binding.loadRunContext(scope, runId) });
      } else if (command.action === "consume") {
        if (command.authorization !== "owner-authorized-qualia-biotech-8032ec07")
          throw new Error("Explicit authorized dispatch command required");
        const bks = requireBksRoot(config.bksRoot);
        const load = (p: string) => import(pathToFileURL(resolve(bks, "packages/kg-ops/src", p)).href);
        const [{ GraphClient }, { KnowledgeWriter }, { PgVerificationAuthority }, { DispatchConsumer }, fixture] =
          await Promise.all([
            load("neo4j.ts"),
            load("write/service.ts"),
            load("admission/verification.ts"),
            load("admission/dispatch.ts"),
            import(pathToFileURL(resolve(bks, "scripts/fixtures/qualia/native-intent.ts")).href),
          ]);
        fixture.assertQualiaTarget(process.env.NEO4J_URI);
        const graph = GraphClient.fromEnv({ ...process.env, BKS_TARGET: "production" });
        const authority = new PgVerificationAuthority({ connectionString: connection.toString(), timeoutMs: 5000 });
        try {
          const writer = new KnowledgeWriter(graph, {
            localDev: false,
            signer: null,
            authority: null,
            witnessKeys: new Map(),
          });
          const consumer = new DispatchConsumer({ authority, writer });
          const native = await fixture.consumeQualiaAndVerify({
            writer,
            principal: {
              principalId: "qualia-host",
              installationId: origin.installationId,
              applicationId: "biotech",
              tenantId: origin.tenantId,
              grants: [],
            },
            effectKey: command.effectKey,
            consume: () => consumer.consumeOnce(origin.tenantId, 1),
            record,
          });
          send({ native });
        } finally {
          await graph.close();
          await authority.close();
        }
      } else throw new Error("Unknown Qualia host action");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await record("error", { action: command.action, message });
      send({ error: message });
    }
  }
} finally {
  await service.settled();
  await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
  await backend.close();
  // Preserve the local database and receipts for outbox recovery; never drop or alter remote schema here.
}
