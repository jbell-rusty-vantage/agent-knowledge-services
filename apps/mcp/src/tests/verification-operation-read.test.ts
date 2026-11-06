import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createVerificationOperationReadMcpExecutor } from "../index.js";

describe("verify_status MCP read", () => {
  it("polls only tenant-owned operations through the verification-aware client read and never fabricates state", async () => {
    const tenantId = randomUUID(),
      operationId = randomUUID(),
      context = { tenantId, correlationId: "poll" };
    const status = {
      operationId,
      kind: "verification_claims",
      state: "running",
      receiptIds: [],
    };
    const get = vi.fn().mockResolvedValue(status);
    const options = {
      operationService: { get } as never,
      apiOrigin: "https://knowledge.example",
      identity: {
        actor: { kind: "human" as const, id: randomUUID() },
        grants: [{ tenantId, roles: ["knowledge_reader" as const], scopes: [] }],
      },
    };
    const execute = createVerificationOperationReadMcpExecutor(options);
    await expect(execute({ context: { ...context, tenantId: randomUUID() }, operationId })).resolves.toMatchObject({
      isError: true,
    });
    await expect(execute({ context, operationId: "latest" })).rejects.toThrow();
    await expect(execute({ context, operationId, state: "succeeded" })).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    await expect(execute({ context, operationId })).resolves.toMatchObject({
      structuredContent: status,
    });
    expect(get).toHaveBeenCalledWith(operationId, tenantId);
    get.mockResolvedValueOnce(undefined);
    await expect(execute({ context, operationId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
