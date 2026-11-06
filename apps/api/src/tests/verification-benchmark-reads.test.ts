import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";

describe("benchmark public reads", () => {
  it("authenticates before repository access and sanitizes unavailable custody", async () => {
    const tenantId = randomUUID(),
      runId = randomUUID(),
      getRun = vi.fn().mockRejectedValue(Object.assign(new Error("private object locator"), { code: "NOT_FOUND" })),
      getManifest = vi.fn().mockRejectedValue(new Error("private signing detail"));
    const server = buildServer({
      resolveIdentity: (token) =>
        token === "valid"
          ? {
              actor: { kind: "human", id: randomUUID() },
              grants: [{ tenantId, roles: ["knowledge_reader"], scopes: [] }],
            }
          : undefined,
      verificationBenchmarkReads: { getRun, getManifest },
    });
    const headers = { authorization: "Bearer valid", "x-tenant-id": tenantId };
    try {
      for (const suffix of ["", "/manifest"]) {
        const url = `/v1/verification/benchmarks/${runId}${suffix}`;
        expect((await server.inject({ url })).statusCode).toBe(401);
        expect((await server.inject({ url, headers: { ...headers, "x-tenant-id": randomUUID() } })).statusCode).toBe(
          403,
        );
      }
      expect(getRun).not.toHaveBeenCalled();
      expect(getManifest).not.toHaveBeenCalled();
      const missing = await server.inject({ url: `/v1/verification/benchmarks/${runId}`, headers }),
        integrity = await server.inject({ url: `/v1/verification/benchmarks/${runId}/manifest`, headers });
      expect(missing.statusCode).toBe(404);
      expect(integrity.statusCode).toBe(503);
      expect(missing.body + integrity.body).not.toContain("private");
      expect(getRun).toHaveBeenCalledWith({ tenantId, runId });
      expect((await server.inject({ url: "/v1/verification/benchmarks/latest", headers })).statusCode).toBe(400);
      expect(getRun).toHaveBeenCalledTimes(1);
      expect(
        (await server.inject({ url: `/v1/verification/benchmarks/${runId}?publicKeyPem=caller`, headers })).statusCode,
      ).toBe(400);
      expect(getRun).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
  it("requires configured read trust independently of submission availability", async () => {
    const tenantId = randomUUID(),
      server = buildServer({
        resolveIdentity: () => ({
          actor: { kind: "human", id: randomUUID() },
          grants: [{ tenantId, roles: ["knowledge_reader"], scopes: [] }],
        }),
      });
    try {
      const response = await server.inject({
        url: `/v1/verification/benchmarks/${randomUUID()}`,
        headers: { authorization: "Bearer valid", "x-tenant-id": tenantId },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("CAPABILITY_NOT_ADMITTED");
    } finally {
      await server.close();
    }
  });
  it("rejects malformed benchmark runtime projections before response serialization", async () => {
    const tenantId = randomUUID(),
      runId = randomUUID(),
      server = buildServer({
        resolveIdentity: () => ({
          actor: { kind: "human", id: randomUUID() },
          grants: [{ tenantId, roles: ["knowledge_reader"], scopes: [] }],
        }),
        verificationBenchmarkReads: {
          getRun: async () => ({ objectKey: "private-storage-coordinate" }) as any,
          getManifest: async () => ({ objectKey: "private-storage-coordinate" }) as any,
        },
      });
    const headers = { authorization: "Bearer valid", "x-tenant-id": tenantId };
    try {
      for (const suffix of ["", "/manifest"]) {
        const response = await server.inject({ url: `/v1/verification/benchmarks/${runId}${suffix}`, headers });
        expect(response.statusCode).toBe(503);
        expect(response.body).not.toContain("private-storage-coordinate");
      }
    } finally {
      await server.close();
    }
  });
});
