import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import { findAllOccurrences, normalizeText } from "./text-normalization.js";

export type TextQuoteSelector = Extract<VerificationSelector, { kind: "text_quote" }>;

/**
 * Every start offset of the normalized quote in the normalized source, kept only where the
 * selector's prefix and suffix (normalized the same way) surround the hit. Overlapping hits count.
 */
export function findQuoteOccurrences(
  normalizedSource: string,
  normalizedQuote: string,
  selector: TextQuoteSelector,
): number[] {
  let occurrences = findAllOccurrences(normalizedSource, normalizedQuote);
  if (selector.prefix !== undefined) {
    const prefix = normalizeText(selector.prefix, selector.normalization).text;
    occurrences = occurrences.filter((at) => normalizedSource.slice(Math.max(0, at - prefix.length), at) === prefix);
  }
  if (selector.suffix !== undefined) {
    const suffix = normalizeText(selector.suffix, selector.normalization).text;
    const quoteEnd = (at: number) => at + normalizedQuote.length;
    occurrences = occurrences.filter(
      (at) => normalizedSource.slice(quoteEnd(at), quoteEnd(at) + suffix.length) === suffix,
    );
  }
  return occurrences;
}
