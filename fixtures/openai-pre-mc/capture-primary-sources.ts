/**
 * Bounded P6.1 capture preparation. This uses the existing server-owned source
 * catalog, durable worker, PostgreSQL repository, Supabase artifact store, and
 * sandbox parser. It intentionally neither fetches arbitrary URLs nor labels
 * claims. Run only against the coordinator-reserved disposable custody target.
 *
 * Required environment: POSTGRES_URL, SUPABASE_URL, SUPABASE_SECRET_KEY and
 * VERIFICATION_PARSER_IMAGE_DIGEST. The script writes a compact receipt only;
 * raw source bytes remain in the configured artifact store.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  TrustedVerificationSourceAcquirer,
  VerificationAdmissionService,
  VerificationOperationApplicationService,
  VerificationServiceCatalog,
  VerificationSourceAcquisitionCatalog,
} from "@aiengineer/knowledge-application";
import { SandboxedVerificationParser, VERIFICATION_PARSER_LIMITS } from "@aiengineer/knowledge-conversion";
import { PostgresCanonicalRepository, PostgresKnowledgeOperationService, PostgresVerificationRepository } from "@aiengineer/knowledge-persistence";
import { deterministicUuid, SupabaseArtifactStore } from "@aiengineer/knowledge-runtime";
import { createVerificationBenchmarkCaptureProfileResolver } from "../../packages/host/src/verification/api/verification-benchmark-capture-profile.js";
import { buildServer } from "../../apps/api/src/server.js";
import { CanonicalActivityRegistry } from "../../apps/worker/src/activity-registry.js";
import { CanonicalDurableKnowledgeWorker } from "../../apps/worker/src/canonical-worker.js";
import { createVerificationOperationExecutor, verificationActivityHandlers } from "../../apps/worker/src/verification-activities.js";
import { disposableDatabaseUrl, disposableStorageConfig } from "../../packages/persistence/test/disposable.mjs";

type Lead = { readonly seedId: string; readonly kind: string; readonly url?: string; readonly companionRole?: string; readonly sourceKind?: "web_page" | "pdf"; };
type CapturedSource = {
  readonly seedId: string;
  readonly sourceId: string;
  readonly captureId: string;
  readonly operationId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly capturedAt: string;
  readonly contentDigest: string;
  readonly contentBytes: number;
  readonly acquisitionReceiptArtifactId: string;
  readonly sourceArtifactId: string;
  readonly resultArtifactId?: string;
  readonly terminalStatus: "succeeded" | "captured_parser_failed";
  readonly authority: "official_openai_primary_source_candidate";
  readonly rights: "public_web_source_rights_unreviewed";
  readonly temporal: "current_capture_not_archival_provenance";
  readonly reviewStatus: "review_required";
};

const fixtureDir = resolve(import.meta.dirname);
const required = ["POSTGRES_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "VERIFICATION_PARSER_IMAGE_DIGEST"] as const;
for (const name of required) assert.ok(process.env[name]?.trim(), `MISSING_${name}`);
assert.equal(process.env.P6_CAPTURE_TARGET, "disposable-ks-p0-p1", "P6_DISPOSABLE_TARGET_REQUIRED");
assert.equal(new URL(process.env.SUPABASE_URL!).hostname, "127.0.0.1", "LOCAL_SUPABASE_REQUIRED");
assert.match(process.env.VERIFICATION_PARSER_IMAGE_DIGEST!, /^sha256:[a-f0-9]{64}$/u, "PARSER_IMAGE_DIGEST_REQUIRED");
const guardedEnvironment = { ...process.env, KS_TEST_DATABASE_URL: process.env.POSTGRES_URL!,
  KS_TEST_SUPABASE_URL: process.env.SUPABASE_URL!, KS_TEST_SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY!,
  KS_TEST_PROJECT_DIR: resolve(fixtureDir, "../../../internal/disposable-ks-p0-p1"), KS_REQUIRE_CURRENT_SCHEMA: "1" };
assert.equal(disposableDatabaseUrl(guardedEnvironment), process.env.POSTGRES_URL);
assert.ok(disposableStorageConfig(guardedEnvironment), "GUARDED_STORAGE_REQUIRED");

const requestedSeeds = process.argv.slice(2).filter(value => value.startsWith("--seeds=")).flatMap(value => value.slice("--seeds=".length).split(",")).filter(Boolean);
const defaultSeeds = ["S01", "S08", "S16", "S20"];
const seedIds = requestedSeeds.length ? requestedSeeds : defaultSeeds;
assert.ok(seedIds.length >= 1 && seedIds.length <= 4, "P6_CAPTURE_LIMIT_1_TO_4");
assert.equal(new Set(seedIds).size, seedIds.length, "DUPLICATE_SEED_ID");

const leads = (await readFile(resolve(fixtureDir, "source-leads.jsonl"), "utf8"))
  .trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as Lead);
const selected = seedIds.map(seedId => {
  const matches = leads.filter(lead => lead.seedId === seedId && ["official_source_lead", "discovered_official_primary_source_lead"].includes(lead.kind) && !lead.companionRole && lead.url);
  assert.equal(matches.length, 1, `OFFICIAL_URL_LEAD_REQUIRED:${seedId}`);
  return { seedId, url: matches[0]!.url!, sourceKind: matches[0]!.sourceKind ?? "web_page" as const };
});

const proofId = randomUUID();
const outputPath = resolve(fixtureDir, `capture-primary-sources.${proofId}.result.json`);
const tenantId = randomUUID();
const missionId = randomUUID();
const workItemId = randomUUID();
const attemptId = randomUUID();
const bucket = "ai-engineer-cloud-bucket";
const now = () => new Date().toISOString();
const database = new PostgresCanonicalRepository({ connectionString: process.env.POSTGRES_URL! });
const repository = new PostgresVerificationRepository(
  database,
  new SupabaseArtifactStore({ projectUrl: process.env.SUPABASE_URL!, serviceRoleKey: process.env.SUPABASE_SECRET_KEY!, bucket, maximumBytes: 8_000_000 }),
  { async authorize(input) { assert.equal(input.tenantId, tenantId); } },
);
const sourceIds = new Map(selected.map(item => [item.seedId, randomUUID()]));
const catalog = new VerificationServiceCatalog({
  captureGrants: [], extractionProfileArtifacts: [],
  acquisitionGrants: selected.map(item => ({ tenantId, sourceKey: `openai-${item.seedId.toLowerCase()}`, source: {
    sourceId: sourceIds.get(item.seedId)!, kind: item.sourceKind, canonicalUri: item.url, logicalIdentity: `openai-pre-mc:${item.seedId}`,
  }})),
});
const transportCatalog = new VerificationSourceAcquisitionCatalog(selected.map(item => ({
  sourceKey: `openai-${item.seedId.toLowerCase()}`, sourceUri: item.url, redirectUris: [], acceptedMediaTypes: [item.sourceKind === "pdf" ? "application/pdf" : "text/html"], maximumBytes: item.sourceKind === "pdf" ? 8_000_000 : 2_000_000, timeoutMs: 30_000,
})));
const sourceAcquirer = new TrustedVerificationSourceAcquirer(
  transportCatalog,
  { resolve: async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(item => item.address) },
  now,
);
const config = { storageBucket: bucket, producerVersion: "verification-service.v1", encryptionClass: "supabase-managed", retentionClass: "verification-audit", now };
const admission = new VerificationAdmissionService(
  repository,
  new SandboxedVerificationParser(process.env.VERIFICATION_PARSER_IMAGE_DIGEST! as `sha256:${string}`),
  { parserVersion: "verification-native-parser.v1", imageDigest: process.env.VERIFICATION_PARSER_IMAGE_DIGEST! as `sha256:${string}`, limits: VERIFICATION_PARSER_LIMITS },
  config,
);
const outputs: CapturedSource[] = [];
const checks: Record<string, boolean> = {};
const submittedOperationIds = new Map<string, string>();
const failures: { seedId: string; error: unknown }[] = [];
function errorDetail(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error) || depth > 4) return String(error);
  return { name: error.name, message: error.message, ...(error.cause === undefined ? {} : { cause: errorDetail(error.cause, depth + 1) }) };
}

async function retainFailedCapture(item: typeof selected[number], error: unknown) {
  failures.push({ seedId: item.seedId, error: errorDetail(error) });
  const operationId = submittedOperationIds.get(item.seedId);
  if (!operationId) return;
  const captureId = deterministicUuid("verification-live-capture", `${tenantId}:${operationId}:${sourceIds.get(item.seedId)!}`);
  const registered = await repository.getRegisteredCapture({ tenantId, captureId }).catch(error => {
    if (error instanceof Error && error.message === "CAPTURE_NOT_REGISTERED") return undefined;
    throw error;
  });
  if (!registered) return;
  const artifact = registered.capture.contentArtifact;
  outputs.push({ seedId: item.seedId, sourceId: registered.source.sourceId, captureId: registered.capture.captureId, operationId,
    requestedUrl: item.url, finalUrl: item.url, capturedAt: registered.capture.capturedAt,
    contentDigest: artifact.digest, contentBytes: artifact.byteLength,
    acquisitionReceiptArtifactId: artifact.parentArtifactIds[0]!, sourceArtifactId: artifact.artifactId,
    terminalStatus: "captured_parser_failed", authority: "official_openai_primary_source_candidate",
    rights: "public_web_source_rights_unreviewed", temporal: "current_capture_not_archival_provenance", reviewStatus: "review_required" });
}

try {
  await database.transaction(tenantId, async client => {
    await client.query("insert into orchestration.mission(id,tenant_id,slug,goal) values($1,$2,$3,$4)", [missionId, tenantId, `openai-pre-mc-capture-${proofId}`, "Bounded primary-source capture for P6.1 fixture; no semantic admission or publication"]);
    await client.query("insert into orchestration.work_item(id,tenant_id,mission_id,kind) values($1,$2,$3,'verify_extraction')", [workItemId, tenantId, missionId]);
    await client.query("insert into orchestration.attempt(id,tenant_id,work_item_id,attempt_no,agent_deployment_id) values($1,$2,$3,1,'openai-pre-mc-capture')", [attemptId, tenantId, workItemId]);
  });
  const operations = new PostgresKnowledgeOperationService(database, { admittedOperationKinds: ["verification_capture"] });
  const actor = { kind: "service" as const, id: attemptId, serviceIdentity: "knowledge_worker" as const };
  const ownershipGrants = JSON.stringify([{ tenantId, actor, missionId, agentDeploymentId: "openai-pre-mc-capture", capabilityVersion: "verification-service.v1" }]);
  const profileName = "openai-pre-mc-capture";
  const profileResolver = createVerificationBenchmarkCaptureProfileResolver(database, JSON.stringify([{ profileName, tenantId, actor, missionId, workItemId, attemptId }]), ownershipGrants);
  const submitToken = randomUUID();
  const server = buildServer({ verificationOperationService: operations, verificationCaptureCatalog: catalog, resolveVerificationBenchmarkCaptureProfile: profileResolver,
    resolveIdentity: candidate => candidate === submitToken ? { actor, grants: [{ tenantId, roles: ["knowledge_operator"], scopes: [] }] } : undefined });
  const executor = createVerificationOperationExecutor({ operations: database, repository, admission, catalog, config, sourceAcquirer });
  const registry = new CanonicalActivityRegistry(verificationActivityHandlers(executor));
  const worker = new CanonicalDurableKnowledgeWorker(`openai-pre-mc-capture-${proofId}`, tenantId, database, async claim => {
    const operation = await database.getOperationRecord(tenantId, claim.operationId); assert.ok(operation); return registry.execute(operation, claim);
  }, 60_000, registry.operationKinds());
  try {
    for (const item of selected) {
      try {
      const expectedOperationId = deterministicUuid("verification-http-operation", `${tenantId}:captureSource:${item.seedId}:${proofId}`);
      const response = await server.inject({ method: "POST", url: `/v1/verification/benchmark-capture-profiles/${profileName}/captures`, headers: {
        authorization: `Bearer ${submitToken}`, "x-correlation-id": `${proofId}:${item.seedId}`, "idempotency-key": `openai-pre-mc:${proofId}:${item.seedId}`,
      }, payload: { verificationContractVersion: "verification.v1", source: { mode: "acquire", sourceKind: item.sourceKind, sourceUri: item.url }, requestedProjectionKinds: item.sourceKind === "pdf" ? ["pdf_text", "geometry"] : ["html_dom"] } });
      assert.equal(response.statusCode, 202, response.body);
      const operationId = String(response.json().operation.operationId);
      assert.match(operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, "OPERATION_ID_REQUIRED");
      assert.notEqual(operationId, expectedOperationId, "SERVER_MUST_OWN_OPERATION_ID");
      submittedOperationIds.set(item.seedId, operationId);
      const completed = await worker.runOperationOnce(operationId);
      assert.equal(completed?.operation?.status, "succeeded", JSON.stringify(completed?.receipt));
      // The durable receipt is the executor result: the capture payload is in
      // its declared output while the result-artifact handle is top-level.
      const receipt = completed!.receipt.body as { output: { capture: { captureId: string; capturedAt: string; contentArtifact: { artifactId: string; digest: string; byteLength: number; }; }; acquisitionReceipt: { artifactId: string; }; }; resultArtifact: { artifactId: string; }; };
      const source = receipt.output.capture;
      outputs.push({ seedId: item.seedId, sourceId: sourceIds.get(item.seedId)!, captureId: source.captureId, operationId, requestedUrl: item.url, finalUrl: item.url,
        capturedAt: source.capturedAt, contentDigest: source.contentArtifact.digest, contentBytes: source.contentArtifact.byteLength,
        acquisitionReceiptArtifactId: receipt.output.acquisitionReceipt.artifactId, sourceArtifactId: source.contentArtifact.artifactId, resultArtifactId: receipt.resultArtifact.artifactId,
        terminalStatus: "succeeded", authority: "official_openai_primary_source_candidate", rights: "public_web_source_rights_unreviewed", temporal: "current_capture_not_archival_provenance", reviewStatus: "review_required" });
      } catch (error) {
        await retainFailedCapture(item, error);
      }
    }
  } finally { await server.close(); }
  checks.apiSubmission = true;
  checks.serverOwnedCatalog = true;
  checks.durableWorker = true;
  checks.postgresAndArtifactStore = true;
  checks.noSemanticProviderOrGold = true;
  const passed = failures.length === 0;
  await writeFile(outputPath, JSON.stringify({ schemaVersion: "openai-pre-mc-capture-result.v1", passed, proofId, tenantId, missionId, workItemId, attemptId, selectedSeedIds: seedIds, sources: outputs, failures, checks,
    limitations: ["Raw source bytes remain in the configured artifact store.", "All captures are current captures, not archival snapshots.", "Authority/rights fields are candidate provenance labels only; gold review remains required.", "No claims, events, qrels, semantic provider calls, ingestion, retrieval, or publication were run."], }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ passed, outputPath, captureCount: outputs.length, failedCount: failures.length }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : "UNKNOWN";
  for (const item of selected) {
    if (outputs.some(output => output.seedId === item.seedId)) continue;
    const operationId = submittedOperationIds.get(item.seedId);
    if (!operationId) continue;
    const captureId = deterministicUuid("verification-live-capture", `${tenantId}:${operationId}:${sourceIds.get(item.seedId)!}`);
    const registered = await repository.getRegisteredCapture({ tenantId, captureId }).catch(() => undefined);
    if (!registered) continue;
    const artifact = registered.capture.contentArtifact;
    outputs.push({ seedId: item.seedId, sourceId: registered.source.sourceId, captureId: registered.capture.captureId, operationId, requestedUrl: item.url, finalUrl: item.url,
      capturedAt: registered.capture.capturedAt, contentDigest: artifact.digest, contentBytes: artifact.byteLength,
      acquisitionReceiptArtifactId: artifact.parentArtifactIds[0]!, sourceArtifactId: artifact.artifactId,
      terminalStatus: "captured_parser_failed", authority: "official_openai_primary_source_candidate", rights: "public_web_source_rights_unreviewed", temporal: "current_capture_not_archival_provenance", reviewStatus: "review_required" });
  }
  await writeFile(outputPath, JSON.stringify({ schemaVersion: "openai-pre-mc-capture-result.v1", passed: false, proofId, tenantId, selectedSeedIds: seedIds, partialSources: outputs, checks, error: message, errorDetail: errorDetail(error) }, null, 2), { flag: "wx" }).catch(() => {});
  console.log(JSON.stringify({ passed: false, outputPath, captureCount: outputs.length, error: message }));
  process.exitCode = 1;
} finally { await database.close(); }
