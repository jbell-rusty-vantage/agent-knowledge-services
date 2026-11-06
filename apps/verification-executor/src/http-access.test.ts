import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ScopedExecutorAccess, scopedCustodyOperations } from "./access.js";
import { loadExecutorConfig, VerificationExecutor } from "./executor.js";
import { createHttpServer } from "./http.js";
import { request as httpRequest } from "node:http";
import { startExecutorServer } from "./serve.js";

describe("authenticated host scoped transport", () => {
  it("checks parent authentication, immutable grant and payload scope before actual custody writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ks-scoped-http-"));
    const tenantId = randomUUID();
    const producerAttemptId = randomUUID();
    const runId = randomUUID();
    const executor = await VerificationExecutor.create(
      loadExecutorConfig({
        VERIFY_STORE_DIR: directory,
        VERIFY_TENANT_ID: tenantId,
        VERIFY_PRODUCER_ATTEMPT_ID: producerAttemptId,
        VERIFY_VERIFIER_ATTEMPT_ID: randomUUID(),
        VERIFY_GIT_SHA: "test",
      }),
    );
    const assignment = {
      tenantId,
      producerAttemptId,
      runId,
      callerId: "host",
      parentSessionId: "parent",
      assignmentId: "child",
      role: "report-synthesizer",
      pinSha256: "a".repeat(64),
      grantId: "grant",
      readScope: [],
      allowedOperations: ["verify_register_artifact"],
      namespace: `${tenantId}/${runId}/child`,
      deadline: "2030-01-01T00:00:00Z",
    };
    const scopedAccess = new ScopedExecutorAccess({
      grants: [{ assignment, operations: scopedCustodyOperations(executor) }],
    });
    expect(() => createHttpServer(executor, { scopedAccess })).toThrow("SCOPED_HOST_AUTH_REQUIRED");
    const server = createHttpServer(executor, { scopedAccess, token: "host-only-secret" });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/scoped/invoke`;
      const input = {
        assignment,
        operation: "verify_register_artifact",
        payload: { name: "report", text: "Final bytes.", mediaType: "text/markdown" },
      };
      const post = (body: unknown, token = "host-only-secret") =>
        fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const catalog = await fetch(url.replace("/invoke", "/catalog"), {
        method: "POST",
        headers: { authorization: "Bearer host-only-secret", "content-type": "application/json" },
        body: JSON.stringify({ assignment }),
      });
      expect(catalog.status).toBe(200);
      expect(await catalog.json()).toEqual(scopedAccess.catalog(assignment));
      expect((await post(input, "child-secret")).status).toBe(401);
      expect((await post({ ...input, assignment: { ...assignment, role: "publisher" } })).status).toBe(403);
      expect((await post({ ...input, payload: { ...input.payload, runId: "other" } })).status).toBe(400);
      expect((await post({ ...input, operation: "db_sql" })).status).toBe(403);
      expect((await post({ ...input, restoredArtifactIds: ["unrelated"] })).status).toBe(400);
      const malformedJson = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer host-only-secret", "content-type": "application/json" },
        body: "{",
      });
      expect(malformedJson.status).toBe(400);
      const malformedTarget = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(
          { hostname: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "http://[", method: "GET" },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => resolve({ status: response.statusCode!, body }));
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(malformedTarget).toEqual({ status: 400, body: JSON.stringify({ error: "INVALID_REQUEST_URL" }, null, 2) });
      expect(await executor.store.listSteps(runId)).toEqual([]);
      const response = await post(input);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ namespace: assignment.namespace, producerAttemptId });
      expect(await executor.store.listSteps(runId)).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports the actual ephemeral listener port and rejects an occupied port without an unhandled error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ks-scoped-listener-"));
    const env = { VERIFY_STORE_DIR: directory, VERIFY_TENANT_ID: randomUUID(), VERIFY_GIT_SHA: "test" };
    const running = await startExecutorServer({ port: 0, host: "127.0.0.1", env });
    try {
      const port = (running.server.address() as AddressInfo).port;
      expect(running.url).toBe(`http://127.0.0.1:${port}`);
      expect((await fetch(`${running.url}/health`)).status).toBe(200);
      await expect(startExecutorServer({ port, host: "127.0.0.1", env })).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await running.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
