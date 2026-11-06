import { describe, expect, it, vi } from "vitest";
import { PostgresVerificationProviderAccounting } from "./verification-provider-accounting.js";
import { PostgresVerificationProviderResponseCaptureStore } from "./verification-provider-response-capture.js";
import { verificationProviderHostTuple, type VerificationProviderHost } from "./verification-provider-host.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lease = {
  id: id(3),
  tenantId: id(1),
  operationId: id(2),
  stepKey: "extract_and_register",
  stepKind: "extract_and_register",
  inputSha256: "a".repeat(64),
  status: "running",
  attemptCount: 1,
  maxAttempts: 1,
  rowVersion: 1,
  holderIdentity: "worker",
  leaseToken: id(4),
  fencingToken: 2,
  expiresAt: "2026-09-06T00:00:00.000Z",
};
describe("closed native provider hosts", () => {
  it.each(["structured_extraction", "claims", "report"] as const)(
    "binds accounting and response recovery to exact %s tuple",
    async (host) => {
      const expected = verificationProviderHostTuple(host);
      const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => ({
        rows:
          sql.includes("knowledge_service.operation where") || sql.includes("select step.id") ? [{ id: id(2) }] : [],
      }));
      const database = {
        transaction: async (_tenant: string, work: (client: unknown) => Promise<unknown>) => work({ query }),
      } as never;
      const scopedLease = { ...lease, stepKey: expected.stepKey, stepKind: expected.stepKey };
      await new PostgresVerificationProviderAccounting(database, {
        host,
        lease: scopedLease,
        profileArtifactId: id(5),
        profileDigest: `sha256:${"a".repeat(64)}`,
      }).readOriginalAttempt(id(1), { requestDigest: `sha256:${"b".repeat(64)}`, attemptOrdinal: 1 });
      await new PostgresVerificationProviderResponseCaptureStore(database, host).readForRecovery({
        lease: scopedLease,
        providerAttemptId: id(6),
      });
      const lookup = query.mock.calls.find(([sql]) =>
        sql.includes("select * from orchestration.verification_provider_attempt"),
      );
      expect(lookup?.[1]).toEqual([id(1), id(2), "b".repeat(64), 1]);
      const operations = query.mock.calls.filter(([sql]) => sql.includes("knowledge_service.operation where"));
      expect(operations).toHaveLength(2);
      for (const [, values] of operations) expect(values).toEqual([id(1), id(2), expected.operationKind]);
      const steps = query.mock.calls.filter(([sql]) => sql.includes("select step.id"));
      expect(steps).toHaveLength(2);
      for (const [sql, values] of steps) {
        expect(sql).toContain("step.step_key=$7 and step.step_kind=$7");
        expect(values?.[6]).toBe(expected.stepKey);
      }
    },
  );
  it("rejects unsupported hosts before accessing persistence", () => {
    const bad = "request_adjudication" as VerificationProviderHost;
    expect(() => new PostgresVerificationProviderResponseCaptureStore({} as never, bad)).toThrow(
      "VERIFICATION_PROVIDER_HOST_INVALID",
    );
    expect(
      () =>
        new PostgresVerificationProviderAccounting({} as never, {
          host: bad,
          lease,
          profileArtifactId: id(5),
          profileDigest: `sha256:${"a".repeat(64)}`,
        }),
    ).toThrow("VERIFICATION_PROVIDER_HOST_INVALID");
  });
  it("requires exact semantic logical call identity before querying", async () => {
    const transaction = vi.fn();
    const accounting = new PostgresVerificationProviderAccounting({ transaction } as never, {
      host: "claims",
      lease,
      profileArtifactId: id(5),
      profileDigest: `sha256:${"a".repeat(64)}`,
    });
    await expect(accounting.readOriginalAttempt(id(1))).rejects.toThrow(
      "PROVIDER_ACCOUNTING_LOGICAL_CALL_IDENTITY_REQUIRED",
    );
    await expect(
      accounting.readOriginalAttempt(id(1), { requestDigest: `sha256:${"b".repeat(64)}`, attemptOrdinal: 9 }),
    ).rejects.toThrow("PROVIDER_ACCOUNTING_ATTEMPT_ORDINAL_INVALID");
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each(["claims", "report"] as const)("includes logical request digest in %s reservation lookup", async (host) => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes("knowledge_service.operation where") || sql.includes("select step.id"))
        return { rows: [{ id: id(2) }] };
      if (sql.startsWith("select * from orchestration.verification_provider_budget"))
        return { rows: [{ id: id(7), ceiling_cost_micros: 1000 }] };
      if (sql.startsWith("select * from orchestration.verification_provider_attempt"))
        throw new Error("LOOKUP_REACHED");
      return { rows: [] };
    });
    const database = {
      transaction: async (_tenant: string, work: (client: unknown) => Promise<unknown>) => work({ query }),
    } as never;
    const accounting = new PostgresVerificationProviderAccounting(database, {
      host,
      lease,
      profileArtifactId: id(5),
      profileDigest: `sha256:${"a".repeat(64)}`,
    });
    await expect(
      accounting.reserve({
        tenantId: id(1),
        budgetId: id(7),
        budgetKey: "semantic",
        ceilingCostMicros: 1000,
        attemptId: id(8),
        requestDigest: `sha256:${"b".repeat(64)}`,
        attemptOrdinal: 0,
        providerId: "judge",
        model: "luna",
        reservationCostMicros: 10,
        requestArtifactId: id(9),
      }),
    ).rejects.toThrow("LOOKUP_REACHED");
    const lookup = query.mock.calls.find(([sql]) =>
      sql.startsWith("select * from orchestration.verification_provider_attempt"),
    );
    expect(lookup?.[0]).toContain("request_sha256=$4");
    expect(lookup?.[1]).toEqual([id(1), id(2), 0, "b".repeat(64)]);
  });
});
