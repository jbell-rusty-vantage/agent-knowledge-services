import { describe, expect, it } from "vitest";
import { KnowledgeIntegrationService, VerificationServiceCatalog } from "@aiengineer/knowledge-application";
import type { LocalApiIdentity } from "@aiengineer/knowledge-host/config";
import { buildServer } from "../server.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenant = id(1),
  foreignTenant = id(9),
  operationId = id(10);
const actor = {
  kind: "service" as const,
  id: id(2),
  serviceIdentity: "mission_control_client" as const,
};
const token = "verification-acquisition-route-token";
const identity: LocalApiIdentity = {
  actor,
  grants: [{ tenantId: tenant, roles: ["knowledge_operator"], scopes: [] }],
};
const headers = {
  authorization: `Bearer ${token}`,
  "x-tenant-id": tenant,
  "x-correlation-id": "acquisition-route",
  "idempotency-key": "acquisition-route-001",
};
const source = {
  sourceId: id(3),
  kind: "web_page" as const,
  canonicalUri: "https://source.example/approved-report",
  logicalIdentity: "fixture:approved-report",
};
const acquire = (sourceUri = source.canonicalUri) => ({
  verificationContractVersion: "verification.v1",
  source: { mode: "acquire", sourceKind: "web_page", sourceUri },
  requestedProjectionKinds: ["html_dom"],
});
const register = {
  verificationContractVersion: "verification.v1",
  source: {
    mode: "register",
    sourceKind: "web_page",
    sourceId: id(4),
    contentArtifact: { artifactId: id(5), digest: `sha256:${"a".repeat(64)}` },
  },
  requestedProjectionKinds: ["html_dom"],
};

function options(
  operations: KnowledgeIntegrationService,
  tenantId = tenant,
  currentIdentity: LocalApiIdentity = identity,
) {
  return {
    verificationOperationService: operations,
    resolveIdentity: (candidate: string) => (candidate === token ? currentIdentity : undefined),
    resolveVerificationContext: ({ identity, correlationId, idempotencyKey }: any) => ({
      tenantId,
      operationId,
      attemptId: id(11),
      correlationId,
      actor: identity.actor,
      capabilityVersion: "verification-service.v1",
      idempotencyKey,
      reason: "capture acquire route test",
      contractVersion: "v1" as const,
    }),
  };
}

const catalog = () =>
  new VerificationServiceCatalog({
    captureGrants: [],
    acquisitionGrants: [{ tenantId: tenant, sourceKey: "approved-report", source }],
    extractionProfileArtifacts: [],
  });

describe("verification capture acquisition HTTP route", () => {
  it("keeps acquisition unavailable without the explicitly configured catalog", async () => {
    const operations = new KnowledgeIntegrationService(),
      api = buildServer(options(operations));
    try {
      const response = await api.inject({
        method: "POST",
        url: "/v1/verification/captures",
        headers,
        payload: acquire(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_NOT_ADMITTED",
      });
      expect(operations.get(operationId, tenant)).toBeUndefined();
    } finally {
      await api.close();
    }
  });

  it("rejects ungranted URI and tenant before durable submission", async () => {
    const unknownOperations = new KnowledgeIntegrationService(),
      unknownApi = buildServer({
        ...options(unknownOperations),
        verificationCaptureCatalog: catalog(),
      });
    try {
      const response = await unknownApi.inject({
        method: "POST",
        url: "/v1/verification/captures",
        headers,
        payload: acquire("https://source.example/unapproved"),
      });
      expect(response.statusCode).toBe(403);
      expect(unknownOperations.get(operationId, tenant)).toBeUndefined();
    } finally {
      await unknownApi.close();
    }

    const foreignOperations = new KnowledgeIntegrationService(),
      foreignApi = buildServer({
        ...options(foreignOperations, foreignTenant),
        verificationCaptureCatalog: catalog(),
      });
    try {
      const foreignIdentity: LocalApiIdentity = {
        actor,
        grants: [
          {
            tenantId: foreignTenant,
            roles: ["knowledge_operator"],
            scopes: [],
          },
        ],
      };
      const response = await foreignApi.inject({
        method: "POST",
        url: "/v1/verification/captures",
        headers: { ...headers, "x-tenant-id": foreignTenant },
        payload: acquire(),
      });
      // The trusted context is intentionally foreign; the catalog has no matching tenant grant.
      expect(response.statusCode).toBe(403);
      expect(foreignOperations.get(operationId, foreignTenant)).toBeUndefined();
      void foreignIdentity;
    } finally {
      await foreignApi.close();
    }
  });

  it("submits an exact trusted acquisition grant durably and preserves register-mode compatibility", async () => {
    const operations = new KnowledgeIntegrationService(),
      api = buildServer({
        ...options(operations),
        verificationCaptureCatalog: catalog(),
      });
    try {
      const admitted = await api.inject({
        method: "POST",
        url: "/v1/verification/captures",
        headers,
        payload: acquire(),
      });
      expect(admitted.statusCode, admitted.body).toBe(202);
      expect(admitted.json()).toMatchObject({ operationId, state: "queued" });
      expect(operations.get(operationId, tenant)).toMatchObject({
        kind: "verification_capture",
        context: { actor },
      });
      expect(operations.input(operationId, tenant)).toEqual({
        schemaVersion: "verification-service-request.v1",
        useCase: "captureSource",
        request: acquire(),
      });
    } finally {
      await api.close();
    }

    const registerOperations = new KnowledgeIntegrationService(),
      registerApi = buildServer(options(registerOperations));
    try {
      const response = await registerApi.inject({
        method: "POST",
        url: "/v1/verification/captures",
        headers,
        payload: register,
      });
      expect(response.statusCode, response.body).toBe(202);
      expect(registerOperations.get(operationId, tenant)).toMatchObject({
        kind: "verification_capture",
      });
    } finally {
      await registerApi.close();
    }
  });
});
