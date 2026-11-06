export {
  admitExtractionSchema,
  DEFAULT_EXTRACTION_SCHEMA_LIMITS,
  validateExtractionCandidate,
  type AdmittedExtractionSchema,
  type CandidateValidationCheck,
  type CandidateValidationResult,
  type ExtractionSchemaAdmission,
  type ExtractionSchemaAdmissionLimits,
  type ExtractionSchemaCheck,
} from "./schema.js";
export type {
  CrossFieldTotalRule,
  DuplicateRecordRule,
  ExtractionEvidence,
  ExtractionFieldRule,
  ExtractionFieldVerificationInput,
  ExtractionFieldVerificationResult,
  ExtractionNormalizationRule,
  ExtractionVerificationCheck,
  FieldComparison,
  ImmutableExtractionRepresentation,
} from "./field-rules.js";
export { verifyExtractionFields } from "./field-verification.js";
export {
  verifyExtractionFieldsWithEvidence,
  type AcceptedExtractionLeaf,
  type ExtractionEvidenceJsonScalar,
  type ExtractionFieldEvidenceResult,
  type ExtractionLeafDerivation,
  type ExtractionNormalizationOperation,
} from "./evidence.js";
