import { describe, expect, it, vi } from "vitest";
import { viaApi, viaMcp } from "./parity-harness.js";
import {
  extractionRequest,
  foreignTenant,
  IDEMPOTENCY,
  integrityFailureTransports,
  CORRELATION,
  KNOWN,
  mutationTransports,
  operationContext,
  owner,
  readRows,
  retrievalPlan,
  retrievalSearchTransports,
  stranger,
  tenant,
  tokens,
  UNKNOWN,
  type ParityRow,
} from "./parity-rows.js";
import { actorsMatch } from "@aiengineer/knowledge-application";

// The API route is the behavioral reference. Every former MCP HTTP shim row runs the
// same application use case in both transports; each case asserts the reference
// outcome and the MCP outcome together.
const run = async (
  row: ParityRow,
  options: {
    configured?: boolean;
    token?: string;
    tenantId?: string;
    resourceId?: string;
    assertedActor?: typeof owner;
  },
) => {
  const tenantId = options.tenantId ?? tenant,
    resourceId = options.resourceId ?? KNOWN;
  const context = operationContext(tenantId, options.assertedActor ?? owner);
  const transports = row.transports(options.configured ?? true);
  return {
    api: await viaApi(transports.api, options.token ?? tokens.owner, tenantId, row.http(resourceId, context)),
    mcp: await viaMcp(transports.mcp, options.token ?? tokens.owner, row.tool, row.args(resourceId, context)),
  };
};

describe.each(readRows)("$tool API/MCP parity", (row) => {
  it("returns the same result for the owner's known resource", async () => {
    const { api, mcp } = await run(row, {});
    if (row.success !== undefined) {
      expect(api).toEqual({ status: 200, value: row.success });
      expect(mcp).toEqual({ value: row.success });
    } else {
      // No schema-valid success fixture is constructed for this row; the stored value
      // fails closed as integrity on both transports.
      expect(api).toEqual({ status: 503, code: "INTERNAL_ERROR" });
      expect(mcp).toEqual({ code: "INTERNAL_ERROR" });
    }
  });

  it("denies a tenant outside the bearer grant", async () => {
    const { api, mcp } = await run(row, { tenantId: foreignTenant });
    expect(api).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(mcp).toEqual({ code: "FORBIDDEN" });
  });

  it("applies the same actor authority", async () => {
    if (row.actorCase === "owned") {
      const { api, mcp } = await run(row, { token: tokens.stranger });
      expect(api).toEqual({ status: 404, code: "NOT_FOUND" });
      expect(mcp).toEqual({ code: "NOT_FOUND" });
    } else if (row.actorCase === "tenant") {
      const reference = await run(row, {});
      const { api, mcp } = await run(row, { token: tokens.stranger });
      expect(api).toEqual(reference.api);
      expect(mcp).toEqual(reference.mcp);
    } else {
      // Catalog tools carry a caller-asserted context actor. A GET route has no asserted
      // actor (the bearer is the actor); MCP rejects any mismatch before reading.
      const { api, mcp } = await run(row, { assertedActor: stranger });
      expect(actorsMatch(owner, stranger)).toBe(false);
      expect(api).toMatchObject({ status: 200 });
      expect(mcp).toEqual({ code: "ACTOR_MISMATCH" });
    }
  });

  it("reports a missing capability without any transport fallback", async () => {
    const { api, mcp } = await run(row, { configured: false });
    expect(api).toEqual(row.unavailable);
    expect(mcp).toEqual({ code: row.unavailable.status === 404 ? "NOT_FOUND" : "CAPABILITY_NOT_ADMITTED" });
  });

  it("reports an unknown resource as not found", async () => {
    const { api, mcp } = await run(row, { resourceId: UNKNOWN });
    expect(api).toEqual({ status: 404, code: "NOT_FOUND" });
    expect(mcp).toEqual({ code: "NOT_FOUND" });
  });
});

describe("uncaught read failure API/MCP parity", () => {
  it("maps a stored resource that fails its integrity checks to the same problem code", async () => {
    const transports = integrityFailureTransports();
    const context = operationContext(tenant, owner);
    const api = await viaApi(transports.api, tokens.owner, tenant, {
      method: "GET",
      url: `/v1/retrieval-runs/${KNOWN}`,
    });
    const mcp = await viaMcp(transports.mcp, tokens.owner, "knowledge_retrieve_run", {
      context,
      input: { runId: KNOWN },
      expectedVersions: { api: "v1" },
    });
    expect(api).toEqual({ status: 409, code: "CONFLICT" });
    expect(mcp).toEqual({ code: "CONFLICT" });
  });
});

describe("knowledge_retrieve_search API/MCP parity", () => {
  const search = async (options: {
    configured?: boolean;
    tenantId?: string;
    assertedActor?: typeof owner;
    execute?: ReturnType<typeof vi.fn>;
  }) => {
    const tenantId = options.tenantId ?? tenant;
    const context = operationContext(tenantId, options.assertedActor ?? owner);
    const transports = retrievalSearchTransports(options.configured ?? true, options.execute as never);
    return {
      execute: transports.execute,
      api: await viaApi(transports.api, tokens.owner, tenantId, {
        method: "POST",
        url: "/v1/retrieval-runs",
        payload: { context, input: { plan: retrievalPlan }, expectedVersions: { api: "v1", retrieval: "v1" } },
      }),
      mcp: await viaMcp(transports.mcp, tokens.owner, "knowledge_retrieve_search", {
        context,
        input: { plan: retrievalPlan },
        expectedVersions: { api: "v1" },
      }),
    };
  };

  it("admits and executes the same retrieval run", async () => {
    const { api, mcp, execute } = await search({});
    expect(api).toMatchObject({ status: 202, value: { operationId: operationContext(tenant, owner).operationId } });
    expect(mcp).toEqual({ value: (api as { value: unknown }).value });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]).toEqual(execute.mock.calls[1]);
  });

  it("denies a tenant outside the bearer grant", async () => {
    const { api, mcp, execute } = await search({ tenantId: foreignTenant });
    expect(api).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(mcp).toEqual({ code: "FORBIDDEN" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an envelope actor that is not the bearer before admission", async () => {
    const { api, mcp, execute } = await search({ assertedActor: stranger });
    expect(api).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(mcp).toEqual({ code: "ACTOR_MISMATCH" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports a missing executor without any transport fallback", async () => {
    const { api, mcp } = await search({ configured: false });
    expect(api).toEqual({ status: 503, code: "INTERNAL_ERROR" });
    expect(mcp).toEqual({ code: "CAPABILITY_NOT_ADMITTED" });
  });

  it("sanitizes an unclassified execution failure identically", async () => {
    const { api, mcp } = await search({
      execute: vi.fn(async () => {
        throw new Error("private database detail");
      }),
    });
    expect(api).toEqual({ status: 500, code: "INTERNAL_ERROR" });
    expect(mcp).toEqual({ code: "INTERNAL_ERROR" });
  });

  it("classifies a policy-rejected execution identically", async () => {
    const { api, mcp } = await search({
      execute: vi.fn(async () => {
        throw new Error("RETRIEVAL_SPACE_NOT_ADMITTED:private_space");
      }),
    });
    expect(api).toEqual({ status: 409, code: "CONFLICT" });
    expect(mcp).toEqual({ code: "CONFLICT" });
  });
});

describe("verification mutation API/MCP parity", () => {
  // SV-17 retired the claims, report, metric and adjudication mutations; extraction verification is the
  // representative in-process mutation that both transports still admit.
  const mcpContext = (tenantId = tenant) => ({ tenantId, correlationId: CORRELATION, idempotencyKey: IDEMPOTENCY });
  const mutate = async (options: {
    configured?: boolean;
    token?: string;
    tenantId?: string;
    owners?: (actor: typeof owner) => boolean;
  }) => {
    const transports = mutationTransports(
      options.configured ?? true,
      options.owners ?? ((actor) => actorsMatch(owner, actor)),
    );
    const tenantId = options.tenantId ?? tenant,
      token = options.token ?? tokens.owner;
    return {
      api: await viaApi(transports.api, token, tenantId, {
        method: "POST",
        url: "/v1/verification/extractions:verify",
        payload: extractionRequest,
      }),
      mcp: await viaMcp(transports.mcp, token, "verify_extract", {
        context: mcpContext(tenantId),
        request: extractionRequest,
      }),
    };
  };

  it("extraction: admits the same operation", async () => {
    const { api, mcp } = await mutate({});
    expect(api).toMatchObject({ status: 202, value: { state: "queued" } });
    expect(mcp).toEqual({ value: (api as { value: unknown }).value });
  });

  it("extraction: denies a tenant outside the bearer grant", async () => {
    const { api, mcp } = await mutate({ tenantId: foreignTenant });
    expect(api).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(mcp).toEqual({ code: "FORBIDDEN" });
  });

  it("extraction: denies a bearer without trusted ownership", async () => {
    const { api, mcp } = await mutate({ token: tokens.stranger });
    expect(api).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(mcp).toEqual({ code: "FORBIDDEN" });
  });

  it("extraction: reports missing verification operations without an HTTP fallback", async () => {
    const { api, mcp } = await mutate({ configured: false });
    expect(api).toEqual({ status: 503, code: "CAPABILITY_NOT_ADMITTED" });
    expect(mcp).toEqual({ code: "CAPABILITY_NOT_ADMITTED" });
  });
});
