import type { ResolvedSelector, VerificationSelector } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, digestCanonicalJson, sha256Digest } from "../canonical/index.js";
import { encodeUtf8 } from "./utf8.js";

/**
 * Bytes the caller already holds, the capture they belong to, and the locator to apply to them.
 * The custody fields are copied onto every report so a selection cannot be re-attached to another capture.
 */
export interface EvidenceSelectionRequest {
  readonly captureId: string;
  readonly representationArtifactId: string;
  readonly representationDigest: string;
  readonly selector: VerificationSelector;
  readonly content: Uint8Array;
}

/**
 * Outcome of applying one locator to captured bytes.
 * A failed locate is still an EvidenceSelection: read `resolution.status`, which is never "resolved" on failure.
 */
export interface EvidenceSelection {
  readonly resolution: ResolvedSelector;
  readonly selectedContent: Uint8Array;
  readonly selectedText?: string;
  readonly selectedValue?: unknown;
}

/**
 * Resolves selector kinds the core does not own (projection-backed media such as HTML, PDF, tables).
 * Its output is a claim: `resolveEvidenceSelector` re-checks custody and digests before returning it.
 */
export interface EvidenceSelectorResolver {
  readonly resolverVersion: string;
  readonly supportedKinds: readonly VerificationSelector["kind"][];
  resolve(request: EvidenceSelectionRequest): EvidenceSelection;
}

export type EvidenceSelectionFailure = Exclude<ResolvedSelector["status"], "resolved">;

type CustodyField =
  | "captureId"
  | "representationArtifactId"
  | "representationDigest"
  | "selectorDigest"
  | "selectorKind"
  | "resolverVersion";

/** The part of a report a resolver decides; custody is stamped by the reporter. */
export type EvidenceSelectionOutcome = Omit<ResolvedSelector, CustodyField>;

/**
 * Where a successful selection is located and how much of it the selection object carries.
 *
 * Core locators hand the selection straight to callers, so they expose the text and value on it
 * (`"text_and_value"`). Delegated resolvers return a claim whose bytes are re-verified and re-decoded
 * by `resolveEvidenceSelector`, so they report bytes only (`"bytes_only"`); a text claim in that mode
 * also omits `selectedValue`, because replaying a JSON-quoted string would not hash to the raw bytes.
 */
export interface ResolvedSelectionOutcome {
  readonly resolvedRanges: readonly ResolvedSelector["resolvedRanges"][number][];
  /** Defaults to `"none"`. */
  readonly normalization?: ResolvedSelector["normalization"];
  readonly exposure: "text_and_value" | "bytes_only";
}

export interface EvidenceSelectionReporter {
  report(request: EvidenceSelectionRequest, outcome: EvidenceSelectionOutcome): ResolvedSelector;
  /** A text selection: the bytes are the UTF-8 encoding of `text`. */
  resolvedText(request: EvidenceSelectionRequest, text: string, outcome: ResolvedSelectionOutcome): EvidenceSelection;
  /** A structured selection: the bytes are the canonical JSON of `value`, so `selectedValue` replays to the content digest. */
  resolvedValue(
    request: EvidenceSelectionRequest,
    value: unknown,
    outcome: ResolvedSelectionOutcome,
  ): EvidenceSelection;
  unresolved(
    request: EvidenceSelectionRequest,
    status: EvidenceSelectionFailure,
    occurrenceCount?: number,
  ): EvidenceSelection;
}

/** Report builders for one resolver version. Every report copies custody from the request. */
export function evidenceSelectionReporter(resolverVersion: string): EvidenceSelectionReporter {
  function report(request: EvidenceSelectionRequest, outcome: EvidenceSelectionOutcome): ResolvedSelector {
    return {
      captureId: request.captureId,
      representationArtifactId: request.representationArtifactId,
      representationDigest: request.representationDigest as ResolvedSelector["representationDigest"],
      selectorDigest: digestCanonicalJson(request.selector),
      selectorKind: request.selector.kind,
      resolverVersion,
      ...outcome,
    };
  }

  function resolvedText(
    request: EvidenceSelectionRequest,
    text: string,
    outcome: ResolvedSelectionOutcome,
  ): EvidenceSelection {
    const selectedContent = encodeUtf8(text);
    const exposed = outcome.exposure === "text_and_value";
    return {
      resolution: report(request, {
        status: "resolved",
        occurrenceCount: 1,
        selectedContentDigest: sha256Digest(selectedContent),
        ...(exposed ? { selectedValue: text } : {}),
        resolvedRanges: [...outcome.resolvedRanges],
        normalization: outcome.normalization ?? "none",
      }),
      selectedContent,
      ...(exposed ? { selectedText: text, selectedValue: text } : {}),
    };
  }

  function resolvedValue(
    request: EvidenceSelectionRequest,
    value: unknown,
    outcome: ResolvedSelectionOutcome,
  ): EvidenceSelection {
    const selectedText = canonicalizeJson(value);
    const selectedContent = encodeUtf8(selectedText);
    return {
      resolution: report(request, {
        status: "resolved",
        occurrenceCount: 1,
        selectedContentDigest: sha256Digest(selectedContent),
        selectedValue: value as ResolvedSelector["selectedValue"],
        resolvedRanges: [...outcome.resolvedRanges],
        normalization: outcome.normalization ?? "none",
      }),
      selectedContent,
      ...(outcome.exposure === "text_and_value" ? { selectedText, selectedValue: value } : {}),
    };
  }

  // A failed locate reports `normalization: "none"` even when the locator asked for another mode:
  // the report must not describe a normalized selection that did not happen.
  function unresolved(
    request: EvidenceSelectionRequest,
    status: EvidenceSelectionFailure,
    occurrenceCount = 0,
  ): EvidenceSelection {
    return {
      resolution: report(request, {
        status,
        occurrenceCount,
        resolvedRanges: [],
        normalization: "none",
      }),
      selectedContent: new Uint8Array(),
    };
  }

  return { report, resolvedText, resolvedValue, unresolved };
}
