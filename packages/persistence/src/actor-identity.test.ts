import { describe, expect, it } from "vitest";
import { actorIdentityKey, sameActorIdentity } from "./actor-identity.js";

describe("sameActorIdentity", () => {
  it("treats a raw uuid and service:<uuid> as the same actor", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(actorIdentityKey(`service:${id}`)).toBe(id);
    expect(sameActorIdentity(id, `service:${id}`)).toBe(true);
    expect(sameActorIdentity(`service:${id}`, id)).toBe(true);
    expect(sameActorIdentity(id, id)).toBe(true);
    expect(sameActorIdentity(`service:${id}`, `service:${id}`)).toBe(true);
  });

  it("rejects a different actor; kind prefixes still name the same key", () => {
    const left = "11111111-1111-4111-8111-111111111111";
    const right = "22222222-2222-4222-8222-222222222222";
    expect(sameActorIdentity(left, right)).toBe(false);
    expect(sameActorIdentity(`service:${left}`, right)).toBe(false);
    expect(sameActorIdentity(`human:${left}`, left)).toBe(true);
    expect(sameActorIdentity("p5-publication-independent-reviewer", "p5-publication-independent-reviewer")).toBe(true);
    expect(sameActorIdentity("", "service:")).toBe(false);
  });
});
