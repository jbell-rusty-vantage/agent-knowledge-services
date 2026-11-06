import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import type { EvidenceSelectorResolver } from "../evidence-selection/index.js";
import type { AdmittedExtractionSchema } from "./schema.js";

export type FieldComparison =
  | "exact"
  | "normalized_text"
  | "decimal"
  | "percentage"
  | "currency"
  | "unit"
  | "date"
  | "datetime"
  | "enum"
  | "identifier"
  | "checksum";

export interface ExtractionNormalizationRule {
  readonly id: string;
  readonly operation: "trim_ascii" | "ascii_whitespace_collapsed";
}

export interface ExtractionFieldRule {
  readonly path: string;
  readonly comparison: FieldComparison;
  readonly normalizationId?: string;
  readonly allowedValues?: readonly string[];
  readonly minimum?: string;
  readonly maximum?: string;
  /** `currency_code_token` validates only uppercase three-letter syntax; it is not an ISO registry lookup. */
  readonly identifierKind?: "uuid" | "sha256" | "cve" | "currency_code_token";
  readonly checksum?: "luhn" | "isbn13";
  /** Explicit scalar evidence extraction from structured selector results; locator metadata is never a field value. */
  readonly sourceComponent?: "table_cell_value" | "geometry_token_text" | "transcript_text";
  /** Required for multi-token/segment components, making source joining deterministic. */
  readonly sourceJoiner?: "space" | "none";
}

export interface ExtractionEvidence {
  readonly path: string;
  readonly captureId: string;
  readonly representationArtifactId: string;
  readonly representationDigest: `sha256:${string}`;
  readonly selector: VerificationSelector;
  readonly expectedSelectedContentDigest?: `sha256:${string}`;
}

/** Representation bytes are checked against their immutable digest before selection. Registration/tenant authorization belongs to WS-03 composition. */
export interface ImmutableExtractionRepresentation {
  readonly captureId: string;
  readonly artifactId: string;
  readonly digest: `sha256:${string}`;
  readonly content: Uint8Array;
}

export interface DuplicateRecordRule {
  readonly arrayPath: string;
  readonly keyPaths: readonly string[];
}

export interface CrossFieldTotalRule {
  readonly resultPath: string;
  readonly operandPaths: readonly string[];
  readonly operation: "identity" | "sum" | "difference" | "product" | "ratio" | "percent_change";
  readonly tolerance?: string;
}

export interface ExtractionVerificationCheck {
  readonly code: string;
  readonly path: string;
  readonly status: "passed" | "failed";
  readonly detail: string;
}

export interface ExtractionFieldVerificationResult {
  readonly valid: boolean;
  readonly candidateValid: boolean;
  readonly checks: readonly ExtractionVerificationCheck[];
}

/** Package-internal capture from the one authoritative field-verification pass. */
export interface VerifiedExtractionScalarSelection {
  readonly path: string;
  readonly value: ExtractionScalar;
  readonly rawValue: ExtractionScalar;
  readonly rule: ExtractionFieldRule;
  readonly evidence: ExtractionEvidence;
  readonly selectedContentDigest: `sha256:${string}`;
}

export type ExtractionScalar = string | number | boolean | null;

export interface ExtractionFieldVerificationInput {
  readonly schema: AdmittedExtractionSchema;
  readonly candidate: unknown;
  readonly fields: readonly ExtractionFieldRule[];
  readonly evidence: readonly ExtractionEvidence[];
  readonly representations: readonly ImmutableExtractionRepresentation[];
  readonly normalizations?: readonly ExtractionNormalizationRule[];
  readonly duplicates?: readonly DuplicateRecordRule[];
  readonly totals?: readonly CrossFieldTotalRule[];
  readonly selectorResolvers?: readonly EvidenceSelectorResolver[];
}
