/**
 * Real local K01 fixture host for the AI Engineer Deep Agents StageGraph fixture. Stdin is a trusted controller.
 *
 * Provenance slice 2 (OVE-204): Mission Control owns the producer key. Every producer-side K01 call
 * (`report.register`, `knowledge.plan_preview`, `report.seal`, `report.decide`, `decision.resolve`, `knowledge.apply`)
 * arrives over HTTP from Mission Control's knowledge gateway under an MC-minted `mission_invocation` credential; the
 * controller passes that wire origin here only so report and intent bytes bind to it. The host mints credentials
 * only for its independent evaluator roles (judge, auditor: standalone origins, own subjects, own key). One JWKS file
 * holds both public keys, and `ks-host.jsonl` attributes every served K01 call to the key that signed it.
 *
 * It attaches to an already-installed DISPOSABLE loopback AI Engineer database (KS component + AIDB migrations), serves
 * the aiengineer-postgres binding with the production exact-use ingestion port, and never installs, migrates, wipes or
 * writes any graph. Judgments are actual model observations submitted by the controller; nothing is auto-admitted.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  Ed25519SealSigner,
  ReportKindCatalog,
  SourceAuthorityCatalog,
  StaticSealVerifier,
  loadUseClassesFile,
  useClassPolicy,
} from "@aiengineer/knowledge-application";
import {
  createAiEngineerPostgresBackend,
  createIngestionApplyPort,
  pinSealSigningKey,
} from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { LocalArtifactStore } from "@aiengineer/knowledge-core";
import {
  ArtifactLedger,
  IngestionExecutor,
  ReadExecutor,
  exactUseEvidenceOracle,
  loadWorkspace,
} from "@aiengineer/knowledge-db";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  KnowledgeOperationService,
  fileJwksSource,
} from "@aiengineer/knowledge-host/knowledge-operation";
import {
  OperationHandleSchema,
  OperationStatusSchema,
  digestBytes,
  digestCanonical,
  type JsonValue,
  type OperationName,
  type Origin,
  type Ref,
} from "@aiengineer/knowledge-operation-protocol";
import { normalizedValuesDigest, type AuthScope } from "@aiengineer/knowledge-research-core";
import { TenantPostgres } from "@aiengineer/knowledge-persistence";
import { Client } from "pg";
import { handleKnowledgeOperation } from "../http.js";
import {
  checkMigrationHead,
  credentialSource,
  evaluatorBase,
  mergeJwks,
  parseHostConfig,
  producerOf,
} from "./aieng-host-support.js";
import { AiengIntentRefused, buildAiengIntent, fullySupported } from "./aieng-intent.js";
import { requireLoopback } from "./proof-guards.js";
import { qualiaAssessmentPreview } from "./qualia-assessment.js";
import { assertQualiaCaptureId, retainQualiaCapture } from "./qualia-captures.js";
import { qualiaCredential, qualiaRoles, type QualiaRole } from "./qualia-credentials.js";
import { qualiaEvaluationRequest, qualiaEvaluationSubmission } from "./qualia-evaluation.js";
import {
  hydrateQualiaFrozenReport,
  retainQualiaFragmentBinding,
  type QualiaFragmentCaptureBinding,
} from "./qualia-frozen.js";
import { AIENG_REPORT_PROFILE, prepareQualiaReport, type CapturedSource } from "./qualia-report.js";
import { envelopeFor, generateIssuerKey, jwksOf } from "./test-support.js";

const config = parseHostConfig(JSON.parse(readFileSync(process.argv[2]!, "utf8")));
/** Mission Control's startup (standalone) origin: tenant, application, KS installation and issuer. */
const origin: Origin = config.origin;
const root = resolve(import.meta.dirname, "../../../../..");
const binding = "aiengineer-postgres";
const scope: AuthScope = { tenant: origin.tenantId, application: "ai-engineer", binding, origin, grants: [] };
// Disposable loopback database only: the guard refuses any non-loopback host before connecting.
const dsn = requireLoopback("AIENG_FIXTURE_DATABASE_URL", process.env.AIENG_FIXTURE_DATABASE_URL);
mkdirSync(config.evidenceRoot, { recursive: true });
const record = async (kind: string, value: unknown) =>
  appendFileSync(
    resolve(config.evidenceRoot, "ks-host.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), kind, value })}\n`,
  );
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const instant = () => new Date().toISOString().replace(/\.(\d*?)0+Z$/, (_m, d: string) => (d ? `.${d}Z` : "Z"));

// The installed component must be exactly this application/binding/installation: never install or alter it here.
const probe = new Client({ connectionString: dsn });
await probe.connect();
const installed = (
  await probe.query<{ installation_id: string; application_id: string; binding: string }>(
    "select installation_id::text, application_id, binding from knowledge_verification.installation",
  )
).rows[0];
const head = (
  await probe.query<{ version: string }>("select max(version) as version from supabase_migrations.schema_migrations")
).rows[0];
// The executor's plan does not check each kind's NOT NULL typed columns; the fixture preflights them.
const requiredColumns = new Map(
  (
    await probe.query<{ code: string; columns: string[] }>(
      `select k.code, array_agg(c.column_name::text order by c.column_name) as columns
         from information_schema.columns c
         join taxonomy.entity_kind k on k.canonical_schema = c.table_schema and k.canonical_table = c.table_name
        where c.is_nullable = 'NO' and c.column_default is null and c.column_name not in ('id', 'tenant_id', 'kind')
        group by k.code`,
    )
  ).rows.map((row) => [row.code, row.columns]),
);
await probe.end();
if (
  !installed ||
  installed.installation_id !== origin.installationId ||
  installed.application_id !== "ai-engineer" ||
  installed.binding !== binding
)
  throw new Error("Disposable AI Engineer component installation differs from the configured origin");
const workspace = loadWorkspace(config.workspaceDir);
const migration = checkMigrationHead({
  database: head?.version,
  workspace: workspace.migrationHead,
  configured: config.migrationHead,
});

// The host's own evaluator key (judge/auditor only), published beside Mission Control's key in one JWKS file.
const evaluatorKey = generateIssuerKey(`aieng-host-evaluator-${randomBytes(4).toString("hex")}`);
const merged = mergeJwks(JSON.parse(readFileSync(config.jwksPath, "utf8")), jwksOf([evaluatorKey]).keys[0]!);
writeFileSync(`${config.jwksPath}.tmp`, `${JSON.stringify(merged.document, null, 2)}\n`);
renameSync(`${config.jwksPath}.tmp`, config.jwksPath);
const keyAttribution = { mcKids: new Set(merged.mcKids), hostKid: evaluatorKey.kid };
const signer = Ed25519SealSigner.fromSeed(`aieng-seal-${randomBytes(4).toString("hex")}`, randomBytes(32));
const publicKey = signer.publicKeyRaw();
await pinSealSigningKey(dsn, { keyId: signer.keyId, publicKey });
const db = new TenantPostgres({ connectionString: dsn, maximumPoolSize: 4 });
const executorVersion = "knowledge-executor/aieng-fixture";
const artifacts = new ArtifactLedger({
  db,
  store: new LocalArtifactStore(resolve(config.evidenceRoot, "aidb-artifacts")),
  bucket: "research-ingestion-intents",
  uploaded: false,
  executorVersion,
});
const reads = new ReadExecutor({ db, workspace, artifacts, executorVersion });
const ingestion = new IngestionExecutor({
  db,
  workspace,
  artifacts,
  executorVersion,
  evidence: exactUseEvidenceOracle,
  useClasses: useClassPolicy(loadUseClassesFile(resolve(root, "catalog/research/use-classes.json"))),
});
const backend = await createAiEngineerPostgresBackend({
  application: "ai-engineer",
  binding,
  installationId: origin.installationId,
  connectionString: dsn,
  kinds: ReportKindCatalog.fromDirectory(resolve(root, "catalog/research/report-kinds")),
  authority: SourceAuthorityCatalog.fromDirectory(resolve(root, "catalog/research/source-authority")),
  seal: { signer, verifier: new StaticSealVerifier([{ keyId: signer.keyId, publicKey, status: "active" }]) },
  auditor: null,
  apply: createIngestionApplyPort(ingestion),
});
const service = new KnowledgeOperationService({
  verifier: new KnowledgeCredentialVerifier({
    issuer: config.issuer,
    audience: config.audience,
    jwks: new JwksCache(fileJwksSource(config.jwksPath)),
  }),
  backends: [backend],
  installed: [
    { application: "ai-engineer", binding, installationId: origin.installationId, tenants: [origin.tenantId] },
  ],
  dispatches: new DispatchRegistry(),
  signingIssuer: "aieng-fixture-host",
});
let k01Calls = 0;
const server = createServer((req, res) => {
  // Attribution of every served K01 call to the key that signed it (the service verifies the signature).
  const source = credentialSource(req.headers.authorization, keyAttribution);
  const sequence = ++k01Calls;
  res.on("finish", () => {
    void record("k01_call", {
      sequence,
      method: req.method,
      path: (req.url ?? "/").split("?")[0],
      status: res.statusCode,
      ...source,
    });
  });
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
const snapshots = new Map<
  string,
  { artifactId?: string; snapshotId: string; snapshotDigest: string; knowledgeSeq: number }
>();
// Independent evaluator roles: standalone origins with host subjects. `producer` is MC's startup origin, reported
// for reference only and never minted: producer-side calls arrive from Mission Control.
const roles = { ...qualiaRoles(evaluatorBase(origin, "aieng-fixture-host")), producer: origin };
type EvaluatorRole = Exclude<QualiaRole, "producer">;
const isEvaluator = (role: unknown): role is EvaluatorRole => role === "judge" || role === "auditor";
/** Bounded read allowlist: identity resolution and the clock, never bulk export. */
const READ_QUERIES = new Set([
  "knowledge.head",
  "entity.resolve",
  "entity.by_identifier",
  "entity.card",
  "entity.relationships",
  "evidence.claims_for_entity",
  "relationships.current_by_kind",
  "vocab.relationship_kind",
]);

async function http(
  actor: EvaluatorRole,
  path: string,
  operations: OperationName[],
  dispatchId: string,
  body?: unknown,
  effect?: { effectKey: string; boundEffectDigest: string } | null,
) {
  const token = qualiaCredential({
    key: evaluatorKey,
    roles,
    actor,
    operations,
    dispatchId,
    effect,
    binding,
    issuer: config.issuer,
    audience: config.audience,
  }).token;
  const response = await fetch(`${url}/knowledge-operation/v2${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`K01 ${response.status}: ${text}`);
  return { text };
}

/** An independent evaluator's own K01 call (host-minted). Producer-side operations never pass here. */
async function call(request: {
  actor: EvaluatorRole;
  operation: string;
  nativeContract?: { name: string; version: string };
  payload: unknown;
  requestId: string;
  upstream?: Ref[];
  effectKey?: string;
  boundEffectDigest?: string;
}): Promise<Record<string, unknown>> {
  if (!isEvaluator(request.actor)) throw new Error("The host mints evaluator credentials only");
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
  envelope.issuedAt = instant();
  await record("request", envelope);
  const response = JSON.parse(
    (await http(request.actor, "/invoke", [envelope.operation], envelope.dispatchId, envelope, null)).text,
  ) as Record<string, unknown>;
  const parsedHandle = OperationHandleSchema.safeParse(response);
  if (!parsedHandle.success) return response;
  for (let i = 0; i < 240; i++) {
    await service.settled();
    const status = OperationStatusSchema.parse(
      JSON.parse(
        (
          await http(
            request.actor,
            `/operations/${encodeURIComponent(parsedHandle.data.operationId)}`,
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
}

async function frozenReport(report: Ref<"report">) {
  const runId = await research.locator.runOf(scope, report);
  if (!runId) throw new Error("Unknown registered report");
  const context = await research.binding.loadRunContext(scope, runId);
  const frozen = await hydrateQualiaFrozenReport({
    report,
    context,
    sources: captures.values(),
    fragmentBindings: fragmentCaptureBindings,
    loadFragments: (refs) => research.binding.loadFragments(scope, refs),
    readArtifact: (ref) => research.binding.custody.get(scope, ref),
    reportKind: (kindId) => (kindId.split("@")[0] ?? kindId) as never,
  });
  return { runId, context, frozen };
}

/** Summarize the executor's own read-only plan as repair feedback (no admission, no write). */
function planFeedback(plan: Awaited<ReturnType<IngestionExecutor["plan"]>>) {
  return {
    plannedOutcome: plan.plannedOutcome,
    plannedSummary: plan.plannedSummary,
    errors: plan.errors,
    ruleChecks: plan.ruleChecks.filter((check) => (check as { passed?: boolean }).passed === false),
    proposals: plan.proposals.map((proposal) => {
      const item = proposal as unknown as Record<string, unknown>;
      return { proposalId: item.proposalId, kind: item.kind, outcome: item.outcome, reason: item.reason ?? null };
    }),
    subjects: plan.subjects.map((subject) => {
      const item = subject as unknown as Record<string, unknown>;
      return { ref: item.ref, resolution: item.resolution ?? item.outcome ?? null, entityId: item.entityId ?? null };
    }),
    head: plan.head,
  };
}

/** The Mission Control producer of one producer-side call: the verified-shape wire origin MC passed. */
function producerOrigin(wire: unknown) {
  return producerOf(wire, {
    tenantId: origin.tenantId,
    installationId: origin.installationId,
    issuer: config.issuer,
  });
}

/**
 * AIDB claims require a producer attempt in AIDB's own orchestration ledger. There is no production Mission Control
 * -> AIDB attempt projection yet, so the fixture materializes one attribution row per actual MC mission/operation
 * attempt, derived from the MC wire origin's `mission` coordinates (true mission id, run id, operation id, attempt)
 * with derived (never equated) ids and an explicit mission-control deployment label. Unqualified production mapping.
 */
async function producerAttribution(wire: unknown) {
  const p = producerOrigin(wire);
  const uuid = (seed: string) => {
    const hex = digestCanonical({ aidbAttribution: seed }).slice(7, 39);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const missionId = uuid(`mission:${p.missionId}`);
  const workItemId = uuid(`work:${p.runId}:${p.operationId}`);
  const attemptId = uuid(`attempt:${p.runId}:${p.operationId}:${p.attempt}`);
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(
      "insert into orchestration.mission(id, tenant_id, goal) values ($1, $2, $3) on conflict (id) do nothing",
      [missionId, origin.tenantId, `Mission Control mission ${p.missionId} (fixture producer attribution)`],
    );
    await client.query(
      "insert into orchestration.work_item(id, tenant_id, mission_id, kind, spec) values ($1, $2, $3, 'execute_ingestion_intent', $4::jsonb) on conflict (id) do nothing",
      [
        workItemId,
        origin.tenantId,
        missionId,
        JSON.stringify({
          missionControl: { missionId: p.missionId, runId: p.runId, operationId: p.operationId },
        }),
      ],
    );
    await client.query(
      "insert into orchestration.attempt(id, tenant_id, work_item_id, attempt_no, agent_deployment_id) values ($1, $2, $3, $4, 'mission-control/deep_agents/fixture') on conflict (id) do nothing",
      [attemptId, origin.tenantId, workItemId, p.attempt],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
  const producer = { missionId: p.missionId, runId: p.runId, operationId: p.operationId, attempt: p.attempt };
  await record("producer_attribution", { producer, missionId, workItemId, attemptId });
  return { missionId, attemptId };
}

async function readback(receiptId: string, effectKey: string, decisionId: string, frozenClaims: Map<string, string>) {
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) =>
      (await client.query<T>(sql, params)).rows;
    const [receipt] = await q<{
      outcome: string;
      affected_refs: unknown;
      changes_summary: unknown;
      use_decision_id: string | null;
      bound_effect_digest: string | null;
    }>(
      "select outcome, affected_refs, changes_summary, use_decision_id, bound_effect_digest from orchestration.operation_receipt where id = $1::uuid",
      [receiptId],
    );
    if (!receipt) throw new Error("Native receipt row is absent");
    const failures: Array<Record<string, unknown>> = [];
    const affected = Array.isArray(receipt.affected_refs)
      ? (receipt.affected_refs as Array<Record<string, string>>)
      : [];
    let checked = 0;
    for (const ref of affected) {
      if (!/^[a-z_]+$/.test(ref.schema ?? "") || !/^[a-z_]+$/.test(ref.table ?? "")) {
        failures.push({ ref, error: "unsafe identifier" });
        continue;
      }
      const rows = await q(`select 1 from ${ref.schema}.${ref.table} where id::text = $1 and tenant_id = $2::uuid`, [
        ref.id,
        origin.tenantId,
      ]);
      checked++;
      if (rows.length !== 1) failures.push({ ref, error: "affected row not found" });
    }
    const entities = await q<{ id: string; kind: string; display_name: string; lifecycle: string }>(
      "select id::text, kind, display_name, lifecycle from corpus.entity where tenant_id = $1::uuid and created_by_receipt_id = $2::uuid order by kind, display_name",
      [origin.tenantId, receiptId],
    );
    const claims = await q<{ id: string; statement: string; claim_type: string; status: string }>(
      "select id::text, statement, claim_type, status::text from evidence.claim where tenant_id = $1::uuid and created_by_receipt_id = $2::uuid",
      [origin.tenantId, receiptId],
    );
    for (const claim of claims)
      if (![...frozenClaims.values()].includes(claim.statement))
        failures.push({ claim: claim.id, error: "materialized claim text differs from every frozen proposition" });
    const [ledger] = await q<{ admissions: number; protocol: number; native: number }>(
      `select (select count(*)::int from research.use_admission where tenant_id = $1::uuid and use_decision_id = $2) as admissions,
              (select count(*)::int from knowledge_verification.protocol_receipt where tenant_id = $1::uuid and effect_key = $3) as protocol,
              (select count(*)::int from knowledge_verification.effect_receipt where tenant_id = $1::uuid and effect_key = $3) as native`,
      [origin.tenantId, decisionId, effectKey],
    );
    if (!ledger || ledger.admissions !== 1 || ledger.protocol !== 1 || ledger.native !== 1)
      failures.push({ ledger, error: "admission/protocol/effect receipt counts differ from exactly one" });
    if (receipt.use_decision_id !== decisionId) failures.push({ error: "receipt names another use decision" });
    return {
      receiptId,
      outcome: receipt.outcome,
      changesSummary: receipt.changes_summary,
      affectedChecked: checked,
      affectedTotal: affected.length,
      entities,
      claims,
      ledger,
      failures,
      complete: failures.length === 0,
    };
  } finally {
    await client.end();
  }
}

const jwks = { path: config.jwksPath, missionControlKids: merged.mcKids, hostEvaluatorKid: evaluatorKey.kid };
send({
  ready: true,
  url,
  issuer: config.issuer,
  audience: config.audience,
  jwks,
  migrationHead: migration,
  roles,
  qualified: false,
});
await record("ready", {
  url,
  issuer: config.issuer,
  audience: config.audience,
  jwks,
  roles,
  migration,
  qualified: false,
});
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const command = JSON.parse(line) as Record<string, any>;
    try {
      if (command.action === "stop") {
        send({ stopped: true });
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
          retrievedAt: instant(),
          completeness: command.completeness ?? "unknown",
        });
        await record("capture", { captureId, ref: captured.ref, sourceUrl: captured.url });
        send({ captureId, sourceUrl: captured.url, ref: captured.ref });
      } else if (command.action === "prepare_report") {
        // The registration's producer is the MC wire origin that will register it (MC-minted report.register).
        const producer = producerOrigin(command.origin);
        const registration = await prepareQualiaReport({
          authored: command.input,
          sources: [...captures.values()],
          origin: producer.origin,
          put: (bytes, mediaType) => research.binding.custody.put(scope, bytes, mediaType),
          bindFragment: (fragment, source) => retainQualiaFragmentBinding(fragmentCaptureBindings, fragment, source),
          profile: AIENG_REPORT_PROFILE,
        });
        await record("prepared_registration", registration);
        send({ registration });
      } else if (command.action === "eval_request") {
        if (!isEvaluator(command.role)) throw new Error("Unknown evaluator role");
        const context = await call({
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
        if (!isEvaluator(command.role)) throw new Error("Unknown evaluator role");
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
          usage: command.usage,
          payload,
        });
        const result = await call({
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
      } else if (command.action === "knowledge_read") {
        const operations = command.operations as Array<{
          opId: string;
          query: string;
          params?: Record<string, unknown>;
        }>;
        if (!Array.isArray(operations) || operations.length < 1 || operations.length > 12)
          throw new Error("knowledge_read takes 1..12 operations");
        for (const op of operations)
          if (!READ_QUERIES.has(op.query)) throw new Error(`Query ${op.query} is outside the bounded read allowlist`);
        const result = await reads.runIntent(
          {
            schemaVersion: "knowledge-read-intent.v1",
            intentId: `read-${randomBytes(6).toString("hex")}`,
            context: { tenantId: origin.tenantId, actor: { kind: "agent", id: command.actor ?? "aieng-fixture" } },
            operations: operations.some((op) => op.query === "knowledge.head")
              ? operations
              : [{ opId: "head", query: "knowledge.head" }, ...operations],
          } as never,
          { persist: true },
        );
        if (!result.storage?.artifactId) throw new Error("Knowledge read was not persisted as a snapshot artifact");
        const snapshot = {
          artifactId: result.storage.artifactId,
          snapshotId: result.snapshotId,
          snapshotDigest: result.snapshotDigest,
          knowledgeSeq: result.atKnowledgeSeq,
        };
        snapshots.set(snapshot.snapshotId, snapshot);
        await record("knowledge_read", { operations, snapshot });
        send({ snapshot, results: (result as unknown as { results?: unknown }).results ?? result });
      } else if (command.action === "native_intent") {
        // Builds the exact-use intent bound to the MC wire origin; MC previews it (knowledge.plan_preview) itself.
        const report = command.report as Ref<"report">;
        const producer = producerOrigin(command.origin);
        const snapshot = snapshots.get(command.snapshotId);
        if (!snapshot) throw new Error("Native intent must cite a snapshot persisted by knowledge_read in this host");
        const { runId, frozen } = await frozenReport(report);
        // One effect per distinct authored input: a fenced or refused effect is never reused for a repair.
        const effectKey = `${report.id}:native:${digestCanonical(command.input as JsonValue).slice(7, 19)}`;
        let built: ReturnType<typeof buildAiengIntent>;
        try {
          built = buildAiengIntent({
            authored: command.input,
            frozen,
            verificationRunId: runId,
            asOf: new Date().toISOString().slice(0, 10),
            context: {
              tenantId: origin.tenantId,
              ...(command.context ?? {}),
              ...(await producerAttribution(producer.origin)),
            },
            snapshot,
            effectKey,
            origin: producer.origin,
          });
        } catch (error) {
          if (error instanceof AiengIntentRefused) {
            send({ refused: true, code: error.code, message: error.message, details: error.details });
            continue;
          }
          throw error;
        }
        const missingTyped = built.intent.subjects.flatMap((subject) => {
          if (subject.mode !== "new") return [];
          const payload = subject.typedPayload as Record<string, unknown>;
          const required = requiredColumns.get(subject.kind) ?? [];
          const missing = required.filter((column) => !column.endsWith("_id") && payload[column] == null);
          const derived = required.filter((column) => column.endsWith("_id") && payload[column] == null);
          return missing.length || derived.length
            ? [{ ref: subject.ref, kind: subject.kind, missingTypedPayload: missing, unresolvedReferences: derived }]
            : [];
        });
        if (missingTyped.some((item) => item.missingTypedPayload.length > 0)) {
          send({
            refused: true,
            code: "TYPED_PAYLOAD_REQUIRED",
            message:
              "New subjects lack NOT NULL typed columns of their kind; supply them in typedPayload from evidence",
            details: { subjects: missingTyped },
          });
          continue;
        }
        // The executor's own read-only plan, with placeholder decision fields, is repair feedback only.
        let plan: ReturnType<typeof planFeedback> | { error: string };
        try {
          plan = planFeedback(
            await ingestion.plan({
              ...built.intent,
              exactUse: {
                ...built.intent.exactUse,
                useDecisionId: "plan-feedback-only",
                boundEffectDigest: `sha256:${"0".repeat(64)}`,
                processedEpoch: 0,
                normalizedValuesDigest: normalizedValuesDigest({}),
              },
            }),
          );
        } catch (error) {
          plan = { error: error instanceof Error ? error.message : String(error) };
        }
        await record("native_plan_feedback", plan);
        await record("native_intent", { intent: built.intent, reportBinding: built.reportBinding, effectKey });
        send({
          intent: built.intent,
          effectKey,
          plan,
          reportBinding: built.reportBinding,
          admitted: false,
          qualified: false,
        });
      } else if (command.action === "apply_context") {
        // What MC's report.decide needs from the registered task (read-only), and the materializable assertions.
        const report = command.report as Ref<"report">;
        const { context, frozen } = await frozenReport(report);
        const supported = fullySupported(frozen).size;
        if (supported === 0) throw new Error("No fully supported assertion to materialize");
        const task = {
          use: context.task.use,
          audience: context.task.audience,
          policy: context.task.policy,
          rubric: context.task.rubric,
        };
        await record("apply_context", { report, task, supported });
        send({ report, task, supported });
      } else if (command.action === "readback") {
        // Row readback of an MC-applied native receipt (read-only; never applies anything).
        const report = command.report as Ref<"report">;
        if (typeof command.receiptId !== "string" || typeof command.effectKey !== "string")
          throw new Error("readback requires receiptId and effectKey");
        if (typeof command.decisionId !== "string") throw new Error("readback requires the resolved decisionId");
        const { frozen } = await frozenReport(report);
        const native = await readback(
          command.receiptId,
          command.effectKey,
          command.decisionId,
          new Map(frozen.assertions.map((assertion) => [assertion.id, assertion.proposition])),
        );
        await record("native_readback", native);
        send({ native });
      } else if (command.action === "frozen") send({ frozen: (await frozenReport(command.report)).frozen });
      else if (command.action === "context") {
        const runId = await research.locator.runOf(scope, command.report);
        if (!runId) throw new Error("Unknown report");
        send({ context: await research.binding.loadRunContext(scope, runId) });
      } else throw new Error("Unknown AI Engineer host action");
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
  await db.close();
}
