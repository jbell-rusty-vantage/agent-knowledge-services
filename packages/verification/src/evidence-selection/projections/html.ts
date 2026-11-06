import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import { findQuoteOccurrences } from "../quote-search.js";
import type { EvidenceSelection, EvidenceSelectionRequest } from "../selection.js";
import { normalizeText } from "../text-normalization.js";
import { resolveTextOffsetRange } from "../text-offsets.js";
import { resolvedText, unresolved } from "./report.js";
import { boundedArray, boundedString, fail, isRecord, only, required, type UnknownRecord } from "./shared.js";

export interface DomNode {
  readonly tag: string;
  readonly id?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly text?: string;
  readonly hidden?: boolean;
  readonly children?: readonly DomNode[];
}

export interface HtmlDomProjection {
  readonly kind: "html_dom";
  readonly document: DomNode;
  readonly canonicalText?: string;
}

type HtmlSelector = Extract<VerificationSelector, { kind: "html" }>;

const MAX_DOM_DEPTH = 64;
const MAX_LOCATOR_LENGTH = 256;
const MAX_FALLBACK_QUOTE_LENGTH = 100_000;
const TAG_NAME = /^[A-Za-z][A-Za-z0-9:-]*$/;
const ATTRIBUTE_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/;
const DOM_PATH = /^\d+(?:\/\d+)*$/;
const CSS_ID = /^#([A-Za-z][A-Za-z0-9_-]*)$/;
const CSS_TAG = /^[A-Za-z][A-Za-z0-9-]*$/;
const CSS_ATTRIBUTE = /^([A-Za-z][A-Za-z0-9-]*)?\[([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]+)"\]$/;
const XPATH = /^\/\/([A-Za-z][A-Za-z0-9-]*)(?:\[@(id|[A-Za-z_:][-A-Za-z0-9_:.]*)='([^']+)'\])?$/;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseHtml(input: UnknownRecord): HtmlDomProjection {
  only(input, ["kind", "document", "canonicalText"], "HTML");
  const canonicalText = input.canonicalText;
  if (canonicalText !== undefined && !boundedString(canonicalText)) fail("HTML_CANONICAL_TEXT");
  return {
    kind: "html_dom",
    document: parseNode(required(input.document, "DOCUMENT")),
    ...(canonicalText === undefined ? {} : { canonicalText }),
  };
}

function parseNode(input: unknown, depth = 0): DomNode {
  if (depth > MAX_DOM_DEPTH) fail("DOM_DEPTH");
  if (!isRecord(input)) fail("DOM_NODE");
  if (input.tag === "#text") return parseTextNode(input);
  only(input, ["tag", "id", "attributes", "text", "hidden", "children"], "DOM_NODE");
  const { tag, id, text, hidden } = input;
  if (!boundedString(tag) || !TAG_NAME.test(tag)) fail("DOM_NODE");
  if (id !== undefined && (!boundedString(id) || id.length === 0)) fail("DOM_ID");
  if (text !== undefined && !boundedString(text)) fail("DOM_TEXT");
  if (hidden !== undefined && typeof hidden !== "boolean") fail("DOM_HIDDEN");
  if (text !== undefined && input.children !== undefined) fail("DOM_MIXED_CONTENT_UNSUPPORTED");
  const attributes = input.attributes === undefined ? undefined : parseAttributes(input.attributes);
  const children =
    input.children === undefined
      ? undefined
      : boundedArray(input.children, "DOM_CHILDREN").map((child) => parseNode(child, depth + 1));
  return {
    tag: tag.toLowerCase(),
    ...(id === undefined ? {} : { id }),
    ...(attributes === undefined ? {} : { attributes }),
    ...(text === undefined ? {} : { text }),
    ...(hidden === undefined ? {} : { hidden }),
    ...(children === undefined ? {} : { children }),
  };
}

function parseTextNode(input: UnknownRecord): DomNode {
  only(input, ["tag", "text"], "DOM_TEXT_NODE");
  const { text } = input;
  if (!boundedString(text) || text.length === 0) fail("DOM_TEXT_NODE");
  return { tag: "#text", text };
}

function parseAttributes(input: unknown): Record<string, string> {
  if (!isRecord(input)) fail("DOM_ATTRIBUTES");
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ATTRIBUTE_NAME.test(key) || !boundedString(value)) fail("DOM_ATTRIBUTE");
    attributes[key] = value;
  }
  if (attributes.id !== undefined) fail("DOM_ID_ATTRIBUTE_DUPLICATE");
  return attributes;
}

// ---------------------------------------------------------------------------
// DOM queries (visible nodes only; script and style never contribute text)
// ---------------------------------------------------------------------------

const visibleNode = (node: DomNode): boolean => !node.hidden && node.tag !== "script" && node.tag !== "style";

export function domText(node: DomNode): string {
  return !visibleNode(node)
    ? ""
    : node.tag === "#text"
      ? (node.text ?? "")
      : (node.text ?? (node.children ?? []).map(domText).join(""));
}

export function domAtPath(root: DomNode, path: string): DomNode | undefined {
  if (!DOM_PATH.test(path)) return undefined;
  if (!visibleNode(root)) return undefined;
  let current: DomNode | undefined = root;
  for (const rawIndex of path.split("/")) {
    current = current?.children?.[Number(rawIndex)];
    if (!current || !visibleNode(current)) return undefined;
  }
  return current;
}

export function walk(root: DomNode): DomNode[] {
  return !visibleNode(root) ? [] : [root, ...(root.children ?? []).flatMap(walk)];
}

export function cssMatches(root: DomNode, css: string): DomNode[] {
  const id = CSS_ID.exec(css);
  const tag = CSS_TAG.exec(css);
  const attribute = CSS_ATTRIBUTE.exec(css);
  if (!id && !tag && !attribute) return [];
  return walk(root).filter(
    (node) =>
      node.tag !== "#text" &&
      (id
        ? node.id === id[1]
        : tag
          ? node.tag === tag[0].toLowerCase()
          : (attribute![1] === undefined || node.tag === attribute![1]!.toLowerCase()) &&
            node.attributes?.[attribute![2]!] === attribute![3]),
  );
}

export function xpathMatches(root: DomNode, xpath: string): DomNode[] {
  const match = XPATH.exec(xpath);
  if (!match) return [];
  return walk(root).filter(
    (node) =>
      node.tag !== "#text" &&
      node.tag === match[1]!.toLowerCase() &&
      (match[2] === undefined || (match[2] === "id" ? node.id : node.attributes?.[match[2]!]) === match[3]),
  );
}

// ---------------------------------------------------------------------------
// Resolution: locate one node → agree with the canonical-text fallback → refine the range
// ---------------------------------------------------------------------------

export function resolveHtml(
  request: EvidenceSelectionRequest,
  projection: HtmlDomProjection,
  selector: HtmlSelector,
): EvidenceSelection {
  if (
    (selector.css?.length ?? 0) > MAX_LOCATOR_LENGTH ||
    (selector.xpath?.length ?? 0) > MAX_LOCATOR_LENGTH ||
    (selector.domPath?.length ?? 0) > MAX_LOCATOR_LENGTH ||
    (selector.canonicalTextFallback?.quote.length ?? 0) > MAX_FALLBACK_QUOTE_LENGTH
  )
    return unresolved(request, "invalid");
  const located = locateDomNode(request, projection.document, selector);
  if ("resolution" in located) return located;
  const selected = domText(located.node);
  if (selected.length === 0) return unresolved(request, "not_found");
  if (selector.canonicalTextFallback !== undefined) {
    const disagreement = agreeWithCanonicalTextFallback(
      request,
      { canonicalText: projection.canonicalText, selected },
      selector.canonicalTextFallback,
    );
    if (disagreement) return disagreement;
  }
  return refineTextRange(request, selected, selector.textRange);
}

/** Every declared locator (css, xpath, domPath) must name exactly one node, and they must all name the same node. */
function locateDomNode(
  request: EvidenceSelectionRequest,
  document: DomNode,
  selector: HtmlSelector,
): { node: DomNode } | EvidenceSelection {
  const candidates: DomNode[][] = [];
  if (selector.css !== undefined) {
    const values = cssMatches(document, selector.css);
    if (values.length !== 1) return unresolved(request, values.length > 1 ? "ambiguous" : "invalid", values.length);
    candidates.push(values);
  }
  if (selector.xpath !== undefined) {
    const values = xpathMatches(document, selector.xpath);
    if (values.length !== 1) return unresolved(request, values.length > 1 ? "ambiguous" : "invalid", values.length);
    candidates.push(values);
  }
  if (selector.domPath !== undefined) {
    const node = domAtPath(document, selector.domPath);
    if (!node) return unresolved(request, "invalid");
    candidates.push([node]);
  }
  if (candidates.length === 0 || candidates.some((candidate) => candidate[0] !== candidates[0]![0]))
    return unresolved(request, "invalid");
  return { node: candidates[0]![0]! };
}

/**
 * The fallback quote must occur exactly once in the projection's canonical text and must equal the
 * selected DOM text under the same normalization. It confirms the DOM selection; it never locates one.
 * Returns the failing selection, or `undefined` when the fallback agrees.
 */
function agreeWithCanonicalTextFallback(
  request: EvidenceSelectionRequest,
  text: {
    readonly canonicalText: string | undefined;
    readonly selected: string;
  },
  fallback: NonNullable<HtmlSelector["canonicalTextFallback"]>,
): EvidenceSelection | undefined {
  if (fallback.normalization === "casefold_whitespace_filler_removed" || text.canonicalText === undefined)
    return unresolved(request, "invalid");
  const normalize = (value: string) => normalizeText(value, fallback.normalization).text;
  const canonical = normalize(text.canonicalText);
  const quote = normalize(fallback.quote);
  if (quote.length === 0) return unresolved(request, "invalid");
  const occurrences = findQuoteOccurrences(canonical, quote, fallback);
  if (occurrences.length !== 1 || normalize(text.selected) !== quote)
    return unresolved(request, occurrences.length > 1 ? "ambiguous" : "invalid", occurrences.length);
  return undefined;
}

/**
 * A range refines the already unique DOM selection. It never locates a node,
 * substitutes for fallback agreement, normalizes text, or splits a code point.
 */
function refineTextRange(
  request: EvidenceSelectionRequest,
  selected: string,
  textRange: HtmlSelector["textRange"],
): EvidenceSelection {
  if (textRange === undefined)
    return resolvedText(request, selected, [
      {
        start: 0,
        end: selected.length,
        coordinateSpace: "html_dom_text_utf16",
      },
    ]);
  const range = resolveTextOffsetRange(selected, {
    ...textRange,
    offsetBasis: "utf16_code_units",
  });
  if (!range) return unresolved(request, "invalid");
  return resolvedText(request, selected.slice(range.start, range.end), [
    { ...range, coordinateSpace: "html_dom_text_utf16" },
  ]);
}
