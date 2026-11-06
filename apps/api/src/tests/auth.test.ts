import { describe, expect, it } from "vitest";
import { createLocalIdentityResolver, isAuthorized } from "@aiengineer/knowledge-host/config";

const tenant = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const token = "local-test-token-with-sufficient-length";
const config = JSON.stringify([
  {
    token,
    actor: {
      kind: "service",
      id: actorId,
      serviceIdentity: "mission_control_client",
    },
    grants: [
      {
        tenantId: tenant,
        roles: ["knowledge_reader"],
        scopes: ["demo.evaluate"],
      },
    ],
  },
]);

describe("local API identities", () => {
  it("binds a token to its configured actor and tenant grant", async () => {
    const resolved = await createLocalIdentityResolver(config)(token);
    expect(resolved?.actor).toMatchObject({
      id: actorId,
      serviceIdentity: "mission_control_client",
    });
    expect(isAuthorized(resolved!, tenant, "knowledge.read")).toBe(true);
    expect(isAuthorized(resolved!, tenant, "demo.evaluate")).toBe(true);
  });
  it("denies unknown tokens, tenants, and actions by default", async () => {
    const resolver = createLocalIdentityResolver(config);
    const resolved = await resolver(token);
    expect(await resolver("not-the-configured-token")).toBeUndefined();
    expect(isAuthorized(resolved!, "00000000-0000-4000-8000-000000000099", "knowledge.read")).toBe(false);
    expect(isAuthorized(resolved!, tenant, "operation.submit")).toBe(false);
  });
  it("has no implicit identity when local configuration is absent", async () => {
    expect(await createLocalIdentityResolver("")("anything")).toBeUndefined();
  });
});
