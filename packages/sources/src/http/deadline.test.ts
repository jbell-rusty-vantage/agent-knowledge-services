import { describe, expect, it, vi } from "vitest";
import { InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import { ExactHttpAcquisitionAdapter } from "./adapter.js";

const request = {
  tenantId: "deadline-test",
  purpose: "capture",
  target: { kind: "http" as const, url: "https://example.com/a" },
  expectedSourceClass: "official_docs",
  preferredMediaTypes: ["text/plain"],
  egressProfile: "public-web",
  maximumBytes: 100,
  renderingPolicy: "none" as const,
  interactionPolicy: "none" as const,
  classification: "public" as const,
  expectedOutputs: ["source_native"],
};
const policy = {
  allowedProtocols: ["https:" as const],
  allowedPorts: [443],
  maximumRedirects: 2,
  timeoutMs: 25,
  maximumBytes: 100,
  maximumDecompressionRatio: 10,
};
const resolver = { resolve: async () => ["93.184.216.34"] };

describe("acquisition execution deadline", () => {
  it("cancels a stalled body after headers without storing an artifact", async () => {
    const store = new InMemoryArtifactStore();
    const put = vi.spyOn(store, "put");
    const cancel = vi.fn();
    const adapter = new ExactHttpAcquisitionAdapter(
      store,
      policy,
      resolver,
      async () => new Response(new ReadableStream({ cancel })),
    );
    const plan = await adapter.plan(request);
    await expect(adapter.execute({ ...plan, admissionId: "stalled-body" })).rejects.toThrow("ACQUISITION_TIMEOUT");
    expect(cancel).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it("does not start a network request after execution DNS outlives its deadline", async () => {
    let resolveLate: ((addresses: readonly string[]) => void) | undefined;
    let calls = 0;
    const dns = {
      resolve: async () =>
        ++calls === 1
          ? ["93.184.216.34"]
          : await new Promise<readonly string[]>((resolve) => {
              resolveLate = resolve;
            }),
    };
    const fetcher = vi.fn(async () => new Response("late"));
    const adapter = new ExactHttpAcquisitionAdapter(new InMemoryArtifactStore(), policy, dns, fetcher);
    const plan = await adapter.plan(request);
    await expect(adapter.execute({ ...plan, admissionId: "slow-dns" })).rejects.toThrow("ACQUISITION_TIMEOUT");
    resolveLate!(["93.184.216.34"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels a rejected oversized response before reading its body", async () => {
    const cancel = vi.fn();
    const adapter = new ExactHttpAcquisitionAdapter(
      new InMemoryArtifactStore(),
      policy,
      resolver,
      async () => new Response(new ReadableStream({ cancel }), { headers: { "content-length": "101" } }),
    );
    const plan = await adapter.plan(request);
    await expect(adapter.execute({ ...plan, admissionId: "oversize-body" })).rejects.toThrow("BYTE_LIMIT_EXCEEDED");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
