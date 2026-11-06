import { OperationKindSchema } from "@aiengineer/knowledge-contracts";
import { describe, expect, it } from "vitest";
import {
  apiOwnedOperationKinds,
  apiOwnedStepsByKind,
  assertOperationKindAdmitted,
  operationStepsByKind,
  productionAdmittedOperationKinds,
  productionWorkerOperationKinds,
  productionWorkerStepsByKind,
} from "./surface.js";

describe("production operation capability catalog", () => {
  it("keeps candidate extraction distinct and closed until its executor is configured", () => {
    expect(OperationKindSchema.parse("verification_structured_extraction")).toBe("verification_structured_extraction");
    expect(operationStepsByKind.verification_structured_extraction).toEqual(["extract_and_register"]);
    expect(() =>
      assertOperationKindAdmitted("verification_structured_extraction", productionAdmittedOperationKinds),
    ).toThrow("CAPABILITY_NOT_ADMITTED:verification_structured_extraction");
  });
  it("partitions executable and deferred contract kinds without overlapping owners", () => {
    const worker = new Set(productionWorkerOperationKinds);
    const api = new Set(apiOwnedOperationKinds);
    expect([...worker].filter((kind) => api.has(kind))).toEqual([]);
    expect(new Set(productionAdmittedOperationKinds).size).toBe(productionAdmittedOperationKinds.length);
    expect(productionAdmittedOperationKinds.every((kind) => OperationKindSchema.options.includes(kind))).toBe(true);
    const deferred = OperationKindSchema.options.filter((kind) => !productionAdmittedOperationKinds.includes(kind));
    expect(deferred.length).toBeGreaterThan(0);
    expect(() => assertOperationKindAdmitted(deferred[0]!, productionAdmittedOperationKinds)).toThrow(
      `CAPABILITY_NOT_ADMITTED:${deferred[0]}`,
    );
  });

  it("binds each admitted kind to its complete canonical step sequence", () => {
    for (const [kind, steps] of Object.entries(productionWorkerStepsByKind))
      expect(steps).toEqual(operationStepsByKind[kind as keyof typeof operationStepsByKind]);
    for (const [kind, steps] of Object.entries(apiOwnedStepsByKind))
      expect(steps).toEqual(operationStepsByKind[kind as keyof typeof operationStepsByKind]);
  });
});
