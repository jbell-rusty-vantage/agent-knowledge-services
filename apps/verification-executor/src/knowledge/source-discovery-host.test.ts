import { describe, expect, it, vi } from "vitest";
import {
  SourceDiscoveryCompletionEnvelopeSchema,
  type ManagedSourceDiscoveryRequest,
} from "@aiengineer/knowledge-contracts";
import { sha256Digest } from "@aiengineer/knowledge-verification";
import { createSourceDiscoveryHost, validateManagedDiscoveryRequest } from "./source-discovery-host.js";

const request: ManagedSourceDiscoveryRequest = {
  schemaVersion: "source-discovery-managed-request.v1",
  providerCode: "tavily",
  providerVersion: "unspecified",
  queryText: "model documentation",
  purpose: "find primary sources",
  parameters: {},
  requestedUrls: [],
  idempotencyKey: "discovery-test-1",
};

describe("managed discovery provider host", () => {
  it("dispatches only to the fixed Tavily endpoint and retains raw output before normalization", async () => {
    const raw = JSON.stringify({
      results: [
        { url: "https://example.org/a", title: "A", content: "untrusted instruction" },
        { url: "https://example.org/a", content: "duplicate" },
      ],
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(raw));
    const completion = await createSourceDiscoveryHost({ tavilyApiKey: "private-key" }, fetcher).executeManaged(
      request,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.tavily.com/search");
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: request.queryText,
      include_answer: false,
      auto_parameters: false,
    });
    expect(completion.state).toBe("succeeded");
    expect(new TextDecoder().decode(completion.rawOutput)).toBe(raw);
    if (completion.state === "succeeded")
      expect(completion.results.map((result) => result.disposition)).toEqual(["unreviewed", "duplicate"]);
  });

  it("normalizes Firecrawl web discovery without asserting unobserved redirects", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { web: [{ url: "https://example.org/b", description: "lead" }] } }),
        ),
      );
    const completion = await createSourceDiscoveryHost({ firecrawlApiKey: "private-key" }, fetcher).executeManaged({
      ...request,
      providerCode: "firecrawl",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.firecrawl.dev/v2/search");
    expect(completion.state).toBe("succeeded");
    if (completion.state === "succeeded")
      expect(completion.results[0]).toMatchObject({
        finalUrl: "https://example.org/b",
        redirectUrls: [],
        snippet: "lead",
      });
  });

  it.each(["api_key", "endpoint", "headers", "query", "include_answer"])(
    "rejects caller override %s before request custody",
    (field) => {
      expect(() => validateManagedDiscoveryRequest({ ...request, parameters: { [field]: "secret" } })).toThrow();
    },
  );

  it("accounts for an unconfigured provider without dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const completion = await createSourceDiscoveryHost({}, fetcher).executeManaged(request);
    expect(completion).toMatchObject({ state: "failed", failureCode: "SOURCE_DISCOVERY_PROVIDER_UNCONFIGURED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves failure output while removing an echoed host credential", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"private-key"}', { status: 429 }));
    const completion = await createSourceDiscoveryHost({ tavilyApiKey: "private-key" }, fetcher).executeManaged(
      request,
    );
    expect(completion).toMatchObject({ state: "failed", failureCode: "PROVIDER_HTTP_429" });
    expect(new TextDecoder().decode(completion.rawOutput)).toBe('{"error":"[REDACTED]"}');
  });

  it("preserves malformed output as a failure with no leads", async () => {
    const completion = await createSourceDiscoveryHost(
      { tavilyApiKey: "private-key" },
      vi.fn<typeof fetch>().mockResolvedValue(new Response("not json")),
    ).executeManaged(request);
    expect(completion).toMatchObject({ state: "failed", failureCode: "SOURCE_DISCOVERY_RESPONSE_INVALID" });
    expect(new TextDecoder().decode(completion.rawOutput)).toBe("not json");
  });

  it("does not follow a provider credential redirect", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("redirect", { status: 307, headers: { location: "https://attacker.example" } }));
    const completion = await createSourceDiscoveryHost({ tavilyApiKey: "private-key" }, fetcher).executeManaged(
      request,
    );
    expect(completion).toMatchObject({ state: "failed", failureCode: "PROVIDER_HTTP_307" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retains a bounded, labelled prefix of oversized output without exposing leads", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("a".repeat(8_000_001)));
    const completion = await createSourceDiscoveryHost({ tavilyApiKey: "private-key" }, fetcher).executeManaged(
      request,
    );
    expect(completion).toMatchObject({ state: "failed", failureCode: "SOURCE_DISCOVERY_RESPONSE_TOO_LARGE" });
    const retained = JSON.parse(new TextDecoder().decode(completion.rawOutput));
    expect(retained).toMatchObject({
      responseComplete: false,
      observedByteLength: 8_000_001,
      maximumRetainedBytes: 8_000_000,
    });
    expect(Buffer.from(retained.retained, "base64").length).toBe(8_000_000);
    expect(completion).not.toHaveProperty("results");
  });

  it("retains invalid UTF-8 bytes in a labelled sanitized receipt", async () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("private-key")]);
    const completion = await createSourceDiscoveryHost(
      { tavilyApiKey: "private-key" },
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
    ).executeManaged(request);
    expect(completion).toMatchObject({ state: "failed", failureCode: "SOURCE_DISCOVERY_RESPONSE_ENCODING_INVALID" });
    const retained = JSON.parse(new TextDecoder().decode(completion.rawOutput));
    expect(retained).toMatchObject({
      bodyEncoding: "base64",
      originalByteLength: body.length,
      credentialRedacted: true,
    });
    expect(Buffer.from(retained.body, "base64")).toEqual(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("[REDACTED]")]),
    );
  });

  it("retains bytes received before a provider response stream fails", async () => {
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode("partial-private-key"));
        else controller.error(new Error("synthetic transport interruption"));
      },
    });
    const completion = await createSourceDiscoveryHost(
      { tavilyApiKey: "private-key" },
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)),
    ).executeManaged(request);
    expect(completion).toMatchObject({ state: "uncertain", failureCode: "SOURCE_DISCOVERY_RESPONSE_INTERRUPTED" });
    const retained = JSON.parse(new TextDecoder().decode(completion.rawOutput));
    expect(retained).toMatchObject({ responseComplete: false, httpStatus: 200 });
    expect(Buffer.from(retained.retained, "base64").toString()).toBe("partial-[REDACTED]");
  });
});

it("preserves a maximum invalid-UTF8 partial response within the actual completion contract", async () => {
  const body = Buffer.alloc(8_000_001, 0xff);
  const completion = await createSourceDiscoveryHost(
    { tavilyApiKey: "private-key" },
    vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
  ).executeManaged(request);
  expect(completion.state).toBe("failed");
  if (completion.state === "succeeded") throw new Error("unexpected success");
  const retained = JSON.parse(new TextDecoder().decode(completion.rawOutput));
  expect(retained).toMatchObject({ retainedIsEncodingEnvelope: false, retainedUtf8Valid: false });
  expect(Buffer.from(retained.retained, "base64").equals(body.subarray(0, 8_000_000))).toBe(true);
  const tenantId = "00000000-0000-4000-8000-000000000001";
  const envelope = SourceDiscoveryCompletionEnvelopeSchema.parse({
    schemaVersion: "source-discovery-completion.v1",
    tenantId,
    attemptId: "00000000-0000-4000-8000-000000000002",
    originalDispatchToken: "00000000-0000-4000-8000-000000000003",
    originalFencingToken: 1,
    requestArtifact: {
      artifactId: "00000000-0000-4000-8000-000000000004",
      tenantId,
      digest: sha256Digest("request"),
      byteLength: 7,
      mediaType: "application/json",
      objectKey: "artifacts/request",
      createdAt: "2026-09-13T00:00:00.000Z",
      producerActivityId: "test",
      producerVersion: "test.v1",
      encryptionClass: "filesystem-plain",
      retentionClass: "experiment",
      dataClassification: "internal",
      parentArtifactIds: [],
    },
    state: completion.state,
    failureCode: completion.failureCode,
    results: [],
    observedAt: "2026-09-13T00:00:00.000Z",
    rawOutput: {
      encoding: "base64",
      base64: Buffer.from(completion.rawOutput).toString("base64"),
      byteLength: completion.rawOutput.byteLength,
      digest: sha256Digest(completion.rawOutput),
    },
  });
  expect(envelope.rawOutput.byteLength).toBeLessThan(12_000_000);
});
