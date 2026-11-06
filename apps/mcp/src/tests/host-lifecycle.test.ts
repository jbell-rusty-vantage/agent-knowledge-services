import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => [] as string[]);

// Record host release while keeping the real composition; persistence connects lazily.
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

const { createMcpRuntime } = await import("../index.js");
const environment = {
  NODE_ENV: "test",
  POSTGRES_URL: "postgres://user:secret@127.0.0.1:54322/knowledge",
  CANONICAL_LOCAL_ONLY: "1",
  KNOWLEDGE_API_URL: "http://127.0.0.1:4100",
};

beforeEach(() => {
  events.length = 0;
});

describe("MCP runtime lifecycle", () => {
  it("closes the HTTP app before releasing the host, once for concurrent callers", async () => {
    const runtime = await createMcpRuntime(environment);
    runtime.app.addHook("onClose", async () => void events.push("app.close"));
    const first = runtime.close();
    expect(runtime.close()).toBe(first);
    await first;
    expect(events).toEqual(["app.close", "host.close"]);
  });

  it("rejects an invalid API origin before composing persistence", async () => {
    await expect(createMcpRuntime({ ...environment, KNOWLEDGE_API_URL: "ftp://knowledge.example" })).rejects.toThrow(
      "INVALID_KNOWLEDGE_API_URL",
    );
    expect(events).toEqual([]);
  });
});
