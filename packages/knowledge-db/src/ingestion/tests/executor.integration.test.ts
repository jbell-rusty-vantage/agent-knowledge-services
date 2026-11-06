import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactLedger, canonicalJson, ReadExecutor } from "../../db-read/index.js";
import { TenantPostgres, type TenantSqlClient, type TransactionScope } from "@aiengineer/knowledge-persistence";
import { LocalArtifactStore } from "@aiengineer/knowledge-core";
import { loadWorkspace } from "../../schema-workspace/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyFailure, IngestionExecutor } from "../executor.js";
import type { IngestionIntentInput } from "../intent.js";
import { disposableDatabaseUrl } from "../../../../persistence/test/disposable.mjs";
import { withSnapshot } from "../../../test/ingestion/snapshot-fixture.mjs";
import { seedPriceSlot } from "../../../test/ingestion/current-schema-fixture.mjs";
import { declaredRunsOracle } from "../../../test/ingestion/declared-evidence.mjs";

const url = disposableDatabaseUrl();
const TENANT = "00000000-0000-7000-8000-000000000001";
const REAL_WORKSPACE = resolve(
  import.meta.dirname,
  "../../../../../../../aiengineer/ai-engineer-db-contract/workspace",
);
const workspaces = [["db-contract", REAL_WORKSPACE]] as [string, string][];

class InterleavedPostgres extends TenantPostgres {
  afterPlan: (() => Promise<void>) | undefined;
  loseApplyResponse = false;
  override async transaction<T>(scope: TransactionScope, work: (client: TenantSqlClient) => Promise<T>): Promise<T> {
    const result = await super.transaction(scope, work);
    if (
      !scope.readOnly &&
      result !== null &&
      typeof result === "object" &&
      "schemaVersion" in result &&
      result.schemaVersion === "knowledge-ingestion-receipt.v1" &&
      this.loseApplyResponse
    ) {
      this.loseApplyResponse = false;
      throw Object.assign(new Error("COMMIT_RESPONSE_LOST"), { code: "ECONNRESET" });
    }
    if (scope.readOnly && result !== null && typeof result === "object" && "plan" in result && this.afterPlan) {
      const callback = this.afterPlan;
      this.afterPlan = undefined;
      await callback();
    }
    return result;
  }
}

describe.skipIf(!url).each(workspaces)(
  "IngestionExecutor against the disposable database (%s workspace)",
  (label, workspaceDir) => {
    const suffix = `${Date.now().toString(36)}${label.slice(0, 1)}`;
    let db!: InterleavedPostgres;
    let storeDir: string | undefined;
    let workspace!: ReturnType<typeof loadWorkspace>;
    let artifacts!: ArtifactLedger;
    let reads!: ReadExecutor;
    let executor!: IngestionExecutor;
    beforeAll(() => {
      workspace = loadWorkspace(workspaceDir);
      db = new InterleavedPostgres({ connectionString: url ?? "postgresql://unused", maximumPoolSize: 2 });
      storeDir = mkdtempSync(join(tmpdir(), "ks-ingest-artifacts-"));
      artifacts = new ArtifactLedger({
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
        executorVersion: "knowledge-executor/synthetic-schema-fixture",
        evidence: declaredRunsOracle,
      });
    });
    afterAll(async () => {
      try {
        await db?.close();
      } finally {
        if (storeDir) rmSync(storeDir, { recursive: true, force: true });
      }
    });

    const twoProposals = async (
      intentId: string,
      expectedKnowledgeHead: number,
      onStale: "fail" | "rebase_if_disjoint" = "rebase_if_disjoint",
    ): Promise<IngestionIntentInput> =>
      withSnapshot(reads, {
        schemaVersion: "knowledge-ingestion-intent.v1",
        intentId,
        context: { tenantId: TENANT, correlationId: `vitest-${suffix}`, actor: { kind: "service", id: "vitest" } },
        expectedKnowledgeHead,
        onStale,
        asOf: "2026-09-11",
        evidence: { verificationRuns: [{ runId: `vr_test_${suffix}` }] },
        subjects: [
          {
            ref: "org",
            mode: "new",
            kind: "organization",
            displayName: `KS Exp3 Org ${suffix} ${intentId}`,
            typedPayload: { website_url: "https://example.test" },
            onMatch: "fail",
            evidence: [{ runId: `vr_test_${suffix}`, claimId: "c_1" }],
          },
        ],
        proposals: [
          {
            proposalId: "p-01",
            kind: "fact.assert_state",
            subjectRef: "org",
            streamKind: "organization_status",
            worldInterval: { from: "2026-01-01T00:00:00Z", to: null, bounds: "[)" },
            status: "operating",
            temporalBasis: "observation_bounded",
            evidence: [{ runId: `vr_test_${suffix}`, claimId: "c_1" }],
          },
          {
            proposalId: "p-02",
            kind: "entity.alias",
            subjectRef: "org",
            alias: `KSX-${suffix}`,
            aliasKind: "acronym",
            evidence: [{ runId: `vr_test_${suffix}`, claimId: "c_1" }],
          },
        ],
      });

    it("plans deterministically without writing", async () => {
      const head = (await reads.head(TENANT)).knowledgeSeq;
      const intent = await twoProposals(`exp3-plan-${suffix}`, head);
      const first = await executor.plan(intent);
      const second = await executor.plan(intent);
      expect(first.errors).toEqual([]);
      expect(first.plannedOutcome).toBe("applied");
      expect(first.order).toEqual(["create-org", "p-02", "p-01"]);
      expect(canonicalJson(first)).toBe(canonicalJson(second));
      expect((await reads.head(TENANT)).knowledgeSeq).toBe(head);
    });

    it("applies a two-proposal intent once and returns the same receipt on resubmission", async () => {
      const before = (await reads.head(TENANT)).knowledgeSeq;
      const intent = await twoProposals(`exp3-apply-${suffix}`, before);
      const receipt = await executor.apply(intent);
      expect(receipt.outcome).toBe("applied");
      expect(receipt.knowledgeBatch?.knowledgeSeq).toBe(before + 1);
      expect(receipt.head).toEqual({ before, after: before + 1, rebased: false });
      expect(receipt.proposals.map((proposal) => proposal.outcome)).toEqual(["admitted", "admitted", "admitted"]);
      expect(receipt.subjects[0]).toMatchObject({ ref: "org", created: true });
      expect(receipt.storage.receiptArtifactId).toBeDefined();
      const relational = await db.transaction(
        { tenantId: TENANT, role: "executor_service", readOnly: true },
        async (client) =>
          (
            await client.query<{ affected_refs: unknown }>(
              "select affected_refs from orchestration.operation_receipt where id=$1",
              [receipt.receiptId],
            )
          ).rows[0],
      );
      const immutable = await artifacts.get(TENANT, receipt.storage.receiptArtifactId!);
      expect(relational?.affected_refs).toEqual(receipt.affectedRefs);
      // Receipt targets: every affected ref is a created/staged target of its proposal; no exact use, no origin/report.
      const targets = receipt.targets ?? [];
      expect(targets.map(({ schema, table, id }) => ({ schema, table, id }))).toEqual(receipt.affectedRefs);
      expect(targets.map((target) => [target.table, target.action, target.proposalId])).toEqual(
        expect.arrayContaining([
          ["entity", "created", "create-org"],
          ["candidate", "staged", "create-org"],
          ["resolution_decision", "staged", "create-org"],
          ["entity_alias", "created", "p-02"],
          ["segment", "created", "p-01"],
        ]),
      );
      expect(targets.find((target) => target.table === "entity")).toMatchObject({
        role: "subject",
        entityId: receipt.subjects[0]?.entityId,
        entityKind: "organization",
      });
      expect(receipt.report).toBeNull();
      const ledgerRow = await db.transaction(
        { tenantId: TENANT, role: "executor_service", readOnly: true },
        async (client) =>
          (
            await client.query<Record<string, unknown>>(
              `select i.origin_digest intent_origin, i.mc_run_id, r.origin_digest receipt_origin,
                      (select count(*)::int from orchestration.operation_receipt_target t where t.receipt_id = r.id) targets
                 from orchestration.operation_receipt r join orchestration.operation_intent i on i.id = r.intent_id where r.id = $1`,
              [receipt.receiptId],
            )
          ).rows[0],
      );
      expect(ledgerRow).toEqual({
        intent_origin: null,
        mc_run_id: null,
        receipt_origin: null,
        targets: targets.length,
      });
      expect((immutable.json as { affectedRefs: unknown }).affectedRefs).toEqual(receipt.affectedRefs);
      const entityId = receipt.subjects[0]!.entityId!;
      const facts = await reads.sqlReadonly({
        tenantId: TENANT,
        sql: "select st.kind, s.status from temporal.segment s join temporal.stream st on st.id=s.stream_id where st.subject_entity_id=$1 and s.k_to is null order by st.kind",
        params: [entityId],
      });
      expect(facts.rows).toEqual([
        { kind: "entity_name", status: null },
        { kind: "organization_status", status: "operating" },
      ]);

      const again = await executor.apply(intent);
      expect(again.duplicateOf).toBe(receipt.receiptId);
      expect((await reads.head(TENANT)).knowledgeSeq).toBe(before + 1);
      expect((await executor.receipt(receipt.receiptId, TENANT)).receiptId).toBe(receipt.receiptId);
    });

    it("recovers a committed apply after response loss without another batch or rejected receipt", async () => {
      const before = (await reads.head(TENANT)).knowledgeSeq;
      const intent = await twoProposals(`exp3-commit-loss-${suffix}`, before);
      db.loseApplyResponse = true;
      const receipt = await executor.apply(intent);
      expect(receipt.outcome).toBe("applied");
      expect(receipt.duplicateOf).toBe(receipt.receiptId);
      expect((await reads.head(TENANT)).knowledgeSeq).toBe(before + 1);
      const again = await executor.apply(intent);
      expect(again.receiptId).toBe(receipt.receiptId);
      await expect(executor.apply({ ...intent, asOf: "2026-09-12" })).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
      });
    });

    it("returns the winner's receipt as duplicateOf when the same intent is applied in parallel", async () => {
      const before = (await reads.head(TENANT)).knowledgeSeq;
      const intent = await twoProposals(`exp3-parallel-${suffix}`, before);
      const [first, second] = await Promise.all([executor.apply(intent), executor.apply(intent)]);
      const [winner, loser] = first.duplicateOf ? [second, first] : [first, second];
      expect(winner).toMatchObject({
        outcome: "applied",
        duplicateOf: null,
        knowledgeBatch: { knowledgeSeq: before + 1 },
      });
      expect(loser.duplicateOf).toBe(winner.receiptId);
      expect(loser.receiptId).toBe(winner.receiptId);
      expect((await reads.head(TENANT)).knowledgeSeq).toBe(before + 1);
    });

    it("detects a stale expected head in the plan and in begin_batch", async () => {
      const head = (await reads.head(TENANT)).knowledgeSeq;
      await expect(executor.apply(await twoProposals(`exp3-stale-${suffix}`, head - 1, "fail"))).rejects.toMatchObject({
        code: "REBASE_REQUIRED",
        exit: 1,
      });
      const failure = await db
        .transaction({ tenantId: TENANT, role: "executor_service" }, async (client) => {
          try {
            await client.query("select temporal.begin_batch($1::bigint)", [head - 1]);
            return undefined;
          } catch (error) {
            return classifyFailure(error);
          }
        })
        .catch((error: unknown) => classifyFailure(error));
      expect(failure).toMatchObject({ code: "REBASE_REQUIRED", sqlstate: "40001" });
      expect((await reads.head(TENANT)).knowledgeSeq).toBe(head);
      // A refused apply leaves no receipt targets (a rejected receipt, if recorded, has none).
      const targets = await db.transaction(
        { tenantId: TENANT, role: "executor_service", readOnly: true },
        async (client) =>
          (
            await client.query<{ n: number }>(
              `select count(*)::int n from orchestration.operation_receipt_target t join orchestration.operation_receipt r on r.id = t.receipt_id
                 join orchestration.operation_intent i on i.id = r.intent_id where i.payload->>'intentId' = $1`,
              [`exp3-stale-${suffix}`],
            )
          ).rows[0]?.n,
      );
      expect(targets).toBe(0);
    });

    it("reuses the existing same-unit price series key and closes the stale segment", async () => {
      const FIXTURE_TERRA_OFFERING = await seedPriceSlot(db, TENANT);
      const staleSeries = await reads.sqlReadonly({
        tenantId: TENANT,
        sql: "select st.scope_key, s.id from temporal.segment s join temporal.stream st on st.id=s.stream_id where st.subject_entity_id=$1 and st.kind='model_offering_price' and s.unit='per_1m_input_tokens' and s.k_to is null and upper_inf(s.valid_during)",
        params: [FIXTURE_TERRA_OFFERING],
      });
      expect(staleSeries.rows).toHaveLength(1);
      const existingKey = String(staleSeries.rows[0]!.scope_key);
      const staleSegmentId = String(staleSeries.rows[0]!.id);
      const amount = label === "fixture" ? 3 : 3.25;
      const before = (await reads.head(TENANT)).knowledgeSeq;
      const intent: IngestionIntentInput = {
        ...(await twoProposals(`exp3-price-slot-${suffix}`, before)),
        subjects: [{ ref: "terra", mode: "resolved", entityId: FIXTURE_TERRA_OFFERING, kind: "model_offering" }],
        proposals: [
          {
            proposalId: "p-01",
            kind: "fact.assert_state",
            subjectRef: "terra",
            streamKind: "model_offering_price",
            scopeKey: "per_1m_input_tokens",
            worldInterval: { from: "2026-08-20T00:00:00Z", to: null, bounds: "[)" },
            amount,
            currency: "USD",
            unit: "per_1m_input_tokens",
            temporalBasis: "observation_bounded",
            evidence: [{ runId: `vr_test_${suffix}`, claimId: "c_1" }],
          },
        ],
      };

      const plan = await executor.plan(intent);
      expect(plan.errors).toEqual([]);
      expect(plan.proposals[0]).toMatchObject({
        outcome: "admitted",
        rewrites: [
          {
            rule: "price.scope_key_is_unit",
            field: "scopeKey",
            from: "per_1m_input_tokens",
            to: existingKey,
            reason: "existing_series_reused",
          },
        ],
      });
      expect(plan.proposals[0]?.actions.at(-1)?.args).toMatchObject({ scope_key: existingKey });

      const receipt = await executor.apply(intent);
      expect(receipt).toMatchObject({ outcome: "applied", head: { before, after: before + 1 } });
      expect(receipt.proposals[0]).toMatchObject({ outcome: "admitted", supersedes: [staleSegmentId] });
      const newSegmentId = String(receipt.proposals[0]?.created?.segmentId);
      // Targets: the resolved subject is reused (kind from corpus.entity), the new segment created, the stale one superseded.
      expect(receipt.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            schema: "corpus",
            table: "entity",
            id: FIXTURE_TERRA_OFFERING,
            action: "reused",
            proposalId: null,
            entityKind: "model_offering",
          }),
          expect.objectContaining({ table: "segment", id: newSegmentId, action: "created", proposalId: "p-01" }),
          expect.objectContaining({
            table: "segment",
            id: staleSegmentId,
            action: "superseded",
            proposalId: "p-01",
            entityId: FIXTURE_TERRA_OFFERING,
          }),
        ]),
      );
      const changed = await reads.sqlReadonly({
        tenantId: TENANT,
        sql: "select c.change_kind, c.item_id::text, st.scope_key, s.amount::float amount, upper_inf(s.valid_during) open_ended from api.what_changed($1,$2,$3) c join temporal.segment s on s.id=c.item_id join temporal.stream st on st.id=s.stream_id where c.item_kind='segment' order by c.change_kind, s.id",
        params: [FIXTURE_TERRA_OFFERING, before, before + 1],
      });
      const ofKind = (kind: string) => changed.rows.filter((row) => row.change_kind === kind);
      expect(ofKind("closed")).toEqual([expect.objectContaining({ item_id: staleSegmentId, open_ended: true })]);
      expect(ofKind("opened").filter((row) => row.open_ended)).toEqual([
        expect.objectContaining({ item_id: newSegmentId, amount }),
      ]);
      expect(new Set(changed.rows.map((row) => row.scope_key))).toEqual(new Set([existingKey]));
    });

    it("refuses a disallowed unit before any transaction", async () => {
      const head = (await reads.head(TENANT)).knowledgeSeq;
      const intent = await twoProposals(`exp3-unit-${suffix}`, head);
      intent.subjects = [
        {
          ref: "offer",
          mode: "new",
          kind: "model_offering",
          displayName: `Offer ${suffix}`,
          onMatch: "fail",
          typedPayload: {},
        },
      ];
      intent.proposals = [
        {
          proposalId: "p-01",
          kind: "fact.assert_state",
          subjectRef: "offer",
          streamKind: "model_offering_price",
          worldInterval: { from: "2026-01-01T00:00:00Z", to: null, bounds: "[)" },
          amount: 1,
          currency: "USD",
          unit: "per_1k_tokens",
          temporalBasis: "observation_bounded",
          evidence: [{ runId: `vr_test_${suffix}`, claimId: "c_1" }],
        },
      ];
      await expect(executor.apply(intent)).rejects.toMatchObject({ code: "VOCABULARY_VIOLATION", exit: 1 });
      expect((await reads.head(TENANT)).knowledgeSeq).toBe(head);
    });

    it("T03 preserves the winner when a conflicting write commits after planning", async () => {
      const baseline = await executor.apply(
        await twoProposals(`p1-conflict-base-${suffix}`, (await reads.head(TENANT)).knowledgeSeq),
      );
      const entityId = baseline.subjects[0]!.entityId!;
      const head = baseline.head.after;
      const change = async (id: string, from: string): Promise<IngestionIntentInput> => {
        const base = await twoProposals(id, head);
        return {
          ...base,
          subjects: [{ ref: "org", mode: "resolved", kind: "organization", entityId }],
          proposals: [
            {
              ...base.proposals[0]!,
              kind: "fact.assert_state",
              proposalId: "change",
              subjectRef: "org",
              streamKind: "organization_status",
              status: "acquired",
              temporalBasis: "observation_bounded",
              worldInterval: { from },
            },
          ],
        };
      };
      const winner = await change(`p1-winner-${suffix}`, "2026-01-01T00:00:00Z");
      const loser = await change(`p1-loser-${suffix}`, "2026-02-01T00:00:00Z");
      db.afterPlan = async () => {
        expect((await executor.apply(winner)).outcome).toBe("applied");
      };
      await expect(executor.apply(loser)).rejects.toMatchObject({ code: "REBASE_REQUIRED" });
      expect((await reads.head(TENANT)).knowledgeSeq).toBe(head + 1);
      const state = await reads.sqlReadonly({
        tenantId: TENANT,
        sql: "select status from api.current_facts where subject_entity_id=$1 and stream_kind='organization_status'",
        params: [entityId],
      });
      expect(state.rows).toEqual([{ status: "acquired" }]);
    });

    it("T04 rebases proven-disjoint work only under explicit policy and records the actual head", async () => {
      const head = (await reads.head(TENANT)).knowledgeSeq;
      const first = await twoProposals(`p1-disjoint-a-${suffix}`, head);
      const second = await twoProposals(`p1-disjoint-b-${suffix}`, head, "rebase_if_disjoint");
      await executor.apply(first);
      await expect(executor.plan({ ...second, onStale: "fail" })).resolves.toMatchObject({
        plannedOutcome: "rejected",
      });
      const plan = await executor.plan(second);
      expect(plan.head).toMatchObject({ rebased: true, effectiveExpectedHead: head + 1, touchedBy: [] });
      const receipt = await executor.apply(second);
      expect(receipt.head).toEqual({ before: head + 1, after: head + 2, rebased: true });
    });

    it("rejects missing, forged, incomplete and unavailable preflights before canonical writes", async () => {
      const head = (await reads.head(TENANT)).knowledgeSeq;
      const intent = await twoProposals(`p1-preflight-${suffix}`, head);
      const { inputSnapshot: _snapshot, ...missing } = intent;
      await expect(executor.apply(missing)).rejects.toMatchObject({ code: "SNAPSHOT_REQUIRED" });
      await expect(
        executor.apply({
          ...intent,
          inputSnapshot: { ...intent.inputSnapshot, snapshotDigest: `sha256:${"0".repeat(64)}` },
        }),
      ).rejects.toMatchObject({ code: "SNAPSHOT_DIGEST_MISMATCH" });
      await expect(executor.apply({ ...intent, expectedKnowledgeHead: head + 1 })).rejects.toMatchObject({
        code: "SNAPSHOT_CLOCK_CONFLICT",
      });
      await expect(
        executor.apply({ ...intent, context: { tenantId: "00000000-0000-7000-8000-000000000099" } }),
      ).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
      const incomplete = await reads.runIntent(
        {
          schemaVersion: "knowledge-read-intent.v1",
          intentId: `missing-search-${suffix}`,
          context: { tenantId: TENANT },
          operations: [
            {
              opId: "search",
              kind: "retrieval",
              query: "retrieval.evidence_packet",
              params: { packet_id: "00000000-0000-7000-8000-000000000001" },
            },
          ],
        },
        { persist: true },
      );
      await expect(
        executor.apply({
          ...intent,
          inputSnapshot: {
            artifactId: incomplete.storage!.artifactId,
            snapshotId: incomplete.snapshotId,
            snapshotDigest: incomplete.snapshotDigest,
            knowledgeSeq: head,
          },
        }),
      ).rejects.toMatchObject({ code: "SNAPSHOT_INCOMPLETE" });
      const missingBytes = new ArtifactLedger({
        db,
        store: {
          put: async () => {
            throw new Error("No fixture writes expected");
          },
          get: async () => undefined,
        },
        bucket: "research-ingestion-intents",
        uploaded: false,
        executorVersion: "synthetic-missing-store/1",
      });
      const unavailable = new IngestionExecutor({
        db,
        workspace,
        artifacts: missingBytes,
        executorVersion: "synthetic-preflight/1",
        evidence: declaredRunsOracle,
      });
      await expect(unavailable.apply(intent)).rejects.toMatchObject({ code: "SNAPSHOT_UNAVAILABLE" });
      expect((await reads.head(TENANT)).knowledgeSeq).toBe(head);
    });
  },
);
