import { createProjection, validateEvidenceSupport, type ProjectionInput } from "../../src/index.js";
import { evidenceFor, id, printJson } from "./fixtures.js";

/**
 * A source-native section is a faithful quote, not a derived claim: its text
 * must equal the ordered evidence exactly, and it may carry no assertions.
 */
export function sourceNativeFidelityExample() {
  const first = "A worker renews its lease before every retry.";
  const second = "Retries never exceed the shared budget.";
  const evidence = [evidenceFor(id(3), id(10), id(11), first), evidenceFor(id(4), id(10), id(12), second)];
  const faithful: ProjectionInput = {
    sourceRecordId: id(1),
    procedureVersionId: id(2),
    evidence,
    assertions: [],
    space: "source_native_sections",
    sectionPath: ["Durable retries"],
    sourceText: `${first}\n\n${second}`,
  };
  const rewritten: ProjectionInput = { ...faithful, sourceText: "A different section entirely." };
  const derived: ProjectionInput = {
    ...faithful,
    assertions: [{ id: "a1", statement: "This is a derived claim", supportLocatorIds: [id(3)] }],
  };
  return {
    faithfulValid: validateEvidenceSupport(faithful).valid,
    faithfulProjectionSpace: createProjection(faithful).space,
    rewrittenIssues: validateEvidenceSupport(rewritten).issues,
    derivedIssues: validateEvidenceSupport(derived).issues,
  };
}

if (process.argv[1]?.includes("02-source-native-fidelity")) printJson(sourceNativeFidelityExample());
