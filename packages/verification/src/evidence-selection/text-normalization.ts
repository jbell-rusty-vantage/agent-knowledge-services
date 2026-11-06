import type { VerificationSelector } from "@aiengineer/knowledge-contracts";

export type TextNormalization = Extract<VerificationSelector, { kind: "text_quote" }>["normalization"];

/**
 * A search index over the source text. Quote search runs on `text`; every UTF-16 unit `i` of `text`
 * maps back to the source range [sourceStarts[i], sourceEnds[i]) so a hit can be sliced from the original.
 * This is not a CanonicalProjection.
 */
export interface NormalizedText {
  readonly text: string;
  readonly sourceStarts: readonly number[];
  readonly sourceEnds: readonly number[];
}

const FILLER_WORDS = /\b(?:uh|um)\b/giu;

export function normalizeText(source: string, normalization: TextNormalization): NormalizedText {
  if (normalization === "none") return identityMapping(source);
  const lineFeeds = normalizeLineEndings(source);
  if (normalization === "lf") return lineFeeds;
  return collapseWhitespace(lineFeeds, normalization === "casefold_whitespace_filler_removed");
}

/** Every start offset of `needle` in `text`, overlapping hits included, so two `42`s are two occurrences. */
export function findAllOccurrences(text: string, needle: string): number[] {
  if (!needle) return [];
  const occurrences: number[] = [];
  let from = 0;
  while (from <= text.length - needle.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    occurrences.push(at);
    from = at + 1;
  }
  return occurrences;
}

function identityMapping(source: string): NormalizedText {
  return {
    text: source,
    sourceStarts: Array.from({ length: source.length }, (_, index) => index),
    sourceEnds: Array.from({ length: source.length }, (_, index) => index + 1),
  };
}

/** `\r\n` and lone `\r` become `\n`; each `\n` remembers the source span it replaced. */
function normalizeLineEndings(source: string): NormalizedText {
  const output = new MappedTextBuilder();
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char !== "\r") {
      output.append(char, index, index + 1);
      continue;
    }
    const end = source[index + 1] === "\n" ? index + 2 : index + 1;
    output.append("\n", index, end);
    if (end === index + 2) index += 1;
  }
  return output.build();
}

/**
 * Runs of whitespace become one space; leading and trailing whitespace are dropped.
 * With `casefoldAndRemoveFiller`, "uh"/"um" are treated as whitespace and letters are lowercased.
 */
function collapseWhitespace(input: NormalizedText, casefoldAndRemoveFiller: boolean): NormalizedText {
  const removed = casefoldAndRemoveFiller ? fillerWordUnits(input.text) : new Set<number>();
  const output = new MappedTextBuilder();
  let pendingGapStart: number | undefined;
  let pendingGapEnd: number | undefined;

  for (let index = 0; index < input.text.length; ) {
    const char = String.fromCodePoint(input.text.codePointAt(index)!);
    const units = char.length;
    const sourceStart = input.sourceStarts[index]!;
    const sourceEnd = input.sourceEnds[index + units - 1]!;
    const isGap = /\s/u.test(char) || allUnitsRemoved(removed, index, units);

    if (isGap) {
      if (output.length > 0) {
        pendingGapStart ??= sourceStart;
        pendingGapEnd = sourceEnd;
      }
    } else {
      if (pendingGapStart !== undefined && pendingGapEnd !== undefined)
        output.append(" ", pendingGapStart, pendingGapEnd);
      pendingGapStart = undefined;
      pendingGapEnd = undefined;
      output.append(casefoldAndRemoveFiller ? char.toLocaleLowerCase("und") : char, sourceStart, sourceEnd);
    }
    index += units;
  }
  return output.build();
}

function fillerWordUnits(text: string): Set<number> {
  const removed = new Set<number>();
  for (const match of text.matchAll(FILLER_WORDS)) {
    const start = match.index ?? 0;
    for (let index = start; index < start + match[0].length; index += 1) removed.add(index);
  }
  return removed;
}

function allUnitsRemoved(removed: Set<number>, index: number, units: number): boolean {
  for (let offset = 0; offset < units; offset += 1) if (!removed.has(index + offset)) return false;
  return true;
}

class MappedTextBuilder {
  private text = "";
  private readonly sourceStarts: number[] = [];
  private readonly sourceEnds: number[] = [];

  get length(): number {
    return this.text.length;
  }

  /** Appends `output` and maps each of its UTF-16 units to the same source range. */
  append(output: string, sourceStart: number, sourceEnd: number): void {
    this.text += output;
    for (let unit = 0; unit < output.length; unit += 1) {
      this.sourceStarts.push(sourceStart);
      this.sourceEnds.push(sourceEnd);
    }
  }

  build(): NormalizedText {
    return {
      text: this.text,
      sourceStarts: this.sourceStarts,
      sourceEnds: this.sourceEnds,
    };
  }
}
