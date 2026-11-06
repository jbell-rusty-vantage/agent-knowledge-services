import { sha256Digest } from "../canonical/index.js";
import { resolveEvidenceSelector } from "../evidence-selection/index.js";
import { prototypeSha256 } from "./digest.js";

/**
 * Compatibility contract for the pre-KS verification prototype.
 *
 * Offsets deliberately address the selected basis text, in UTF-16 code units.
 * In particular, `lf_normalized_newlines_collapsed` is not a KS normalization:
 * it only replaces whitespace surrounding a newline.  Keep that transform here
 * until all persisted prototype locators have been migrated.
 */
export type PrototypeTextOffsetBasis = "raw_utf16" | "lf_normalized" | "lf_normalized_newlines_collapsed";

export interface PrototypeTextLocator {
  readonly kind: "text_quote";
  readonly quote: string;
  readonly offsetBasis: PrototypeTextOffsetBasis;
}

export interface PrototypeResolvedTextLocator {
  readonly matchMode: "exact" | "normalized" | "not_found" | "ambiguous";
  readonly start: number | null;
  readonly end: number | null;
  readonly selectedContentSha256: string | null;
  readonly occurrenceCount: number;
}

function contentForPrototypeBasis(content: string, basis: PrototypeTextOffsetBasis): string {
  const lf = content.replace(/\r\n?/g, "\n");
  if (basis === "raw_utf16") return content;
  if (basis === "lf_normalized") return lf;
  return lf.replace(/\s*\n\s*/g, " ");
}

function allIndexes(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const indexes: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    indexes.push(at);
    from = at + 1;
  }
  return indexes;
}

interface NormalizedText {
  readonly text: string;
  readonly originalOffsets: readonly number[];
}

// This is frozen prototype behavior, including its UTF-16-unit iteration.
function normalizePrototypeText(value: string): NormalizedText {
  const removed = value.split("");
  for (const match of value.matchAll(/\b(?:uh|um)\b/gi)) {
    const start = match.index ?? 0;
    for (let index = start; index < start + match[0].length; index += 1) removed[index] = " ";
  }
  let text = "";
  const originalOffsets: number[] = [];
  let pendingSpace = false;
  for (let index = 0; index < removed.length; index += 1) {
    const char = removed[index] ?? "";
    if (/\s/.test(char)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += " ";
      originalOffsets.push(index);
      pendingSpace = false;
    }
    text += char.toLowerCase();
    originalOffsets.push(index);
  }
  return { text: text.trim(), originalOffsets };
}

function unresolved(matchMode: "not_found" | "ambiguous", occurrenceCount: number): PrototypeResolvedTextLocator {
  return {
    matchMode,
    start: null,
    end: null,
    selectedContentSha256: null,
    occurrenceCount,
  };
}

/** Resolve a legacy text locator while retaining its result shape and coordinates. */
export function resolvePrototypeTextLocator(
  content: string,
  locator: PrototypeTextLocator,
): PrototypeResolvedTextLocator {
  const basisContent = contentForPrototypeBasis(content, locator.offsetBasis);
  // The canonical resolver owns exact quote matching.  We preproject to retain
  // the prototype's coordinate space, then translate its range back unchanged.
  const selected = resolveEvidenceSelector({
    captureId: "prototype-compatibility-capture",
    representationArtifactId: "prototype-compatibility-artifact",
    representationDigest: sha256Digest(basisContent),
    selector: {
      kind: "text_quote",
      quote: locator.quote,
      normalization: "none",
    },
    content: new TextEncoder().encode(basisContent),
  });
  if (selected?.resolution.status === "resolved") {
    const range = selected.resolution.resolvedRanges[0];
    if (range)
      return {
        matchMode: "exact",
        start: range.start,
        end: range.end,
        selectedContentSha256: prototypeSha256(basisContent.slice(range.start, range.end)),
        occurrenceCount: 1,
      };
  }
  const exact = allIndexes(basisContent, locator.quote);
  if (exact.length > 1) return unresolved("ambiguous", exact.length);

  const normalizedContent = normalizePrototypeText(basisContent);
  const normalizedQuote = normalizePrototypeText(locator.quote).text;
  const normalizedMatches = allIndexes(normalizedContent.text, normalizedQuote);
  if (normalizedMatches.length !== 1)
    return unresolved(normalizedMatches.length > 1 ? "ambiguous" : "not_found", normalizedMatches.length);
  const normalizedStart = normalizedMatches[0] ?? 0;
  const normalizedEnd = normalizedStart + normalizedQuote.length - 1;
  const start = normalizedContent.originalOffsets[normalizedStart] ?? null;
  const last = normalizedContent.originalOffsets[normalizedEnd] ?? null;
  if (start === null || last === null) return unresolved("not_found", 0);
  const end = last + 1;
  return {
    matchMode: "normalized",
    start,
    end,
    selectedContentSha256: prototypeSha256(basisContent.slice(start, end)),
    occurrenceCount: 1,
  };
}
