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
import { verificationOwnedOperationKinds } from "../verification/operations/verification-service.js";

describe("production operation capability catalog", () => {
  it("keeps candidate extraction distinct and closed until its executor is configured", () => {
    expect(OperationKindSchema.parse("verification_structured_extraction")).toBe("verification_structured_extraction");
    expect(operationStepsByKind.verification_structured_extraction).toEqual(["extract_and_register"]);
    expect(() =>
      assertOperationKindAdmitted("verification_structured_extraction", productionAdmittedOperationKinds),
    ).toThrow("CAPABILITY_NOT_ADMITTED:verification_structured_extraction");
  });
  it("partitions the contract kinds among the worker, the API and verification without overlap or remainder", () => {
    const worker = new Set(productionWorkerOperationKinds);
    const api = new Set(apiOwnedOperationKinds);
    expect([...worker].filter((kind) => api.has(kind))).toEqual([]);
    expect(new Set(productionAdmittedOperationKinds).size).toBe(productionAdmittedOperationKinds.length);
    expect(productionAdmittedOperationKinds.every((kind) => OperationKindSchema.options.includes(kind))).toBe(true);
    // Every other kind is verification-owned: the vocabulary holds no kind that nothing executes.
    const remainder = OperationKindSchema.options.filter((kind) => !productionAdmittedOperationKinds.includes(kind));
    expect([...remainder].sort()).toEqual([...verificationOwnedOperationKinds].sort());
    expect(Object.keys(operationStepsByKind).sort()).toEqual([...OperationKindSchema.options].sort());
    expect(() => assertOperationKindAdmitted(remainder[0]!, productionAdmittedOperationKinds)).toThrow(
      `CAPABILITY_NOT_ADMITTED:${remainder[0]}`,
    );
  });

  it("binds each admitted kind to its complete canonical step sequence", () => {
    for (const [kind, steps] of Object.entries(productionWorkerStepsByKind))
      expect(steps).toEqual(operationStepsByKind[kind as keyof typeof operationStepsByKind]);
    for (const [kind, steps] of Object.entries(apiOwnedStepsByKind))
      expect(steps).toEqual(operationStepsByKind[kind as keyof typeof operationStepsByKind]);
  });
});
