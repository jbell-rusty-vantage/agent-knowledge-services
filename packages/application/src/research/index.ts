// K04 research coordination (Sprint V SV-05/SV-06): one run writer, one sealer, one exact-use oracle over a binding,
// the independent auditor census, K08 report kinds and the asynchronous `report.assess` operation.
export {
  type AdmissionOutcome,
  type AuditorDiscovery,
  type DiscoveryInput,
  type DiscoveryResult,
  type OperationRecord,
  type OperationStart,
  type OperationStore,
  OperationStoreError,
  type OperationTransition,
  REPORT_ASSESSMENT_SCHEMA_VERSION,
  type ReportAssessmentRecord,
  type ResearchBinding,
  type RunContext,
  type RunOpening,
  type CorrectionClosure,
  type CorrectionInput,
  type CounterevidenceSearch,
  type CounterevidenceSearchResult,
  type RecordCollision,
  type RecordProbe,
  type ReviewerGrantInput,
  type RevisionFrontier,
  type RevisionStatus,
  type SourceAuthorityResolver,
  type StoredDecision,
} from "./ports.js";
export {
  ResearchCoordinator,
  ResearchCoordinatorError,
  addDecimal,
  type AssertionUseDecision,
  type AssertionUseInput,
  type AuditInput,
  type AuditedReport,
  type Clock,
  systemClock,
  toInstant,
  type RegisterReportInput,
  type RegisteredReport,
  type ReportAssessment,
  type ReportUseDecision,
  type ReportUseInput,
  type SealInput,
  type CoordinatorOptions,
  type SubjectEvaluation,
} from "./coordinator.js";
export {
  REPORT_ASSESS_OPERATION,
  ReportAssessmentError,
  ReportAssessmentService,
  type ReportAssessmentDependencies,
} from "./assessment.js";
export { ScriptedAuditorDiscovery, type DiscoveryScript, type DiscoveryScriptEntry } from "./auditor.js";
export { ReportKindCatalog } from "./report-kinds.js";
export { InMemoryOperationStore, InMemoryResearchBinding, type InMemoryBindingOptions } from "./in-memory.js";
export { AuthorityChallengeService } from "./authority.js";
export { CrossrefRevisionFrontier, type CrossrefOptions, type FetchLike } from "./adapters/crossref.js";
export { SourceAuthorityCatalog, loadJudgmentPoliciesFile, loadUseClassesFile } from "./source-authority.js";
// The K08 use-class policy constructor, so transports and hosts compose it through the application (FINAL-LAYOUT 4.1).
export { useClassPolicy } from "@aiengineer/knowledge-research-core";
export {
  Ed25519SealSigner,
  type PinnedSealKey,
  SealKeyError,
  SealKeyRegistryError,
  StaticSealVerifier,
  testSealKeys,
} from "./signing.js";
export {
  CORRECTION_RECHECK_SCHEMA_VERSION,
  type CorrectionRecheck,
  SealVerificationError,
  correctionRecheckBytes,
  familyContent,
  parseCorrectionRecheck,
  verifySealedLineage,
} from "./lineage.js";
export {
  type Adjudicated,
  type AdjudicateInput,
  CorrectionService,
  ReviewService,
  ReviewServiceError,
} from "./review.js";
