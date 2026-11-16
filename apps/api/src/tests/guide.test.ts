import { afterAll, describe, expect, it } from "vitest";
import { guidePage, guideTopics, GUIDE_SKILLS } from "@aiengineer/knowledge-contracts";
import type { LocalApiIdentity } from "@aiengineer/knowledge-host";
import { buildServer } from "../server.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TOKEN = "guide-route-token-000000001";
const identity: LocalApiIdentity = {
  actor: { kind: "service", id: id(2), serviceIdentity: "mission_control_client" },
  grants: [],
};
const markdown = (topic?: string) => {
  const result = guidePage(topic);
  if (!result.ok) throw new Error(`guide topic ${topic} was refused`);
  return result.markdown;
};

/** GET /v1/guide[/topic]: the pages the MCP tool knowledge_guide and `ks guide` return, over HTTP, as Markdown. */
describe("guide route", () => {
  const server = buildServer({ resolveIdentity: (token) => (token === TOKEN ? identity : undefined) });
  afterAll(() => server.close());
  const get = (path = "", token: string | null = TOKEN) =>
    server.inject({
      method: "GET",
      url: `/v1/guide${path}`,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-correlation-id": "guide-test" },
    });

  it("returns the start page as Markdown text, without a tenant", async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(response.body).toBe(markdown());
    expect(response.body.startsWith("# Knowledge Services\n")).toBe(true);
    // Markdown, never Markdown inside a JSON string.
    expect(() => JSON.parse(response.body)).toThrow();
    expect((await get("/start")).body).toBe(response.body);
  });

  it("returns every skill and every reference by topic, the path keeping its slashes", async () => {
    for (const topic of guideTopics()) {
      const response = await get(`/${topic}`);
      expect(response.statusCode, topic).toBe(200);
      expect(response.headers["content-type"], topic).toBe("text/markdown; charset=utf-8");
      expect(response.body, topic).toBe(markdown(topic));
    }
    expect(guideTopics().length).toBeGreaterThan(GUIDE_SKILLS.length + 3);
    expect((await get("/knowledge-research/references/tools/tavily")).body).toContain("# Tavily playbook");
    // The file name a filesystem agent would open is accepted too.
    expect((await get("/knowledge-research/references/method.md")).body).toBe(
      markdown("knowledge-research/references/method"),
    );
  });

  it("refuses an unknown topic with a typed problem that lists the valid topics", async () => {
    const response = await get("/knowledge-research/references/nothing");
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      code: "NOT_FOUND",
      title: "Guide topic not found",
      correlationId: "guide-test",
      issues: [{ path: "topic", message: `Valid topics: ${guideTopics().join(", ")}` }],
    });
  });

  it("requires a bearer", async () => {
    for (const path of ["", "/knowledge-research"]) {
      const anonymous = await get(path, null);
      expect(anonymous.statusCode, path).toBe(401);
      expect(anonymous.json(), path).toMatchObject({ code: "UNAUTHORIZED" });
    }
  });
});
