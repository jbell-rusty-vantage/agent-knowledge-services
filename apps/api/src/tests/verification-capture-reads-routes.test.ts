import { describe, expect, it, vi } from "vitest";

import type { VerificationCaptureTerminalResource } from "@aiengineer/knowledge-contracts";

import type { LocalApiIdentity } from "@aiengineer/knowledge-host/config";
import { buildServer } from "../server.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = (value: string) => `sha256:${value.repeat(64)}` as const;
const tenant = id(1),
  foreignTenant = id(2),
  operationId = id(3),
  token = "capture-read-token";
const actor = {
  kind: "service" as const,
  id: id(4),
  serviceIdentity: "mission_control_client" as const,
};
const identity: LocalApiIdentity = {
  actor,
  grants: [{ tenantId: tenant, roles: ["knowledge_reader"], scopes: [] }],
};
const foreignIdentity: LocalApiIdentity = {
  actor,
  grants: [{ tenantId: foreignTenant, roles: ["knowledge_reader"], scopes: [] }],
};
const headers = {
  authorization: `Bearer ${token}`,
  "x-tenant-id": tenant,
  "x-correlation-id": "capture-read",
};

const artifact = (n: number, mediaType = "application/json") => ({
  artifactId: id(n),
  digest: digest(n.toString(16)),
  mediaType,
  sizeBytes: n,
});
const content = artifact(5, "text/html");
const resource: VerificationCaptureTerminalResource = {
  verificationContractVersion: "verification.v1",
  tenantId: tenant,
  operationId,
  state: "succeeded",
  disposition: "captured_without_admission",
  requestDigest: digest("a"),
  source: {
    sourceId: id(6),
    kind: "web_page",
    canonicalUri: "https://source.example/report",
    logicalIdentity: "source:report",
  },
  capture: {
    captureId: id(7),
    sourceId: id(6),
    capturedAt: "2026-09-07T00:00:00.000Z",
    captureMethod: "https_acquire",
    captureMethodVersion: "verification-source-acquisition.v1",
    contentArtifact: content,
  },
  projections: [
    {
      schemaVersion: "verification-projection-admission.v1",
      captureId: id(7),
      projectionKind: "html_dom",
      projectionOrdinal: 0,
      sourceArtifact: content,
      nativeOutputArtifact: artifact(8),
      projectionArtifact: artifact(9),
      transformationArtifact: artifact(10),
      parserVersion: "verification-native-parser.v1",
      imageDigest: digest("b"),
      parserOptionsDigest: digest("c"),
      parserTransformationSignature: digest("d"),
      residualsDigest: digest("e"),
    },
  ],
  resultArtifact: artifact(11),
  captureMode: "acquire",
  acquisitionReceipt: artifact(12),
};

const options = (
  getCapture?: (input: {
    tenantId: string;
    operationId: string;
    actor: typeof actor;
  }) => Promise<VerificationCaptureTerminalResource>,
  currentIdentity: LocalApiIdentity = identity,
) => ({
  resolveIdentity: (candidate: string) => (candidate === token ? currentIdentity : undefined),
  ...(getCapture ? { verificationCaptureReads: { getCapture } } : {}),
});

describe("capture terminal HTTP reads", () => {
  it("authenticates before invoking custody reads and returns a generic cross-tenant not-found", async () => {
    const getCapture = vi.fn(async () => resource);
    const unauthenticated = buildServer(options(getCapture));
    try {
      const response = await unauthenticated.inject({
        method: "GET",
        url: `/v1/verification/captures/${operationId}`,
      });
      expect(response.statusCode).toBe(401);
      expect(getCapture).not.toHaveBeenCalled();
    } finally {
      await unauthenticated.close();
    }

    const missing = vi.fn(async (input: { tenantId: string }) => {
      expect(input.tenantId).toBe(foreignTenant);
      throw Object.assign(new Error("foreign capture"), { code: "NOT_FOUND" });
    });
    const crossTenant = buildServer(options(missing as never, foreignIdentity));
    try {
      const response = await crossTenant.inject({
        method: "GET",
        url: `/v1/verification/captures/${operationId}`,
        headers: { ...headers, "x-tenant-id": foreignTenant },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        code: "NOT_FOUND",
        title: "Capture result not found",
      });
      expect(response.body).not.toContain("foreign capture");
    } finally {
      await crossTenant.close();
    }
  });

  it("maps pending and failed durable states without exposing a terminal resource", async () => {
    for (const [code, status] of [
      ["PENDING", 409],
      ["FAILED", 422],
      ["CANCELLED", 422],
    ] as const) {
      const server = buildServer(
        options(async () => {
          throw Object.assign(new Error(code), { code });
        }),
      );
      try {
        const response = await server.inject({
          method: "GET",
          url: `/v1/verification/captures/${operationId}`,
          headers,
        });
        expect(response.statusCode).toBe(status);
        expect(response.json()).not.toHaveProperty("capture");
      } finally {
        await server.close();
      }
    }
  });

  it("returns the compact validated projection and rejects malformed runtime output", async () => {
    const server = buildServer(options(async () => resource));
    try {
      const response = await server.inject({
        method: "GET",
        url: `/v1/verification/captures/${operationId}`,
        headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual(resource);
      expect(response.body).not.toContain("objectKey");
      expect(response.body).not.toContain("storageHeaders");
      expect(response.body).not.toContain("rawBytes");
    } finally {
      await server.close();
    }

    const malformed = buildServer(options(async () => ({ ...resource, rawBytes: "secret" }) as never));
    try {
      expect(
        (
          await malformed.inject({
            method: "GET",
            url: `/v1/verification/captures/${operationId}`,
            headers,
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await malformed.close();
    }
  });

  it("rejects a well-shaped resource belonging to another operation or tenant", async () => {
    for (const changed of [
      { ...resource, tenantId: id(98) },
      { ...resource, operationId: id(99) },
    ]) {
      const server = buildServer(options(async () => changed));
      try {
        const response = await server.inject({
          url: `/v1/verification/captures/${operationId}`,
          headers,
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).not.toHaveProperty("capture");
      } finally {
        await server.close();
      }
    }
  });

  it("fails closed when capture-read composition is disabled", async () => {
    const server = buildServer(options());
    try {
      const response = await server.inject({
        method: "GET",
        url: `/v1/verification/captures/${operationId}`,
        headers,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_NOT_ADMITTED",
      });
    } finally {
      await server.close();
    }
  });
});
