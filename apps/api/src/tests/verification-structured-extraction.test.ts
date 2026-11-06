import { randomUUID, generateKeyPairSync } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../server.js";
import { createVerificationStructuredExtractionReads } from "@aiengineer/knowledge-host";
import { createVerificationOperationReadAuthorizer } from "@aiengineer/knowledge-host";

describe("structured extraction public custody boundary", () => {
  it("authenticates and validates before reads and sanitizes integrity errors", async () => {
    const tenantId = randomUUID(),
      operationId = randomUUID(),
      actor = { kind: "human" as const, id: randomUUID() },
      getExtraction = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("private locator"), { code: "NOT_FOUND" }))
        .mockRejectedValueOnce(new Error("private signing key"));
    const server = buildServer({
      resolveIdentity: (token) =>
        token === "valid"
          ? {
              actor,
              grants: [{ tenantId, roles: ["knowledge_reader"], scopes: [] }],
            }
          : undefined,
      verificationStructuredExtractionReads: { getExtraction },
    });
    const url = `/v1/verification/extractions/${operationId}`,
      headers = { authorization: "Bearer valid", "x-tenant-id": tenantId };
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
            url: "/v1/verification/extractions/latest",
            headers,
          })
        ).statusCode,
      ).toBe(400);
      expect(getExtraction).not.toHaveBeenCalled();
      const missing = await server.inject({ url, headers }),
        invalid = await server.inject({ url, headers });
      expect(missing.statusCode).toBe(404);
      expect(invalid.statusCode).toBe(503);
      expect(missing.body + invalid.body).not.toContain("private");
      expect(getExtraction).toHaveBeenCalledWith({
        tenantId,
        operationId,
        actor,
      });
    } finally {
      await server.close();
    }
  });
  it("requires operator signing trust, Storage and ownership grants", () => {
    expect(createVerificationStructuredExtractionReads(undefined, {})).toBeUndefined();
    const publicKeyPem = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
    expect(() =>
      createVerificationStructuredExtractionReads(undefined, {
        VERIFICATION_STRUCTURED_EXTRACTION_READ_PUBLIC_KEYS_JSON: JSON.stringify([{ keyId: "key", publicKeyPem }]),
      }),
    ).toThrow("STORAGE_AND_OWNERSHIP_REQUIRED");
  });
  it("returns a compact typed provider failure without raw provider material", async () => {
    const tenantId = randomUUID(),
      operationId = randomUUID(),
      actor = { kind: "human" as const, id: randomUUID() },
      digest = `sha256:${"a".repeat(64)}`;
    const getExtraction = vi.fn().mockResolvedValue({
      verificationContractVersion: "verification.v1",
      tenantId,
      operationId,
      requestDigest: digest,
      publication: {
        artifact: { artifactId: randomUUID(), digest },
        signatureStatus: "verified",
        purpose: "artifact_custody_only",
      },
      output: {
        status: "failed",
        code: "PROVIDER_HTTP_FAILURE",
        category: "provider_http",
        automaticRetry: false,
        candidateArtifact: null,
        executionArtifact: { artifactId: randomUUID(), digest },
        manifestDigest: digest,
        providerCallDigest: digest,
      },
    });
    const server = buildServer({
      resolveIdentity: (token) =>
        token === "valid"
          ? {
              actor,
              grants: [{ tenantId, roles: ["knowledge_reader"], scopes: [] }],
            }
          : undefined,
      verificationStructuredExtractionReads: { getExtraction },
    });
    const headers = { authorization: "Bearer valid", "x-tenant-id": tenantId };
    try {
      const response = await server.inject({
        url: `/v1/verification/extractions/${operationId}`,
        headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        operationId,
        output: {
          status: "failed",
          code: "PROVIDER_HTTP_FAILURE",
          category: "provider_http",
          automaticRetry: false,
          candidateArtifact: null,
        },
      });
      expect(response.body).not.toContain("private");
      expect(getExtraction).toHaveBeenCalledWith({
        tenantId,
        operationId,
        actor,
      });
      const valid = getExtraction.mock.results[0]!.value;
      const resource = await valid;
      for (const invalid of [
        {
          ...resource,
          output: {
            ...resource.output,
            rawProviderBody: "Authorization: Bearer private",
          },
        },
        {
          ...resource,
          publication: { ...resource.publication, storageKey: "private/path" },
        },
        { ...resource, tenantId: randomUUID() },
        { ...resource, operationId: randomUUID() },
      ]) {
        getExtraction.mockResolvedValueOnce(invalid);
        const rejected = await server.inject({
          url: `/v1/verification/extractions/${operationId}`,
          headers,
        });
        expect(rejected.statusCode, rejected.body).toBe(503);
        expect(rejected.body).not.toContain("private");
      }
    } finally {
      await server.close();
    }
  });
  it("binds read grants to mission, deployment, capability and optional external execution", async () => {
    const tenantId = randomUUID(),
      operationId = randomUUID(),
      actor = { kind: "human" as const, id: randomUUID() },
      missionId = randomUUID();
    const grant = {
      tenantId,
      actor,
      missionId,
      agentDeploymentId: "worker",
      capabilityVersion: "verification-service.v1",
      externalExecution: { runtime: "eve", runId: "run-1" },
    };
    const row = {
      mission_id: missionId,
      agent_deployment_id: "worker",
      capability_version: "verification-service.v1",
      external_execution: grant.externalExecution,
    };
    const query = vi.fn().mockResolvedValue({ rows: [row] }),
      transaction = vi.fn(async (_tenant, work) => work({ query }));
    const authorize = createVerificationOperationReadAuthorizer({ transaction }, JSON.stringify([grant]));
    expect(() => createVerificationOperationReadAuthorizer({ transaction }, JSON.stringify([grant, grant]))).toThrow(
      "DUPLICATE_VERIFICATION_OWNERSHIP_GRANT",
    );
    expect(
      await authorize({
        tenantId,
        operationId,
        actor: { ...actor, id: randomUUID() },
      }),
    ).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(await authorize({ tenantId, operationId, actor })).toBe(true);
    for (const changed of [
      { mission_id: randomUUID() },
      { agent_deployment_id: "other" },
      { capability_version: "other" },
      { external_execution: { runtime: "eve", runId: "other" } },
    ]) {
      query.mockResolvedValueOnce({ rows: [{ ...row, ...changed }] });
      expect(await authorize({ tenantId, operationId, actor })).toBe(false);
    }
  });
});
