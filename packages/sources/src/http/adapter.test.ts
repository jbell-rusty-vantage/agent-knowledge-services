import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import {
  ExactHttpAcquisitionAdapter,
  assertSafeHttpUrl,
  buildPinnedRequestOptions,
  isForbiddenAddress,
} from "./index.js"; // the http folder barrel: adapter, policy, and transport together
const policy = {
  allowedProtocols: ["https:"] as const,
  allowedPorts: [443],
  maximumRedirects: 2,
  timeoutMs: 1000,
  maximumBytes: 100,
  maximumDecompressionRatio: 10,
};
const resolver = { resolve: async () => ["93.184.216.34"] };
const request = {
  tenantId: "tenant",
  purpose: "capture",
  target: { kind: "http", url: "https://example.com/a" } as const,
  expectedSourceClass: "official_docs",
  preferredMediaTypes: ["text/plain"],
  egressProfile: "public-web",
  maximumBytes: 100,
  renderingPolicy: "none" as const,
  interactionPolicy: "none" as const,
  classification: "public" as const,
  expectedOutputs: ["source_native"],
};
describe("exact HTTP acquisition", () => {
  it("blocks private, metadata, loopback and special-use addresses", async () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "240.0.0.1",
      "::1",
      "fd00::1",
      "fec0::1",
      "::ffff:7f00:1",
      "2001:db8::1",
      "2002:7f00:1::",
    ])
      expect(isForbiddenAddress(address)).toBe(true);
    await expect(assertSafeHttpUrl("https://localhost/a", policy, resolver)).rejects.toThrow("HOST_DENIED");
    await expect(assertSafeHttpUrl("https://[::ffff:7f00:1]/a", policy, resolver)).rejects.toThrow("ADDRESS_DENIED");
  });
  it("revalidates redirects and hashes exact bytes", async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: "/final" } })
        : new Response("captured", {
            status: 200,
            headers: {
              "content-type": "text/plain",
              "set-cookie": "secret",
              "x-api-key": "also-secret",
            },
          });
    };
    const adapter = new ExactHttpAcquisitionAdapter(new InMemoryArtifactStore(), policy, resolver, fetcher);
    const plan = await adapter.plan(request);
    const result = await adapter.execute({
      ...plan,
      admissionId: "admitted-http-v1",
    });
    expect(calls).toEqual(["https://example.com/a", "https://example.com/final"]);
    expect(result.artifacts[0]?.byteLength).toBe(8);
    expect(result.observations.find((item) => item.key === "headers")?.value).not.toContain("secret");
    expect((await adapter.verify(result)).accepted).toBe(true);
  });
  it("enforces byte limits", async () => {
    const adapter = new ExactHttpAcquisitionAdapter(
      new InMemoryArtifactStore(),
      policy,
      resolver,
      async () => new Response("x".repeat(101)),
    );
    const plan = await adapter.plan(request);
    await expect(adapter.execute({ ...plan, admissionId: "admitted-http-v1" })).rejects.toThrow("BYTE_LIMIT_EXCEEDED");
  });
  it("enforces decompression ratio limits", async () => {
    const adapter = new ExactHttpAcquisitionAdapter(
      new InMemoryArtifactStore(),
      policy,
      resolver,
      async () =>
        new Response("x".repeat(50), {
          headers: { "content-encoding": "gzip", "content-length": "1" },
        }),
    );
    const plan = await adapter.plan(request);
    await expect(adapter.execute({ ...plan, admissionId: "admitted-http-v1" })).rejects.toThrow(
      "DECOMPRESSION_RATIO_EXCEEDED",
    );
  });
  it("fails closed when an encoded response has no compressed length", async () => {
    const adapter = new ExactHttpAcquisitionAdapter(
      new InMemoryArtifactStore(),
      policy,
      resolver,
      async () => new Response("encoded", { headers: { "content-encoding": "gzip" } }),
    );
    const plan = await adapter.plan(request);
    await expect(adapter.execute({ ...plan, admissionId: "admitted-http-v1" })).rejects.toThrow(
      "ENCODED_LENGTH_REQUIRED",
    );
  });
  it("re-resolves redirects and blocks a private destination before fetching it", async () => {
    const calls: string[] = [];
    const redirectResolver = {
      resolve: async (host: string) => (host === "internal.example" ? ["10.0.0.4"] : ["93.184.216.34"]),
    };
    const adapter = new ExactHttpAcquisitionAdapter(
      new InMemoryArtifactStore(),
      policy,
      redirectResolver,
      async (url) => {
        calls.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "https://internal.example/private" },
        });
      },
    );
    const plan = await adapter.plan(request);
    await expect(adapter.execute({ ...plan, admissionId: "redirect-private" })).rejects.toThrow("ADDRESS_DENIED");
    expect(calls).toEqual(["https://example.com/a"]);
  });
  it("passes the validated address to the socket transport without a second DNS lookup", async () => {
    let resolutions = 0;
    const rebindingResolver = {
      resolve: async () => (++resolutions <= 2 ? ["93.184.216.34"] : ["127.0.0.1"]),
    };
    const pins: string[][] = [];
    const transport = {
      fetch: async (_url: URL, _init: RequestInit, addresses: readonly string[]) => {
        pins.push([...addresses]);
        return new Response("pinned", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    };
    const adapter = new ExactHttpAcquisitionAdapter(
      new InMemoryArtifactStore(),
      policy,
      rebindingResolver,
      undefined,
      transport,
    );
    const plan = await adapter.plan(request);
    const result = await adapter.execute({ ...plan, admissionId: "dns-pin" });
    expect(result.artifacts[0]?.byteLength).toBe(6);
    expect(resolutions).toBe(2);
    expect(pins).toEqual([["93.184.216.34"]]);
  });
  it("pins IPv4 and IPv6 sockets while preserving HTTPS Host, SNI, and certificate verification", () => {
    for (const address of ["93.184.216.34", "2606:4700:4700::1111"]) {
      const options = buildPinnedRequestOptions(
        new URL("https://example.com:443/path?q=1"),
        { headers: { accept: "text/plain" } },
        address,
      );
      expect(options.hostname).toBe(address);
      expect(options.family).toBe(address.includes(":") ? 6 : 4);
      expect(options.servername).toBe("example.com");
      expect(options.rejectUnauthorized).toBe(true);
      expect(options.headers).toMatchObject({
        host: "example.com",
        accept: "text/plain",
      });
      expect(options.path).toBe("/path?q=1");
    }
  });
  it("rejects forbidden addresses at the transport boundary as defense in depth", () => {
    expect(() => buildPinnedRequestOptions(new URL("https://example.com"), {}, "127.0.0.1")).toThrow(
      "PINNED_ADDRESS_INVALID",
    );
    expect(() => buildPinnedRequestOptions(new URL("https://example.com"), {}, "::1")).toThrow(
      "PINNED_ADDRESS_INVALID",
    );
  });
});
