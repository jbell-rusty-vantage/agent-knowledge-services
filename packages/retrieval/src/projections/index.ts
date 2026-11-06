// Validation — evidence support set checks against locators and assertions.
export { validateEvidenceSupport } from "./validation/index.js";

// Projection — build a contract-valid domain projection from validated evidence.
export { createProjection } from "./projection/index.js";

// Classification — map a domain disposition set to the vector spaces it targets.
export { classifyProjectionSpaces, publicProjectionSpaces } from "./classification/index.js";

// Types — projection input, evidence support, and classification shapes owned by this package.
export type {
  ClassificationProposal,
  DomainDisposition,
  EvidenceSupport,
  EvidenceValidationResult,
  ProjectionInput,
  SupportedAssertion,
} from "./types.js";
