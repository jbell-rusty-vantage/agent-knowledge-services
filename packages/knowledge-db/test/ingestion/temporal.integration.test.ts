import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactLedger, ReadExecutor } from "../../src/db-read/index.js";
import { PostgresCanonicalRepository, TenantPostgres } from "@aiengineer/knowledge-persistence";
import { LocalArtifactStore } from "@aiengineer/knowledge-core";
import { loadWorkspace } from "../../src/schema-workspace/index.js";
import { beforeAll, describe, expect, it } from "vitest";
import { disposableDatabaseUrl } from "../../../persistence/test/disposable.mjs";
import { IngestionExecutor } from "../../src/ingestion/executor.js";
import { IngestionIntentSchema, type IngestionIntentInput } from "../../src/ingestion/intent.js";
import { declaredRunsOracle } from "./declared-evidence.mjs";
import { prepareCurrentSchemaFixture } from "./preparation-fixture.mjs";
import { seedPriceSlot } from "./current-schema-fixture.mjs";
import { withSnapshot } from "./snapshot-fixture.mjs";

const url = disposableDatabaseUrl();
let workspace: ReturnType<typeof loadWorkspace>;

async function fixture() {
  const tenantId = randomUUID();
  const activeWorkspace = workspace;
  const directory = mkdtempSync(join(tmpdir(), "ks-p1-temporal-"));
  const store = new LocalArtifactStore(directory);
  const db = new TenantPostgres({ connectionString: url! });
  const canonical = new PostgresCanonicalRepository({ connectionString: url! });
  const close = async () => {
    try {
      await db.close();
    } finally {
      try {
        await canonical.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  };
  try {
    const prepared = await prepareCurrentSchemaFixture({ database: canonical, tenantId, store });
    const artifacts = new ArtifactLedger({
      db,
      store,
      bucket: "research-ingestion-intents",
      uploaded: false,
      executorVersion: "synthetic-temporal/1",
    });
    const reads = new ReadExecutor({
      db,
      workspace: activeWorkspace,
      artifacts,
      executorVersion: "synthetic-temporal/1",
    });
    const executor = new IngestionExecutor({
      db,
      workspace: activeWorkspace,
      artifacts,
      executorVersion: "synthetic-temporal/1",
      evidence: declaredRunsOracle,
    });
    const locator = randomUUID();
    await db.transaction({ tenantId }, (client) =>
      client.query(
        "insert into evidence.locator(id,tenant_id,capture_id,media_type,selector,extractor_name,extractor_version) values($1,$2,$3,'text/plain',$4::jsonb,'synthetic-temporal','1')",
        [
          locator,
          tenantId,
          prepared.captured.input.captureId,
          JSON.stringify({ type: "text_quote", exact: prepared.sourceText }),
        ],
      ),
    );
    return { tenantId, directory, db, reads, executor, prepared, locator, close };
  } catch (error) {
    await close();
    throw error;
  }
}

describe.skipIf(!url)("P1 temporal current-schema proof (explicit synthetic admission adapter)", () => {
  beforeAll(() => {
    workspace = loadWorkspace(
      resolve(import.meta.dirname, "../../../../../../aiengineer/ai-engineer-db-contract/workspace"),
    );
  });
  it("T05/T06/T08 corrects one legacy slot over a bounded interval and preserves K0 and adjacent evidence", async () => {
    const f = await fixture();
    try {
      const offering = await seedPriceSlot(f.db, f.tenantId);
      const runId = `temporal-${f.tenantId}`;
      const make = async (claimId: string, changes: Record<string, unknown> = {}) =>
        withSnapshot(f.reads, {
          schemaVersion: "knowledge-ingestion-intent.v1",
          intentId: `temporal-${randomUUID()}`,
          context: { tenantId: f.tenantId, attemptId: f.prepared.parents.attemptId },
          evidence: {
            verificationRuns: [{ runId }],
            claims: [{ runId, claimId, statement: `Synthetic price ${claimId}`, subjects: [{ ref: "offering" }] }],
          },
          subjects: [
            { ref: "offering", mode: "resolved", kind: "model_offering", entityId: offering },
            { ref: "organization", mode: "resolved", kind: "organization", entityId: f.prepared.parents.entityId },
          ],
          proposals: [
            { proposalId: "claim", kind: "claim.materialize", runId, claimIds: [claimId] },
            {
              proposalId: "price",
              kind: "fact.assert_state",
              subjectRef: "offering",
              streamKind: "model_offering_price",
              scopeKey: "per_1m_input_tokens",
              unit: "per_1m_input_tokens",
              currency: "USD",
              amount: 2,
              worldInterval: { from: "2026-01-01T00:00:00Z", to: null },
              temporalBasis: "explicit",
              extent: {
                sourceText: "January 2026",
                precision: "month",
                locatorRef: f.locator,
                earliest: "2026-01-01",
                latest: "2026-02-01",
              },
              evidence: [{ runId, claimId }],
              ...changes,
            },
          ],
        } as IngestionIntentInput);
      const original = await f.executor.apply(await make("original"));
      const k0 = original.head.after;
      const stale = await make("stale", { amount: 9, unit: "Per 1m input tokens" });
      stale.onStale = "rebase_if_disjoint";
      const correction = await make("correction", {
        amount: 3,
        unit: "Per 1m input tokens",
        worldInterval: { from: "2026-02-01T00:00:00Z", to: "2026-03-01T00:00:00Z" },
      });
      const plan = await f.executor.plan(correction);
      expect(plan.errors).toEqual([]);
      expect(plan.proposals.find((p) => p.proposalId === "price")?.effective).toMatchObject({
        scopeKey: "input_tokens",
        unit: "per_1m_input_tokens",
      });
      const corrected = await f.executor.apply(correction);
      expect(corrected.head.after).toBe(k0 + 1);
      await expect(f.executor.apply(stale)).rejects.toMatchObject({ code: "REBASE_REQUIRED" });
      const state = async (k: number, date: string) =>
        f.db.transaction(
          { tenantId: f.tenantId, role: "pipeline_agent", readOnly: true },
          async (client) =>
            (
              await client.query(
                `select st.scope_key,s.amount::text,c.structured->'verification'->>'claimId' claim_id
        from temporal.segment s join temporal.stream st on st.id=s.stream_id left join evidence.claim c on c.id=s.primary_claim_id
        where st.subject_entity_id=$1 and st.kind='model_offering_price' and s.k_from<=$2 and (s.k_to is null or $2<s.k_to) and s.valid_during @> $3::timestamptz`,
                [offering, k, date],
              )
            ).rows,
        );
      expect(await state(k0, "2026-02-15Z")).toEqual([
        { scope_key: "input_tokens", amount: "2.000000", claim_id: "original" },
      ]);
      expect(await state(corrected.head.after, "2026-02-15Z")).toEqual([
        { scope_key: "input_tokens", amount: "3.000000", claim_id: "correction" },
      ]);
      for (const date of ["2026-01-15Z", "2026-04-15Z"])
        expect(await state(corrected.head.after, date)).toEqual([
          { scope_key: "input_tokens", amount: "2.000000", claim_id: "original" },
        ]);
      const duplicated = await f.executor.apply(correction);
      expect(duplicated.receiptId).toBe(corrected.receiptId);
      expect((await f.reads.head(f.tenantId)).knowledgeSeq).toBe(corrected.head.after);
      const regional = await f.executor.apply(
        await make("regional", { scopeKey: "eu-enterprise", amount: 4, payload: { region: "eu", plan: "enterprise" } }),
      );
      expect(regional.outcome).toBe("applied");
      expect((await state(regional.head.after, "2026-02-15Z")).map((row) => row.scope_key).sort()).toEqual([
        "eu-enterprise",
        "input_tokens",
      ]);
      const alteredPayload = await f.executor.apply(
        await make("regional", {
          scopeKey: "eu-enterprise",
          amount: 4,
          payload: { region: "eu", plan: "enterprise", qualifier: "batch" },
        }),
      );
      expect(alteredPayload.proposals.find((p) => p.proposalId === "price")?.outcome).toBe("admitted");
      const currency = await f.executor.apply(
        await make("regional", {
          scopeKey: "eu-enterprise",
          amount: 4,
          currency: "EUR",
          payload: { region: "eu", plan: "enterprise", qualifier: "batch" },
        }),
      );
      expect(currency.proposals.find((p) => p.proposalId === "price")?.outcome).toBe("admitted");
      const reference = await f.executor.apply(
        await make("regional", {
          scopeKey: "eu-enterprise",
          amount: 4,
          currency: "EUR",
          payload: { region: "eu", plan: "enterprise", qualifier: "batch" },
          refEntityRef: "organization",
        }),
      );
      expect(reference.proposals.find((p) => p.proposalId === "price")?.outcome).toBe("admitted");
      const unchanged = await f.executor.apply(
        await make("regional", {
          scopeKey: "eu-enterprise",
          amount: 4,
          currency: "EUR",
          payload: { region: "eu", plan: "enterprise", qualifier: "batch" },
          refEntityRef: "organization",
        }),
      );
      expect(unchanged.outcome).toBe("noop");
      for (const amount of [0.0000001, 0.00000000000001, 1e14]) {
        const rounded = await f.executor.plan(await make("regional", { amount }));
        expect(rounded.plannedOutcome).toBe("rejected");
        expect(rounded.errors.some((error) => error.message.includes("without rounding"))).toBe(true);
      }
      process.stdout.write(
        `${JSON.stringify({ proof: "P1-T05-T06-T08", tenantId: f.tenantId, directory: f.directory, offering, k0, k1: corrected.head.after, originalReceipt: original.receiptId, correctedReceipt: corrected.receiptId })}\n`,
      );
    } finally {
      await f.close();
    }
  });

  it("T07 preserves actual day/month locator extents and rejects contradictions/relative bounds", async () => {
    const f = await fixture();
    try {
      const runId = `events-${f.tenantId}`;
      const make = async (precision: "day" | "month", extra: Record<string, unknown> = {}) =>
        withSnapshot(f.reads, {
          schemaVersion: "knowledge-ingestion-intent.v1",
          intentId: `event-${randomUUID()}`,
          context: { tenantId: f.tenantId },
          evidence: { verificationRuns: [{ runId }] },
          subjects: [{ ref: "org", mode: "resolved", entityId: f.prepared.parents.entityId, kind: "organization" }],
          proposals: [
            {
              proposalId: "event",
              kind: "event.assert",
              eventKind: "founded",
              subjectRef: "org",
              dedupeKey: precision,
              occurredDuring: {
                from: "2026-01-01T00:00:00Z",
                to: precision === "day" ? "2026-01-02T00:00:00Z" : "2026-02-01T00:00:00Z",
              },
              extent: {
                sourceText: precision === "day" ? "January 1, 2026" : "January 2026",
                precision,
                locatorRef: f.locator,
                earliest: "2026-01-01",
                latest: precision === "day" ? "2026-01-02" : "2026-02-01",
              },
              evidence: [{ runId, claimId: "event" }],
              ...extra,
            },
          ],
        } as IngestionIntentInput);
      for (const precision of ["day", "month"] as const) {
        const raw = await make(precision);
        expect((await f.executor.apply(raw)).outcome).toBe("applied");
        const duplicate = await f.executor.apply(await make(precision));
        expect(duplicate.outcome).toBe("noop");
      }
      const extents = await f.db.transaction(
        { tenantId: f.tenantId, role: "pipeline_agent", readOnly: true },
        (client) =>
          client.query(
            "select x.precision,x.locator_id,x.source_text from temporal.event_occurrence o join temporal.extent x on x.id=o.extent_id where o.k_to is null order by x.precision",
          ),
      );
      expect(extents.rows).toEqual([
        { precision: "day", locator_id: f.locator, source_text: "January 1, 2026" },
        { precision: "month", locator_id: f.locator, source_text: "January 2026" },
      ]);
      const mismatch = await f.executor.plan(await make("month", { precision: "instant" }));
      expect(mismatch.plannedOutcome).toBe("rejected");
      const relative = await make("day", {
        extent: { sourceText: "tomorrow", precision: "relative", earliest: "tomorrow" },
      });
      expect(IngestionIntentSchema.safeParse(relative).success).toBe(false);
      const automatic = await make("day", { extent: undefined, precision: "month", dedupeKey: "month-without-extent" });
      expect((await f.executor.apply(automatic)).outcome).toBe("applied");
      const actual = await f.db.transaction(
        { tenantId: f.tenantId, role: "pipeline_agent", readOnly: true },
        (client) =>
          client.query(
            "select x.precision from temporal.event e join temporal.event_occurrence o on o.event_id=e.id join temporal.extent x on x.id=o.extent_id where e.dedupe_key='month-without-extent' and o.k_to is null",
          ),
      );
      expect(actual.rows).toEqual([{ precision: "month" }]);
      const foreign = await fixture();
      try {
        const head = (await f.reads.head(f.tenantId)).knowledgeSeq;
        await expect(
          f.executor.apply(
            await make("day", {
              dedupeKey: "foreign-locator",
              extent: { sourceText: "January 1", precision: "day", locatorRef: foreign.locator },
            }),
          ),
        ).rejects.toThrow("locator tenant mismatch");
        expect((await f.reads.head(f.tenantId)).knowledgeSeq).toBe(head);
      } finally {
        await foreign.close();
      }
      process.stdout.write(
        `${JSON.stringify({ proof: "P1-T07", tenantId: f.tenantId, locator: f.locator, directory: f.directory })}\n`,
      );
    } finally {
      await f.close();
    }
  });
});
