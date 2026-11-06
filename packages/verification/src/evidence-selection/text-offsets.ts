interface TextOffsetRange {
  readonly start: number;
  readonly end: number;
  readonly offsetBasis: "utf8_bytes" | "utf16_code_units" | "unicode_code_points";
}

interface Utf16Range {
  readonly start: number;
  readonly end: number;
}

const utf8 = new TextEncoder();

/** Converts a nonempty, code-point-aligned range for slicing; callers retain the declared coordinates. */
export function resolveTextOffsetRange(text: string, range: TextOffsetRange): Utf16Range | undefined {
  const { start, end, offsetBasis } = range;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return undefined;

  if (offsetBasis === "utf16_code_units") {
    const startsInsideSurrogatePair = start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!);
    const endsInsideSurrogatePair = end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!);
    if (end > text.length || startsInsideSurrogatePair || endsInsideSurrogatePair) return undefined;
    return { start, end };
  }

  if (offsetBasis === "unicode_code_points") {
    const points = [...text];
    if (end > points.length) return undefined;
    return {
      start: points.slice(0, start).join("").length,
      end: points.slice(0, end).join("").length,
    };
  }

  const bytes = utf8.encode(text);
  if (end > bytes.length) return undefined;
  try {
    // Each slice is already text; an initial U+FEFF is content, not a stream BOM.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const prefix = decoder.decode(bytes.slice(0, start));
    const selection = decoder.decode(bytes.slice(start, end));
    return { start: prefix.length, end: prefix.length + selection.length };
  } catch {
    return undefined;
  }
}
