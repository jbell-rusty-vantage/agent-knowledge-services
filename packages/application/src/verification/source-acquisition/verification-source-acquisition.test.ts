import { describe, expect, it, vi } from "vitest";
import type { DnsResolver, PinnedHttpTransport } from "@aiengineer/knowledge-acquisition";
import {
  TrustedVerificationSourceAcquirer,
  VerificationSourceAcquisitionCatalog,
} from "./verification-source-acquisition.js";

const resolver: DnsResolver = { resolve: async () => ["93.184.216.34"] };
const grant = {
  sourceKey: "public-report",
  sourceUri: "https://source.example/report",
  redirectUris: ["https://cdn.example/report.html"],
  acceptedMediaTypes: ["text/html"],
  maximumBytes: 64,
  timeoutMs: 1_000,
} as const;

function acquirer(responses: readonly Response[], calls: URL[] = []): TrustedVerificationSourceAcquirer {
  let index = 0;
  const transport: PinnedHttpTransport = {
    fetch: async (url) => {
      calls.push(url);
      const response = responses[index++];
      if (!response) throw new Error("unexpected fetch");
      return response;
    },
  };
  return new TrustedVerificationSourceAcquirer(
    new VerificationSourceAcquisitionCatalog([grant]),
    resolver,
    () => "2026-09-07T12:00:00.000Z",
    transport,
  );
}

describe("TrustedVerificationSourceAcquirer", () => {
  it("fetches only the catalog URL, follows an exact allowed redirect, and returns bounded raw capture metadata", async () => {
    const calls: URL[] = [];
    const value = await acquirer(
      [
        new Response(null, { status: 302, headers: { location: "https://cdn.example/report.html" } }),
        new Response("<article>source</article>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "content-length": "25", etag: "v1" },
        }),
      ],
      calls,
    ).acquire({ sourceKey: "public-report" });
    expect(calls.map((item) => item.href)).toEqual([
      "https://source.example/report",
      "https://cdn.example/report.html",
    ]);
    expect(new TextDecoder().decode(value.bytes)).toBe("<article>source</article>");
    expect(value).toMatchObject({
      sourceKey: "public-report",
      finalUri: "https://cdn.example/report.html",
      redirectUris: ["https://cdn.example/report.html"],
      mediaType: "text/html",
      responseMetadata: { contentLength: 25, etag: "v1" },
    });
  });

  it("denies unknown keys, redirects outside the exact catalog, unsafe DNS targets, unsupported content, and excess bytes", async () => {
    await expect(acquirer([]).acquire({ sourceKey: "caller-url-is-not-a-key" })).rejects.toThrow(
      "SOURCE_ACQUISITION_NOT_ADMITTED",
    );
    await expect(
      acquirer([new Response(null, { status: 302, headers: { location: "https://evil.example/" } })]).acquire({
        sourceKey: "public-report",
      }),
    ).rejects.toThrow("SOURCE_ACQUISITION_REDIRECT_NOT_ADMITTED");
    const unsafe = new TrustedVerificationSourceAcquirer(
      new VerificationSourceAcquisitionCatalog([grant]),
      { resolve: async () => ["127.0.0.1"] },
      () => "2026-09-07T12:00:00.000Z",
      { fetch: vi.fn() },
    );
    await expect(unsafe.acquire({ sourceKey: "public-report" })).rejects.toThrow("ADDRESS_DENIED");
    await expect(
      acquirer([new Response("plain", { status: 200, headers: { "content-type": "text/plain" } })]).acquire({
        sourceKey: "public-report",
      }),
    ).rejects.toThrow("SOURCE_ACQUISITION_MEDIA_TYPE_DENIED");
    await expect(
      acquirer([new Response("x".repeat(65), { status: 200, headers: { "content-type": "text/html" } })]).acquire({
        sourceKey: "public-report",
      }),
    ).rejects.toThrow("SOURCE_ACQUISITION_BYTE_LIMIT_EXCEEDED");
  });

  it("rejects caller-supplied authentication, form, or terms controls before catalog lookup or networking", async () => {
    const fetch = vi.fn();
    const value = new TrustedVerificationSourceAcquirer(
      new VerificationSourceAcquisitionCatalog([grant]),
      resolver,
      () => "2026-09-07T12:00:00.000Z",
      { fetch },
    );
    for (const attemptedBypass of [
      { authenticationReference: "secret://caller-token" },
      { headers: { authorization: "Bearer caller-token" } },
      { form: { email: "person@example.test" } },
      { acceptedTerms: true },
      { method: "POST" },
    ]) {
      await expect(
        value.acquire({ sourceKey: "public-report", ...attemptedBypass } as unknown as { sourceKey: string }),
      ).rejects.toThrow("SOURCE_ACQUISITION_REQUEST_INVALID");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors caller cancellation before networking", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const fetch = vi.fn();
    const value = new TrustedVerificationSourceAcquirer(
      new VerificationSourceAcquisitionCatalog([grant]),
      resolver,
      () => "2026-09-07T12:00:00.000Z",
      { fetch },
    );
    await expect(value.acquire({ sourceKey: "public-report", signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces the server timeout and rejects encoded responses without attempting decompression", async () => {
    const fastGrant = { ...grant, timeoutMs: 100 };
    const timeout = new TrustedVerificationSourceAcquirer(
      new VerificationSourceAcquisitionCatalog([fastGrant]),
      resolver,
      () => "2026-09-07T12:00:00.000Z",
      {
        fetch: async (_url, init) =>
          await new Promise<Response>((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
          ),
      },
    );
    await expect(timeout.acquire({ sourceKey: "public-report" })).rejects.toThrow();
    await expect(
      acquirer([
        new Response("compressed", {
          status: 200,
          headers: { "content-type": "text/html", "content-encoding": "gzip", "content-length": "10" },
        }),
      ]).acquire({ sourceKey: "public-report" }),
    ).rejects.toThrow("SOURCE_ACQUISITION_CONTENT_ENCODING_DENIED");
  });
});
