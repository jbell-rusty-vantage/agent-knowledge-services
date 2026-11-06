import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => [] as string[]);

// Record host release while keeping the real composition.
vi.mock("@aiengineer/knowledge-host", async (importOriginal) => {
  const original = await importOriginal<typeof import("@aiengineer/knowledge-host")>();
  return {
    ...original,
    createHost: async (options: Parameters<typeof original.createHost>[0]) => {
      const host = await (original.createHost as (value: typeof options) => Promise<{ close(): Promise<void> }>)(
        options,
      );
      const release = host.close.bind(host);
      return Object.assign(host, {
        close: async () => {
          events.push("host.close");
          await release();
        },
      });
    },
  };
});

const { createApiRuntime } = await import("../index.js");

beforeEach(() => {
  events.length = 0;
});

describe("API runtime lifecycle", () => {
  it("closes the HTTP server before releasing the host, once for concurrent callers", async () => {
    const runtime = await createApiRuntime({ NODE_ENV: "test" });
    runtime.server.addHook("onClose", async () => void events.push("server.close"));
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    await first;
    await runtime.close();
    expect(events).toEqual(["server.close", "host.close"]);
  });

  it("releases the host when transport construction fails after composition", async () => {
    await expect(createApiRuntime({ NODE_ENV: "test", KNOWLEDGE_CALLBACK_SIGNING_KEYS: "not-json" })).rejects.toThrow();
    expect(events).toEqual(["host.close"]);
  });
});
