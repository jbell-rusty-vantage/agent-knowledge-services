import { classifyProjectionSpaces, type ClassificationProposal } from "../../src/index.js";
import { id, printJson } from "./fixtures.js";

/**
 * Classification maps domain dispositions to the vector spaces they target.
 * `not_ingestible` always stands alone, and a canonical (non-source-native)
 * disposition is refused while its entity identity is still unresolved.
 */
export function classifyDispositionsExample() {
  const resolved: ClassificationProposal = {
    dispositions: ["engineering_claim", "faithful_source_section"],
    targetContractVersion: "v1",
    deduplicationKeys: ["claim:durable-retries"],
    evidenceLocatorIds: [id(3)],
    unresolvedIdentityQuestions: [],
  };
  const notIngestible: ClassificationProposal = {
    dispositions: ["not_ingestible"],
    targetContractVersion: "v1",
    deduplicationKeys: [],
    evidenceLocatorIds: [],
    unresolvedIdentityQuestions: [],
  };
  const unresolved: ClassificationProposal = {
    dispositions: ["entity_profile"],
    targetContractVersion: "v1",
    deduplicationKeys: ["entity:worker"],
    evidenceLocatorIds: [id(3)],
    unresolvedIdentityQuestions: ["which worker implementation?"],
  };
  let unresolvedRejection: string | undefined;
  try {
    classifyProjectionSpaces(unresolved);
  } catch (error) {
    unresolvedRejection = error instanceof Error ? error.message : String(error);
  }
  return {
    resolvedSpaces: classifyProjectionSpaces(resolved),
    notIngestibleSpaces: classifyProjectionSpaces(notIngestible),
    unresolvedRejection,
  };
}

if (process.argv[1]?.includes("03-classify-dispositions")) printJson(classifyDispositionsExample());
