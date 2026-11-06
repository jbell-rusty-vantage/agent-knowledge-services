import { describe, expect, it, vi } from "vitest";
import { KnowledgeIntegrationService, VerificationServiceCatalog } from "@aiengineer/knowledge-application";
import type { LocalApiIdentity } from "@aiengineer/knowledge-host";
import { buildServer } from "../server.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1),
  operationId = id(2),
  attemptId = id(3),
  missionId = id(4),
  workItemId = id(5),
  actor = {
    kind: "service" as const,
    id: id(6),
    serviceIdentity: "mission_control_client" as const,
  },
  token = "benchmark-profile-route-token";
const identity: LocalApiIdentity = {
  actor,
  grants: [{ tenantId, roles: ["knowledge_operator"], scopes: [] }],
};
const request = {
  verificationContractVersion: "verification.v1",
  source: {
    mode: "acquire" as const,
    sourceKind: "web_page" as const,
    sourceUri: "https://source.example/approved",
  },
  requestedProjectionKinds: ["html_dom" as const],
};
const headers = {
  authorization: `Bearer ${token}`,
  "x-correlation-id": "profile-route-correlation",
  "idempotency-key": "profile-route-key",
};
const profileContext = ({ correlationId, idempotencyKey }: { correlationId: string; idempotencyKey: string }) => ({
  tenantId,
  operationId,
  attemptId,
  missionId,
  workItemId,
  correlationId,
  idempotencyKey,
  actor,
  capabilityVersion: "verification-service.v1",
  reason: "authenticated captureSource request",
  contractVersion: "v1" as const,
});
const catalog = (granted = true) =>
  new VerificationServiceCatalog({
    captureGrants: [],
    acquisitionGrants: granted
      ? [
          {
            tenantId,
            sourceKey: "approved",
            source: {
              sourceId: id(7),
              kind: "web_page",
              canonicalUri: request.source.sourceUri,
              logicalIdentity: "fixture:approved",
            },
          },
        ]
      : [],
    extractionProfileArtifacts: [],
  });
function options(
  operations: KnowledgeIntegrationService,
  resolver: any = vi.fn(async (input: any) => profileContext(input)),
) {
  return {
    verificationOperationService: operations,
    verificationCaptureCatalog: catalog(),
    resolveIdentity: (value: string) => (value === token ? identity : undefined),
    resolveVerificationBenchmarkCaptureProfile: resolver,
  };
}
const url = "/v1/verification/benchmark-capture-profiles/diagnostics-companies/captures";
describe("benchmark capture profile HTTP route", () => {
  it("submits acquired source under server-owned profile", async () => {
    const operations = new KnowledgeIntegrationService(),
      resolver = vi.fn(async (input: any) => profileContext(input)),
      api = buildServer(options(operations, resolver));
    try {
      const response = await api.inject({
        method: "POST",
        url,
        headers,
        payload: request,
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({
        tenantId,
        operation: { operationId, state: "queued" },
      });
      expect(resolver).toHaveBeenCalledWith({
        profileName: "diagnostics-companies",
        identity,
        correlationId: "profile-route-correlation",
        idempotencyKey: "profile-route-key",
      });
      expect(operations.get(operationId, tenantId)).toMatchObject({
        kind: "verification_capture",
        context: { tenantId, actor, attemptId, missionId, workItemId },
      });
    } finally {
      await api.close();
    }
  });
  it("requires auth and rejects caller routing before resolver", async () => {
    const operations = new KnowledgeIntegrationService(),
      resolver = vi.fn(async (input: any) => profileContext(input)),
      api = buildServer(options(operations, resolver));
    try {
      expect(
        (
          await api.inject({
            method: "POST",
            url,
            headers: {
              "x-correlation-id": "profile-route-correlation",
              "idempotency-key": "profile-route-key",
            },
            payload: request,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await api.inject({
            method: "POST",
            url,
            headers: {
              ...headers,
              "x-tenant-id": tenantId,
              "x-verification-attempt-id": attemptId,
            },
            payload: request,
          })
        ).statusCode,
      ).toBe(400);
      expect(resolver).not.toHaveBeenCalled();
      expect(operations.get(operationId, tenantId)).toBeUndefined();
    } finally {
      await api.close();
    }
  });
  it("does not disclose unknown profile or ownership failures", async () => {
    const operations = new KnowledgeIntegrationService(),
      api = buildServer(
        options(
          operations,
          vi.fn(async () => undefined),
        ),
      );
    try {
      const response = await api.inject({
        method: "POST",
        url,
        headers,
        payload: request,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "NOT_FOUND" });
      expect(operations.get(operationId, tenantId)).toBeUndefined();
    } finally {
      await api.close();
    }
  });
  it("denies ungranted source and unavailable route before enqueue", async () => {
    const operations = new KnowledgeIntegrationService(),
      resolver = vi.fn(async (input: any) => profileContext(input)),
      denied = buildServer({
        ...options(operations, resolver),
        verificationCaptureCatalog: catalog(false),
      });
    try {
      expect(
        (
          await denied.inject({
            method: "POST",
            url,
            headers,
            payload: request,
          })
        ).statusCode,
      ).toBe(403);
      expect(operations.get(operationId, tenantId)).toBeUndefined();
    } finally {
      await denied.close();
    }
    const unavailable = buildServer({
      resolveIdentity: (value: string) => (value === token ? identity : undefined),
    });
    try {
      expect(
        (
          await unavailable.inject({
            method: "POST",
            url,
            headers,
            payload: request,
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await unavailable.close();
    }
  });
});
