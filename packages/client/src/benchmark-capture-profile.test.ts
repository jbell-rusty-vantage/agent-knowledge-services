import { describe, expect, it, vi } from "vitest";
import { KnowledgeClient } from "./client.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1),
  operationId = id(2);
const request: {
  verificationContractVersion: "verification.v1";
  source: { mode: "acquire"; sourceKind: "web_page"; sourceUri: string };
  requestedProjectionKinds: "html_dom"[];
} = {
  verificationContractVersion: "verification.v1",
  source: { mode: "acquire", sourceKind: "web_page", sourceUri: "https://source.example/approved" },
  requestedProjectionKinds: ["html_dom"],
};
const accepted = {
  tenantId,
  operation: {
    operationId,
    state: "queued",
    contractVersion: "v1",
    statusUrl: "https://knowledge.example/status",
    eventStreamUrl: "https://knowledge.example/events",
    cancellationUrl: "https://knowledge.example/cancel",
    retryUrl: "https://knowledge.example/retry",
    reconcileUrl: "https://knowledge.example/reconcile",
  },
};
describe("benchmark capture profile client", () => {
  it("sends no caller ownership headers and parses the strict response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(request);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer profile-token");
      expect(headers.get("x-correlation-id")).toBe("profile-correlation");
      expect(headers.get("idempotency-key")).toBe("profile-idempotency-key");
      for (const name of [
        "x-tenant-id",
        "x-verification-attempt-id",
        "x-verification-work-item-id",
        "x-verification-mission-id",
        "x-causation-id",
      ])
        expect(headers.get(name)).toBeNull();
      return new Response(JSON.stringify(accepted), { status: 202 });
    });
    const client = new KnowledgeClient({
      baseUrl: "https://knowledge.example",
      getAccessToken: () => "profile-token",
      fetch,
    });
    await expect(
      client.captureVerificationSourceWithProfile("diagnostics-companies", request, {
        correlationId: "profile-correlation",
        idempotencyKey: "profile-idempotency-key",
      }),
    ).resolves.toEqual(accepted);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://knowledge.example/v1/verification/benchmark-capture-profiles/diagnostics-companies/captures",
    );
  });
  it("rejects invalid profile before fetch and expanded response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ ...accepted, objectKey: "private" }), { status: 202 }),
    );
    const client = new KnowledgeClient({ baseUrl: "https://knowledge.example", fetch });
    expect(() =>
      client.captureVerificationSourceWithProfile("../forged", request, {
        correlationId: "profile-correlation",
        idempotencyKey: "profile-idempotency-key",
      }),
    ).toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      client.captureVerificationSourceWithProfile("diagnostics-companies", request, {
        correlationId: "profile-correlation",
        idempotencyKey: "profile-idempotency-key",
      }),
    ).rejects.toThrow();
  });
});
