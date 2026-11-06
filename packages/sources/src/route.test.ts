import { describe, expect, it } from "vitest";
import { InMemoryArtifactStore } from "@aiengineer/knowledge-core";
import { ExactHttpAcquisitionAdapter } from "./http/index.js";
import { RoutedAcquisitionAdapter } from "./route.js";
import { BoundedManualUploadAdapter } from "./upload/index.js";
import type { AcquisitionRequest } from "./types.js";

const policy = {
  allowedProtocols: ["https:"] as const,
  allowedPorts: [443],
  maximumRedirects: 1,
  timeoutMs: 1000,
  maximumBytes: 100,
  maximumDecompressionRatio: 10,
};
const request = (target: AcquisitionRequest["target"]): AcquisitionRequest => ({
  tenantId: "tenant",
  purpose: "capture",
  target,
  expectedSourceClass: "official_docs",
  preferredMediaTypes: ["text/plain"],
  egressProfile: "public-web",
  maximumBytes: 100,
  renderingPolicy: "none",
  interactionPolicy: "none",
  classification: "public",
  expectedOutputs: ["source_native"],
});

describe("RoutedAcquisitionAdapter", () => {
  const store = new InMemoryArtifactStore();
  const http = new ExactHttpAcquisitionAdapter(
    store,
    policy,
    { resolve: async () => ["93.184.216.34"] },
    async () => new Response("captured", { headers: { "content-type": "text/plain" } }),
  );
  const upload = new BoundedManualUploadAdapter(
    store,
    {
      get: async () => ({
        uploadId: "notes",
        relativePath: "notes.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("local"),
        attestation: {
          uploadId: "notes",
          origin: "operator",
          method: "local file",
          acquiredAt: "2026-09-16T00:00:00Z",
          accessAndRightsContext: "operator supplied",
          automaticFailureReason: "",
        },
      }),
    },
    { maximumBytes: 100, maximumPathLength: 80 },
  );
  const router = new RoutedAcquisitionAdapter([http, upload]);

  it("routes HTTP and upload targets to the matching adapter", async () => {
    expect(router.supports(request({ kind: "http", url: "https://example.com/a" })).supported).toBe(true);
    expect(router.supports(request({ kind: "upload", uploadId: "notes", declaredOrigin: "operator" })).supported).toBe(
      true,
    );
    const httpPlan = await router.plan(request({ kind: "http", url: "https://example.com/a" }));
    const httpResult = await router.execute({ ...httpPlan, admissionId: "http" });
    expect(httpResult.artifacts).toHaveLength(1);
    expect((await router.verify(httpResult)).accepted).toBe(true);
    const uploadPlan = await router.plan(request({ kind: "upload", uploadId: "notes", declaredOrigin: "operator" }));
    const uploadResult = await router.execute({ ...uploadPlan, admissionId: "upload" });
    expect(uploadResult.artifacts).toHaveLength(1);
    expect((await router.verify(uploadResult)).accepted).toBe(true);
  });

  it("fails closed for unsupported targets", () => {
    expect(
      router.supports(
        request({
          kind: "paper",
          identifierKind: "doi",
          identifier: "10.1234/abc",
        }),
      ).supported,
    ).toBe(false);
  });
});
