import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createVerificationResourceReads } from "@aiengineer/knowledge-application";
import { createBenchmarkReadMcpExecutor } from "../index.js";

describe("benchmark MCP reads", () => {
  it("rejects foreign tenants and caller signing keys before the read", async () => {
    const tenantId = randomUUID(),
      runId = randomUUID(),
      getRun = vi.fn(),
      getManifest = vi.fn(),
      context = { tenantId, correlationId: "read" };
    const execute = createBenchmarkReadMcpExecutor({
      operationService: {} as never,
      apiOrigin: "https://knowledge.example",
      identity: {
        actor: { kind: "human", id: randomUUID() },
        grants: [{ tenantId, roles: ["knowledge_reader"], scopes: [] }],
      },
      verificationReads: createVerificationResourceReads({
        benchmarkReads: { getRun, getManifest },
      }),
    });
    await expect(
      execute("verify_benchmark_show", {
        context: { ...context, tenantId: randomUUID() },
        runId,
      }),
    ).resolves.toMatchObject({ isError: true });
    await expect(
      execute("verify_benchmark_manifest", {
        context,
        runId,
        publicKeyPem: "caller-key",
      }),
    ).rejects.toThrow();
    expect(getRun).not.toHaveBeenCalled();
    expect(getManifest).not.toHaveBeenCalled();
    await execute("verify_benchmark_show", { context, runId });
    await execute("verify_benchmark_manifest", { context, runId });
    expect(getRun).toHaveBeenCalledWith({ tenantId, runId });
    expect(getManifest).toHaveBeenCalledWith({ tenantId, runId });
  });
});
