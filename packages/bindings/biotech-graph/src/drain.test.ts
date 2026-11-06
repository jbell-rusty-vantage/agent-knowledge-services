import type { AuthScope } from "@aiengineer/knowledge-research-core";
import { describe, expect, it } from "vitest";
import { type DrainDelivery, DispatchDrain, PostgresPendingDispatches, drainConfigFromEnv } from "./drain.js";

const scope = (tenant: string) => ({ tenant, binding: "biotech-graph" }) as AuthScope;

function harness(pending: Record<string, string[]>) {
  const calls: string[] = [];
  const delivery: DrainDelivery = {
    async deliver(s, id) {
      calls.push(`deliver ${s.tenant} ${id}`);
      pending[s.tenant] = (pending[s.tenant] ?? []).filter((item) => item !== id);
      return { state: "applied" };
    },
    async reconcile(s, id) {
      calls.push(`reconcile ${s.tenant} ${id}`);
      return { state: "pending_dispatch" };
    },
  };
  const drain = new DispatchDrain({
    scopes: [scope("t-1"), scope("t-2")],
    pending: { pending: async (s, limit) => (pending[s.tenant] ?? []).slice(0, limit) },
    delivery: async () => delivery,
    config: { intervalMs: 250, limit: 2 },
  });
  return { drain, calls };
}

describe("biotech dispatch drain (OVE-169)", () => {
  it("delivers the oldest pending dispatch per tenant once, reconciles the rest within the limit", async () => {
    const { drain, calls } = harness({ "t-1": ["d-1", "d-2", "d-3"], "t-2": [] });
    const passes = await drain.drainOnce();
    expect(calls).toEqual(["deliver t-1 d-1", "reconcile t-1 d-2"]);
    expect(passes).toEqual([
      {
        tenant: "t-1",
        results: [
          { dispatchId: "d-1", state: "applied" },
          { dispatchId: "d-2", state: "pending_dispatch" },
        ],
      },
    ]);
  });

  it("does nothing when nothing is pending and stops cleanly", async () => {
    const { drain, calls } = harness({});
    expect(await drain.drainOnce()).toEqual([]);
    drain.start();
    await drain.stop();
    expect(calls).toEqual([]);
  });

  it("is off by default and refuses malformed limits", () => {
    expect(drainConfigFromEnv({})).toBeNull();
    expect(drainConfigFromEnv({ KS_BIOTECH_DISPATCH_DRAIN_INTERVAL_MS: "0" })).toBeNull();
    expect(drainConfigFromEnv({ KS_BIOTECH_DISPATCH_DRAIN_INTERVAL_MS: "5000" })).toEqual({
      intervalMs: 5000,
      limit: 10,
    });
    expect(() => drainConfigFromEnv({ KS_BIOTECH_DISPATCH_DRAIN_INTERVAL_MS: "10" })).toThrow(/DRAIN_CONFIG_INVALID/);
    expect(() =>
      drainConfigFromEnv({ KS_BIOTECH_DISPATCH_DRAIN_INTERVAL_MS: "5000", KS_BIOTECH_DISPATCH_DRAIN_LIMIT: "500" }),
    ).toThrow(/DRAIN_CONFIG_INVALID/);
  });
});

describe("biotech dispatch drain review fixes (OVE-169)", () => {
  it("isolates a failing tenant and a failing row; the others still drain", async () => {
    const errors: unknown[] = [];
    const calls: string[] = [];
    const drain = new DispatchDrain({
      scopes: [scope("bad"), scope("t-1")],
      pending: {
        pending: async (s) => {
          if (s.tenant === "bad") throw new Error("tenant down");
          return ["d-1", "d-2", "d-3"];
        },
      },
      delivery: async () => ({
        async deliver(_s, id) {
          calls.push(`deliver ${id}`);
          return { state: "applied" as const };
        },
        async reconcile(_s, id) {
          calls.push(`reconcile ${id}`);
          if (id === "d-2") throw new Error("row down");
          return { state: "applied" as const };
        },
      }),
      config: { intervalMs: 250, limit: 3 },
      onError: (error) => errors.push(error),
    });
    const passes = await drain.drainOnce();
    expect(calls).toEqual(["deliver d-1", "reconcile d-2", "reconcile d-3"]);
    expect(passes[0]?.results.map((r) => r.dispatchId)).toEqual(["d-1", "d-3"]);
    expect(errors.map((e) => (e as Error).message)).toEqual(["tenant down", "row down"]);
  });

  it("never overlaps passes", async () => {
    let active = 0;
    let peak = 0;
    let passes = 0;
    const drain = new DispatchDrain({
      scopes: [scope("t-1")],
      pending: {
        pending: async () => {
          active += 1;
          peak = Math.max(peak, active);
          passes += 1;
          await new Promise((resolve) => setTimeout(resolve, 700));
          active -= 1;
          return [];
        },
      },
      delivery: async () => {
        throw new Error("unused");
      },
      config: { intervalMs: 250, limit: 1 },
    });
    drain.start();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await drain.stop();
    expect(peak).toBe(1);
    expect(passes).toBeGreaterThanOrEqual(1);
  });

  it("lists only due undelivered rows under the reader role", async () => {
    const seen: { options: unknown; sql: string; params: unknown[] }[] = [];
    const db = {
      transaction: async (options: unknown, fn: (c: unknown) => Promise<unknown>) =>
        fn({
          query: async (sql: string, params: unknown[]) => {
            seen.push({ options, sql, params });
            return { rows: [{ dispatch_id: "d-1" }] };
          },
        }),
    };
    const pending = new PostgresPendingDispatches(db as never);
    expect(await pending.pending(scope("t-1"), 5)).toEqual(["d-1"]);
    expect(seen[0]?.options).toEqual({ tenantId: "t-1", role: "knowledge_verification_reader", readOnly: true });
    expect(seen[0]?.sql).toContain("state in ('pending', 'dispatched') and available_at <= now()");
    expect(seen[0]?.params).toEqual(["t-1", 5]);
  });
});
