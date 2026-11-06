import { type Origin, digestBytes, digestCanonical } from "@aiengineer/knowledge-operation-protocol";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../db-read/index.js";
import type { KnowledgeError } from "../../schema-workspace/errors.js";
import { IngestionExecutor, type IngestionExecutorConfig } from "../executor.js";
import { IngestionIntentSchema, type IngestionIntent } from "../intent.js";
import { buildPlan, deterministicId, intentDigestOf, planIdentityDigest } from "../plan.js";
import { fixtureFacts, priceIntent } from "./test-fixtures.js";

/**
 * Sprint OC `knowledge.plan_preview` (knowledge-db half): the preview answers exactly the plan-level values `apply`
 * computes for the same intent in the same state, before a decision exists, and writes nothing. The real planner reads
 * the AI Engineer database (covered by the AIDB integration suite); here the plan facts are the deterministic fixture.
 */
const identity = { version: "knowledge-executor/test", migrationHead: "20260912020000" };
const origin: Origin = {
  kind: "standalone",
  installationId: "install-1",
  applicationId: "ai-engineer",
  tenantId: "00000000-0000-7000-8000-000000000001",
  issuer: "mission-control",
  subject: "runtime",
  mission: null,
  recoveryAuthorityRef: null,
  invocationId: "inv-1",
  authenticatedAt: "2026-10-25T00:00:00Z",
};
const decision = {
  useDecisionId: "ud-preview-1",
  boundEffectDigest: digestBytes("whatever the caller presents"),
  processedEpoch: 7,
  normalizedValuesDigest: digestCanonical({ parameters: "7000000000" }),
};
const effect = { effectKey: "effect-preview-1", originatingOrigin: origin };
const code = async (run: () => Promise<unknown>): Promise<string | null> => {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as KnowledgeError).code;
  }
};

/** An executor whose planner sees the fixture facts and whose only database access is the recorded epoch read. */
function previewExecutor(epoch: number | null = 3) {
  const transactions: { readOnly: boolean; role?: string; sql: string[] }[] = [];
  const db = {
    async transaction<T>(scope: { readOnly?: boolean; role?: string }, work: (client: unknown) => Promise<T>) {
      const record = {
        readOnly: scope.readOnly === true,
        ...(scope.role ? { role: scope.role } : {}),
        sql: [] as string[],
      };
      transactions.push(record);
      return work({
        async query(sql: string) {
          record.sql.push(sql);
          return { rows: [{ epoch: epoch === null ? null : String(epoch) }] };
        },
      });
    },
  };
  const untouchable = new Proxy(
    {},
    {
      get: () => {
        throw new Error("must not be touched");
      },
    },
  );
  const executor = new IngestionExecutor({
    db,
    workspace: { migrationHead: identity.migrationHead },
    artifacts: untouchable,
    executorVersion: identity.version,
    evidence: () => untouchable,
  } as unknown as IngestionExecutorConfig);
  // The planner's database read (`planWithContext`) is replaced by the pure planner over the fixture facts.
  const planned: IngestionIntent[] = [];
  Object.assign(executor, {
    planWithContext: async (intent: IngestionIntent) => {
      planned.push(intent);
      return { intent, plan: buildPlan(intent, fixtureFacts(), identity), vocabulary: null };
    },
  });
  return { executor, transactions, planned };
}

describe("knowledge.plan_preview (native planner preview)", () => {
  it("answers exactly the planId and bound digest the apply plan computes once the decision is filled in", async () => {
    const { executor } = previewExecutor(3);
    const preview = await executor.preview({ ...priceIntent(), exactUse: effect });
    const applyIntent = IngestionIntentSchema.parse({
      ...priceIntent(),
      exactUse: { ...effect, ...decision, boundEffectDigest: preview.boundEffectDigest },
    });
    const applied = buildPlan(applyIntent, fixtureFacts(), identity);
    expect(applied.errors).toEqual([]);
    expect(preview).toEqual({
      planId: applied.planId,
      semanticPayloadDigest: applied.effect?.semanticPayloadDigest,
      boundEffectDigest: applied.effect?.boundEffectDigest,
      normalizedValuesDigest: digestCanonical({}),
      processedEpoch: 3,
      migrationHead: identity.migrationHead,
    });
    // `apply`'s own exact-effect check (plan digest == intent digest) therefore passes for this decision.
    expect(applied.effect?.boundEffectDigest).toBe(applyIntent.exactUse?.boundEffectDigest);
  });

  it("ignores presented decision fields except the normalized-values digest the native write presents", async () => {
    const { executor } = previewExecutor(0);
    const bare = await executor.preview({ ...priceIntent(), exactUse: effect });
    const presented = await executor.preview({ ...priceIntent(), exactUse: { ...effect, ...decision } });
    expect({ ...presented, normalizedValuesDigest: bare.normalizedValuesDigest }).toEqual(bare);
    expect(presented.normalizedValuesDigest).toBe(decision.normalizedValuesDigest);
  });

  it("changes with the originating origin and the proposals, like the apply digest", async () => {
    const { executor } = previewExecutor();
    const base = await executor.preview({ ...priceIntent(), exactUse: effect });
    const otherOrigin = await executor.preview({
      ...priceIntent(),
      exactUse: { ...effect, originatingOrigin: { ...origin, subject: "other" } },
    });
    expect(otherOrigin.boundEffectDigest).not.toBe(base.boundEffectDigest);
    expect(otherOrigin.semanticPayloadDigest).toBe(base.semanticPayloadDigest);
    const edited = await executor.preview({ ...priceIntent({ intentId: "price-edited" }), exactUse: effect });
    expect(edited.boundEffectDigest).not.toBe(base.boundEffectDigest);
  });

  it("writes nothing: its only database access is one read-only epoch read", async () => {
    const { executor, transactions } = previewExecutor(5);
    await executor.preview({ ...priceIntent(), exactUse: effect });
    expect(transactions).toEqual([
      {
        readOnly: true,
        role: "executor_service",
        sql: ["select knowledge_verification.current_revocation_epoch($1)::text as epoch"],
      },
    ]);
  });

  it("refuses typed before any database access", async () => {
    const { executor, transactions, planned } = previewExecutor();
    // No exact-use effect binding: nothing to bind a digest to.
    expect(await code(() => executor.preview(priceIntent()))).toBe("INTENT_SCHEMA_INVALID");
    expect(await code(() => executor.preview({ ...priceIntent(), exactUse: { effectKey: "e-1" } }))).toBe(
      "INTENT_SCHEMA_INVALID",
    );
    // The executor's workspace head is not the intent's.
    expect(
      await code(() =>
        executor.preview({ ...priceIntent(), contract: { migrationHead: "20990101000000" }, exactUse: effect }),
      ),
    ).toBe("WORKSPACE_STALE");
    // A declared use this executor cannot classify (no use-class policy), as apply refuses it.
    expect(
      await code(() =>
        executor.preview({
          ...priceIntent(),
          exactUse: effect,
          declaredUse: { use: "report_publication", audience: "official" },
        }),
      ),
    ).toBe("SCHEMA_UNSUPPORTED");
    expect(transactions).toEqual([]);
    expect(planned).toEqual([]);
  });

  it("refuses a plan apply would refuse, and an absent epoch", async () => {
    const held = previewExecutor();
    Object.assign(held.executor, {
      planWithContext: async (intent: IngestionIntent) => ({
        intent,
        plan: {
          ...buildPlan(intent, fixtureFacts(), identity),
          errors: [{ code: "VOCABULARY_VIOLATION", message: "x" }],
        },
        vocabulary: null,
      }),
    });
    expect(await code(() => held.executor.preview({ ...priceIntent(), exactUse: effect }))).toBe(
      "VOCABULARY_VIOLATION",
    );
    expect(held.transactions).toEqual([]);
    const { executor } = previewExecutor(null);
    expect(await code(() => executor.preview({ ...priceIntent(), exactUse: effect }))).toBe("EXECUTOR_INTERNAL");
  });
});

describe("plan identity (decision-independent)", () => {
  it("keeps the plan id of an intent without exact use and ignores only the decision fields of one with it", () => {
    const plain = IngestionIntentSchema.parse(priceIntent());
    expect(planIdentityDigest(plain)).toBe(intentDigestOf(plain));
    const facts = fixtureFacts();
    expect(buildPlan(plain, facts, identity).planId).toBe(
      deterministicId(
        "knowledge-ingestion-plan",
        canonicalJson({
          intentDigest: intentDigestOf(plain),
          head: facts.currentHead,
          rules: facts.rules.rulesVersion,
          executor: identity.version,
        }),
      ),
    );
    const a = IngestionIntentSchema.parse({ ...priceIntent(), exactUse: { ...effect, ...decision } });
    const b = IngestionIntentSchema.parse({
      ...priceIntent(),
      exactUse: { ...effect, ...decision, useDecisionId: "ud-other", processedEpoch: 99 },
    });
    expect(buildPlan(a, facts, identity).planId).toBe(buildPlan(b, facts, identity).planId);
    // The intent digest (idempotency and duplicate checks) still covers the whole intent.
    expect(intentDigestOf(a)).not.toBe(intentDigestOf(b));
    const otherKey = IngestionIntentSchema.parse({
      ...priceIntent(),
      exactUse: { ...effect, ...decision, effectKey: "effect-other" },
    });
    // MC previews before the final decision-derived dispatch key exists. Semantic plan identity remains the same;
    // idempotency/conflict checks still distinguish the full requests, including their effect keys.
    expect(buildPlan(otherKey, facts, identity).planId).toBe(buildPlan(a, facts, identity).planId);
    expect(buildPlan(otherKey, facts, identity).effect?.boundEffectDigest).toBe(
      buildPlan(a, facts, identity).effect?.boundEffectDigest,
    );
    expect(intentDigestOf(otherKey)).not.toBe(intentDigestOf(a));
  });
});
