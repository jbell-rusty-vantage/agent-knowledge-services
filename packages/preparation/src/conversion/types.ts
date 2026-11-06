import type { StoredArtifact } from "@aiengineer/knowledge-core";

export type ConversionNodeKind =
  | "document"
  | "title"
  | "heading"
  | "paragraph"
  | "list"
  | "list_item"
  | "table"
  | "table_row"
  | "table_cell"
  | "figure"
  | "image"
  | "caption"
  | "formula"
  | "code_block"
  | "quotation"
  | "footnote"
  | "citation"
  | "bibliography_entry"
  | "transcript_segment"
  | "speaker_turn"
  | "slide"
  | "speaker_note"
  | "repository_file"
  | "symbol"
  | "class"
  | "function"
  | "method"
  | "declaration"
  | "test"
  | "configuration_block";

export interface ConversionLocator {
  startOffset?: number;
  endOffset?: number;
  sectionPath?: readonly string[];
  startTimeMs?: number;
  endTimeMs?: number;
  speaker?: string;
  domPath?: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface ConversionNode {
  id: string;
  parentId?: string;
  ordinal: number;
  kind: ConversionNodeKind;
  label?: string;
  text: string;
  contentDigest: string;
  locator: ConversionLocator;
}

export interface ConversionProfile {
  profileKey: string;
  version: string;
  mediaType: string;
  language?: string;
  preserveHtml?: boolean;
  managedProcessingAllowed: boolean;
  maximumPolls?: number;
}

export interface ConversionRequest {
  tenantId: string;
  sourceArtifact: StoredArtifact;
  profile: ConversionProfile;
}

export interface ConversionMetrics {
  inputCharacters: number;
  outputCharacters: number;
  characterCoverage: number;
  headings: number;
  tables: number;
  figures: number;
  codeBlocks: number;
  citations: number;
  emptyNodes: number;
  repeatedBlockRatio: number;
  locatorResolvability: number;
  encodingAnomalies: number;
}

export type FidelityGrade = "high" | "medium" | "low";

export type FidelityFindingDisposition =
  | "accept"
  | "repair"
  | "alternate_conversion"
  | "quarantine"
  | "review"
  | "reject";

export interface FidelityFinding {
  disposition: FidelityFindingDisposition;
  nodeIds: readonly string[];
  impact: string;
  allowedAction: string;
}

export interface FidelityReport {
  grade: FidelityGrade;
  metrics: ConversionMetrics;
  checks: readonly string[];
  findings: readonly FidelityFinding[];
}

export interface ConversionOutput {
  providerKey: string;
  providerVersion: string;
  profileDigest: string;
  requestDigest: string;
  providerNativeArtifact: StoredArtifact;
  markdownArtifact: StoredArtifact;
  plainTextArtifact: StoredArtifact;
  nodes: readonly ConversionNode[];
  metrics: ConversionMetrics;
  fidelity: FidelityReport;
  receiptDigest: string;
  providerJobId?: string;
  observations: Readonly<Record<string, string | number>>;
}

export interface DocumentConversionProvider {
  readonly providerKey: string;
  readonly version: string;
  supports(profile: ConversionProfile): boolean;
  convert(request: ConversionRequest): Promise<ConversionOutput>;
}

export type ConversionFailureClass =
  | "policy_denied"
  | "provider_unavailable"
  | "provider_failed"
  | "timeout"
  | "invalid_output";

export type ConversionAttemptOutcome = "failed" | "succeeded";

export interface ConversionRouteAttempt {
  providerKey: string;
  providerVersion: string;
  ordinal: number;
  outcome: ConversionAttemptOutcome;
  failureClass?: ConversionFailureClass;
}

export interface ConversionRoutingReceipt {
  requestDigest: string;
  candidateRoute: readonly string[];
  attempts: readonly ConversionRouteAttempt[];
  selectedProviderKey: string;
  fallbackUsed: boolean;
  receiptDigest: string;
}

export interface ConversionRouteOptions {
  readonly admittedKeys?: readonly string[];
}

export interface ConversionRouterProviders {
  readonly deterministic: DocumentConversionProvider;
  readonly docling?: DocumentConversionProvider;
  readonly unstructured?: DocumentConversionProvider;
}
