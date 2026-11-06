import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalArtifactStore } from "@aiengineer/knowledge-core";
import { type Origin, digestCanonical, originDigest } from "@aiengineer/knowledge-operation-protocol";
import { TenantPostgres, type TenantSqlClient, type TransactionScope } from "@aiengineer/knowledge-persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposableDatabaseUrl } from "../../../../persistence/test/disposable.mjs";
import { declaredRunsOracle } from "../../../test/ingestion/declared-evidence.mjs";
import { withSnapshot } from "../../../test/ingestion/snapshot-fixture.mjs";
import { ArtifactLedger, ReadExecutor } from "../../db-read/index.js";
import { loadWorkspace } from "../../schema-workspace/index.js";
import { IngestionExecutor, lookupExactUseReceipt, type ExactUseIngestionReceipt } from "../executor.js";
import type { IngestionIntentInput } from "../intent.js";

/**
 * SV-08 KS half on the disposable AI Engineer Supabase database (component 2.2.0 installed first, then every AIDB
 * migration incl. the binding and the report-v2 projection): the exact-use admission runs INSIDE `applyOnce`'s
 * transaction (`temporal.begin_batch ... commit_batch`) on the executor's own client. Needs `KS_TEST_DATABASE_URL` and
 * `KS_TEST_PROJECT_DIR` (the disposable-project guard of the executor suite); skips without them.
 */
const url = disposableDatabaseUrl();
const TENANT = "00000000-0000-7000-8000-000000000001";
const REAL_WORKSPACE = resolve(
  import.meta.dirname,
  "../../../../../../../aiengineer/ai-engineer-db-contract/workspace",
);
const digest = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const values = digestCanonical({ parameters: "7000000000" });

class LossyPostgres extends TenantPostgres {
  loseApplyResponse = false;
  override async transaction<T>(scope: TransactionScope, work: (client: TenantSqlClient) => Promise<T>): Promise<T> {
    const result = await super.transaction(scope, work);
    if (
      this.loseApplyResponse &&
      !scope.readOnly &&
      result !== null &&
      typeof result === "object" &&
      "schemaVersion" in result &&
      result.schemaVersion === "knowledge-ingestion-receipt.v1"
    ) {
      this.loseApplyResponse = false;
      throw Object.assign(new Error("COMMIT_RESPONSE_LOST"), { code: "ECONNRESET" });
    }
    return result;
  }
}

describe.skipIf(!url)("exact-use admission inside the native ingestion transaction (AIDB disposable database)", () => {
  const suffix = Date.now().toString(36);
  let db!: LossyPostgres;
  let storeDir: string | undefined;
  let reads!: ReadExecutor;
  let executor!: IngestionExecutor;
  let runId = "";
  const keyId = `ks-exec-test-${suffix}`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const origin: Origin = {
    kind: "standalone",
    installationId: "0195f0a0-5b08-7000-8000-00000000a1d8",
    applicationId: "ai-engineer",
    tenantId: TENANT,
    issuer: "mission-control",
    subject: "sv08-executor-test",
    mission: null,
    recoveryAuthorityRef: null,
    invocationId: `inv-${suffix}`,
    authenticatedAt: "2026-10-25T00:00:00Z",
  };
  const owner = <T>(work: (client: TenantSqlClient) => Promise<T>) => db.transaction({ tenantId: TENANT }, work);

  beforeAll(async () => {
    const workspace = loadWorkspace(REAL_WORKSPACE);
    db = new LossyPostgres({ connectionString: url ?? "postgresql://unused", maximumPoolSize: 3 });
    storeDir = mkdtempSync(join(tmpdir(), "ks-exact-use-"));
    const artifacts = new ArtifactLedger({
      db,
      store: new LocalArtifactStore(storeDir),
      bucket: "research-ingestion-intents",
      uploaded: false,
      executorVersion: "knowledge-executor/test",
    });
    reads = new ReadExecutor({ db, workspace, artifacts, executorVersion: "knowledge-executor/test" });
    executor = new IngestionExecutor({
      db,
      workspace,
      artifacts,
      executorVersion: "knowledge-executor/sv08-exact-use",
      evidence: declaredRunsOracle,
    });
    // A sealed component run with a report revision (the use-decision guard requires one), seeded as the owner.
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
        binding: "aiengineer-postgres",
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
  });

  afterAll(async () => {
    try {
      await db?.close();
    } finally {
      if (storeDir) rmSync(storeDir, { recursive: true, force: true });
    }
  });

  /** A Mission Control invocation: the origin carries the run coordinates the native ledger restates. */
  const missionOrigin: Origin = {
    ...origin,
    kind: "mission_invocation",
    subject: "sv08-mission-test",
    mission: {
      missionId: `mission-${suffix}`,
      runId: `mc-run-${suffix}`,
      activationId: null,
      operationId: `op-${suffix}`,
      operationAttempt: 1,
      executionGeneration: 0,
      lane: "knowledge",
    },
  };
  interface Variant {
    readonly origin?: Origin;
    /** Also materialize claim c_1 (inline text, no context.attemptId: the origin is the producer). */
    readonly materialize?: boolean;
  }

  const intentFor = async (
    intentId: string,
    effectKey: string,
    decisionId: string,
    processedEpoch: number,
    variant: Variant = {},
  ): Promise<IngestionIntentInput> =>
    withSnapshot(reads, {
      schemaVersion: "knowledge-ingestion-intent.v1",
      intentId,
      context: { tenantId: TENANT, correlationId: `sv08-${suffix}`, actor: { kind: "service", id: "vitest" } },
      expectedKnowledgeHead: (await reads.head(TENANT)).knowledgeSeq,
      onStale: "rebase_if_disjoint",
      asOf: "2026-10-25",
      evidence: {
        verificationRuns: [{ runId: `vr_sv08_${suffix}` }],
        ...(variant.materialize
          ? {
              claims: [
                {
                  runId: `vr_sv08_${suffix}`,
                  claimId: "c_1",
                  claimType: "attribute" as const,
                  statement: `SV08 org ${suffix} ${intentId} is an organization.`,
                  subjects: [{ ref: "org", role: "subject" as const }],
                },
              ],
            }
          : {}),
      },
      subjects: [
        {
          ref: "org",
          mode: "new",
          kind: "organization",
          displayName: `SV08 Exact Use Org ${suffix} ${intentId}`,
          typedPayload: { website_url: "https://example.test" },
          onMatch: "fail",
          evidence: [{ runId: `vr_sv08_${suffix}`, claimId: "c_1" }],
        },
      ],
      proposals: [
        {
          proposalId: "p-01",
          kind: "entity.alias",
          subjectRef: "org",
          alias: `SV8-${suffix}-${intentId}`.slice(0, 60),
          aliasKind: "acronym",
          evidence: [{ runId: `vr_sv08_${suffix}`, claimId: "c_1" }],
        },
        ...(variant.materialize
          ? [
              {
                proposalId: "p-claims",
                kind: "claim.materialize" as const,
                runId: `vr_sv08_${suffix}`,
                claimIds: ["c_1"],
                evidence: [{ runId: `vr_sv08_${suffix}`, claimId: "c_1" }],
              },
            ]
          : []),
      ],
      exactUse: {
        useDecisionId: decisionId,
        boundEffectDigest: digest("placeholder: replaced by the plan's bound digest"),
        processedEpoch,
        normalizedValuesDigest: values,
        effectKey,
        originatingOrigin: variant.origin ?? origin,
      },
    });

  /** Plan first (read-only) to learn the exact native effect, decide on THAT digest, then apply. */
  const prepared = async (name: string, options: { decide?: boolean; epochShift?: number; variant?: Variant } = {}) => {
    const epoch = await owner(async (c) =>
      Number(
        (await c.query<{ e: string }>("select knowledge_verification.current_revocation_epoch($1)::text e", [TENANT]))
          .rows[0]?.e,
      ),
    );
    const effectKey = `effect-${suffix}-${name}`;
    const decisionId = `ud-${suffix}-${name}`;
    const draft = await intentFor(
      `sv08-${name}-${suffix}`.slice(0, 64),
      effectKey,
      decisionId,
      epoch - (options.epochShift ?? 0),
      options.variant,
    );
    const plan = await executor.plan(draft);
    const bound = plan.effect?.boundEffectDigest as string;
    expect(bound).toMatch(/^sha256:/);
    if (options.decide !== false) {
      await owner((c) =>
        c.query(
          `insert into knowledge_verification.use_decision (tenant_id, use_decision_id, schema_version, subject_kind, subject_id, subject_digest, run_id, bound_effect_digest, use_name, audience, disposition, conditions, policy_ref, rubric_ref, qualifiers_digest, revocation_epoch, record, digest, normalized_values, normalized_values_digest)
           values ($1, $2, 'research-core.use_decision.v2', 'report', $3, $4, $5::uuid, $6, 'knowledge_ingestion', 'official', 'admitted', '[]'::jsonb, 'p', 'r', null, $7, $8::jsonb, $9, $10::jsonb, $11)`,
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
          ],
        ),
      );
    }
    return {
      intent: {
        ...draft,
        exactUse: { ...(draft.exactUse as NonNullable<typeof draft.exactUse>), boundEffectDigest: bound },
      },
      effectKey,
      decisionId,
      bound,
      epoch,
    };
  };

  /** Read as executor_service (the only role besides control_plane that reads operation_receipt). */
  const ledger = <T extends Record<string, unknown>>(sql: string, params: unknown[]) =>
    db.transaction(
      { tenantId: TENANT, role: "executor_service", readOnly: true },
      async (c) => (await c.query<T>(sql, params)).rows,
    );
  const targetCount = async (intentId: string) =>
    Number(
      (
        await ledger<{ n: number }>(
          `select count(*)::int n from orchestration.operation_receipt_target t
             join orchestration.operation_receipt r on r.id = t.receipt_id
             join orchestration.operation_intent i on i.id = r.intent_id
            where i.payload->>'intentId' = $1`,
          [intentId],
        )
      )[0]?.n,
    );

  const effectReceipt = (effectKey: string) =>
    db.transaction({ tenantId: TENANT, role: "executor_service", readOnly: true }, (c) =>
      lookupExactUseReceipt(c, TENANT, effectKey),
    );

  it("admitted: one transaction writes the domain rows, the native receipt bound to the decision and the effect receipt", async () => {
    const { intent, effectKey, decisionId, bound } = await prepared("admit");
    const receipt = await executor.apply(intent);
    expect(receipt.outcome).toBe("applied");
    const admission = (receipt as { admission?: { path: string; effectReceiptDigest: string } }).admission;
    // ai-engineer installation: the AIDB guard is required and ran, recording the normalized-values digest.
    expect(admission?.path).toBe("aidb_guard");
    const recorded = await owner(
      async (c) =>
        (
          await c.query<{ n: number; digests: string[] }>(
            "select count(*)::int n, array_agg(normalized_values_digest) digests from research.use_admission where tenant_id = $1 and use_decision_id = $2",
            [TENANT, decisionId],
          )
        ).rows[0],
    );
    expect(recorded).toEqual({ n: 1, digests: [values] });
    const stored = await effectReceipt(effectKey);
    expect(stored).toMatchObject({
      outcome: "applied",
      useDecisionId: decisionId,
      digest: admission?.effectReceiptDigest,
    });
    const native = await db.transaction(
      { tenantId: TENANT, role: "executor_service", readOnly: true },
      async (c) =>
        (
          await c.query("select to_jsonb(r) j from orchestration.operation_receipt r where id = $1", [
            receipt.receiptId,
          ])
        ).rows[0]?.j,
    );
    expect(native).toMatchObject({
      requires_admission: true,
      use_decision_id: decisionId,
      bound_effect_digest: bound,
      origin_digest: originDigest(origin),
    });
    expect(receipt.subjects[0]?.created).toBe(true);
    // The ledger restates the origin; a standalone origin carries no Mission Control coordinates.
    const [intentRow] = await ledger<Record<string, unknown>>(
      "select origin_digest, origin_kind, mc_run_id, mc_mission_id from orchestration.operation_intent where id = $1",
      [receipt.operationIntentId],
    );
    expect(intentRow).toEqual({
      origin_digest: originDigest(origin),
      origin_kind: "standalone",
      mc_run_id: null,
      mc_mission_id: null,
    });
    // Receipt targets: written in the same transaction, attributed to proposals, entity kind from corpus.entity.
    const targets = (receipt as ExactUseIngestionReceipt).targets ?? [];
    const entityId = receipt.subjects[0]?.entityId;
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: "corpus",
          table: "entity",
          id: entityId,
          role: "subject",
          action: "created",
          proposalId: "create-org",
          entityId,
          entityKind: "organization",
        }),
        expect.objectContaining({ schema: "staging", table: "candidate", role: "staging", action: "staged" }),
        expect.objectContaining({
          schema: "corpus",
          table: "entity_alias",
          action: "created",
          proposalId: "p-01",
          entityId,
        }),
        expect.objectContaining({
          schema: "research",
          table: "report_v2_ingestion",
          id: decisionId,
          role: "projection",
        }),
      ]),
    );
    const storedTargets = await ledger<Record<string, unknown>>(
      `select ordinal, target_schema, target_table, target_id, entity_id::text, entity_kind, role, action, proposal_id, claim_id::text
         from orchestration.operation_receipt_target where receipt_id = $1 order by ordinal`,
      [receipt.receiptId],
    );
    expect(
      storedTargets.map((row) => ({
        schema: row.target_schema,
        table: row.target_table,
        id: row.target_id,
        role: row.role,
        action: row.action,
        proposalId: row.proposal_id,
        entityId: row.entity_id,
        entityKind: row.entity_kind,
        claimId: row.claim_id,
      })),
    ).toEqual(targets);
    expect(storedTargets.map((row) => row.ordinal)).toEqual(targets.map((_, index) => index));
    // affectedRefs (the K01 effect-receipt payload) keeps its shape: {schema, table, id} for written rows only.
    expect(receipt.affectedRefs.every((ref) => Object.keys(ref).sort().join() === "id,schema,table")).toBe(true);
    // report_v2 projection: the report-subject decision names the sealed revision; the ingestion row names this receipt.
    const report = (receipt as ExactUseIngestionReceipt).report;
    expect(report).toMatchObject({
      reportId: `report-${suffix}`,
      revision: 1,
      reportRevisionId: `rev-${suffix}`,
      runId,
      useDecisionId: decisionId,
      subjectKind: "report",
      assertionRefDigest: null,
      resolution: "report_subject",
      candidateRevisions: 1,
      assertions: 0,
    });
    const projected = await ledger<Record<string, unknown>>(
      `select r.report_revision_id, r.run_id::text, r.verification_snapshot_digest, i.receipt_id::text, i.intent_id::text, i.outcome
         from research.report_v2_revision r join research.report_v2_ingestion i on i.tenant_id = r.tenant_id and i.report_id = r.report_id and i.revision = r.revision
        where r.tenant_id = $1 and i.use_decision_id = $2`,
      [TENANT, decisionId],
    );
    expect(projected).toEqual([
      {
        report_revision_id: `rev-${suffix}`,
        run_id: runId,
        verification_snapshot_digest: report?.verificationSnapshotDigest,
        receipt_id: receipt.receiptId,
        intent_id: receipt.operationIntentId,
        outcome: "applied",
      },
    ]);
    // The same intent again is the same receipt; the effect receipt is unique per effect key.
    expect((await executor.apply(intent)).duplicateOf).toBe(receipt.receiptId);
  });

  it("stale epoch, unknown decision, edited effect: typed refusal and nothing written (rollback)", async () => {
    const stale = await prepared("stale");
    await owner(async (c) => {
      const inv = await c.query<{ invalidation_id: string }>(
        "select invalidation_id::text from knowledge_verification.record_invalidation($1, 'fragment', $2, 'unrelated correction')",
        [TENANT, `frag-unrelated-${suffix}`],
      );
      await c.query(
        "update knowledge_verification.invalidation set closure_processed_at = now() where invalidation_id = $1::uuid",
        [inv.rows[0]?.invalidation_id],
      );
    });
    const before = (await reads.head(TENANT)).knowledgeSeq;
    await expect(executor.apply(stale.intent)).rejects.toMatchObject({ code: "STALE_DECISION", exit: 1 });
    expect(await effectReceipt(stale.effectKey)).toBeNull();
    expect((await reads.head(TENANT)).knowledgeSeq).toBe(before);
    const missing = await prepared("missing", { decide: false });
    await expect(executor.apply(missing.intent)).rejects.toMatchObject({ code: "UNRESOLVED_EFFECT" });
    const edited = await prepared("edited");
    await expect(
      executor.apply({
        ...edited.intent,
        exactUse: {
          ...(edited.intent.exactUse as NonNullable<typeof edited.intent.exactUse>),
          boundEffectDigest: digest("other bytes"),
        },
      }),
    ).rejects.toMatchObject({ code: "EFFECT_CONFLICT" });
    expect(await effectReceipt(edited.effectKey)).toBeNull();
    expect((await reads.head(TENANT)).knowledgeSeq).toBe(before);
    // Rolled back: no receipt targets and no report projection for any refused apply (a rejected receipt has none).
    for (const refused of [stale, missing, edited]) {
      expect(await targetCount(refused.intent.intentId)).toBe(0);
      expect(
        await ledger("select 1 from research.report_v2_ingestion where tenant_id = $1 and use_decision_id = $2", [
          TENANT,
          refused.decisionId,
        ]),
      ).toEqual([]);
    }
  });

  it("mission origin without an attempt: the claim names its producer origin and the run's effects are one SELECT", async () => {
    const { intent, decisionId } = await prepared("mission", { variant: { origin: missionOrigin, materialize: true } });
    expect(intent.context.attemptId).toBeUndefined();
    const receipt = (await executor.apply(intent)) as ExactUseIngestionReceipt;
    expect(receipt.outcome).toBe("applied");
    expect(receipt.proposals.find((proposal) => proposal.proposalId === "p-claims")?.outcome).toBe("admitted");
    const claimRowId = receipt.claims[0]?.claimRowId;
    expect(claimRowId).toBeTruthy();
    const [claim] = await ledger<Record<string, unknown>>(
      "select producer_attempt_id, producer_origin_digest from evidence.claim where id = $1",
      [claimRowId],
    );
    expect(claim).toEqual({ producer_attempt_id: null, producer_origin_digest: originDigest(missionOrigin) });
    const [intentRow] = await ledger<Record<string, unknown>>(
      `select origin_kind, mc_mission_id, mc_run_id, mc_activation_id, mc_operation_id, mc_operation_attempt, mc_execution_generation, mc_lane
         from orchestration.operation_intent where id = $1`,
      [receipt.operationIntentId],
    );
    expect(intentRow).toEqual({
      origin_kind: "mission_invocation",
      mc_mission_id: `mission-${suffix}`,
      mc_run_id: `mc-run-${suffix}`,
      mc_activation_id: null,
      mc_operation_id: `op-${suffix}`,
      mc_operation_attempt: 1,
      mc_execution_generation: 0,
      mc_lane: "knowledge",
    });
    const effects = await ledger<Record<string, unknown>>(
      `select receipt_id::text, target_schema, target_table, target_id, action, proposal_id, claim_id::text
         from orchestration.mission_run_effects where mc_run_id = $1 order by ordinal`,
      [`mc-run-${suffix}`],
    );
    expect(effects.length).toBe(receipt.targets?.length);
    expect(new Set(effects.map((row) => row.receipt_id))).toEqual(new Set([receipt.receiptId]));
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_table: "claim",
          target_id: claimRowId,
          claim_id: claimRowId,
          proposal_id: "p-claims",
        }),
        expect.objectContaining({ target_table: "claim_subject", action: "created", claim_id: claimRowId }),
        expect.objectContaining({ target_table: "report_v2_ingestion", target_id: decisionId }),
        // The report revision was projected by an earlier apply in this suite: reused, not rewritten.
        expect.objectContaining({ target_table: "report_v2_revision", action: "reused" }),
      ]),
    );
  });

  it("two concurrent same-key requests yield one effect and one receipt", async () => {
    const { intent, effectKey } = await prepared("parallel");
    const [first, second] = await Promise.all([executor.apply(intent), executor.apply(intent)]);
    expect(first.receiptId).toBe(second.receiptId);
    expect([first.duplicateOf, second.duplicateOf].filter((value) => value !== null)).toHaveLength(1);
    expect(await effectReceipt(effectKey)).toMatchObject({ outcome: "applied" });
  });

  it("crash after native commit and before caller settlement: the effect receipt lookup finds it", async () => {
    const { intent, effectKey, decisionId } = await prepared("crash");
    db.loseApplyResponse = true;
    const receipt = await executor.apply(intent);
    expect(receipt.duplicateOf).toBe(receipt.receiptId);
    expect(await effectReceipt(effectKey)).toMatchObject({ outcome: "applied", useDecisionId: decisionId });
    expect((await executor.receipt(receipt.receiptId, TENANT)).receiptId).toBe(receipt.receiptId);
  });
});
