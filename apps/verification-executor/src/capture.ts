import type { CaptureRecord, FilesystemStore } from "./store.js";
import { encoder, shortId } from "./store.js";
import { sha256Digest } from "@aiengineer/knowledge-verification";

export const CAPTURE_METHOD_VERSION = "verification-executor-capture.v2";

export interface CaptureInput {
  readonly url: string;
  /** `auto` uses Firecrawl when FIRECRAWL_API_KEY is present, else a plain HTTPS GET. */
  readonly method?: "auto" | "firecrawl" | "https_get";
  readonly captureId?: string;
  readonly runId?: string;
}

export interface CaptureFileInput {
  /** Raw bytes of the document (markdown, text, html, json, csv, pdf, docx, xlsx, pptx, …). */
  readonly bytes: Uint8Array;
  /** File name; drives media-type detection when `mediaType` is absent. */
  readonly filename: string;
  readonly mediaType?: string;
  /** Where the bytes came from (a URL, a bucket key, a sandbox path). Recorded as the capture's logical identity. */
  readonly sourceUri?: string;
  readonly captureId?: string;
  readonly runId?: string;
}

export interface CaptureOutcome {
  readonly record: CaptureRecord;
  readonly content: string;
  readonly reused: boolean;
}

interface Fetched {
  readonly content: string;
  readonly finalUrl: string;
  readonly title?: string;
  readonly method:
    | "firecrawl"
    | "https_get"
    | "https_get+firecrawl_parse"
    | "file_text"
    | "file_html"
    | "firecrawl_parse";
  readonly sourceKind: CaptureRecord["sourceKind"];
  readonly originalBytes?: Uint8Array;
  readonly originalMediaType?: string;
}

// ---- media types ----------------------------------------------------------------------

/**
 * Every content type the executor can turn into a text representation. `text` types
 * are decoded directly, `html` is tag-stripped, `document` types go through Firecrawl
 * `/v2/parse` (requires FIRECRAWL_API_KEY). Anything else is refused: there is no
 * text representation to select quotes from, so it cannot carry evidence.
 */
export const SUPPORTED_MEDIA_TYPES: Readonly<
  Record<string, { readonly kind: "text" | "html" | "document"; readonly extensions: readonly string[] }>
> = {
  "text/markdown": { kind: "text", extensions: [".md", ".markdown"] },
  "text/plain": { kind: "text", extensions: [".txt"] },
  "application/json": { kind: "text", extensions: [".json"] },
  "text/csv": { kind: "document", extensions: [".csv"] },
  "text/html": { kind: "html", extensions: [".html", ".htm", ".xhtml"] },
  "application/pdf": { kind: "document", extensions: [".pdf"] },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    kind: "document",
    extensions: [".docx", ".docm"],
  },
  "application/msword": { kind: "document", extensions: [".doc"] },
  "application/vnd.oasis.opendocument.text": { kind: "document", extensions: [".odt"] },
  "application/vnd.oasis.opendocument.spreadsheet": { kind: "document", extensions: [".ods"] },
  "application/vnd.oasis.opendocument.presentation": { kind: "document", extensions: [".odp"] },
  "application/rtf": { kind: "document", extensions: [".rtf"] },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    kind: "document",
    extensions: [".xlsx", ".xlsm", ".xlsb"],
  },
  "application/vnd.ms-excel": { kind: "document", extensions: [".xls"] },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    kind: "document",
    extensions: [".pptx", ".pptm"],
  },
  "application/vnd.ms-powerpoint": { kind: "document", extensions: [".ppt"] },
  "application/epub+zip": { kind: "document", extensions: [".epub"] },
};

export function mediaTypeForFilename(filename: string): string | undefined {
  const lower = filename.toLowerCase().replace(/[?#].*$/, "");
  for (const [mediaType, spec] of Object.entries(SUPPORTED_MEDIA_TYPES)) {
    if (spec.extensions.some((ext) => lower.endsWith(ext))) return mediaType;
  }
  return undefined;
}

export function normalizeMediaType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const base = value.split(";")[0]!.trim().toLowerCase();
  if (base === "application/x-pdf") return "application/pdf";
  if (base === "text/x-markdown") return "text/markdown";
  if (base === "application/xhtml+xml") return "text/html";
  return base;
}

function mediaKind(mediaType: string): "text" | "html" | "document" | undefined {
  return SUPPORTED_MEDIA_TYPES[mediaType]?.kind;
}

/** The media type captureFile converts: a supported declared type, otherwise the one the filename implies. */
export function captureFileMediaType(input: {
  readonly filename: string;
  readonly mediaType?: string;
}): string | undefined {
  const declared = normalizeMediaType(input.mediaType);
  return declared && mediaKind(declared) ? declared : mediaTypeForFilename(input.filename);
}

/** How captureFile would convert this input, without converting it. */
export function captureFileMediaKind(input: {
  readonly filename: string;
  readonly mediaType?: string;
}): "text" | "html" | "document" | undefined {
  const mediaType = captureFileMediaType(input);
  return mediaType ? mediaKind(mediaType) : undefined;
}

function sourceKindFor(mediaType: string): CaptureRecord["sourceKind"] {
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === "text/html") return "web_page";
  if (mediaType === "application/json") return "api";
  return "other";
}

// ---- fetchers --------------------------------------------------------------------------

async function viaFirecrawlScrape(url: string, apiKey: string): Promise<Fetched> {
  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false, parsePDF: true, timeout: 90_000 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`FIRECRAWL_SCRAPE_FAILED:${response.status}:${(await response.text()).slice(0, 300)}`);
  const payload = (await response.json()) as {
    success?: boolean;
    data?: { markdown?: string; metadata?: { url?: string; sourceURL?: string; title?: string; contentType?: string } };
    error?: string;
  };
  const markdown = payload.data?.markdown?.trim();
  if (!markdown) throw new Error(`FIRECRAWL_MARKDOWN_EMPTY:${payload.error ?? "no markdown"}`);
  const contentType = payload.data?.metadata?.contentType ?? "";
  return {
    content: markdown,
    finalUrl: payload.data?.metadata?.url ?? payload.data?.metadata?.sourceURL ?? url,
    ...(payload.data?.metadata?.title ? { title: payload.data.metadata.title } : {}),
    method: "firecrawl",
    sourceKind: contentType.includes("pdf") || /\.pdf($|\?)/i.test(url) ? "pdf" : "web_page",
  };
}

/** Firecrawl `/v2/parse`: multipart upload of document bytes → markdown. */
export async function parseDocumentViaFirecrawl(
  bytes: Uint8Array,
  filename: string,
  mediaType: string,
  apiKey: string,
): Promise<string> {
  if (bytes.byteLength > 50_000_000) throw new Error("DOCUMENT_TOO_LARGE:50MB");
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(bytes)], { type: mediaType }), filename);
  form.append("options", JSON.stringify({ formats: ["markdown"], onlyMainContent: false, timeout: 240_000 }));
  const response = await fetch("https://api.firecrawl.dev/v2/parse", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok)
    throw new Error(`FIRECRAWL_PARSE_FAILED:${response.status}:${(await response.text()).slice(0, 300)}`);
  const payload = (await response.json()) as {
    success?: boolean;
    data?: { markdown?: string };
    markdown?: string;
    error?: string;
  };
  const markdown = (payload.data?.markdown ?? payload.markdown)?.trim();
  if (!markdown) throw new Error(`FIRECRAWL_PARSE_EMPTY:${payload.error ?? "no markdown"}`);
  return markdown;
}

export function htmlToText(html: string): { text: string; title?: string } {
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return { text, ...(title ? { title } : {}) };
}

async function viaHttps(url: string, firecrawlKey: string | undefined): Promise<Fetched> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
    headers: { "user-agent": "knowledge-verification-executor/0.2" },
  });
  if (!response.ok) throw new Error(`HTTPS_GET_FAILED:${response.status}`);
  const declared = normalizeMediaType(response.headers.get("content-type") ?? undefined);
  const mediaType = declared && mediaKind(declared) ? declared : (mediaTypeForFilename(url) ?? declared ?? "text/html");
  const kind = mediaKind(mediaType);
  if (kind === "document") {
    // Binary document behind a URL: download the bytes, convert through Firecrawl parse.
    if (!firecrawlKey) throw new Error(`HTTPS_GET_DOCUMENT_REQUIRES_FIRECRAWL:${mediaType}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const filename = new URL(response.url || url).pathname.split("/").pop() || "document";
    const markdown = await parseDocumentViaFirecrawl(bytes, filename, mediaType, firecrawlKey);
    return {
      content: markdown,
      finalUrl: response.url || url,
      method: "https_get+firecrawl_parse",
      sourceKind: sourceKindFor(mediaType),
      originalBytes: bytes,
      originalMediaType: mediaType,
    };
  }
  const body = await response.text();
  if (kind === "text") {
    if (body.trim().length === 0) throw new Error("HTTPS_GET_TEXT_EMPTY");
    return { content: body, finalUrl: response.url || url, method: "https_get", sourceKind: sourceKindFor(mediaType) };
  }
  const { text, title } = htmlToText(body);
  if (text.length < 200) throw new Error("HTTPS_GET_TEXT_EMPTY");
  return {
    content: text,
    finalUrl: response.url || url,
    ...(title ? { title } : {}),
    method: "https_get",
    sourceKind: "web_page",
  };
}

export function sourceIdFor(url: string): string {
  return `source-${shortId(canonicalUrl(url))}`;
}

export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

// ---- store write ------------------------------------------------------------------------

async function persistCapture(
  store: FilesystemStore,
  fetched: Fetched,
  requestedUri: string,
  captureIdInput: string | undefined,
): Promise<CaptureOutcome> {
  const contentBytes = encoder.encode(fetched.content);
  const contentDigest = sha256Digest(contentBytes);
  const captureId =
    captureIdInput?.trim() || `capture-${shortId(canonicalUrl(requestedUri), 10)}-${contentDigest.slice(7, 15)}`;
  let previous: CaptureRecord | undefined;
  try {
    previous = await store.readCapture(captureId);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("CAPTURE_NOT_FOUND:")) throw error;
  }
  if (previous) {
    const originalDigest = fetched.originalBytes ? sha256Digest(fetched.originalBytes) : undefined;
    if (
      previous.contentArtifact.digest !== contentDigest ||
      canonicalUrl(previous.requestedUrl) !== canonicalUrl(requestedUri) ||
      previous.originalArtifact?.digest !== originalDigest
    )
      throw new Error(`CAPTURE_ID_CONFLICT:${captureId}:choose a new --capture-id`);
    return { record: previous, content: fetched.content, reused: true };
  }
  const acquisitionIdentity = shortId(JSON.stringify([captureId, canonicalUrl(requestedUri)]), 64);
  const capturedAt = new Date().toISOString();
  const contentArtifact = await store.put({
    bytes: contentBytes,
    mediaType: "text/markdown; charset=utf-8",
    producerActivityId: `verification-executor:capture:${acquisitionIdentity}`,
    producerVersion: CAPTURE_METHOD_VERSION,
    dataClassification: "public",
    createdAt: capturedAt,
  });
  const originalArtifact = fetched.originalBytes
    ? await store.put({
        bytes: fetched.originalBytes,
        mediaType: fetched.originalMediaType ?? "application/octet-stream",
        producerActivityId: `verification-executor:capture_original:${acquisitionIdentity}`,
        producerVersion: CAPTURE_METHOD_VERSION,
        dataClassification: "public",
        createdAt: capturedAt,
      })
    : undefined;
  const record: CaptureRecord = {
    captureId,
    sourceId: sourceIdFor(requestedUri),
    requestedUrl: requestedUri,
    finalUrl: fetched.finalUrl,
    ...(fetched.title ? { title: fetched.title } : {}),
    capturedAt,
    captureMethod: fetched.method,
    captureMethodVersion: CAPTURE_METHOD_VERSION,
    contentArtifact,
    ...(originalArtifact ? { originalArtifact } : {}),
    characters: fetched.content.length,
    sourceKind: fetched.sourceKind,
    logicalIdentity: canonicalUrl(requestedUri),
  };
  const provenanceArtifact = (
    await store.putJson(record, {
      mediaType: "application/json",
      producerActivityId: `verification-executor:capture-record:${record.captureId}`,
      producerVersion: "capture-record.v1",
      parentArtifactIds: [
        ...new Set([contentArtifact.artifactId, ...(originalArtifact ? [originalArtifact.artifactId] : [])]),
      ],
      transformation: { kind: "capture-record.v1", captureId: record.captureId },
    })
  ).handle;
  const retained = { ...record, provenanceArtifact };
  await store.writeCapture(retained);
  return { record: retained, content: fetched.content, reused: false };
}

/** Capture a URL. HTML → Firecrawl markdown (or tag-stripped text), PDF/DOCX/XLSX/… → Firecrawl parse. */
export async function captureSource(
  store: FilesystemStore,
  input: CaptureInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CaptureOutcome> {
  const method = input.method ?? "auto";
  const firecrawlKey = env.FIRECRAWL_API_KEY?.trim();
  const guessed = mediaTypeForFilename(input.url);
  const guessedKind = guessed ? mediaKind(guessed) : undefined;
  let fetched: Fetched;
  if (
    method === "firecrawl" ||
    (method === "auto" && firecrawlKey && guessedKind !== "document" && guessedKind !== "text")
  ) {
    if (!firecrawlKey) throw new Error("FIRECRAWL_API_KEY_REQUIRED");
    fetched = await viaFirecrawlScrape(input.url, firecrawlKey);
  } else if (method === "auto" && firecrawlKey && guessed === "application/pdf") {
    // PDFs: download the original bytes and parse them (same path as capture-file, so a URL
    // capture and a file capture of the same document yield the same text digest and the
    // original bytes are stored for provenance). Firecrawl scrape is only a fallback when the
    // direct download is refused (bot walls, auth redirects).
    try {
      fetched = await viaHttps(input.url, firecrawlKey);
    } catch {
      fetched = await viaFirecrawlScrape(input.url, firecrawlKey);
    }
  } else {
    fetched = await viaHttps(input.url, firecrawlKey);
  }
  return persistCapture(store, fetched, input.url, input.captureId);
}

/**
 * Capture bytes the agent already holds (a sandbox file, an upload, a bucket object).
 * The executor performs the text conversion itself so the agent cannot substitute
 * a doctored representation; the original bytes are stored beside the text.
 */
export async function captureFile(
  store: FilesystemStore,
  input: CaptureFileInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CaptureOutcome> {
  if (input.bytes.byteLength === 0) throw new Error("CAPTURE_FILE_EMPTY");
  const mediaType = captureFileMediaType(input);
  if (!mediaType)
    throw new Error(
      `CAPTURE_FILE_UNSUPPORTED_TYPE:${input.mediaType ?? input.filename}:supported=${Object.keys(SUPPORTED_MEDIA_TYPES).join(",")}`,
    );
  const kind = mediaKind(mediaType)!;
  const sourceUri = input.sourceUri?.trim() || `file:///${input.filename.replace(/^\/+/, "")}`;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let fetched: Fetched;
  if (kind === "text") {
    const text = decoder.decode(input.bytes);
    if (text.trim().length === 0) throw new Error("CAPTURE_FILE_TEXT_EMPTY");
    fetched = { content: text, finalUrl: sourceUri, method: "file_text", sourceKind: sourceKindFor(mediaType) };
  } else if (kind === "html") {
    const { text, title } = htmlToText(decoder.decode(input.bytes));
    if (text.length === 0) throw new Error("CAPTURE_FILE_TEXT_EMPTY");
    fetched = {
      content: text,
      finalUrl: sourceUri,
      ...(title ? { title } : {}),
      method: "file_html",
      sourceKind: "web_page",
      originalBytes: input.bytes,
      originalMediaType: mediaType,
    };
  } else {
    const firecrawlKey = env.FIRECRAWL_API_KEY?.trim();
    if (!firecrawlKey) throw new Error(`CAPTURE_FILE_DOCUMENT_REQUIRES_FIRECRAWL:${mediaType}`);
    const markdown = await parseDocumentViaFirecrawl(input.bytes, input.filename, mediaType, firecrawlKey);
    fetched = {
      content: markdown,
      finalUrl: sourceUri,
      title: input.filename,
      method: "firecrawl_parse",
      sourceKind: sourceKindFor(mediaType),
      originalBytes: input.bytes,
      originalMediaType: mediaType,
    };
  }
  return persistCapture(store, fetched, sourceUri, input.captureId);
}
