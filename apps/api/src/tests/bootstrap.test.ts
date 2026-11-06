import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import handler, { createApiRequestHandler, createApiRuntime, validateApiPublicOrigin } from "../index.js";

it("refuses the retired verification.v1 metric, claims, audit and adjudication configuration (SV-17)", async () => {
  for (const name of [
    "VERIFICATION_METRIC_ENABLED",
    "VERIFICATION_CLAIMS_ENABLED",
    "VERIFICATION_AUDIT_INSPECTION_ENABLED",
    "VERIFICATION_ADJUDICATION_GRANTS_JSON",
    "VERIFICATION_EVE_RUNTIME_ATTESTATION_KEYS_JSON",
  ])
    await expect(createApiRuntime({ NODE_ENV: "test", [name]: "1" })).rejects.toThrow(
      `VERIFICATION_RETIRED_CONFIGURATION:${name}`,
    );
});

describe("API deployment bootstrap", () => {
  it("is side-effect free on import and exports a Vercel handler", () => {
    expect(typeof handler).toBe("function");
  });

  it("boots unrelated development endpoints without an embedding credential", async () => {
    const runtime = await createApiRuntime({
      NODE_ENV: "test",
      KNOWLEDGE_API_URL: "http://127.0.0.1:4100",
    });
    expect(runtime.retrievalConfigured).toBe(false);
    const health = await runtime.server.inject({
      method: "GET",
      url: "/health",
    });
    expect(health.statusCode).toBe(200);
    await runtime.server.close();
  });

  it("bridges a real Node request through the exported serverless handler", async () => {
    const runtime = await createApiRuntime({ NODE_ENV: "test" });
    const bridge = createApiRequestHandler(async () => runtime);
    const nodeServer = createServer((request, response) => {
      void bridge(request, response).catch((error) => {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "handler failure");
      });
    });
    await new Promise<void>((resolve) => nodeServer.listen(0, "127.0.0.1", resolve));
    const address = nodeServer.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    await new Promise<void>((resolve, reject) => nodeServer.close((error) => (error ? reject(error) : resolve())));
    await runtime.server.close();
  });

  it("requires durable persistence and an HTTPS public origin in production", async () => {
    await expect(
      createApiRuntime({
        NODE_ENV: "production",
        KNOWLEDGE_API_URL: "https://knowledge.example",
      }),
    ).rejects.toThrow("POSTGRES_URL_REQUIRED");
    expect(() => validateApiPublicOrigin("http://knowledge.example", true)).toThrow("INVALID_KNOWLEDGE_API_URL");
    expect(validateApiPublicOrigin("https://knowledge.example/", true)).toBe("https://knowledge.example");
  });
});
