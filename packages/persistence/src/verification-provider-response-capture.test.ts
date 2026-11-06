import { describe, expect, it, vi } from "vitest";
import { PostgresVerificationProviderResponseCaptureStore } from "./verification-provider-response-capture.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lease = {
  id: id(3),
  tenantId: id(1),
  operationId: id(2),
  stepKey: "extract_and_register",
  stepKind: "verification",
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
describe("provider response capture", () => {
  it("does not read recovery state under a stale lease", async () => {
    const query = vi.fn(async (sql: string) =>
        sql.includes("knowledge_service.operation where") ? { rows: [] } : { rows: [] },
      ),
      db = { transaction: async (_t: string, fn: (c: unknown) => Promise<unknown>) => fn({ query }) } as never;
    await expect(
      new PostgresVerificationProviderResponseCaptureStore(db).readForRecovery({ lease, providerAttemptId: id(5) }),
    ).rejects.toThrow("PROVIDER_RESPONSE_CAPTURE_STALE_LEASE");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("verification_provider_response_capture where"))).toBe(
      false,
    );
  });
});
