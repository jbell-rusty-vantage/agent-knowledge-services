/**
 * WI-05 (OVE-167) proof driver: one Knowledge Services K01 executor composition per process (the real binding backend
 * over the disposable component PostgreSQL), so `native-recovery.integration.test.ts` can crash it between the native
 * commit and the protocol receipt and recover in a FRESH process. Test-only.
 *
 *   node --import tsx ks-operation-driver.ts <request.json>
 *
 * request: { step: "invoke" | "receipt", binding: "biotech-graph" | "aiengineer-postgres", installationId, tenants,
 *            jwks, token, envelope?, effectKey?, crash?: "before_protocol_receipt",
 *            hold?: { releaseFile } }  (hold: announce WI05_HELD on stderr after the native commit and wait for the
 *            release file before writing the protocol receipt: a real delayed acknowledgment)
 * env: WI05_KS_DSN (component database), and for aiengineer-postgres WI05_AIDB_WORKSPACE + WI05_ARTIFACT_DIR.
 * Answers one JSON line: { answer } or { refusal }. Never prints credentials.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ReportKindCatalog } from "@aiengineer/knowledge-application";
import {
  createAiEngineerPostgresBackend,
  createIngestionApplyPort,
} from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { createBiotechGraphPostgresBackend } from "@aiengineer/knowledge-binding-biotech-graph";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  KnowledgeOperationService,
  ProtocolRefusal,
  staticJwksSource,
  type KnowledgeOperationBackend,
} from "@aiengineer/knowledge-host/knowledge-operation";
import { requireLoopback } from "./proof-guards.js";
import { TEST_AUDIENCE, TEST_ISSUER } from "./test-support.js";

interface Request {
  readonly step: "invoke" | "receipt";
  readonly binding: "biotech-graph" | "aiengineer-postgres";
  readonly installationId: string;
  readonly tenants: readonly string[];
  readonly jwks: Parameters<typeof staticJwksSource>[0];
  readonly token: string;
  readonly envelope?: unknown;
  readonly effectKey?: string;
  readonly crash?: "before_protocol_receipt";
  readonly hold?: { readonly releaseFile: string };
}

const request = JSON.parse(readFileSync(process.argv[2] as string, "utf8")) as Request;
requireLoopback("WI05_KS_DSN", process.env.WI05_KS_DSN);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kinds = ReportKindCatalog.fromDirectory(resolve(ROOT, "catalog/research/report-kinds"));
const application = request.binding === "biotech-graph" ? "biotech" : "ai-engineer";

async function backendFor(): Promise<{ backend: KnowledgeOperationBackend; close: () => Promise<void> }> {
  const options = {
    application,
    binding: request.binding,
    installationId: request.installationId,
    connectionString: process.env.WI05_KS_DSN as string,
    kinds,
    auditor: null,
  };
  if (request.binding === "biotech-graph") {
    const backend = await createBiotechGraphPostgresBackend(options);
    return { backend, close: () => backend.close() };
  }
  // The real knowledge-db ingestion executor over the disposable AI Engineer database (AIDB guard path).
  const [{ LocalArtifactStore }, db, { TenantPostgres }] = await Promise.all([
    import("@aiengineer/knowledge-core"),
    import("@aiengineer/knowledge-db"),
    import("@aiengineer/knowledge-persistence"),
  ]);
  const { declaredRunsOracle } = await import(
    pathToFileURL(resolve(ROOT, "packages/knowledge-db/test/ingestion/declared-evidence.mjs")).href
  );
  const tenant = new TenantPostgres({ connectionString: process.env.WI05_KS_DSN as string, maximumPoolSize: 3 });
  const workspace = db.loadWorkspace(process.env.WI05_AIDB_WORKSPACE as string);
  const artifacts = new db.ArtifactLedger({
    db: tenant,
    store: new LocalArtifactStore(process.env.WI05_ARTIFACT_DIR as string),
    bucket: "research-ingestion-intents",
    uploaded: false,
    executorVersion: "knowledge-executor/wi05",
  });
  const ingestion = new db.IngestionExecutor({
    db: tenant,
    workspace,
    artifacts,
    executorVersion: "knowledge-executor/wi05",
    evidence: declaredRunsOracle,
  });
  const backend = await createAiEngineerPostgresBackend({ ...options, apply: createIngestionApplyPort(ingestion) });
  return {
    backend,
    close: async () => {
      await backend.close();
      await tenant.close();
    },
  };
}

const { backend, close } = await backendFor();
if (request.crash === "before_protocol_receipt") {
  // A real crash in the window under test: the native transaction committed; the K01 protocol receipt write never runs.
  const ledger = backend.effects();
  ledger.record = async () => {
    process.stderr.write("WI05_CRASH before_protocol_receipt\n");
    process.kill(process.pid, "SIGKILL");
    await new Promise(() => undefined);
    throw new Error("unreachable");
  };
}
if (request.hold !== undefined) {
  const ledger = backend.effects();
  const record = ledger.record.bind(ledger);
  const releaseFile = request.hold.releaseFile;
  ledger.record = async (scope, receipt, options) => {
    process.stderr.write("WI05_HELD before_protocol_receipt\n");
    while (!existsSync(releaseFile)) await new Promise((done) => setTimeout(done, 100));
    return record(scope, receipt, options);
  };
}
const service = new KnowledgeOperationService({
  verifier: new KnowledgeCredentialVerifier({
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    jwks: new JwksCache(staticJwksSource(request.jwks)),
  }),
  backends: [backend],
  installed: [
    { application, binding: request.binding, installationId: request.installationId, tenants: [...request.tenants] },
  ],
  dispatches: new DispatchRegistry(),
  signingIssuer: "knowledge-services",
});
try {
  const answer =
    request.step === "invoke"
      ? await service.invoke(request.token, request.envelope)
      : await service.receipt(request.token, request.effectKey as string);
  process.stdout.write(`${JSON.stringify({ answer })}\n`);
} catch (error) {
  if (!(error instanceof ProtocolRefusal)) throw error;
  process.stdout.write(`${JSON.stringify({ refusal: error.error })}\n`);
} finally {
  await close();
}
