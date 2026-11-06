const HTML_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const EXCLUSIVE_TEXT_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/vtt",
  "application/json",
  "application/xml",
  "text/xml",
]);
const TEXT_MEDIA_TYPE_PREFIX = "text/";
const DOCLING_MEDIA_TYPES = new Set([
  "application/pdf",
  "text/html",
  "application/xhtml+xml",
  "application/msword",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export function normalizeMediaType(mediaType: string): string {
  return mediaType.toLowerCase().split(";")[0]!.trim();
}

export function isHtmlMediaType(mediaType: string): boolean {
  return HTML_MEDIA_TYPES.has(normalizeMediaType(mediaType));
}

export function isExclusiveTextMediaType(mediaType: string): boolean {
  const normalized = normalizeMediaType(mediaType);
  if (isHtmlMediaType(normalized)) return false;
  if (EXCLUSIVE_TEXT_MEDIA_TYPES.has(normalized)) return true;
  return normalized.startsWith(TEXT_MEDIA_TYPE_PREFIX);
}

export function isDeterministicTextMediaType(mediaType: string): boolean {
  return isExclusiveTextMediaType(mediaType) || isHtmlMediaType(mediaType);
}

export function isDoclingMediaType(mediaType: string): boolean {
  return DOCLING_MEDIA_TYPES.has(normalizeMediaType(mediaType));
}
