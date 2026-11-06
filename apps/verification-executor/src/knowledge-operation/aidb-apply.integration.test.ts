import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReportKindCatalog } from "@aiengineer/knowledge-application";
import { LocalArtifactStore } from "@aiengineer/knowledge-core";
import { ArtifactLedger, IngestionExecutor, ReadExecutor, loadWorkspace } from "@aiengineer/knowledge-db";
import {
  type JsonValue,
  KnowledgePlanPreviewSchema,
  type OperationEnvelope,
  OperationReceiptSchema,
  ProtocolErrorSchema,
  ReceiptLookupSchema,
  digestCanonical,
  envelopeDigest,
} from "@aiengineer/knowledge-operation-protocol";
import { TenantPostgres, type TenantSqlClient } from "@aiengineer/knowledge-persistence";
import { normalizedValuesDigest } from "@aiengineer/knowledge-research-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Test-only helpers of the knowledge-db and persistence suites (disposable-project guard, declared evidence, snapshot).
import { disposableDatabaseUrl } from "../../../../packages/persistence/test/disposable.mjs";
import { declaredRunsOracle } from "../../../../packages/knowledge-db/test/ingestion/declared-evidence.mjs";
import { withSnapshot } from "../../../../packages/knowledge-db/test/ingestion/snapshot-fixture.mjs";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  staticJwksSource,
} from "@aiengineer/knowledge-host/knowledge-operation";
import { createAiEngineerPostgresBackend } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import { handleKnowledgeOperation } from "./http.js";
import { createIngestionApplyPort } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import type { KnowledgeOperationBackend } from "@aiengineer/knowledge-host/knowledge-operation";
import { KnowledgeOperationService } from "@aiengineer/knowledge-host/knowledge-operation";
import {
  TEST_AUDIENCE,
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
 * SV-16 follow-up B: the REAL `knowledge.apply` path over the wire on a disposable AI Engineer Supabase database
 * (component 2.4.0 installed first, then every AIDB migration incl. the binding and the report-v2 projection). The
 * executor's K01 service calls the knowledge-db `IngestionExecutor`: exact-use admission inside the native ingestion
 * transaction (AIDB guard path), then the K01 receipt document is persisted in component `protocol_receipt` so
 * `receipt.get` answers `found`. Needs `KS_TEST_DATABASE_URL` + `KS_TEST_PROJECT_DIR` (the disposable-project guard of
 * the knowledge-db executor suite); skips without them. Synthetic fixtures; no model calls.
 */
const url = disposableDatabaseUrl();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORKSPACE = resolve(
  process.env.KS_TEST_AIDB_WORKSPACE ?? resolve(ROOT, "../../aiengineer/ai-engineer-db-contract/workspace"),
);
const TENANT = "00000000-0000-7000-8000-000000000001";
/** The disposable's component installation id (`knowledge_verification.installation`); override per database. */
const INSTALLATION = process.env.KS_TEST_AIDB_INSTALLATION ?? "0195f0a0-5b08-7000-8000-00000000a1d8";
const BINDING = "aiengineer-postgres";
const digest = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const values = digestCanonical({ parameters: "7000000000" });

describe.skipIf(!url)("knowledge.apply over K01 on the disposable AI Engineer database (AIDB guard path)", () => {
  const suffix = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const key = generateIssuerKey("mc-issuer-aidb");
  const origin = liveOrigin(TENANT, { installationId: INSTALLATION });
  let db!: TenantPostgres;
  let storeDir = "";
  let reads!: ReadExecutor;
  let ingestion!: IngestionExecutor;
  let backend!: KnowledgeOperationBackend;
  let service!: KnowledgeOperationService;
  let server!: Server;
  let base = "";
  let runId = "";
  const owner = <T>(work: (client: TenantSqlClient) => Promise<T>) => db.transaction({ tenantId: TENANT }, work);

  beforeAll(async () => {
    const workspace = loadWorkspace(WORKSPACE);
    db = new TenantPostgres({ connectionString: url ?? "postgresql://unused", maximumPoolSize: 3 });
    storeDir = mkdtempSync(join(tmpdir(), "ks-kop-aidb-"));
    const artifacts = new ArtifactLedger({
      db,
      store: new LocalArtifactStore(storeDir),
      bucket: "research-ingestion-intents",
      uploaded: false,
      executorVersion: "knowledge-executor/test",
    });
    reads = new ReadExecutor({ db, workspace, artifacts, executorVersion: "knowledge-executor/test" });
    ingestion = new IngestionExecutor({
      db,
      workspace,
      artifacts,
      executorVersion: "knowledge-executor/sv16-kop",
      evidence: declaredRunsOracle,
    });
    // A sealed component run with a report revision (the use-decision guard requires one), seeded as the owner.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = `ks-kop-test-${suffix}`;
    runId = await owner(async (c) => {
      const spki = publicKey.export({ format: "der", type: "spki" });
      await c.query(
        "insert into knowledge_verification.seal_signing_key (key_id, algorithm, public_key, issuer) values ($1, 'Ed25519', $2, 'knowledge-services')",
        [keyId, Buffer.from(spki.subarray(spki.length - 32))],
      );
      const originDigest = digestCanonical({ seed: suffix });
      await c.query(
        `insert into knowledge_verification.origin (tenant_id, origin_digest, kind, installation_id, application_id, issuer, subject, identity)
         values ($1, $2, 'standalone', 'i', 'ai-engineer', 'ks', 'seed', '{}'::jsonb)`,
        [TENANT, originDigest],
      );
      await c.query(
        `insert into knowledge_verification.verification_task (tenant_id, task_id, schema_version, task_digest, original_task_ref, use_name, audience, minimum_risk, rubric_ref, policy_ref, body)
         values ($1, $2, 'research-core.task.v2', $3, '{}'::jsonb, 'knowledge_ingestion', 'official', 'medium', 'r', 'p', '{}'::jsonb)`,
        [TENANT, `task-${suffix}`, digest(`task-${suffix}`)],
      );
      const run = await c.query<{ run_id: string }>(
        "insert into knowledge_verification.verification_run (tenant_id, task_id, binding, originating_origin_digest) values ($1, $2, 'aiengineer-postgres', $3) returning run_id::text",
        [TENANT, `task-${suffix}`, originDigest],
      );
      const id = String(run.rows[0]?.run_id);
      const body = `# exact use ${suffix}\n`;
      for (const [artifact, content] of [
        [`s-${suffix}`, `{"s":"${suffix}"}`],
        [`b-${suffix}`, body],
        [`l-${suffix}`, `["${suffix}"]`],
      ] as const) {
        await c.query(
          "insert into knowledge_verification.artifact_custody (tenant_id, artifact_id, digest, byte_length, media_type, custody_kind, inline_bytes) values ($1, $2, $3, $4, 'text/plain', 'inline', $5)",
          [TENANT, artifact, digest(content), Buffer.byteLength(content), Buffer.from(content)],
        );
      }
      const kind = {
        kind: "report_kind",
        id: "evidence_report@1.0.0",
        version: "research-report-kind.v1",
        digest: digest("kind"),
        tenant: TENANT,
        binding: BINDING,
      };
      await c.query(
        `insert into knowledge_verification.report_revision (tenant_id, report_revision_id, report_id, revision, schema_version, report_kind, task_id, run_id,
           structured_body_artifact_id, body_artifact_id, ledger_artifact_id, body_digest, renderer_version, assertion_refs, time_coverage, record, digest)
         values ($1, $2, $3, 1, 'research-report.v2', 'evidence_report', $4, $5::uuid, $6, $7, $8, $9, 'r', '[]'::jsonb, '{}'::jsonb, $10::jsonb, $11)`,
        [
          TENANT,
          `rev-${suffix}`,
          `report-${suffix}`,
          `task-${suffix}`,
          id,
          `s-${suffix}`,
          `b-${suffix}`,
          `l-${suffix}`,
          digest(body),
          JSON.stringify({ kind }),
          digest(`rev-${suffix}`),
        ],
      );
      const manifest = { snapshot: "verification_snapshot", run: { id }, predecessor: null };
      const manifestDigest = digestCanonical(manifest);
      const context = { manifestDigest, signer: "ks-sealer", signedAt: "2026-10-25T00:00:00Z", keyId };
      await c.query(
        "select * from knowledge_verification.seal_run($1, $2::uuid, null, 'verification_snapshot', $3::jsonb, $4, $5::jsonb, 'ks-sealer', 'Ed25519', $6, $7, $8::jsonb)",
        [
          TENANT,
          id,
          JSON.stringify(manifest),
          manifestDigest,
          JSON.stringify({
            capture: digest("c"),
            claims: digest("cl"),
            report: digest("r"),
            observations: digest("o"),
          }),
          keyId,
          sign(null, Buffer.from(JSON.stringify(context)), privateKey),
          JSON.stringify(context),
        ],
      );
      return id;
    });
    backend = await createAiEngineerPostgresBackend({
      application: "ai-engineer",
      binding: BINDING,
      installationId: INSTALLATION,
      connectionString: url as string,
      kinds: ReportKindCatalog.fromDirectory(resolve(ROOT, "catalog/research/report-kinds")),
      auditor: null,
      apply: createIngestionApplyPort(ingestion),
    });
    service = new KnowledgeOperationService({
      verifier: new KnowledgeCredentialVerifier({
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        jwks: new JwksCache(staticJwksSource(jwksOf([key]))),
      }),
      backends: [backend],
      installed: [{ application: "ai-engineer", binding: BINDING, installationId: INSTALLATION, tenants: [TENANT] }],
      dispatches: new DispatchRegistry(),
      signingIssuer: "knowledge-services",
    });
    server = createServer((request, response) => {
      void handleKnowledgeOperation(request, response, new URL(request.url ?? "/", "http://localhost"), service);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/knowledge-operation/v2`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    await backend?.close();
    await db?.close();
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
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
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** The exact-use ingestion intent of one effect (`exactUse` with or without the decision fields), snapshotted now. */
  async function draftFor(name: string, exactUse: Record<string, unknown>) {
    return withSnapshot(reads, {
      schemaVersion: "knowledge-ingestion-intent.v1",
      intentId: `kop-${name}-${suffix}`.slice(0, 64),
      context: { tenantId: TENANT, correlationId: `kop-${suffix}`, actor: { kind: "service", id: "vitest" } },
      expectedKnowledgeHead: (await reads.head(TENANT)).knowledgeSeq,
      onStale: "rebase_if_disjoint",
      asOf: "2026-10-25",
      evidence: { verificationRuns: [{ runId: `vr_kop_${suffix}` }] },
      subjects: [
        {
          ref: "org",
          mode: "new",
          kind: "organization",
          displayName: `KOP Exact Use Org ${suffix} ${name}`,
          typedPayload: { website_url: "https://example.test" },
          onMatch: "fail",
          evidence: [{ runId: `vr_kop_${suffix}`, claimId: "c_1" }],
        },
      ],
      proposals: [
        {
          proposalId: "p-01",
          kind: "entity.alias",
          subjectRef: "org",
          alias: `KOP-${suffix}-${name}`.slice(0, 60),
          aliasKind: "acronym",
          evidence: [{ runId: `vr_kop_${suffix}`, claimId: "c_1" }],
        },
      ],
      // A preview intent omits the decision fields (IngestionPreviewIntent); the apply intent carries them.
      exactUse: exactUse as never,
    });
  }

  /** Plan first (read-only) to learn the exact native effect, decide on THAT plan-level digest, then send the intent. */
  async function prepared(
    name: string,
    options: {
      epochShift?: number;
      reviewRequired?: boolean;
      retry?: { intent: Awaited<ReturnType<typeof draftFor>>; intentId: string };
    } = {},
  ) {
    const epoch = await owner(async (c) =>
      Number(
        (await c.query<{ e: string }>("select knowledge_verification.current_revocation_epoch($1)::text e", [TENANT]))
          .rows[0]?.e,
      ),
    );
    const effectKey = `effect-kop-${suffix}-${name}`;
    const decisionId = `ud-kop-${suffix}-${name}`;
    const exactUse = {
      useDecisionId: decisionId,
      boundEffectDigest: digest("placeholder: replaced by the plan's bound digest"),
      processedEpoch: epoch - (options.epochShift ?? 0),
      normalizedValuesDigest: values,
      effectKey,
      originatingOrigin: origin,
    };
    const draft = options.retry
      ? { ...options.retry.intent, intentId: options.retry.intentId, exactUse }
      : await draftFor(name, exactUse);
    const plan = await ingestion.plan(draft);
    const bound = plan.effect?.boundEffectDigest as string;
    await owner((c) =>
      c.query(
        `insert into knowledge_verification.use_decision (tenant_id, use_decision_id, schema_version, subject_kind, subject_id, subject_digest, run_id, bound_effect_digest, use_name, audience, disposition, conditions, policy_ref, rubric_ref, qualifiers_digest, revocation_epoch, record, digest, normalized_values, normalized_values_digest)
         values ($1, $2, 'research-core.use_decision.v2', 'report', $3, $4, $5::uuid, $6, 'knowledge_ingestion', 'official', 'admitted', $12::jsonb, 'p', 'r', null, $7, $8::jsonb, $9, $10::jsonb, $11)`,
        [
          TENANT,
          decisionId,
          `rev-${suffix}`,
          digest(`rev-${suffix}`),
          runId,
          bound,
          epoch,
          JSON.stringify({ normalizedValues: { parameters: "7000000000" }, report: { id: `rev-${suffix}` } }),
          digest(decisionId),
          JSON.stringify({ parameters: "7000000000" }),
          values,
          JSON.stringify(options.reviewRequired ? ["review_required"] : []),
        ],
      ),
    );
    const intent = {
      ...draft,
      exactUse: { ...(draft.exactUse as NonNullable<typeof draft.exactUse>), boundEffectDigest: bound },
    };
    // The envelope carries the plan-level bound digest explicitly (integrator decision 2026-10-25).
    const envelope = envelopeFor({
      operation: "knowledge.apply",
      origin,
      binding: BINDING,
      payload: JSON.parse(JSON.stringify(intent)) as JsonValue,
      effectKey,
      boundEffectDigest: bound,
    });
    return { intent, envelope, effectKey, decisionId, bound };
  }

  it("admitted -> receipt (AIDB guard path) -> receipt.get found; duplicate -> same receipt", async () => {
    const { envelope, effectKey, decisionId, bound } = await prepared("admit");
    const applied = await call("/invoke", token(envelope), envelope);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const receipt = OperationReceiptSchema.parse(applied.body);
    expect(receipt.outcome).toBe("applied");
    expect(receipt.effect.boundEffectDigest).toBe(bound);
    expect((receipt.details as { admission: { path: string; useDecisionId: string } }).admission).toMatchObject({
      path: "aidb_guard",
      useDecisionId: decisionId,
    });
    const found = await call(`/receipts/${effectKey}`, token(null, ["receipt.get"]));
    expect(ReceiptLookupSchema.parse(found.body)).toEqual({ disposition: "found", receipt });
    const again = { ...envelope, dispatchId: `dispatch-${randomBytes(6).toString("hex")}` };
    expect(OperationReceiptSchema.parse((await call("/invoke", token(again), again)).body)).toEqual(receipt);
    const rows = await owner(
      async (c) =>
        (
          await c.query<{ admissions: number; protocol: number; native: number }>(
            `select (select count(*)::int from research.use_admission where tenant_id = $1 and use_decision_id = $2) as admissions,
                    (select count(*)::int from knowledge_verification.protocol_receipt where tenant_id = $1 and effect_key = $3) as protocol,
                    (select count(*)::int from knowledge_verification.effect_receipt where tenant_id = $1 and effect_key = $3) as native`,
            [TENANT, decisionId, effectKey],
          )
        ).rows[0],
    );
    expect(rows).toEqual({ admissions: 1, protocol: 1, native: 1 });
  }, 120_000);

  it("review successor admits the original selected key before first native dispatch; replay keeps one receipt", async () => {
    const root = await prepared("review-root", { reviewRequired: true });
    const epoch = root.intent.exactUse!.processedEpoch;
    const admit = (id: string, bound = root.bound, normalized = values) =>
      owner(
        async (c) =>
          (
            await c.query("select * from knowledge_verification.admit_exact_use($1, $2, $3, $4, now(), $5)", [
              TENANT,
              id,
              bound,
              epoch,
              normalized,
            ])
          ).rows[0],
      );
    expect(await admit(root.decisionId)).toMatchObject({ outcome: "held", reason: "REVIEW_REQUIRED" });
    const successor = `${root.decisionId}-review`;
    const adjudication = `adj-${suffix}-native`;
    const reviewer = `reviewer-${suffix}`;
    await owner(async (c) => {
      await c.query(
        `insert into knowledge_verification.reviewer_grant
        (tenant_id, reviewer_id, scope, granted_by, granted_at)
        values ($1, $2, '{"uses":["knowledge_ingestion"],"audiences":["official"],"reportKinds":["evidence_report"]}'::jsonb, 'owner', now() - interval '1 hour')`,
        [TENANT, reviewer],
      );
      await c.query(
        `insert into knowledge_verification.adjudication
        (tenant_id, adjudication_id, subject_kind, subject_id, subject_digest, bound_effect_digest, reviewer_id, decision, rationale, digest, use_decision_id, qualifiers_digest)
        values ($1, $2, 'report', $3, $4, $5, $6, 'approve', 'exact native effect reviewed', $7, $8, null)`,
        [
          TENANT,
          adjudication,
          `rev-${suffix}`,
          digest(`rev-${suffix}`),
          root.bound,
          reviewer,
          digest(adjudication),
          root.decisionId,
        ],
      );
      await c.query(
        `insert into knowledge_verification.use_decision
        (tenant_id, use_decision_id, schema_version, subject_kind, subject_id, subject_digest, run_id, bound_effect_digest, use_name, audience, disposition, conditions, policy_ref, rubric_ref, qualifiers_digest, revocation_epoch, reviewer_adjudication_id, supersedes_use_decision_id, record, digest, normalized_values, normalized_values_digest)
        select tenant_id, $3, schema_version, subject_kind, subject_id, subject_digest, run_id, bound_effect_digest, use_name, audience, disposition, conditions, policy_ref, rubric_ref, qualifiers_digest, revocation_epoch, $4, use_decision_id, record, $5, normalized_values, normalized_values_digest
        from knowledge_verification.use_decision where tenant_id=$1 and use_decision_id=$2`,
        [TENANT, root.decisionId, successor, adjudication, digest(successor)],
      );
    });
    expect(await admit(root.decisionId)).toMatchObject({ outcome: "held", reason: "STALE_DECISION" });
    expect(await admit(successor)).toMatchObject({ outcome: "admitted" });
    expect(await admit(successor, digest("foreign native bytes"))).toMatchObject({
      outcome: "rejected",
      reason: "EFFECT_DIGEST_MISMATCH",
    });
    expect(await admit(successor, root.bound, digestCanonical({ changed: true }))).toMatchObject({
      outcome: "rejected",
      reason: "NORMALIZED_VALUES_MISMATCH",
    });
    // Read admission probes above created no native effect or ledger receipt. The first dispatch
    // uses successor authority with the original immutable plan, epoch, values, origin and key.
    const before = await rowCounts(root.effectKey);
    if (!before || typeof before.receipts !== "number") throw new Error("missing native fixture counts");
    expect(before.native).toBe(0);
    expect(before.protocol).toBe(0);
    expect(before.dispatches).toBe(0);
    const intent = { ...root.intent, exactUse: { ...root.intent.exactUse!, useDecisionId: successor } };
    const envelope = envelopeFor({
      operation: "knowledge.apply",
      origin,
      binding: BINDING,
      payload: JSON.parse(JSON.stringify(intent)) as JsonValue,
      effectKey: root.effectKey,
      boundEffectDigest: root.bound,
    });
    const answer = await call("/invoke", token(envelope), envelope);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const receipt = OperationReceiptSchema.parse(answer.body);
    expect(receipt.outcome).toBe("applied");
    expect(receipt.effect.effectKey).toBe(root.effectKey);
    expect((receipt.details as { admission: Record<string, unknown> }).admission).toMatchObject({
      useDecisionId: successor,
      boundEffectDigest: root.bound,
      effectKey: root.effectKey,
    });
    const duplicate = { ...envelope, dispatchId: `dispatch-${randomBytes(6).toString("hex")}` };
    expect(OperationReceiptSchema.parse((await call("/invoke", token(duplicate), duplicate)).body)).toEqual(receipt);
    expect(
      ReceiptLookupSchema.parse((await call(`/receipts/${root.effectKey}`, token(null, ["receipt.get"]))).body),
    ).toEqual({ disposition: "found", receipt });
    const after = await rowCounts(root.effectKey);
    if (!after || typeof after.receipts !== "number") throw new Error("missing native fixture counts");
    expect(after.native).toBe(1);
    expect(after.protocol).toBe(1);
    expect(after.receipts - before.receipts).toBe(1);
  }, 120_000);

  /** Rows the preview must never write (native ledger, domain, artifacts, component effects/journal/receipts). */
  async function rowCounts(effectKey: string) {
    return owner(
      async (c) =>
        (
          await c.query<Record<string, number>>(
            `select (select count(*)::int from orchestration.operation_intent where tenant_id = $1) as intents,
                    (select count(*)::int from orchestration.operation_receipt r join orchestration.operation_intent i on i.id = r.intent_id where i.tenant_id = $1) as receipts,
                    (select count(*)::int from corpus.entity where tenant_id = $1) as entities,
                    (select count(*)::int from knowledge_verification.origin where tenant_id = $1) as origins,
                    (select count(*)::int from knowledge_verification.effect where tenant_id = $1 and effect_key = $2) as effects,
                    (select count(*)::int from knowledge_verification.effect_dispatch where tenant_id = $1 and effect_key = $2) as dispatches,
                    (select count(*)::int from knowledge_verification.effect_receipt where tenant_id = $1 and effect_key = $2) as native,
                    (select count(*)::int from knowledge_verification.protocol_receipt where tenant_id = $1 and effect_key = $2) as protocol,
                    (select count(*)::int from research.use_admission where tenant_id = $1) as admissions,
                    (select knowledge_seq from api.knowledge_head()) as head`,
            [TENANT, effectKey],
          )
        ).rows[0],
    );
  }

  it("knowledge.plan_preview (read-only) -> decide on its digests -> knowledge.apply admits them exactly", async () => {
    const effectKey = `effect-kop-${suffix}-preview`;
    const decisionId = `ud-kop-${suffix}-preview`;
    // What Mission Control has before it decides: the effect key and originating origin, no decision fields.
    const previewKey = `preview-${suffix}`;
    const draft = await draftFor("preview", { effectKey: previewKey, originatingOrigin: origin });
    const previewEnvelope = envelopeFor({
      operation: "knowledge.plan_preview",
      origin,
      binding: BINDING,
      payload: JSON.parse(JSON.stringify(draft)) as JsonValue,
      effectKey: previewKey,
    });
    const previewToken = signCredential(
      key,
      claimsFor({
        origin,
        operations: ["knowledge.plan_preview"],
        dispatchId: previewEnvelope.dispatchId,
        binding: BINDING,
      }),
    );
    const before = await rowCounts(effectKey);
    const answered = await call("/invoke", previewToken, previewEnvelope);
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const preview = KnowledgePlanPreviewSchema.parse(answered.body);
    // Read-only: nothing bound, journaled, admitted, planned into the ledger or written to the domain.
    expect(await rowCounts(effectKey)).toEqual(before);
    expect(preview.processedEpoch).toBe(
      await owner(async (c) =>
        Number(
          (await c.query<{ e: string }>("select knowledge_verification.current_revocation_epoch($1)::text e", [TENANT]))
            .rows[0]?.e,
        ),
      ),
    );
    // No values presented: the echo is the digest an empty-values decision stores (the binding's `recordDecision`
    // computes it with research-core `normalizedValuesDigest`) and AIDB's exact-use admission compares below.
    const emptyValues = normalizedValuesDigest({});
    expect(preview.normalizedValuesDigest).toBe(emptyValues);
    expect(preview.migrationHead).toBe(loadWorkspace(WORKSPACE).migrationHead);
    // The same plan-level values the native planner computes for the apply intent (decision fields filled in).
    const applyIntent = {
      ...draft,
      exactUse: {
        useDecisionId: decisionId,
        boundEffectDigest: preview.boundEffectDigest,
        processedEpoch: preview.processedEpoch,
        normalizedValuesDigest: preview.normalizedValuesDigest,
        effectKey,
        originatingOrigin: origin,
      },
    };
    const plan = await ingestion.plan(applyIntent);
    expect({
      planId: plan.planId,
      semanticPayloadDigest: plan.effect?.semanticPayloadDigest,
      boundEffectDigest: plan.effect?.boundEffectDigest,
    }).toEqual({
      planId: preview.planId,
      semanticPayloadDigest: preview.semanticPayloadDigest,
      boundEffectDigest: preview.boundEffectDigest,
    });
    // The decision binds the previewed bound digest and epoch; its values digest is the binding's own `{}` digest.
    await owner((c) =>
      c.query(
        `insert into knowledge_verification.use_decision (tenant_id, use_decision_id, schema_version, subject_kind, subject_id, subject_digest, run_id, bound_effect_digest, use_name, audience, disposition, conditions, policy_ref, rubric_ref, qualifiers_digest, revocation_epoch, record, digest, normalized_values, normalized_values_digest)
         values ($1, $2, 'research-core.use_decision.v2', 'report', $3, $4, $5::uuid, $6, 'knowledge_ingestion', 'official', 'admitted', '[]'::jsonb, 'p', 'r', null, $7, $8::jsonb, $9, '{}'::jsonb, $10)`,
        [
          TENANT,
          decisionId,
          `rev-${suffix}`,
          digest(`rev-${suffix}`),
          runId,
          preview.boundEffectDigest,
          preview.processedEpoch,
          JSON.stringify({ normalizedValues: {}, report: { id: `rev-${suffix}` } }),
          digest(decisionId),
          emptyValues,
        ],
      ),
    );
    const envelope = envelopeFor({
      operation: "knowledge.apply",
      origin,
      binding: BINDING,
      payload: JSON.parse(JSON.stringify(applyIntent)) as JsonValue,
      effectKey,
      boundEffectDigest: preview.boundEffectDigest,
    });
    const applied = await call("/invoke", token(envelope), envelope);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const receipt = OperationReceiptSchema.parse(applied.body);
    expect(receipt.outcome).toBe("applied");
    expect(receipt.effect.boundEffectDigest).toBe(preview.boundEffectDigest);
    expect((receipt.details as { admission: Record<string, unknown> }).admission).toMatchObject({
      path: "aidb_guard",
      useDecisionId: decisionId,
      boundEffectDigest: preview.boundEffectDigest,
      effectKey,
    });
    // AIDB's admission row records the values digest the native write presented: the echoed `{}` digest.
    const admitted = await owner(async (c) =>
      (
        await c.query<{ v: string | null }>(
          "select normalized_values_digest as v from research.use_admission where tenant_id = $1 and use_decision_id = $2",
          [TENANT, decisionId],
        )
      ).rows.map((row) => row.v),
    );
    expect(admitted).toEqual([emptyValues]);
    // The native effect receipt names the previewed plan.
    const nativeRef = await owner(
      async (c) =>
        (
          await c.query<{ ref: { planId: string } }>(
            "select native_receipt_ref as ref from knowledge_verification.effect_receipt where tenant_id = $1 and effect_key = $2",
            [TENANT, effectKey],
          )
        ).rows[0]?.ref,
    );
    expect(nativeRef?.planId).toBe(preview.planId);
  }, 120_000);

  it("knowledge.plan_preview successor after rejected admission preserves the old receipt and applies once", async () => {
    const rejected = await prepared("rejected-retry");
    await owner(async (c) => {
      const inv = await c.query<{ invalidation_id: string }>(
        "select invalidation_id::text from knowledge_verification.record_invalidation($1, 'fragment', $2, 'unrelated correction')",
        [TENANT, `frag-retry-${suffix}`],
      );
      await c.query(
        "update knowledge_verification.invalidation set closure_processed_at = now() where invalidation_id = $1::uuid",
        [inv.rows[0]?.invalidation_id],
      );
    });
    const refusal = await call("/invoke", token(rejected.envelope), rejected.envelope);
    expect(ProtocolErrorSchema.parse(refusal.body).code).toBe("STALE_DECISION");
    expect(await nativeCounts(rejected.effectKey, rejected.decisionId)).toMatchObject({ native: 0, commit: 0 });
    const oldOutcome = async () =>
      owner(async (c) =>
        (
          await c.query<{ outcome: string }>(
            "select r.outcome from orchestration.operation_intent i join orchestration.operation_receipt r on r.intent_id = i.id where i.tenant_id = $1 and i.payload->>'intentId' = $2",
            [TENANT, rejected.intent.intentId],
          )
        ).rows.map((row) => row.outcome),
      );
    expect(await oldOutcome()).toEqual(["rejected"]);
    // MC only chooses this stable successor after its journal has fenced the rejected dispatch. A new native intent
    // gets a new plan/use decision; mutating decision fields under the rejected intent's key would conflict.
    const intentId = `mc-retry-${digestCanonical({ prior: rejected.intent.intentId, decision: rejected.decisionId, bound: rejected.bound }).slice(7, 47)}`;
    const successor = await prepared("retry-successor", { retry: { intent: rejected.intent, intentId } });
    const applied = await call("/invoke", token(successor.envelope), successor.envelope);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const receipt = OperationReceiptSchema.parse(applied.body);
    expect(receipt.outcome).toBe("applied");
    const replay = { ...successor.envelope, dispatchId: `dispatch-${randomBytes(6).toString("hex")}` };
    expect((await call("/invoke", token(replay), replay)).body).toEqual(receipt);
    expect(await oldOutcome()).toEqual(["rejected"]);
    expect(await nativeCounts(successor.effectKey, successor.decisionId)).toMatchObject({
      native: 1,
      commit: 1,
      protocol: 1,
    });
    expect(await nativeCounts(rejected.effectKey, rejected.decisionId)).toMatchObject({ native: 0, commit: 0 });
  }, 120_000);

  it("stale epoch -> STALE_DECISION; edited bytes -> EFFECT_CONFLICT; nothing written", async () => {
    const stale = await prepared("stale");
    await owner(async (c) => {
      const inv = await c.query<{ invalidation_id: string }>(
        "select invalidation_id::text from knowledge_verification.record_invalidation($1, 'fragment', $2, 'unrelated correction')",
        [TENANT, `frag-unrelated-kop-${suffix}`],
      );
      await c.query(
        "update knowledge_verification.invalidation set closure_processed_at = now() where invalidation_id = $1::uuid",
        [inv.rows[0]?.invalidation_id],
      );
    });
    const before = (await reads.head(TENANT)).knowledgeSeq;
    const staleResult = await call("/invoke", token(stale.envelope), stale.envelope);
    expect(ProtocolErrorSchema.parse(staleResult.body)).toMatchObject({ code: "STALE_DECISION", domainOutcome: true });
    expect(staleResult.status).toBe(409);
    const edited = await prepared("edited");
    const otherBound = digest("other bytes");
    const editedIntent = {
      ...edited.intent,
      exactUse: {
        ...(edited.intent.exactUse as NonNullable<typeof edited.intent.exactUse>),
        boundEffectDigest: otherBound,
      },
    };
    const editedEnvelope = envelopeFor({
      operation: "knowledge.apply",
      origin,
      binding: BINDING,
      payload: JSON.parse(JSON.stringify(editedIntent)) as JsonValue,
      effectKey: edited.effectKey,
      boundEffectDigest: otherBound,
    });
    const conflict = await call("/invoke", token(editedEnvelope), editedEnvelope);
    expect(ProtocolErrorSchema.parse(conflict.body).code).toBe("EFFECT_CONFLICT");
    // The envelope digest must equal the intent's exact-use digest (checked before the native transaction).
    const mismatched = { ...edited.envelope, dispatchId: `dispatch-${randomBytes(6).toString("hex")}` };
    const forged = {
      ...mismatched,
      effect: { ...(mismatched.effect as NonNullable<OperationEnvelope["effect"]>), boundEffectDigest: otherBound },
    };
    expect(ProtocolErrorSchema.parse((await call("/invoke", token(forged), forged)).body).code).toBe("EFFECT_CONFLICT");
    expect((await reads.head(TENANT)).knowledgeSeq).toBe(before);
    for (const effectKey of [stale.effectKey, edited.effectKey]) {
      const lookup = await call(`/receipts/${effectKey}`, token(null, ["receipt.get"]));
      expect(ReceiptLookupSchema.parse(lookup.body).disposition).toBe("not_found");
    }
  }, 120_000);

  // ------------------------------------------------------------------------------------------ WI-05 (OVE-167)

  /** A child held after its native commit (stderr `WI05_HELD`) until `release()`: a real delayed acknowledgment. */
  async function heldChild(body: Record<string, unknown>) {
    const tag = randomBytes(4).toString("hex");
    const file = join(storeDir, `wi05-request-${tag}.json`);
    const releaseFile = join(storeDir, `wi05-release-${tag}`);
    writeFileSync(
      file,
      JSON.stringify({
        binding: BINDING,
        installationId: INSTALLATION,
        tenants: [TENANT],
        jwks: jwksOf([key]),
        ...body,
        hold: { releaseFile },
      }),
    );
    const here = dirname(fileURLToPath(import.meta.url));
    const proc = spawn(process.execPath, ["--import", "tsx", join(here, "tests", "ks-operation-driver.ts"), file], {
      cwd: resolve(here, "../.."),
      env: { ...process.env, WI05_KS_DSN: url as string, WI05_AIDB_WORKSPACE: WORKSPACE, WI05_ARTIFACT_DIR: storeDir },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += String(chunk)));
    const held = new Promise<void>((ready, failed) => {
      proc.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.includes("WI05_HELD")) ready();
      });
      proc.on("exit", () => failed(new Error(`driver exited before holding: ${stderr.slice(-2000)}`)));
    });
    const done = new Promise<Record<string, unknown>>((answer, failed) =>
      proc.on("exit", (status) => {
        const line = stdout.trim().split("\n").filter(Boolean).at(-1);
        if (status !== 0 || !line) failed(new Error(`driver failed: ${stderr.slice(-2000)}`));
        else answer(JSON.parse(line) as Record<string, unknown>);
      }),
    );
    await held;
    return { release: () => writeFileSync(releaseFile, "release"), done };
  }

  /** One K01 executor composition in its OWN OS process over this database (the crash and the recovery processes). */
  function child(body: Record<string, unknown>): { killed: boolean; out: Record<string, unknown> | null } {
    const file = join(storeDir, `wi05-request-${randomBytes(4).toString("hex")}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        binding: BINDING,
        installationId: INSTALLATION,
        tenants: [TENANT],
        jwks: jwksOf([key]),
        ...body,
      }),
    );
    const here = dirname(fileURLToPath(import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(here, "tests", "ks-operation-driver.ts"), file],
      {
        cwd: resolve(here, "../.."),
        env: {
          ...process.env,
          WI05_KS_DSN: url as string,
          WI05_AIDB_WORKSPACE: WORKSPACE,
          WI05_ARTIFACT_DIR: storeDir,
        },
        encoding: "utf8",
        timeout: 180_000,
        windowsHide: true,
      },
    );
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    // The driver announces the crash on stderr right before it SIGKILLs itself; anything else is a failure.
    const killed = !line && result.status !== 0 && result.stderr.includes("WI05_CRASH");
    if (!killed && (result.status !== 0 || !line)) throw new Error(`driver failed: ${result.stderr.slice(-2000)}`);
    return { killed, out: line ? (JSON.parse(line) as Record<string, unknown>) : null };
  }

  const nativeCounts = (effectKey: string, decisionId: string) =>
    owner(
      async (c) =>
        (
          await c.query<Record<string, number>>(
            `select (select count(*)::int from research.use_admission where tenant_id = $1 and use_decision_id = $2) as admissions,
                    (select count(*)::int from orchestration.operation_receipt where use_decision_id = $2) as receipts,
                    (select count(*)::int from knowledge_verification.effect_receipt where tenant_id = $1 and effect_key = $3) as native,
                    (select count(*)::int from knowledge_verification.effect_commit where tenant_id = $1 and effect_key = $3) as commit,
                    (select count(*)::int from knowledge_verification.effect_dispatch where tenant_id = $1 and effect_key = $3) as journal,
                    (select count(*)::int from knowledge_verification.protocol_receipt where tenant_id = $1 and effect_key = $3) as protocol`,
            [TENANT, decisionId, effectKey],
          )
        ).rows[0],
    );

  it("WI-05: a real crash after the AIDB commit and before the protocol receipt; fresh processes answer the original receipt and never apply again", async () => {
    const x = await prepared("wi05-crash");
    const before = (await reads.head(TENANT)).knowledgeSeq;
    // Process A: the native ingestion transaction (domain rows + AIDB guard admission + effect receipt + commit stamp)
    // commits; the process dies before the K01 protocol receipt is written.
    const crashed = child({
      step: "invoke",
      envelope: x.envelope,
      token: token(x.envelope),
      crash: "before_protocol_receipt",
    });
    expect(crashed.killed).toBe(true);
    expect(await nativeCounts(x.effectKey, x.decisionId)).toEqual({
      admissions: 1,
      receipts: 1,
      native: 1,
      commit: 1,
      journal: 1,
      protocol: 0,
    });
    const head = (await reads.head(TENANT)).knowledgeSeq;
    expect(head).toBeGreaterThan(before);

    // Process B (fresh): a retransmission answers the ORIGINAL caller/effect receipt rebuilt from the journal and the
    // committed native receipt read back; the knowledge head does not move (nothing applied again).
    const retry = { ...x.envelope, dispatchId: `dispatch-${randomBytes(6).toString("hex")}` };
    const receipt = OperationReceiptSchema.parse(
      child({ step: "invoke", envelope: retry, token: token(retry) }).out?.answer,
    );
    expect(receipt.outcome).toBe("applied");
    expect(receipt.effect).toMatchObject({
      dispatchId: x.envelope.dispatchId,
      envelopeDigest: envelopeDigest(x.envelope),
      dispatchSequence: 1,
      currentCallerOrigin: origin,
      boundEffectDigest: x.bound,
    });
    expect(receipt.details).toMatchObject({
      duplicateOf: null,
      admission: { path: "aidb_guard", useDecisionId: x.decisionId },
    });
    expect((await reads.head(TENANT)).knowledgeSeq).toBe(head);

    // Separate native readback (this process, its own executor objects): the committed ingestion receipt is the one the
    // protocol receipt names, and it binds the committed effect receipt digest.
    const native = await ingestion.committedExactUseReceipt({
      tenantId: TENANT,
      effectKey: x.effectKey,
      receiptId: receipt.nativeReceiptRef.id,
    });
    expect(native.admission?.effectReceiptDigest).toBe(receipt.nativeReceiptRef.digest);

    // Process C (fresh, read-only recovery): receipt.get answers the same recorded document.
    const lookupClaims = claimsFor({
      origin: recoveryOriginFor(TENANT, "recovery-wi05", INSTALLATION),
      operations: ["receipt.get"],
      dispatchId: `dispatch-${randomBytes(6).toString("hex")}`,
      binding: BINDING,
      recovery: {
        scope: "read_only",
        authorityRef: "recovery-wi05",
        effectKey: x.effectKey,
        boundEffectDigest: x.bound,
      },
    });
    const found = ReceiptLookupSchema.parse(
      child({ step: "receipt", token: signCredential(key, lookupClaims), effectKey: x.effectKey }).out?.answer,
    );
    expect(found).toEqual({ disposition: "found", receipt });

    // Changed bytes under the committed key refuse EFFECT_CONFLICT; nothing native runs.
    const edited = await prepared("wi05-edited");
    const forged = {
      ...edited.envelope,
      effect: { ...(edited.envelope.effect as NonNullable<OperationEnvelope["effect"]>), effectKey: x.effectKey },
    };
    expect(child({ step: "invoke", envelope: forged, token: token(forged) }).out?.refusal).toMatchObject({
      code: "EFFECT_CONFLICT",
    });

    // Revocation after the commit (during the lost acknowledgment): the committed effect is not un-applied; the receipt
    // keeps its processed epoch, and a new admission under the old epoch is refused (rolled back).
    await owner(async (c) => {
      const inv = await c.query<{ invalidation_id: string }>(
        "select invalidation_id::text from knowledge_verification.record_invalidation($1, 'fragment', $2, 'unrelated correction')",
        [TENANT, `frag-wi05-${suffix}`],
      );
      await c.query(
        "update knowledge_verification.invalidation set closure_processed_at = now() where invalidation_id = $1::uuid",
        [inv.rows[0]?.invalidation_id],
      );
    });
    const again = { ...x.envelope, dispatchId: `dispatch-${randomBytes(6).toString("hex")}` };
    expect(
      OperationReceiptSchema.parse(child({ step: "invoke", envelope: again, token: token(again) }).out?.answer),
    ).toEqual(receipt);
    // (A fresh dispatch id: the forged envelope above already consumed the edited one's.)
    const stale = { ...edited.envelope, dispatchId: `dispatch-${randomBytes(6).toString("hex")}` };
    expect(child({ step: "invoke", envelope: stale, token: token(stale) }).out?.refusal).toMatchObject({
      code: "STALE_DECISION",
    });

    // No duplicated native write in AI Engineer: one admission, one native receipt, one commit, one protocol receipt.
    expect(await nativeCounts(x.effectKey, x.decisionId)).toEqual({
      admissions: 1,
      receipts: 1,
      native: 1,
      commit: 1,
      journal: 1,
      protocol: 1,
    });
    expect((await nativeCounts(edited.effectKey, edited.decisionId))?.commit).toBe(0);
    expect((await reads.head(TENANT)).knowledgeSeq).toBe(head);
  }, 600_000);

  it("WI-05: revocation before dispatch rolls the native transaction back in a fresh process; nothing is written and the refusal says so", async () => {
    const x = await prepared("wi05-revoked");
    const before = (await reads.head(TENANT)).knowledgeSeq;
    await owner(async (c) => {
      const inv = await c.query<{ invalidation_id: string }>(
        "select invalidation_id::text from knowledge_verification.record_invalidation($1, 'fragment', $2, 'unrelated correction')",
        [TENANT, `frag-wi05-revoked-${suffix}`],
      );
      await c.query(
        "update knowledge_verification.invalidation set closure_processed_at = now() where invalidation_id = $1::uuid",
        [inv.rows[0]?.invalidation_id],
      );
    });
    const refused = child({ step: "invoke", envelope: x.envelope, token: token(x.envelope) }).out?.refusal;
    // Journaled, sent, refused natively and rolled back: the caller may settle it rejected once receipt.get agrees.
    expect(refused).toMatchObject({ code: "STALE_DECISION", details: { dispatch: "journaled_uncommitted" } });
    // (The executor may keep a rejected ingestion receipt; no admission, effect receipt or commit exists.)
    expect(await nativeCounts(x.effectKey, x.decisionId)).toMatchObject({
      admissions: 0,
      native: 0,
      commit: 0,
      journal: 1,
      protocol: 0,
    });
    expect((await reads.head(TENANT)).knowledgeSeq).toBe(before);
    const lookupClaims = claimsFor({
      origin: recoveryOriginFor(TENANT, "recovery-wi05", INSTALLATION),
      operations: ["receipt.get"],
      dispatchId: `dispatch-${randomBytes(6).toString("hex")}`,
      binding: BINDING,
      recovery: {
        scope: "read_only",
        authorityRef: "recovery-wi05",
        effectKey: x.effectKey,
        boundEffectDigest: x.bound,
      },
    });
    const lookup = ReceiptLookupSchema.parse(
      child({ step: "receipt", token: signCredential(key, lookupClaims), effectKey: x.effectKey }).out?.answer,
    );
    expect(lookup.disposition).toBe("not_found");
  }, 600_000);

  it("WI-05: reordered acknowledgments across processes: N held after the AIDB commit, N+1 records first, N's late ack answers the same receipt", async () => {
    const x = await prepared("wi05-reordered");
    const original = await heldChild({ step: "invoke", envelope: x.envelope, token: token(x.envelope) });
    expect((await nativeCounts(x.effectKey, x.decisionId))?.protocol).toBe(0);
    const next = { ...x.envelope, dispatchId: `dispatch-${randomBytes(6).toString("hex")}` };
    const first = OperationReceiptSchema.parse(
      child({ step: "invoke", envelope: next, token: token(next) }).out?.answer,
    );
    expect(first.effect.dispatchId).toBe(x.envelope.dispatchId);
    original.release();
    expect(OperationReceiptSchema.parse((await original.done).answer)).toEqual(first);
    expect(await nativeCounts(x.effectKey, x.decisionId)).toEqual({
      admissions: 1,
      receipts: 1,
      native: 1,
      commit: 1,
      journal: 1,
      protocol: 1,
    });
  }, 600_000);
});
