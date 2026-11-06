import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import { FirecrawlAcquisitionAdapter } from "./adapter.js";
import type { AcquisitionRequest } from "../types.js";

const resolver = { resolve: async () => ["93.184.216.34"] };
const targetPolicy = {
  allowedProtocols: ["https:"] as const,
  allowedPorts: [443],
  maximumRedirects: 2,
  timeoutMs: 1000,
  maximumBytes: 10_000,
  maximumDecompressionRatio: 10,
};
function request(target: AcquisitionRequest["target"], maximumBytes = 10_000): AcquisitionRequest {
  return {
    tenantId: "tenant-1",
    purpose: "test",
    target,
    expectedSourceClass: "official",
    preferredMediaTypes: ["text/markdown"],
    egressProfile: "public-web",
    maximumBytes,
    renderingPolicy: "allowed",
    interactionPolicy: "none",
    classification: "public",
    expectedOutputs: ["source_native"],
  };
}

describe("FirecrawlAcquisitionAdapter", () => {
  const config = {
    endpoint: "https://api.firecrawl.dev/v2/scrape",
    authenticationReference: "secret://firecrawl",
    apiVersion: "v2",
    timeoutMs: 1000,
    maximumResponseBytes: 1_000,
    maximumDecompressionRatio: 2,
    allowedApiHosts: ["api.firecrawl.dev"],
    targetPolicy,
  };
  it("uses referenced auth, redacts it, and replays idempotently", async () => {
    const store = new InMemoryArtifactStore();
    const secret = "fc-secret-value";
    let observed: RequestInit | undefined;
    const adapter = new FirecrawlAcquisitionAdapter(
      store,
      config,
      { resolve: async () => secret },
      resolver,
      async (_url, init) => {
        observed = init;
        return Response.json({
          success: true,
          id: "job-1",
          creditsUsed: 2,
          data: { markdown: "# Page", metadata: { authorization: secret, nested: secret } },
        });
      },
    );
    const plan = await adapter.plan({
      ...request({ kind: "http", url: "https://example.com/docs" }),
      authenticationReference: "secret://firecrawl",
    });
    const admitted = { ...plan, admissionId: "fc-1" };
    const first = await adapter.execute(admitted);
    const second = await adapter.execute(admitted);
    expect(new Headers(observed?.headers).get("authorization")).toBe(`Bearer ${secret}`);
    expect(observed?.redirect).toBe("manual");
    expect(first.artifacts.map((x) => x.artifactId)).toEqual(second.artifacts.map((x) => x.artifactId));
    expect(first.observations).toContainEqual({ key: "provider_job_id", value: "job-1" });
    const native = await store.get("tenant-1", first.artifacts[0]!.digest);
    expect(new TextDecoder().decode(native)).not.toContain(secret);
    expect((await adapter.verify(first)).accepted).toBe(true);
  });
  it("rejects SSRF targets, provider redirects, size excess, and decompression bombs", async () => {
    const make = (response: Response) =>
      new FirecrawlAcquisitionAdapter(
        new InMemoryArtifactStore(),
        { ...config, maximumResponseBytes: 50 },
        { resolve: async () => "secret" },
        resolver,
        async () => response,
      );
    await expect(make(Response.json({})).plan(request({ kind: "http", url: "https://127.0.0.1/x" }))).rejects.toThrow(
      "ADDRESS_DENIED",
    );
    const execute = async (response: Response, id: string) => {
      const adapter = make(response);
      const plan = await adapter.plan(request({ kind: "http", url: "https://example.com" }));
      return adapter.execute({ ...plan, admissionId: id });
    };
    await expect(
      execute(new Response(null, { status: 307, headers: { location: "https://evil.example" } }), "r"),
    ).rejects.toThrow("PROVIDER_REDIRECT_DENIED");
    await expect(execute(new Response("x".repeat(51)), "s")).rejects.toThrow("BYTE_LIMIT_EXCEEDED");
    await expect(
      execute(new Response("x".repeat(30), { headers: { "content-encoding": "gzip", "content-length": "10" } }), "z"),
    ).rejects.toThrow("DECOMPRESSION_RATIO_EXCEEDED");
  });
});
