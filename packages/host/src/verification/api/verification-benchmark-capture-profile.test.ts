import type { LocalApiIdentity } from "@aiengineer/knowledge-application";
import { describe, expect, it, vi } from "vitest";
import { ServerOwnedBenchmarkCaptureProfileResolver } from "./verification-benchmark-capture-profile.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1),
  actor = {
    kind: "service" as const,
    id: id(2),
    serviceIdentity: "mission_control_client" as const,
  },
  missionId = id(3),
  workItemId = id(4),
  attemptId = id(5);
const identity: LocalApiIdentity = {
  actor,
  grants: [{ tenantId, roles: ["knowledge_operator"], scopes: [] }],
};
const ownershipGrants = JSON.stringify([
  {
    tenantId,
    actor,
    missionId,
    agentDeploymentId: "profiled-capture",
    capabilityVersion: "verification-service.v1",
  },
]);
const profiles = JSON.stringify([
  {
    profileName: "diagnostics-companies",
    tenantId,
    actor,
    missionId,
    workItemId,
    attemptId,
  },
]);
const database = (options: { owned?: boolean } = {}) => {
  const query = vi.fn(async (text: string) => {
    if (text.includes("from orchestration.attempt"))
      return { rows: options.owned === false ? [] : [{ id: attemptId }] };
    throw new Error(`UNEXPECTED_QUERY:${text}`);
  });
  return {
    database: {
      transaction: async (_tenant: string, work: (client: { query: typeof query }) => Promise<unknown>) =>
        work({ query }),
    },
    query,
  };
};

describe("ServerOwnedBenchmarkCaptureProfileResolver", () => {
  it("uses configured canonical routing only after bearer actor and tenant action checks", async () => {
    const fixture = database(),
      resolver = new ServerOwnedBenchmarkCaptureProfileResolver(fixture.database as never, profiles, ownershipGrants);
    const context = await resolver.resolve(
      "diagnostics-companies",
      identity,
      "profile-correlation",
      "profile-idempotency-key",
    );
    expect(context).toMatchObject({
      tenantId,
      actor,
      missionId,
      workItemId,
      attemptId,
      correlationId: "profile-correlation",
      idempotencyKey: "profile-idempotency-key",
      reason: "authenticated captureSource request",
    });
    expect(fixture.query).toHaveBeenCalledTimes(1);
  });
  it("returns no distinguishable profile result before a canonical ownership query for unknown, foreign, or unauthorized callers", async () => {
    for (const candidate of [
      ["unknown", identity],
      ["diagnostics-companies", { ...identity, actor: { ...actor, id: id(99) } }],
      ["diagnostics-companies", { ...identity, grants: [] }],
    ] as const) {
      const fixture = database(),
        resolver = new ServerOwnedBenchmarkCaptureProfileResolver(fixture.database as never, profiles, ownershipGrants);
      await expect(
        resolver.resolve(candidate[0], candidate[1], "profile-correlation", "profile-idempotency-key"),
      ).resolves.toBeUndefined();
      expect(fixture.query).not.toHaveBeenCalled();
    }
  });
  it("refuses stale or mismatched canonical attempt ownership without manufacturing context", async () => {
    const fixture = database({ owned: false }),
      resolver = new ServerOwnedBenchmarkCaptureProfileResolver(fixture.database as never, profiles, ownershipGrants);
    await expect(
      resolver.resolve("diagnostics-companies", identity, "profile-correlation", "profile-idempotency-key"),
    ).resolves.toBeUndefined();
    expect(fixture.query).toHaveBeenCalledTimes(1);
  });
  it("fails closed on duplicate or oversized profile configuration", () => {
    const duplicate = JSON.stringify([
      {
        profileName: "diagnostics-companies",
        tenantId,
        actor,
        missionId,
        workItemId,
        attemptId,
      },
      {
        profileName: "diagnostics-companies",
        tenantId,
        actor,
        missionId,
        workItemId,
        attemptId,
      },
    ]);
    expect(
      () => new ServerOwnedBenchmarkCaptureProfileResolver(database().database as never, duplicate, ownershipGrants),
    ).toThrow("DUPLICATE_VERIFICATION_BENCHMARK_CLI_PROFILE");
    expect(
      () =>
        new ServerOwnedBenchmarkCaptureProfileResolver(
          database().database as never,
          "x".repeat(262_145),
          ownershipGrants,
        ),
    ).toThrow("VERIFICATION_BENCHMARK_CLI_PROFILE_CONFIG_TOO_LARGE");
  });
});
