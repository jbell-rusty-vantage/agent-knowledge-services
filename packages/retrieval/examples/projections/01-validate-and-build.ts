import { createProjection, validateEvidenceSupport, type ProjectionInput } from "../../src/index.js";
import { evidenceFor, id, printJson } from "./fixtures.js";

/**
 * A validated evidence support set is the gate before a projection is built:
 * the digest of the ordered locator set feeds the deterministic projectionId,
 * so replaying the same evidence and text always yields the same id.
 */
export function validateAndBuildExample() {
  const evidence = [evidenceFor(id(3), id(10), id(11), "The retry budget is shared across the lease.")];
  const input: ProjectionInput = {
    sourceRecordId: id(1),
    procedureVersionId: id(2),
    evidence,
    assertions: [{ id: "a1", statement: "The retry budget is shared across the lease.", supportLocatorIds: [id(3)] }],
    space: "engineering_claims",
    claimClass: "verified_fact",
    attribution: "source",
    problem: "durable retries",
    mechanism: "shared retry budget",
    applicability: ["workers"],
    limitations: ["single lease scope"],
  };
  const validation = validateEvidenceSupport(input);
  const first = createProjection(input);
  const second = createProjection(input);
  return {
    valid: validation.valid,
    supportSetDigest: validation.supportSetDigest,
    projectionId: first.projectionId,
    deterministic: first.projectionId === second.projectionId,
  };
}

if (process.argv[1]?.includes("01-validate-and-build")) printJson(validateAndBuildExample());
