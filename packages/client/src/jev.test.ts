import { describe, expect, it, vi } from "vitest";
import { KnowledgeJevClient } from "./jev.js";

const job = {
  id: "test-job",
  status: "succeeded",
  attempts: 1,
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:01Z",
  requestDigest: "digest",
  provenance: { type: "inline", source: "inline", sha256: "digest", bytes: 4, capturedAt: "2026-09-26T00:00:00Z" },
};

describe("KnowledgeJevClient", () => {
  it("uses service auth and the public task contract", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json(job, { status: 202 }));
    const client = new KnowledgeJevClient({
      baseUrl: "https://jev.example",
      getAccessToken: () => "test-token",
      fetch: transport,
    });
    const result = await client.submit({
      input: { type: "inline", state: "sample" },
      questions: { valid: { type: "noul", instructions: "Is this a sample?" } },
    });
    expect(result.id).toBe("test-job");
    expect(transport).toHaveBeenCalledWith(
      "https://jev.example/v1/jev/jobs",
      expect.objectContaining({
        headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        redirect: "error",
      }),
    );
  });

  it("rejects malformed success responses and does not leak server failure bodies", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ status: "succeeded" }));
    const client = new KnowledgeJevClient({ baseUrl: "https://jev.example", fetch: transport });
    await expect(client.get("job")).rejects.toThrow();
    transport.mockResolvedValueOnce(new Response("private provider details", { status: 502 }));
    await expect(client.get("job")).rejects.toThrow("Jev service returned HTTP 502");
    transport.mockResolvedValueOnce(new Response("private invalid JSON fragment"));
    await expect(client.get("job")).rejects.toThrow("Jev service returned an invalid response");
  });

  it("stops polling at a terminal job and rejects unsafe URL credentials", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json(job));
    const client = new KnowledgeJevClient({ baseUrl: "https://jev.example", fetch: transport });
    expect((await client.wait("test-job")).status).toBe("succeeded");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(() => new KnowledgeJevClient({ baseUrl: "https://secret:password@example.com" })).toThrow();
  });

  it("interrupts an in-flight poll when the caller aborts", async () => {
    const controller = new AbortController();
    const transport = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          controller.abort(new Error("caller cancelled"));
        }),
    );
    const client = new KnowledgeJevClient({ baseUrl: "https://jev.example", fetch: transport });
    await expect(client.wait("job", { signal: controller.signal })).rejects.toThrow("caller cancelled");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("applies the wait deadline to an in-flight poll", async () => {
    const transport = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    const client = new KnowledgeJevClient({ baseUrl: "https://jev.example", fetch: transport });
    await expect(client.wait("job", { timeoutMs: 10 })).rejects.toThrow("Jev wait timed out");
    await expect(client.wait("job", { timeoutMs: -1 })).rejects.toThrow();
  });
});
