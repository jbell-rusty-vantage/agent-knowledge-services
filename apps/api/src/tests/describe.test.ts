import { afterAll, describe, expect, it } from "vitest";
import { describeReference, PLATFORM_TOOL_NAMES, SKILL_CATALOG } from "@aiengineer/knowledge-contracts";
import type { LocalApiIdentity } from "@aiengineer/knowledge-host";
import { buildServer } from "../server.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TOKEN = "describe-route-token-0000001";
const identity: LocalApiIdentity = {
  actor: { kind: "service", id: id(2), serviceIdentity: "mission_control_client" },
  grants: [],
};

/** GET /v1/describe: what the MCP tool knowledge_describe and `ks describe` return, over HTTP. */
describe("describe route", () => {
  const server = buildServer({ resolveIdentity: (token) => (token === TOKEN ? identity : undefined) });
  afterAll(() => server.close());
  const get = (query: string, token: string | null = TOKEN) =>
    server.inject({
      method: "GET",
      url: `/v1/describe${query}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-correlation-id": "describe-test" },
    });

  it("returns the contract package's description of a tool, an operation and a skill, without a tenant", async () => {
    for (const ref of [
      "tool:knowledge_source_fetch",
      "tool:verify_benchmark_run",
      "operation:space_publication",
      ...SKILL_CATALOG.slice(0, 1).map((skill) => `skill:${skill.name}`),
    ]) {
      const response = await get(`?ref=${encodeURIComponent(ref)}`);
      const expected = describeReference(ref);
      expect(response.statusCode, ref).toBe(200);
      expect(expected.ok && response.json(), ref).toEqual(
        expected.ok && JSON.parse(JSON.stringify(expected.description)),
      );
    }
  });

  it("refuses an unknown reference with a typed problem that lists the valid prefixes and names", async () => {
    const response = await get("?ref=tool%3Aknowledge_source_inspect");
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      code: "NOT_FOUND",
      title: "Reference not found",
      detail: 'No tool is named "knowledge_source_inspect". Valid prefixes: tool:, operation:, skill:',
      correlationId: "describe-test",
      issues: [{ path: "ref", message: `Valid names: ${PLATFORM_TOOL_NAMES.join(", ")}` }],
    });
    const prefix = await get("?ref=capture");
    expect(prefix.statusCode).toBe(404);
    expect(prefix.json()).toMatchObject({
      code: "NOT_FOUND",
      detail: "A reference starts with tool:, operation: or skill:. Valid prefixes: tool:, operation:, skill:",
    });
    expect(prefix.json().issues).toBeUndefined();
  });

  it("requires a bearer and a single ref parameter", async () => {
    const anonymous = await get("?ref=operation%3Acapture", null);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: "UNAUTHORIZED" });
    for (const query of ["", "?ref=", "?ref=operation%3Acapture&extra=1"]) {
      const response = await get(query);
      expect(response.statusCode, query).toBe(400);
      expect(response.json(), query).toMatchObject({ code: "INVALID_CONTRACT" });
    }
  });
});
