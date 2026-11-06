import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OperationContext } from "@aiengineer/knowledge-contracts";
import { dispatchCliCommand, resolveCommand, type CliKnowledgeClient } from "../commands.js";

describe("benchmark CLI reads", () => {
  it("accepts a run identity without permitting supplied projections or trust keys", async () => {
    const runId = randomUUID(),
      context = {
        tenantId: randomUUID(),
        correlationId: "read",
      } as OperationContext,
      getBenchmarkRun = vi.fn(),
      getBenchmarkRunManifest = vi.fn();
    const client = {
      getBenchmarkRun,
      getBenchmarkRunManifest,
    } as unknown as CliKnowledgeClient;
    for (const [action, method] of [
      ["show", getBenchmarkRun],
      ["manifest", getBenchmarkRunManifest],
    ] as const) {
      const command = resolveCommand("benchmark", action)!;
      await expect(dispatchCliCommand(client, command, { runId, publication: {} }, context)).rejects.toThrow(
        "CLI_BENCHMARK_READ_UNKNOWN_FIELD",
      );
      expect(method).not.toHaveBeenCalled();
      await dispatchCliCommand(client, command, { runId }, context);
      expect(method).toHaveBeenCalledWith(runId, context);
    }
  });
});
