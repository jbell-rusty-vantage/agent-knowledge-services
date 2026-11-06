import { describe, expect, it, vi } from "vitest";
import { startPollingLoop } from "../lifecycle/polling.js";
import { HostResources, constructWithResources } from "../lifecycle/resources.js";

describe("host resource ownership", () => {
  it("releases in reverse acquisition order and attempts every release after a failure", async () => {
    const resources = new HostResources();
    const released: string[] = [];
    resources.own("first", "a", () => void released.push("first"));
    resources.own("second", "b", () => {
      released.push("second");
      throw new Error("SECOND_CLOSE_FAILED");
    });
    resources.own("third", "c", () => void released.push("third"));
    await expect(resources.close()).rejects.toThrow("SECOND_CLOSE_FAILED");
    expect(released).toEqual(["third", "second", "first"]);
  });

  it("aggregates multiple release failures", async () => {
    const resources = new HostResources();
    resources.own("one", 1, () => Promise.reject(new Error("ONE")));
    resources.own("two", 2, () => Promise.reject(new Error("TWO")));
    const failure = await resources.close().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual(["TWO", "ONE"]);
  });

  it("shares one cleanup across concurrent and repeated close calls", async () => {
    const resources = new HostResources();
    let releases = 0;
    let finish!: () => void;
    resources.own("slow", undefined, () => {
      releases += 1;
      return new Promise<void>((resolve) => (finish = resolve));
    });
    const first = resources.close();
    const second = resources.close();
    expect(second).toBe(first);
    finish();
    await Promise.all([first, second, resources.close()]);
    expect(releases).toBe(1);
    expect(() => resources.own("late", 1, () => undefined)).toThrow("HOST_CLOSED:late");
  });

  it("releases everything acquired before a construction failure and rethrows the original error", async () => {
    const released: string[] = [];
    await expect(
      constructWithResources((resources) => {
        resources.own("pool", "pool", () => void released.push("pool"));
        resources.own("timer", "timer", () => void released.push("timer"));
        throw new Error("CONSTRUCTION_FAILED");
      }),
    ).rejects.toThrow("CONSTRUCTION_FAILED");
    expect(released).toEqual(["timer", "pool"]);
  });

  it("keeps the construction error when a release also fails", async () => {
    await expect(
      constructWithResources((resources) => {
        resources.own("pool", "pool", () => Promise.reject(new Error("RELEASE_FAILED")));
        throw new Error("CONSTRUCTION_FAILED");
      }),
    ).rejects.toThrow("CONSTRUCTION_FAILED");
  });
});

describe("host polling loop", () => {
  it("stops scheduling, awaits the active run and runs nothing afterwards", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      let finishRun!: () => void;
      const loop = startPollingLoop({
        pollMs: 10,
        runOnce: () => {
          runs += 1;
          return new Promise<void>((resolve) => (finishRun = resolve));
        },
        onError: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(runs).toBe(1);
      let stopped = false;
      const stopping = loop.stop().then(() => (stopped = true));
      expect(loop.stop()).toBe(loop.stop());
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      finishRun();
      await stopping;
      expect(stopped).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(runs).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed run and keeps polling until stopped", async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      let runs = 0;
      const loop = startPollingLoop({
        pollMs: 5,
        runOnce: async () => {
          runs += 1;
          if (runs === 1) throw new Error("ACTIVITY_FAILED");
        },
        onError: (error) => errors.push(error),
      });
      await vi.advanceTimersByTimeAsync(12);
      expect(runs).toBe(2);
      expect(errors).toHaveLength(1);
      await loop.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
