import { describe, expect, it } from "vitest";
import { deterministicUuid } from "./deterministic-uuid.js";

describe("deterministicUuid", () => {
  it("derives the same version-5-shaped uuid from the same value", () => {
    const first = deterministicUuid("rep:node:h");
    expect(first).toBe(deterministicUuid("rep:node:h"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("changes with the value", () => {
    expect(deterministicUuid("rep:node:h")).not.toBe(deterministicUuid("rep:node:p"));
  });
});
