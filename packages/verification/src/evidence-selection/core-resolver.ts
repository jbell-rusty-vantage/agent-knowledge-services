import type { ResolvedSelector, VerificationSelector } from "@aiengineer/knowledge-contracts";
import { evaluateJsonPointer } from "./json-pointer.js";
import { evidenceSelectionReporter, type EvidenceSelection, type EvidenceSelectionRequest } from "./selection.js";
import { findQuoteOccurrences } from "./quote-search.js";
import { normalizeText, type NormalizedText } from "./text-normalization.js";
import { resolveTextOffsetRange } from "./text-offsets.js";
import { decodeUtf8 } from "./utf8.js";
import { CORE_RESOLVER_VERSION } from "../versions.js";

const report = evidenceSelectionReporter(CORE_RESOLVER_VERSION);

type CoreSelector<Kind extends VerificationSelector["kind"]> = Extract<VerificationSelector, { kind: Kind }>;
type ResolvedRanges = ResolvedSelector["resolvedRanges"];

/** Core selections go straight to callers, so the selection object carries the text and value. */
const EXPOSURE = "text_and_value" as const;

/**
 * Resolves the locator kinds this package owns directly: text quotes, character positions,
 * JSON pointers, and ordered multi-fragment text. `undefined` means the kind belongs to another resolver.
 */
export function resolveCoreEvidenceSelector(request: EvidenceSelectionRequest): EvidenceSelection | undefined {
  const { selector } = request;
  switch (selector.kind) {
    case "text_quote":
      return resolveTextQuote(request, selector);
    case "character_position":
      return resolveCharacterPosition(request, selector);
    case "json_pointer":
      return resolveJsonPointer(request, selector);
    case "multi_fragment_text":
      return resolveMultiFragmentText(request, selector);
    default:
      return undefined;
  }
}

/** A quote identifies evidence only if it occurs exactly once after normalization and prefix/suffix filtering. */
function resolveTextQuote(request: EvidenceSelectionRequest, selector: CoreSelector<"text_quote">): EvidenceSelection {
  const source = decodeSource(request);
  if (typeof source !== "string") return source;
  const normalizedSource = normalizeText(source, selector.normalization);
  const normalizedQuote = normalizeText(selector.quote, selector.normalization).text;
  const occurrences = findQuoteOccurrences(normalizedSource.text, normalizedQuote, selector);
  if (occurrences.length !== 1) {
    return report.unresolved(request, occurrences.length > 1 ? "ambiguous" : "not_found", occurrences.length);
  }
  const range = sourceRangeOf(normalizedSource, occurrences[0]!, normalizedQuote.length);
  if (!range) return report.unresolved(request, "not_found");
  return report.resolvedText(request, source.slice(range.start, range.end), {
    resolvedRanges: [{ ...range, coordinateSpace: "utf16_code_units" }],
    normalization: selector.normalization,
    exposure: EXPOSURE,
  });
}

/** Maps a hit in the normalized text back onto the original source; `undefined` if the mapping is missing. */
function sourceRangeOf(
  normalized: NormalizedText,
  normalizedStart: number,
  length: number,
): { start: number; end: number } | undefined {
  const start = normalized.sourceStarts[normalizedStart];
  const end = normalized.sourceEnds[normalizedStart + length - 1];
  return start === undefined || end === undefined ? undefined : { start, end };
}

/** Offsets that miss the text or split a code point are a bad locator (`invalid`), not a missing quote. */
function resolveCharacterPosition(
  request: EvidenceSelectionRequest,
  selector: CoreSelector<"character_position">,
): EvidenceSelection {
  const source = decodeSource(request);
  if (typeof source !== "string") return source;
  const normalized = normalizeText(source, selector.normalization).text;
  const range = resolveTextOffsetRange(normalized, selector);
  if (!range) return report.unresolved(request, "invalid");
  // The report keeps the caller's declared coordinates, not the converted UTF-16 slice, so replay sees the same numbers.
  return report.resolvedText(request, normalized.slice(range.start, range.end), {
    resolvedRanges: [
      {
        start: selector.start,
        end: selector.end,
        coordinateSpace: selector.offsetBasis,
      },
    ],
    normalization: selector.normalization,
    exposure: EXPOSURE,
  });
}

/** The selection is the canonical JSON of the pointed node; a pointer is a path, so no character range is reported. */
function resolveJsonPointer(
  request: EvidenceSelectionRequest,
  selector: CoreSelector<"json_pointer">,
): EvidenceSelection {
  let document: unknown;
  try {
    document = JSON.parse(decodeUtf8(request.content)) as unknown;
  } catch {
    return report.unresolved(request, "parse_error");
  }
  const lookup = evaluateJsonPointer(selector.pointer, document);
  if (!lookup.found) return report.unresolved(request, "not_found");
  return report.resolvedValue(request, lookup.value, {
    resolvedRanges: [],
    exposure: EXPOSURE,
  });
}

/**
 * Two or more core text locators, in order, joined with the declared joiner.
 * The joined text is a constructed selection, not a contiguous slice of the source.
 */
function resolveMultiFragmentText(
  request: EvidenceSelectionRequest,
  selector: CoreSelector<"multi_fragment_text">,
): EvidenceSelection | undefined {
  const fragments: EvidenceSelection[] = [];
  for (const fragmentSelector of selector.fragments) {
    const fragment = resolveCoreEvidenceSelector({
      ...request,
      selector: fragmentSelector,
    });
    if (fragment === undefined) return undefined;
    fragments.push(fragment);
  }
  if (fragments.some((fragment) => fragment.resolution.status !== "resolved")) {
    const anyAmbiguous = fragments.some((fragment) => fragment.resolution.status === "ambiguous");
    return report.unresolved(request, anyAmbiguous ? "ambiguous" : "not_found");
  }
  const ranges = fragments.flatMap((fragment) => fragment.resolution.resolvedRanges);
  if (!rangesAreOrdered(ranges)) return report.unresolved(request, "invalid");
  const joined = fragments.map((fragment) => fragment.selectedText ?? "").join(selector.joiner);
  return report.resolvedText(request, joined, {
    resolvedRanges: ranges,
    normalization: selector.fragments[0]!.normalization,
    exposure: EXPOSURE,
  });
}

/** Fragments must share one coordinate space and must not overlap or run backwards. */
function rangesAreOrdered(ranges: ResolvedRanges): boolean {
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1]!;
    const current = ranges[index]!;
    if (previous.coordinateSpace !== current.coordinateSpace || current.start < previous.end) return false;
  }
  return true;
}

/** Returns the decoded source, or a `parse_error` selection when the bytes are not UTF-8 text. */
function decodeSource(request: EvidenceSelectionRequest): string | EvidenceSelection {
  try {
    return decodeUtf8(request.content);
  } catch {
    return report.unresolved(request, "parse_error");
  }
}
