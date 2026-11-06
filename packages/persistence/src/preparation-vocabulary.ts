const CAPTURE_METHODS = new Set([
  "http",
  "browser",
  "firecrawl",
  "api",
  "youtube_transcript",
  "repository",
  "manual",
  "other",
]);

const CAPTURE_ADAPTER_METHODS: Readonly<Record<string, string>> = {
  "direct-http": "http",
  "firecrawl-scrape": "firecrawl",
  "manual-upload": "manual",
  "repository-archive": "repository",
  "paper-resolver": "api",
  https_acquire: "http",
  registered_artifact: "manual",
  file_text: "manual",
  file_html: "manual",
  https_get: "http",
  firecrawl_parse: "firecrawl",
  "https_get+firecrawl_parse": "http",
};

const DOCUMENT_TYPE_ALIASES: Readonly<Record<string, string>> = {
  official_docs: "official_docs_page",
  official_blog: "official_blog_post",
  official_repository: "repository_readme",
  talk_transcript: "video_transcript",
};

/** Adapter identity remains in capture context; the foreign key contains only a canonical method. */
export function canonicalCaptureMethod(method: string): string {
  const adapter = method.split("@", 1)[0]!;
  if (CAPTURE_METHODS.has(adapter)) return adapter;
  const canonical = Object.hasOwn(CAPTURE_ADAPTER_METHODS, adapter) ? CAPTURE_ADAPTER_METHODS[adapter] : undefined;
  if (!canonical) throw new Error(`CAPTURE_METHOD_UNSUPPORTED:${method}`);
  return canonical;
}

/** Unaliased codes are validated by the canonical document_type foreign key. */
export function canonicalDocumentType(kind: string): string {
  return Object.hasOwn(DOCUMENT_TYPE_ALIASES, kind) ? DOCUMENT_TYPE_ALIASES[kind]! : kind;
}
