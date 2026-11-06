import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../server.js";

describe("comparison statistics public reads", () => {
  it("authenticates and validates before read access, and sanitizes integrity failures", async () => {
    const tenantId = randomUUID(),
      comparisonId = randomUUID(),
      getComparison = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("private locator"), { code: "NOT_FOUND" }))
        .mockRejectedValueOnce(new Error("private signing detail"));
    const server = buildServer({
      resolveIdentity: (token) =>
        token === "valid"
          ? {
              actor: { kind: "human", id: randomUUID() },
              grants: [{ tenantId, roles: ["knowledge_reader"], scopes: [] }],
            }
          : undefined,
      verificationBenchmarkComparisonReads: { getComparison },
    });
    const headers = { authorization: "Bearer valid", "x-tenant-id": tenantId },
      url = `/v1/verification/benchmarks/comparisons/${comparisonId}`;
    try {
      expect((await server.inject({ url })).statusCode).toBe(401);
      expect(
        (
          await server.inject({
            url,
            headers: { ...headers, "x-tenant-id": randomUUID() },
          })
        ).statusCode,
      ).toBe(403);
      expect((await server.inject({ url: `${url}?publicKeyPem=caller`, headers })).statusCode).toBe(400);
      expect(
        (
          await server.inject({
            url: "/v1/verification/benchmarks/comparisons/latest",
            headers,
          })
        ).statusCode,
      ).toBe(400);
      expect(getComparison).not.toHaveBeenCalled();
      const missing = await server.inject({ url, headers }),
        invalid = await server.inject({ url, headers });
      expect(missing.statusCode).toBe(404);
      expect(invalid.statusCode).toBe(503);
      expect(missing.body + invalid.body).not.toContain("private");
      expect(getComparison).toHaveBeenCalledWith({ tenantId, comparisonId });
    } finally {
      await server.close();
    }
  });
  it("requires separately configured comparison read trust", async () => {
    const tenantId = randomUUID(),
      server = buildServer({
        resolveIdentity: () => ({
          actor: { kind: "human", id: randomUUID() },
          grants: [{ tenantId, roles: ["knowledge_reader"], scopes: [] }],
        }),
      });
    try {
      const result = await server.inject({
        url: `/v1/verification/benchmarks/comparisons/${randomUUID()}`,
        headers: { authorization: "Bearer valid", "x-tenant-id": tenantId },
      });
      expect(result.statusCode).toBe(503);
      expect(result.json().code).toBe("CAPABILITY_NOT_ADMITTED");
    } finally {
      await server.close();
    }
  });
  it("rejects malformed runtime comparison data before response serialization", async () => {
    const tenantId = randomUUID(),
      comparisonId = randomUUID(),
      server = buildServer({
        resolveIdentity: () => ({
          actor: { kind: "human", id: randomUUID() },
          grants: [{ tenantId, roles: ["knowledge_reader"], scopes: [] }],
        }),
        verificationBenchmarkComparisonReads: {
          getComparison: async () => ({ objectKey: "private-storage-coordinate" }) as any,
        },
      });
    try {
      const response = await server.inject({
        url: `/v1/verification/benchmarks/comparisons/${comparisonId}`,
        headers: { authorization: "Bearer valid", "x-tenant-id": tenantId },
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("private-storage-coordinate");
    } finally {
      await server.close();
    }
  });
});
