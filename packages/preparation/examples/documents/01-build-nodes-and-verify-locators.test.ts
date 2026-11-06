import { describe, expect, it } from "vitest";
import { buildNodesAndVerifyLocatorsExample } from "./01-build-nodes-and-verify-locators.js";

describe("example 01: build nodes and verify locators", () => {
  it("seals deterministic, frozen nodes", () => {
    const result = buildNodesAndVerifyLocatorsExample();
    expect(result.deterministic).toBe(true);
    expect(result.frozen).toBe(true);
  });

  it("normalizes prose but keeps code layout", () => {
    const [, body, snippet] = buildNodesAndVerifyLocatorsExample().nodes;
    expect(body?.text).toBe("Workers renew a lease before\neach retry.");
    expect(snippet?.text).toBe("await lease.renew();\n  return retry();");
  });

  it("verifies every locator and reconstructs a span from the sealed text", () => {
    const result = buildNodesAndVerifyLocatorsExample();
    expect(result.locatorIssues).toEqual([]);
    expect(result.nodes[1]?.page).toBe(1);
    expect(result.span).toBe("Workers");
  });
});
