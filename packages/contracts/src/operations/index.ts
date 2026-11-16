// Operation contracts: the typed input of every operation, its description, and `describe`.
// One module per operation family holds the input schemas (`*-inputs.ts`) and, beside them, what a caller is
// told about each operation (`*-operations.ts`). Transports check an input with `assertOperationInput` before
// they submit it; the worker parses the same schemas when it executes the step.
export * from "./source-inputs.js";
export * from "./preparation-inputs.js";
export * from "./review-inputs.js";
export * from "./publication-inputs.js";
export * from "./evaluation-inputs.js";
export * from "./retrieval-inputs.js";
export * from "./operation-inputs.js";
export * from "./json-schema.js";
export {
  envelopeArguments,
  toolArgumentsExample,
  toolArgumentsSchema,
  ToolReadContextSchema,
  VerificationToolContextSchema,
  type ArgumentShape,
  type OperationContract,
  type OperationResult,
} from "./contract-types.js";
export * from "./operation-contracts.js";
export * from "./describe.js";
export * from "./guide.js";
export {
  GUIDE_FILES,
  GUIDE_JOBS,
  GUIDE_SKILLS,
  GUIDE_UNASSIGNED,
  type GuideJobEntry,
  type GuideSkillEntry,
} from "./guide-pages.generated.js";
export { SKILL_CATALOG, type SkillSummary } from "./skill-catalog.generated.js";
