import { convertTextToNodes, type ConversionNode } from "@aiengineer/knowledge-preparation";
import { sha256Hex } from "../db-read/canonical.js";
import { domainError } from "../schema-workspace/index.js";
import { deterministicId } from "../ingestion/plan.js";

/**
 * The quotable units of one captured text, in the AI Engineer database's grammar (`content.unit_kind`). Text,
 * Markdown and HTML go through Knowledge Services' own deterministic conversion (`convertTextToNodes` of
 * packages/preparation); JSON is split into its members with their exact source spans. Every unit's text is a slice
 * of the representation it is read from, so a quote located in the capture text is verbatim in one unit.
 */

/** The captured media types a capture can be registered from; anything else is refused. */
export const CAPTURE_REGISTRATION_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "text/html",
  "application/json",
] as const;
export type CaptureRegistrationMediaType = (typeof CAPTURE_REGISTRATION_MEDIA_TYPES)[number];

/** The grammar that produced the units; recorded on the representation and every unit. */
export const CAPTURE_UNIT_GRAMMAR = "ks-capture-units/1";
export const MAX_CAPTURE_UNITS = 5_000;
export const MAX_CAPTURE_TEXT_CHARS = 8_000_000;
/** A JSON member whose source is longer than this is split into its own members (to `MAX_JSON_DEPTH`). */
const JSON_SPLIT_CHARS = 2_000;
const MAX_JSON_DEPTH = 4;

export interface CaptureUnit {
  readonly id: string;
  readonly ordinal: number;
  readonly unitKind: string;
  readonly stableLocalKey: string;
  readonly logicalKey: string;
  readonly text: string;
  /** UTF-16 offsets into the representation text, when the unit is a verbatim slice of it. */
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  readonly startMs: number | null;
  readonly endMs: number | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly selector: Readonly<Record<string, unknown>>;
  readonly contentSha256: string;
}

export function normalizeCaptureMediaType(value: string): string {
  const base = (value.split(";")[0] ?? "").trim().toLowerCase();
  if (base === "text/x-markdown") return "text/markdown";
  if (base === "application/xhtml+xml") return "text/html";
  return base;
}

export function isCaptureRegistrationMediaType(value: string): value is CaptureRegistrationMediaType {
  return (CAPTURE_REGISTRATION_MEDIA_TYPES as readonly string[]).includes(value);
}

/** The `content.format` code of a captured media type. */
export function captureFormatCode(mediaType: CaptureRegistrationMediaType): string {
  return { "text/plain": "text", "text/markdown": "markdown", "text/html": "html", "application/json": "json" }[
    mediaType
  ];
}

/**
 * Plans the units of a representation text. `sourceMediaType` is the media type of what was captured: for HTML the
 * text is the executor's tag-stripped rendering (one block per line), for JSON the raw document.
 */
export function planCaptureUnits(input: {
  readonly representationId: string;
  readonly text: string;
  readonly sourceMediaType: CaptureRegistrationMediaType;
}): CaptureUnit[] {
  if (input.text.length > MAX_CAPTURE_TEXT_CHARS)
    throw domainError(
      "CAPTURE_TOO_LARGE",
      `CAPTURE_TOO_LARGE: the captured text has ${input.text.length} characters; at most ${MAX_CAPTURE_TEXT_CHARS} are registered.`,
      { characters: input.text.length, maximum: MAX_CAPTURE_TEXT_CHARS },
    );
  const units =
    input.sourceMediaType === "application/json"
      ? jsonUnits(input.representationId, input.text)
      : textUnits(input.representationId, input.text, input.sourceMediaType);
  if (units.length === 0)
    throw domainError(
      "CAPTURE_HAS_NO_TEXT",
      "CAPTURE_HAS_NO_TEXT: the capture has no text to quote. Capture a page or file with text, then register it.",
    );
  if (units.length > MAX_CAPTURE_UNITS)
    throw domainError(
      "CAPTURE_TOO_MANY_UNITS",
      `CAPTURE_TOO_MANY_UNITS: the capture splits into ${units.length} units; at most ${MAX_CAPTURE_UNITS} are registered. Capture a smaller page or file.`,
      { units: units.length, maximum: MAX_CAPTURE_UNITS },
    );
  return units;
}

// ---- text, Markdown, HTML ------------------------------------------------------------------------------------------

const TEXT_UNIT_KIND: Partial<Record<ConversionNode["kind"], string>> = {
  heading: "section",
  paragraph: "paragraph",
  list: "list",
  code_block: "code_block",
  table: "table",
  quotation: "quote",
  transcript_segment: "transcript_segment",
};

function textUnits(representationId: string, text: string, mediaType: CaptureRegistrationMediaType): CaptureUnit[] {
  // The executor renders HTML as one block per line, without blank lines; the converter splits on blank lines.
  const blocks = mediaType === "text/html" ? text.replace(/\r\n?/g, "\n").replace(/\n+/g, "\n\n") : text;
  const converted = convertTextToNodes(
    blocks,
    mediaType === "text/plain" ? "text/plain" : "text/markdown",
    representationId,
  );
  const units: CaptureUnit[] = [];
  let cursor = 0;
  for (const node of converted.nodes) {
    if (node.kind === "document" || node.text.trim() === "") continue;
    const found = text.indexOf(node.text, cursor);
    const startOffset = found >= 0 ? found : null;
    if (found >= 0) cursor = found + node.text.length;
    let unitKind = TEXT_UNIT_KIND[node.kind] ?? "paragraph";
    if (unitKind === "transcript_segment" && node.locator.startTimeMs === undefined) unitKind = "paragraph";
    const path = node.locator.sectionPath?.join(" > ");
    const ordinal = units.length;
    units.push({
      id: node.id,
      ordinal,
      unitKind,
      stableLocalKey: `u${ordinal}`,
      logicalKey: `${unitKind}:${sha256Hex(node.text).slice(0, 24)}`,
      text: node.text,
      startOffset,
      endOffset: startOffset === null ? null : startOffset + node.text.length,
      startMs: unitKind === "transcript_segment" ? (node.locator.startTimeMs ?? null) : null,
      endMs: unitKind === "transcript_segment" ? (node.locator.endTimeMs ?? null) : null,
      attributes: textAttributes(unitKind, node, path),
      selector: { kind: "text_quote" },
      contentSha256: sha256Hex(node.text),
    });
  }
  return units;
}

function textAttributes(unitKind: string, node: ConversionNode, path: string | undefined): Record<string, unknown> {
  const withPath = path ? { path } : {};
  switch (unitKind) {
    case "section": {
      const level = /^(#{1,6})\s/.exec(node.text)?.[1]?.length;
      return { ...withPath, ...(node.label ? { heading: node.label } : {}), ...(level ? { level } : {}) };
    }
    case "list":
      return {
        ...withPath,
        items: node.text.split("\n").filter((line) => /^\s*(?:[-*+]|\d+\.)\s/.test(line)).length,
        ordered: /^\s*\d+\.\s/.test(node.text),
      };
    case "code_block": {
      const language = /^```([A-Za-z0-9_+-]+)/.exec(node.text)?.[1];
      return { ...withPath, lines: node.text.split("\n").length, ...(language ? { language } : {}) };
    }
    case "table":
      return { ...withPath, rows: node.text.split("\n").filter((line) => line.trim().startsWith("|")).length };
    case "transcript_segment":
      return {
        ...withPath,
        t0_ms: node.locator.startTimeMs,
        ...(node.locator.endTimeMs === undefined ? {} : { t1_ms: node.locator.endTimeMs }),
        ...(node.locator.speaker ? { speaker: node.locator.speaker } : {}),
      };
    default:
      return withPath;
  }
}

// ---- JSON ----------------------------------------------------------------------------------------------------------

interface JsonSpan {
  readonly pointer: string;
  /** The member (`"key": value`) or element source. */
  readonly start: number;
  readonly end: number;
  /** The value source alone. */
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly depth: number;
}

const escapePointer = (token: string): string => token.replace(/~/g, "~0").replace(/\//g, "~1");
const isSpace = (code: number): boolean => code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;

function skipSpace(text: string, at: number): number {
  let index = at;
  while (index < text.length && isSpace(text.charCodeAt(index))) index += 1;
  return index;
}

/** The end (exclusive) of the JSON value that starts at `at`; the document is already known to parse. */
function valueEnd(text: string, at: number): number {
  const first = text[at];
  if (first === '"') {
    let index = at + 1;
    while (index < text.length) {
      const character = text[index];
      if (character === "\\") index += 2;
      else if (character === '"') return index + 1;
      else index += 1;
    }
    return text.length;
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    let index = at;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index = valueEnd(text, index);
        continue;
      }
      if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
      index += 1;
    }
    return text.length;
  }
  let index = at;
  while (index < text.length && !/[\s,}\]]/.test(text.charAt(index))) index += 1;
  return index;
}

/** The members of the container value at `at` (an object's members or an array's elements). */
function members(text: string, at: number, pointer: string, depth: number): JsonSpan[] {
  const open = text[at];
  const close = open === "{" ? "}" : "]";
  const spans: JsonSpan[] = [];
  let index = skipSpace(text, at + 1);
  let element = 0;
  while (index < text.length && text[index] !== close) {
    const start = index;
    let token = String(element);
    if (open === "{") {
      const keyEnd = valueEnd(text, index);
      token = JSON.parse(text.slice(index, keyEnd)) as string;
      index = skipSpace(text, keyEnd);
      index = skipSpace(text, index + 1); // the colon
    }
    const valueStart = index;
    const end = valueEnd(text, valueStart);
    spans.push({ pointer: `${pointer}/${escapePointer(token)}`, start, end, valueStart, valueEnd: end, depth });
    index = skipSpace(text, end);
    if (text[index] === ",") index = skipSpace(text, index + 1);
    element += 1;
  }
  return spans;
}

function jsonSpans(text: string, span: JsonSpan): JsonSpan[] {
  const first = text[span.valueStart];
  const container = first === "{" || first === "[";
  if (!container || span.end - span.start <= JSON_SPLIT_CHARS || span.depth >= MAX_JSON_DEPTH) return [span];
  const inner = members(text, span.valueStart, span.pointer, span.depth + 1);
  return inner.length === 0 ? [span] : inner.flatMap((child) => jsonSpans(text, child));
}

function jsonUnits(representationId: string, text: string): CaptureUnit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw domainError(
      "CAPTURE_JSON_INVALID",
      `CAPTURE_JSON_INVALID: the capture is declared JSON but does not parse (${(error as Error).message}).`,
    );
  }
  const root = skipSpace(text, 0);
  const first = text[root];
  const topLevel =
    (first === "{" || first === "[") && parsed !== null && typeof parsed === "object"
      ? members(text, root, "", 1).flatMap((span) => jsonSpans(text, span))
      : [];
  if (topLevel.length === 0) {
    // A scalar or an empty container: one unit for the whole document, quoted as text.
    const body = text.trim();
    if (body === "") return [];
    const start = text.indexOf(body);
    return [unit(representationId, 0, "document_root", "json:", body, start, {}, { kind: "text_quote" })];
  }
  return topLevel.map((span, ordinal) => {
    const source = text.slice(span.start, span.end);
    const value = JSON.parse(text.slice(span.valueStart, span.valueEnd)) as unknown;
    const scalar = value === null || typeof value !== "object";
    return unit(
      representationId,
      ordinal,
      "metadata_field",
      `json:${span.pointer}`,
      source,
      span.start,
      { key: span.pointer, ...(scalar ? { value } : {}) },
      { kind: "json_pointer", pointer: span.pointer },
    );
  });
}

function unit(
  representationId: string,
  ordinal: number,
  unitKind: string,
  logicalKey: string,
  text: string,
  startOffset: number,
  attributes: Record<string, unknown>,
  selector: Record<string, unknown>,
): CaptureUnit {
  return {
    id: deterministicId("content.document_node", `${representationId}\0${ordinal}\0${logicalKey}`),
    ordinal,
    unitKind,
    stableLocalKey: `u${ordinal}`,
    logicalKey,
    text,
    startOffset,
    endOffset: startOffset + text.length,
    startMs: null,
    endMs: null,
    attributes,
    selector,
    contentSha256: sha256Hex(text),
  };
}
