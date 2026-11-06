import { describe, expect, it, vi } from "vitest";
import { PostgresVerificationProviderAccounting } from "./verification-provider-accounting.js";

const tenant = "11111111-1111-4111-8111-111111111111",
  operation = "22222222-2222-4222-8222-222222222222",
  step = "33333333-3333-4333-8333-333333333333",
  profile = "44444444-4444-4444-8444-444444444444",
  budget = "55555555-5555-4555-8555-555555555555",
  attempt = "66666666-6666-4666-8666-666666666666",
  request = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const digest = `sha256:${"a".repeat(64)}` as const;
const lease = {
  id: step,
  tenantId: tenant,
  operationId: operation,
  stepKey: "extract_and_register",
  stepKind: "verification",
  inputSha256: "a".repeat(64),
  status: "running",
  attemptCount: 1,
  maxAttempts: 1,
  rowVersion: 1,
  holderIdentity: "worker",
  leaseToken: "77777777-7777-4777-8777-777777777777",
  fencingToken: 7,
  expiresAt: "2026-09-06T00:00:00.000Z",
};
const budgetRow = {
  id: budget,
  tenant_id: tenant,
  budget_key: "fixture",
  ceiling_cost_micros: 100,
  reserved_cost_micros: 0,
  settled_cost_micros: 0,
};
const attemptRow = {
  id: attempt,
  tenant_id: tenant,
  budget_id: budget,
  request_sha256: "a".repeat(64),
  attempt_ordinal: 0,
  provider_id: "gateway",
  model: "model",
  reservation_cost_micros: 10,
  state: "reserved",
  dispatch_fence: null,
  operation_id: operation,
  operation_step_id: step,
  profile_artifact_id: profile,
  profile_sha256: "a".repeat(64),
  reserved_fencing_token: 7,
  dispatch_fencing_token: null,
  estimated_cost_micros: null,
  actual_cost_micros: null,
  request_artifact_id: request,
  response_artifact_id: null,
};

const scoped = (query: ReturnType<typeof vi.fn>) =>
  ({ transaction: async (_tenant: string, fn: (client: unknown) => Promise<unknown>) => fn({ query }) }) as never;
const activeLease = (sql: string) =>
  sql.includes("from knowledge_service.operation where") || sql.includes("from knowledge_service.operation_step step");

describe("operation-scoped provider accounting", () => {
  it("rejects a non-UUID lease token before database access", () => {
    const db = { transaction: vi.fn() } as never;
    expect(
      () =>
        new PostgresVerificationProviderAccounting(db, {
          lease: { ...lease, leaseToken: "lease" },
          profileArtifactId: profile,
          profileDigest: digest,
        }),
    ).toThrow("PROVIDER_ACCOUNTING_UUID_INVALID");
    expect((db as { transaction: ReturnType<typeof vi.fn> }).transaction).not.toHaveBeenCalled();
  });

  it("uses the live operation then step lease, and emits exactly fifteen scoped insert parameters", async () => {
    const query = vi.fn(async (sql: string) => {
      if (activeLease(sql)) return { rows: [{ id: step }] };
      if (sql.includes("select * from orchestration.verification_provider_budget where")) return { rows: [budgetRow] };
      if (sql.includes("verification_provider_attempt where tenant_id=$1 and operation_id")) return { rows: [] };
      if (sql.startsWith("insert into orchestration.verification_provider_attempt")) return { rows: [attemptRow] };
      return { rows: [] };
    });
    const subject = new PostgresVerificationProviderAccounting(scoped(query), {
      lease,
      profileArtifactId: profile,
      profileDigest: digest,
    });
    await expect(
      subject.reserve({
        tenantId: tenant,
        budgetId: budget,
        budgetKey: "fixture",
        ceilingCostMicros: 100,
        attemptId: attempt,
        requestDigest: digest,
        attemptOrdinal: 0,
        providerId: "gateway",
        model: "model",
        reservationCostMicros: 10,
        requestArtifactId: request,
      }),
    ).resolves.toMatchObject({ attempt: { operationId: operation, reservedFencingToken: 7 } });
    expect(
      query.mock.calls.find(([sql]) => String(sql).includes("from knowledge_service.operation where")),
    ).toBeTruthy();
    const insert = query.mock.calls.find(([sql]) =>
      String(sql).startsWith("insert into orchestration.verification_provider_attempt"),
    )!;
    expect((insert as unknown as readonly [string, readonly unknown[]])[1]).toHaveLength(15);
    expect(String(insert[0])).toContain("$15)");
    expect(String(insert[0])).not.toContain("$16");
  });

  it("reuses a prior scoped reservation under a replacement live lease without a second budget reservation", async () => {
    const replacement = { ...lease, leaseToken: "88888888-8888-4888-8888-888888888888", fencingToken: 8 };
    const query = vi.fn(async (sql: string) => {
      if (activeLease(sql)) return { rows: [{ id: step }] };
      if (sql.includes("select * from orchestration.verification_provider_budget where")) return { rows: [budgetRow] };
      if (sql.includes("verification_provider_attempt where tenant_id=$1 and operation_id"))
        return { rows: [attemptRow] };
      return { rows: [] };
    });
    const result = await new PostgresVerificationProviderAccounting(scoped(query), {
      lease: replacement,
      profileArtifactId: profile,
      profileDigest: digest,
    }).reserve({
      tenantId: tenant,
      budgetId: budget,
      budgetKey: "fixture",
      ceilingCostMicros: 100,
      attemptId: attempt,
      requestDigest: digest,
      attemptOrdinal: 0,
      providerId: "gateway",
      model: "model",
      reservationCostMicros: 10,
      requestArtifactId: request,
    });
    expect(result.reused).toBe(true);
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).startsWith("update orchestration.verification_provider_budget set reserved"),
      ),
    ).toBe(false);
  });

  it("rejects a stale lease before it can create or reserve budget", async () => {
    const query = vi.fn(async (sql: string) => (activeLease(sql) ? { rows: [] } : { rows: [] }));
    const subject = new PostgresVerificationProviderAccounting(scoped(query), {
      lease,
      profileArtifactId: profile,
      profileDigest: digest,
    });
    await expect(
      subject.reserve({
        tenantId: tenant,
        budgetId: budget,
        budgetKey: "fixture",
        ceilingCostMicros: 100,
        attemptId: attempt,
        requestDigest: digest,
        attemptOrdinal: 0,
        providerId: "gateway",
        model: "model",
        reservationCostMicros: 10,
        requestArtifactId: request,
      }),
    ).rejects.toThrow("PROVIDER_ACCOUNTING_STALE_OPERATION_LEASE");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("verification_provider_budget"))).toBe(false);
  });

  it.each(["settle", "uncertain"] as const)(
    "rejects profile drift before cached %s handling",
    async (operationName) => {
      const drifted = {
        ...attemptRow,
        profile_artifact_id: "99999999-9999-4999-8999-999999999999",
        state: operationName === "settle" ? "settled" : "uncertain",
        actual_cost_micros: 10,
        response_artifact_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      };
      const query = vi.fn(async (sql: string) => {
        if (activeLease(sql)) return { rows: [{ id: step }] };
        if (sql.includes("select budget_id")) return { rows: [{ budget_id: budget }] };
        if (sql.includes("select * from orchestration.verification_provider_budget")) return { rows: [budgetRow] };
        if (sql.includes("select * from orchestration.verification_provider_attempt")) return { rows: [drifted] };
        return { rows: [] };
      });
      const subject = new PostgresVerificationProviderAccounting(scoped(query), {
        lease,
        profileArtifactId: profile,
        profileDigest: digest,
      });
      const run =
        operationName === "settle"
          ? subject.settle({
              tenantId: tenant,
              attemptId: attempt,
              actualCostMicros: 10,
              responseArtifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            })
          : subject.markUncertain({ tenantId: tenant, attemptId: attempt });
      await expect(run).rejects.toThrow("PROVIDER_ACCOUNTING_SCOPE_ATTEMPT_MISMATCH");
      expect(
        query.mock.calls.some(([sql]) => String(sql).startsWith("update orchestration.verification_provider_attempt")),
      ).toBe(false);
    },
  );
});
