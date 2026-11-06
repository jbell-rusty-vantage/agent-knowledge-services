import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viaMcp, type Outcome } from "./parity-harness.js";
import {
  CORRELATION,
  IDEMPOTENCY,
  KNOWN,
  mutationTransports,
  operationContext,
  owner,
  readRows,
  retrievalPlan,
  retrievalSearchTransports,
  tenant,
  tokens,
} from "./parity-rows.js";
import { verificationMutationInventory, version } from "./verification-inventory.js";

// Every tool that previously reached the API through createApiClient, exercised through
// the real MCP HTTP app with and without its in-process capability. Any HTTP request
// (the retired shim) hits the trap.
let fetchTrap: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchTrap = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("MCP_HTTP_SHIM_CALLED");
  });
});
afterEach(() => {
  fetchTrap.mockRestore();
});

const answered = (outcome: Outcome) => {
  // A protocol error or a thrown tool failure would hide where the call went.
  expect(outcome).not.toHaveProperty("error");
  return outcome;
};

describe("MCP issues no HTTP request to the API", () => {
  it.each([true, false])("serves every former read shim in process (capability composed: %s)", async (configured) => {
    for (const row of readRows) {
      const context = operationContext(tenant, owner);
      answered(await viaMcp(row.transports(configured).mcp, tokens.owner, row.tool, row.args(KNOWN, context)));
    }
    expect(fetchTrap).not.toHaveBeenCalled();
  });

  it.each([true, false])("runs knowledge_retrieve_search in process (executor composed: %s)", async (configured) => {
    const transports = retrievalSearchTransports(configured);
    const outcome = answered(
      await viaMcp(transports.mcp, tokens.owner, "knowledge_retrieve_search", {
        context: operationContext(tenant, owner),
        input: { plan: retrievalPlan },
        expectedVersions: { api: "v1" },
      }),
    );
    expect(outcome).toEqual(
      configured ? { value: expect.objectContaining({ state: "queued" }) } : { code: "CAPABILITY_NOT_ADMITTED" },
    );
    expect(transports.execute).toHaveBeenCalledTimes(configured ? 1 : 0);
    expect(fetchTrap).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "submits every verification mutation in process or not at all (composed: %s)",
    async (configured) => {
      for (const entry of verificationMutationInventory) {
        const outcome = answered(
          await viaMcp(mutationTransports(configured, () => true).mcp, tokens.owner, entry.tool, {
            context: { tenantId: tenant, correlationId: CORRELATION, idempotencyKey: IDEMPOTENCY },
            request: { ...version, ...entry.request },
          }),
        );
        expect(outcome, entry.tool).toEqual(
          configured ? { value: expect.objectContaining({ state: "queued" }) } : { code: "CAPABILITY_NOT_ADMITTED" },
        );
      }
      expect(fetchTrap).not.toHaveBeenCalled();
    },
  );

  it("MCP runtime source and manifest no longer reference the KnowledgeClient", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(source).not.toMatch(/@aiengineer\/knowledge-client|KnowledgeClient|createApiClient|apiClient/u);
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@aiengineer/knowledge-client");
  });
});
