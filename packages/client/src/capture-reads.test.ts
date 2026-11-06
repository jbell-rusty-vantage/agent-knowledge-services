import { describe, expect, it, vi } from "vitest";
import { KnowledgeClient } from "./client.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = (value: string) => `sha256:${value.repeat(64)}`;
const artifact = (n: number, value: string, mediaType = "application/json") => ({
  artifactId: id(n),
  digest: digest(value),
  mediaType,
  sizeBytes: n,
});
const tenantId = id(1),
  operationId = id(2);

function resource() {
  const sourceArtifact = artifact(4, "a", "text/html");
  return {
    verificationContractVersion: "verification.v1",
    tenantId,
    operationId,
    state: "succeeded",
    disposition: "captured_without_admission",
    requestDigest: digest("b"),
    captureMode: "acquire",
    source: {
      sourceId: id(3),
      kind: "web_page",
      canonicalUri: "https://source.example/report",
      logicalIdentity: "fixture:report",
    },
    capture: {
      captureId: id(9),
      sourceId: id(3),
      capturedAt: "2026-09-07T00:00:00.000Z",
      captureMethod: "https_acquire",
      captureMethodVersion: "verification-source-acquisition.v1",
      contentArtifact: sourceArtifact,
    },
    projections: [
      {
        schemaVersion: "verification-projection-admission.v1",
        captureId: id(9),
        projectionKind: "html_dom",
        projectionOrdinal: 0,
        sourceArtifact,
        nativeOutputArtifact: artifact(5, "c"),
        projectionArtifact: artifact(6, "d"),
        transformationArtifact: artifact(7, "e"),
        parserVersion: "verification-native-parser.v1",
        imageDigest: digest("f"),
        parserOptionsDigest: digest("1"),
        parserTransformationSignature: digest("2"),
        residualsDigest: digest("3"),
      },
    ],
    resultArtifact: artifact(8, "4"),
    acquisitionReceipt: artifact(10, "5", "application/vnd.aiengineer.verification-source-acquisition-receipt+json"),
  };
}

describe("verification capture terminal client read", () => {
  it("validates operation ID, sends an authenticated tenant-scoped GET, and parses the compact resource", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer capture-token");
      expect(headers.get("x-tenant-id")).toBe(tenantId);
      expect(headers.get("x-correlation-id")).toBe("capture-read");
      return new Response(JSON.stringify(resource()), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new KnowledgeClient({
      baseUrl: "https://knowledge.example",
      getAccessToken: () => "capture-token",
      fetch,
    });
    await expect(
      client.getVerificationCaptureResult(operationId, { tenantId, correlationId: "capture-read" }),
    ).resolves.toMatchObject({ captureMode: "acquire", resultArtifact: { artifactId: id(8) } });
    expect(String(fetch.mock.calls[0]![0])).toBe(`https://knowledge.example/v1/verification/captures/${operationId}`);
    expect(() =>
      client.getVerificationCaptureResult("not-a-uuid", { tenantId, correlationId: "capture-read" }),
    ).toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects storage/private fields and malformed compact capture responses", async () => {
    const client = new KnowledgeClient({
      baseUrl: "https://knowledge.example",
      fetch: async () =>
        new Response(
          JSON.stringify({
            ...resource(),
            resultArtifact: { ...resource().resultArtifact, objectKey: "private/capture" },
          }),
          { status: 200 },
        ),
    });
    await expect(
      client.getVerificationCaptureResult(operationId, { tenantId, correlationId: "strict" }),
    ).rejects.toThrow();
  });
});
