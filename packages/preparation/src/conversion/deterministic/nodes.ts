import { sha256Digest } from "@aiengineer/knowledge-core";
import { deterministicUuid } from "@aiengineer/knowledge-core";
import { isHtmlMediaType } from "../media-type.js";
import type { ConversionLocator, ConversionNode, ConversionNodeKind } from "../types.js";

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const WEBVTT_HEADER = "WEBVTT";
const SPEAKER_LABEL_PATTERN = /^([^:\n]{1,80}):\s/;
const TIMED_BLOCK =
  /^(?:\[)?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)(?:\])?(?:\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?))?\s*\n?([\s\S]*)$/;
const TRANSCRIPT_START = /^(?:\[)?\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:\])?\s/m;
const HTML_FRAGMENT = "html";
const VTT_FRAGMENT = "vtt";

const HTML_ENTITIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&amp;/gi, "&"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#39;/gi, "'"],
];

interface ClassifiedBlock {
  kind: ConversionNodeKind;
  label?: string;
  headingLevel?: number;
  timed?: RegExpMatchArray;
}

function decodeEntities(value: string): string {
  return HTML_ENTITIES.reduce((decoded, [pattern, replacement]) => decoded.replace(pattern, replacement), value);
}

function normalize(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function timestampToMilliseconds(value: string): number {
  const parts = value.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  const seconds =
    parts.length === 3
      ? parts[0]! * SECONDS_PER_HOUR + parts[1]! * SECONDS_PER_MINUTE + parts[2]!
      : parts[0]! * SECONDS_PER_MINUTE + parts[1]!;
  return Math.round(seconds * MILLISECONDS_PER_SECOND);
}

function addNode(input: {
  nodes: ConversionNode[];
  representationKey: string;
  kind: ConversionNodeKind;
  text: string;
  locator: ConversionLocator;
  parentId?: string;
  label?: string;
}): ConversionNode {
  const ordinal = input.nodes.length;
  const contentDigest = sha256Digest(input.text);
  const id = deterministicUuid("document-node", `${input.representationKey}:${ordinal}:${input.kind}:${contentDigest}`);
  const node: ConversionNode = {
    id,
    ordinal,
    kind: input.kind,
    text: input.text,
    contentDigest,
    locator: input.locator,
  };
  if (input.parentId) node.parentId = input.parentId;
  if (input.label) node.label = input.label;
  input.nodes.push(node);
  return node;
}

function stripHtml(source: string): string {
  return normalize(
    decodeEntities(
      source
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(
          /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
          (_match, level: string, text: string) => `\n${"#".repeat(Number(level))} ${text.replace(/<[^>]+>/g, " ")}\n`,
        )
        .replace(
          /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
          (_match, code: string) => `\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, ""))}\n\`\`\`\n`,
        )
        .replace(/<li[^>]*>/gi, "\n- ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function classifyHeading(text: string): ClassifiedBlock | undefined {
  const heading = text.match(/^(#{1,6})\s+(.+)$/s);
  if (!heading) return undefined;
  return {
    kind: "heading",
    label: heading[2]!.trim(),
    headingLevel: heading[1]!.length,
  };
}

function classifyTimedTranscript(text: string): ClassifiedBlock | undefined {
  const timed = text.match(TIMED_BLOCK);
  if (!timed) return undefined;
  const speaker = timed[3]?.match(SPEAKER_LABEL_PATTERN)?.[1];
  return speaker ? { kind: "transcript_segment", label: speaker, timed } : { kind: "transcript_segment", timed };
}

function classifyProse(text: string): ClassifiedBlock {
  if (text.startsWith("```") && text.endsWith("```")) return { kind: "code_block" };
  if (/^(?:[-*+] |\d+\. )/m.test(text)) return { kind: "list" };
  if (/^\|.+\|\n\|[- :|]+\|/m.test(text)) return { kind: "table" };
  if (/^>\s/m.test(text)) return { kind: "quotation" };
  return { kind: "paragraph" };
}

function classifyTranscriptBlock(text: string): ClassifiedBlock {
  return classifyHeading(text) ?? classifyTimedTranscript(text) ?? classifyProse(text);
}

function classifyProseBlock(text: string): ClassifiedBlock {
  return classifyHeading(text) ?? classifyProse(text);
}

function shouldStripHtml(mediaType: string): boolean {
  return isHtmlMediaType(mediaType) || mediaType.includes(HTML_FRAGMENT);
}

function looksLikeTranscript(mediaType: string, source: string): boolean {
  return mediaType.includes(VTT_FRAGMENT) || TRANSCRIPT_START.test(source);
}

function withTranscriptTimes(locator: ConversionLocator, classified: ClassifiedBlock): ConversionLocator {
  if (classified.kind !== "transcript_segment" || !classified.timed) {
    return locator;
  }
  return {
    ...locator,
    startTimeMs: timestampToMilliseconds(classified.timed[1]!),
    ...(classified.timed[2] ? { endTimeMs: timestampToMilliseconds(classified.timed[2]) } : {}),
    ...(classified.label ? { speaker: classified.label } : {}),
  };
}

function markdownToPlainText(source: string): string {
  return source
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^```.*$/gm, "")
    .replace(/^[-*+]\s+/gm, "");
}

export function convertTextToNodes(
  input: string,
  mediaType: string,
  representationKey: string,
): { nodes: ConversionNode[]; markdown: string; plainText: string } {
  let source = normalize(input);
  const nodes: ConversionNode[] = [];
  const root = addNode({
    nodes,
    representationKey,
    kind: "document",
    text: source,
    locator: { startOffset: 0, endOffset: source.length },
  });
  if (shouldStripHtml(mediaType)) {
    source = stripHtml(source);
  }
  const transcript = looksLikeTranscript(mediaType, source);
  const headings: { level: number; label: string }[] = [];
  let cursor = 0;
  for (const raw of source.split(/\n{2,}/)) {
    const text = raw.trim();
    if (!text || text === WEBVTT_HEADER) continue;
    const startOffset = source.indexOf(text, cursor);
    cursor = startOffset + text.length;
    const classified = transcript ? classifyTranscriptBlock(text) : classifyProseBlock(text);
    if (classified.kind === "heading" && classified.label && classified.headingLevel) {
      while (headings.at(-1) && headings.at(-1)!.level >= classified.headingLevel) {
        headings.pop();
      }
      headings.push({ level: classified.headingLevel, label: classified.label });
    }
    const locator = withTranscriptTimes(
      {
        startOffset,
        endOffset: startOffset + text.length,
        sectionPath: headings.map((heading) => heading.label),
      },
      classified,
    );
    addNode({
      nodes,
      representationKey,
      kind: classified.kind,
      text,
      locator,
      parentId: root.id,
      ...(classified.label ? { label: classified.label } : {}),
    });
  }
  return {
    nodes,
    markdown: source,
    plainText: markdownToPlainText(source),
  };
}
