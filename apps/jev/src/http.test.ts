import { afterEach, describe, expect, it, vi } from "vitest";
import { get, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JevService } from "@aiengineer/knowledge-contracts/jev";
import { createJevHttpServer } from "./http.js";
import { loadJevConfig } from "./config.js";

const stats = { counts: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 }, workers: [] };
const servers: Server[] = [];

function application(): JevService {
  return {
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    submit: vi.fn(),
    submitBatch: vi.fn(),
    get: vi.fn(),
    list: vi.fn(() => []),
    cancel: vi.fn(),
    stats: vi.fn(() => stats),
  };
}

async function start(service: JevService, token?: string) {
  const server = createJevHttpServer(service, token ? { token } : {});
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("Jev transports", () => {
  it("requires authentication before reading queue or submitting work", async () => {
    const service = application();
    const base = await start(service, "test-only-token");
    expect((await fetch(`${base}/v1/jev/health`)).status).toBe(401);
    expect(service.stats).not.toHaveBeenCalled();
    const response = await fetch(`${base}/v1/jev/health`, { headers: { authorization: "Bearer test-only-token" } });
    expect(await response.json()).toEqual(stats);
  });

  it("rejects invalid task shapes before invoking the application", async () => {
    const service = application();
    const base = await start(service);
    const response = await fetch(`${base}/v1/jev/jobs`, {
      method: "POST",
      body: JSON.stringify({ input: { type: "inline", state: "sample" }, questions: {} }),
    });
    expect(response.status).toBe(400);
    expect(service.submit).not.toHaveBeenCalled();
    expect((await fetch(`${base}/v1/jev/jobs/missing`)).status).toBe(404);
  });

  it("blocks browser-origin requests and DNS rebinding hostnames", async () => {
    const base = await start(application());
    expect((await fetch(`${base}/v1/jev/health`, { headers: { origin: "https://example.com" } })).status).toBe(403);
    const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${base}/v1/jev/health`, { headers: { host: "attacker.example" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    expect(reboundStatus).toBe(403);
    expect(() => loadJevConfig({ JEV_HOST: "0.0.0.0" })).toThrow("JEV_SERVICE_TOKEN");
  });

  it("exposes tools through a real MCP HTTP protocol exchange", async () => {
    const base = await start(application());
    const client = new Client({ name: "jev-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["jev_submit", "jev_batch", "jev_get", "jev_cancel", "jev_workers"]),
      );
      const result = await client.callTool({ name: "jev_workers", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(stats) }]);
    } finally {
      await client.close();
    }
  });

  it("does not serialize private application failures into HTTP or MCP", async () => {
    const service = application();
    vi.mocked(service.stats).mockImplementation(() => {
      throw new Error("private-token-and-file-path");
    });
    const base = await start(service);
    expect(await (await fetch(`${base}/v1/jev/health`)).json()).toEqual({ error: "JEV_REQUEST_FAILED" });
    const client = new Client({ name: "jev-error-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const result = await client.callTool({ name: "jev_workers", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: '{"error":"JEV_REQUEST_FAILED"}' }]);
    } finally {
      await client.close();
    }
  });

  it("serves only the fixed report artifacts and protects them with authentication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jev-report-test-"));
    try {
      await Promise.all([
        writeFile(join(directory, "index.html"), "<h1>Results</h1>"),
        writeFile(join(directory, "receipts.json"), '{"runs":[]}'),
        writeFile(join(directory, "README.md"), "Experiment method"),
        writeFile(join(directory, "private.txt"), "private"),
      ]);
      const server = createJevHttpServer(application(), {
        token: "report-token",
        reportPath: join(directory, "index.html"),
        experimentReadmePath: join(directory, "README.md"),
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP listener");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { authorization: "Bearer report-token" };
      expect((await fetch(`${base}/receipts.json`)).status).toBe(401);
      expect(await (await fetch(`${base}/receipts.json`, { headers })).json()).toEqual({ runs: [] });
      expect(await (await fetch(`${base}/scripts/experiments/jev/README.md`, { headers })).text()).toBe(
        "Experiment method",
      );
      expect((await fetch(`${base}/private.txt`, { headers })).status).toBe(404);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
