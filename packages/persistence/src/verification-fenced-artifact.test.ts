import { describe, expect, it, vi } from "vitest";
import { PostgresVerificationRepository } from "./verification.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("verification fenced artifact registration", () => {
  it("rejects a stale step lease before registry or object-store writes", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] }),
      put = vi.fn(),
      database = {
        transaction: async (_tenant: string, work: (client: { query: typeof query }) => unknown) => work({ query }),
      };
    const repository = new PostgresVerificationRepository(database as never, { put, get: vi.fn() } as never, {
      authorize: async () => undefined,
    });
    await expect(
      repository.registerFencedContentAddressedArtifact({
        artifact: {
          tenantId: id(1),
          producerAttemptId: id(2),
          missionId: id(3),
          bytes: new TextEncoder().encode("{}"),
          mediaType: "application/json",
          createdAt: "2026-09-07T00:00:00.000Z",
          producerActivityId: "verification-worker:test",
          producerVersion: "test.v1",
          encryptionClass: "managed",
          retentionClass: "test",
          dataClassification: "restricted",
          parentArtifactIds: [],
          artifactType: "deterministic_verification_result",
          bucketClass: "ledger",
          storageBucket: "test",
        },
        lease: { stepId: id(4), leaseToken: "lease", fencingToken: 1, holderIdentity: "worker" },
      }),
    ).rejects.toThrow("VERIFICATION_RUN_STALE_LEASE");
    expect(put).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
