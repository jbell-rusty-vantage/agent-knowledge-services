import { describe, expect, it } from "vitest";
import { planAndAdmissionExample } from "./01-plan-and-admission.js";

describe("example 01: plan and admission", () => {
  it("decomposes a compound query into more than one subquery", () => {
    expect(planAndAdmissionExample().subqueryCount).toBeGreaterThan(1);
  });

  it("infers implementation_support for an API/compare question", () => {
    expect(planAndAdmissionExample().intents).toContain("implementation_support");
  });

  it("denies a space the policy never admitted with SPACE_NOT_ADMITTED", () => {
    expect(planAndAdmissionExample().spaceDenied).toContain("SPACE_NOT_ADMITTED:benchmark_intelligence");
  });

  it("denies a filter field the policy never allowed with FILTER_NOT_ALLOWED", () => {
    expect(planAndAdmissionExample().filterDenied).toBe("FILTER_NOT_ALLOWED:secret");
  });
});
