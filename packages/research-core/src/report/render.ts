import { type Digest, type Ref, digestBytes } from "@aiengineer/knowledge-operation-protocol";
import { type Span, span } from "../records/common.js";
import {
  type Block,
  type Inline,
  NORMALIZATION_VERSION,
  RENDERER_VERSION,
  type StructuredBody,
  StructuredBodySchema,
} from "../records/report.js";

export type UnitKind =
  | "heading"
  | "paragraph"
  | "list_item"
  | "table_header_cell"
  | "table_cell"
  | "caption"
  | "code"
  | "reference";

/** One structural unit of the frozen body. `span` is null for an empty unit (an empty table cell). */
export interface RenderedUnit {
  readonly path: string;
  readonly kind: UnitKind;
  readonly span: Span | null;
  readonly factual: boolean;
  readonly excludedReason: string | null;
}

export interface RenderedClaim {
  readonly occurrenceId: string;
  readonly assertion: Ref<"assertion">;
  readonly obligations: readonly string[];
  readonly attribution: string | null;
  readonly blockPath: string;
  readonly span: Span;
  readonly quoteDigest: Digest;
}

export interface FrozenReport {
  readonly renderer: typeof RENDERER_VERSION;
  readonly normalization: typeof NORMALIZATION_VERSION;
  readonly text: string;
  /** Exact UTF-8 bytes; `bodyDigest` is their SHA-256. */
  readonly bytes: Uint8Array;
  readonly bodyDigest: Digest;
  readonly units: readonly RenderedUnit[];
  readonly claims: readonly RenderedClaim[];
}

export class RenderError extends Error {
  readonly code: "BLANK_LINE_IN_INLINE" | "LINE_BREAK_NOT_ALLOWED" | "CODE_FENCE_IN_CODE" | "CITATION_LABEL_CONFLICT";
  constructor(code: RenderError["code"], message: string) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

interface RawUnit {
  path: string;
  kind: UnitKind;
  start: number;
  end: number;
  excludedReason: string | null;
}
interface RawClaim {
  inline: Extract<Inline, { type: "claim" }>;
  path: string;
  start: number;
  end: number;
}

const SPECIAL = /[\\`*_[\]<>|#]/g;
const LINE_BREAK = /\r\n|\r|\n/;
const BLANK_LINE = /(?:\r\n|\r(?!\n)|\n)[ \t]*(?:\r\n|\r|\n)/;

function escapeLineStart(line: string): string {
  const marker = /^([-+=]|\d+[.)])/.exec(line);
  if (marker === null) return line;
  const lead = marker[0];
  return /^\d/.test(lead) ? `${lead.slice(0, -1)}\\${lead.slice(-1)}${line.slice(lead.length)}` : `\\${line}`;
}

/** Escape Markdown syntax so authored text renders literally. Line-leading list/heading markers are escaped too. */
export function escapeMarkdown(text: string, atLineStart: boolean): string {
  const escaped = text.replace(SPECIAL, "\\$&");
  const parts = escaped.split(/(\r\n|\r|\n)/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return index > 0 || atLineStart ? escapeLineStart(part) : part;
    })
    .join("");
}

class Writer {
  private readonly parts: string[] = [];
  length = 0;
  readonly units: RawUnit[] = [];
  readonly claims: RawClaim[] = [];
  readonly citations = new Map<string, Ref<"fragment">>();

  push(text: string): void {
    this.parts.push(text);
    this.length += text.length;
  }

  text(): string {
    return this.parts.join("");
  }
}

function inlines(writer: Writer, items: readonly Inline[], path: string, options: { allowLineBreaks: boolean }): void {
  items.forEach((item, index) => {
    const atLineStart = index === 0;
    if (item.type === "citation") {
      const existing = writer.citations.get(item.label);
      if (existing !== undefined && existing.digest !== item.fragment.digest) {
        throw new RenderError("CITATION_LABEL_CONFLICT", `label ${item.label} names two fragments`);
      }
      writer.citations.set(item.label, item.fragment);
      writer.push(`[^${item.label}]`);
      return;
    }
    if (BLANK_LINE.test(item.text)) throw new RenderError("BLANK_LINE_IN_INLINE", `blank line in ${path}`);
    if (!options.allowLineBreaks && LINE_BREAK.test(item.text)) {
      throw new RenderError("LINE_BREAK_NOT_ALLOWED", `line break in ${path}`);
    }
    const start = writer.length;
    writer.push(escapeMarkdown(item.text, atLineStart));
    if (item.type === "claim") writer.claims.push({ inline: item, path, start, end: writer.length });
  });
}

function unit(writer: Writer, path: string, kind: UnitKind, excludedReason: string | null, write: () => void): void {
  const start = writer.length;
  write();
  writer.units.push({ path, kind, start, end: writer.length, excludedReason });
}

function block(writer: Writer, sectionId: string, item: Block): void {
  const path = `${sectionId}/${item.id}`;
  switch (item.type) {
    case "paragraph":
      unit(writer, path, "paragraph", item.excludedReason, () =>
        inlines(writer, item.inlines, path, { allowLineBreaks: true }),
      );
      return;
    case "list":
      item.items.forEach((entry, index) => {
        if (index > 0) writer.push("\n");
        writer.push(item.ordered ? `${index + 1}. ` : "- ");
        unit(writer, `${path}/i${index}`, "list_item", item.excludedReason, () =>
          inlines(writer, entry, `${path}/i${index}`, { allowLineBreaks: false }),
        );
      });
      return;
    case "table": {
      const row = (cells: readonly (readonly Inline[])[], prefix: string, kind: UnitKind, reason: string | null) => {
        writer.push("|");
        cells.forEach((cell, index) => {
          writer.push(" ");
          unit(writer, `${prefix}c${index}`, kind, reason, () =>
            inlines(writer, cell, `${prefix}c${index}`, { allowLineBreaks: false }),
          );
          writer.push(" |");
        });
      };
      row(item.header, `${path}/h/`, "table_header_cell", item.headerExcludedReason ?? item.excludedReason);
      writer.push(`\n|${item.header.map(() => " --- |").join("")}`);
      item.rows.forEach((cells, index) => {
        writer.push("\n");
        row(cells, `${path}/r${index}/`, "table_cell", item.excludedReason);
      });
      if (item.caption !== null) {
        const caption = item.caption;
        writer.push("\n\nTable: ");
        unit(writer, `${path}/caption`, "caption", item.excludedReason, () =>
          inlines(writer, caption, `${path}/caption`, { allowLineBreaks: false }),
        );
      }
      return;
    }
    case "code":
      if (item.text.includes("```")) throw new RenderError("CODE_FENCE_IN_CODE", `fence inside ${path}`);
      writer.push(`\`\`\`${item.language ?? ""}\n`);
      unit(writer, path, "code", item.excludedReason, () => writer.push(item.text));
      writer.push("\n```");
      return;
  }
}

/**
 * Freeze normalization (`research-report-normalization.v1`, see records/report.ts). Deletes CR before LF and spaces/tabs
 * before line ends, maps lone CR to LF, and ends with exactly one LF. Returns the raw-offset -> frozen-offset map.
 * There is deliberately no Unicode normalization.
 */
export function normalizeForFreeze(raw: string): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = new Array<number>(raw.length + 1).fill(0);
  let pending: number[] = [];
  const drop = () => {
    for (const index of pending) map[index] = out.length;
    pending = [];
  };
  for (let index = 0; index < raw.length; index += 1) {
    let char = raw[index] ?? "";
    if (char === "\r") {
      if (raw[index + 1] === "\n") {
        drop();
        map[index] = out.length;
        continue;
      }
      char = "\n";
    }
    if (char === "\n") {
      drop();
      map[index] = out.length;
      out.push("\n");
      continue;
    }
    if (char === " " || char === "\t") {
      pending.push(index);
      continue;
    }
    for (const kept of pending) {
      map[kept] = out.length;
      out.push(raw[kept] ?? "");
    }
    pending = [];
    map[index] = out.length;
    out.push(char);
  }
  drop();
  while (out.length > 0 && out[out.length - 1] === "\n") out.pop();
  const length = out.length;
  out.push("\n");
  for (let index = 0; index < map.length; index += 1) map[index] = Math.min(map[index] ?? 0, length);
  map[raw.length] = length;
  return { text: out.join(""), map };
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Digest of the exact UTF-8 bytes of a span of the frozen body. */
export function quoteDigest(text: string, at: Span): Digest {
  return digestBytes(utf8(text.slice(at.start, at.end)));
}

/** Render a structured body deterministically to Markdown with pinned renderer and normalization, then freeze it. */
export function renderReport(input: StructuredBody): FrozenReport {
  const body = StructuredBodySchema.parse(input);
  const writer = new Writer();
  body.sections.forEach((section, index) => {
    if (index > 0) writer.push("\n\n");
    writer.push("## ");
    unit(writer, `${section.id}/heading`, "heading", section.headingExcludedReason, () =>
      inlines(writer, section.heading, `${section.id}/heading`, { allowLineBreaks: false }),
    );
    for (const item of section.blocks) {
      writer.push("\n\n");
      block(writer, section.id, item);
    }
  });
  const labels = [...writer.citations.keys()].sort();
  if (labels.length > 0) writer.push("\n");
  for (const label of labels) {
    const fragment = writer.citations.get(label);
    if (fragment === undefined) continue;
    writer.push("\n");
    unit(writer, `references/${label}`, "reference", "citation_reference", () =>
      writer.push(`[^${label}]: fragment ${fragment.tenant}/${fragment.binding}/${fragment.id} ${fragment.digest}`),
    );
  }
  writer.push("\n");

  const { text, map } = normalizeForFreeze(writer.text());
  const at = (offset: number) => map[offset] ?? text.length;
  const units: RenderedUnit[] = writer.units.map((raw) => {
    const start = at(raw.start);
    const end = at(raw.end);
    return {
      path: raw.path,
      kind: raw.kind,
      span: start < end ? span(start, end) : null,
      factual: raw.excludedReason === null && start < end,
      excludedReason: raw.excludedReason,
    };
  });
  const claims: RenderedClaim[] = writer.claims.map((raw) => {
    const claimSpan = span(at(raw.start), at(raw.end));
    return {
      occurrenceId: raw.inline.occurrenceId,
      assertion: raw.inline.assertion,
      obligations: raw.inline.obligations,
      attribution: raw.inline.attribution,
      blockPath: raw.path,
      span: claimSpan,
      quoteDigest: quoteDigest(text, claimSpan),
    };
  });
  const bytes = utf8(text);
  return {
    renderer: RENDERER_VERSION,
    normalization: NORMALIZATION_VERSION,
    text,
    bytes,
    bodyDigest: digestBytes(bytes),
    units,
    claims,
  };
}
