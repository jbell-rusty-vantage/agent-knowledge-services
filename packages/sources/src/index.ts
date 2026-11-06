// Contract
export type {
  AcquisitionAdapter,
  AcquisitionObservation,
  AcquisitionPlan,
  AcquisitionRequest,
  AcquisitionResult,
  AcquisitionTarget,
  AcquisitionVerification,
  AdmittedAcquisitionPlan,
  ManualUploadAttestation,
  PaperAcquisitionAdapter,
  PaperResolution,
  RepositoryAcquisitionAdapter,
  RepositoryManifest,
  SupportDecision,
  UploadAcquisitionAdapter,
} from "./types.js";

// Route
export { RoutedAcquisitionAdapter } from "./route.js";

// HTTP — wired in the worker
export {
  ExactHttpAcquisitionAdapter,
  assertSafeHttpUrl,
  buildPinnedRequestOptions,
  isForbiddenAddress,
  nodePinnedHttpTransport,
  resolveSafeHttpTarget,
  type DnsResolver,
  type HttpFetch,
  type HttpPolicy,
  type PinnedHttpTransport,
  type PinnedRequestOptions,
  type SafeHttpTarget,
} from "./http/index.js";

// Upload — wired in the worker
export {
  BoundedManualUploadAdapter,
  FilesystemManualUploadSource,
  normalizeUploadPath,
  UPLOAD_ID_PATTERN,
  type FilesystemUploadSidecar,
  type ManualUploadPolicy,
  type ManualUploadRecord,
  type ManualUploadSource,
} from "./upload/index.js";

// Inspect — library, used by examples; executor reads use its own path
export {
  observeSealedCapture,
  readSealedCapture,
  searchSealedCapture,
  type InspectionDimension,
  type InspectionFinding,
  type InspectionFindingStatus,
  type ObserveSealedCaptureInput,
  type ReadSealedCaptureInput,
  type SealedCaptureExcerpt,
  type SealedCaptureObservation,
  type SealedCaptureSearchHit,
  type SealedCaptureSearchResult,
  type SearchSealedCaptureInput,
} from "./inspect/index.js";

// Paper — identity wired in the worker; execute unwired
export { normalizePaperIdentifier } from "./paper/identity.js";
export {
  IdentityBoundPaperAcquisitionAdapter,
  type PaperProvider,
  type ResolvedPaper,
} from "./paper/adapter.js";
export { planPaperAsHttpRequest } from "./paper/plan-http.js";

// Repository — unwired pending the capture-cardinality decision
export { ImmutableRepositoryAcquisitionAdapter } from "./repository/adapter.js";

// Firecrawl — unwired; agents use the Firecrawl skill and source_import
export { FirecrawlAcquisitionAdapter } from "./firecrawl/adapter.js";

// Fakes
export { FixtureAcquisitionAdapter, type FakeAcquisitionFixture } from "./fakes.js";
