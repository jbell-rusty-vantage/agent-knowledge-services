import { describe, expect, it } from "vitest";
import { canonicalCaptureMethod, canonicalDocumentType } from "./preparation-vocabulary.js";

describe("canonical preparation vocabulary", () => {
  it.each([
    ["direct-http@1.0.0", "http"],
    ["firecrawl-scrape@v2", "firecrawl"],
    ["manual-upload@1.0.0", "manual"],
    ["repository-archive@1.0.0", "repository"],
    ["paper-resolver@1.0.0", "api"],
    ["https_acquire", "http"],
    ["registered_artifact", "manual"],
  ])("maps acquisition adapter %s to %s", (adapter, method) => {
    expect(canonicalCaptureMethod(adapter)).toBe(method);
  });

  it.each(["http", "browser", "firecrawl", "api", "youtube_transcript", "repository", "manual", "other"])(
    "accepts canonical method %s with or without a provider version",
    (method) => {
      expect(canonicalCaptureMethod(method)).toBe(method);
      expect(canonicalCaptureMethod(`${method}@version-2`)).toBe(method);
    },
  );

  it.each(["", "fixture@1", "unknown-adapter@1", "constructor", "__proto__"])(
    "rejects unsupported capture method %s without defaulting its classification",
    (method) => {
      expect(() => canonicalCaptureMethod(method)).toThrow("CAPTURE_METHOD_UNSUPPORTED");
    },
  );

  it.each([
    ["official_docs", "official_docs_page"],
    ["official_blog", "official_blog_post"],
    ["official_repository", "repository_readme"],
    ["talk_transcript", "video_transcript"],
  ])("maps legacy document kind %s to %s", (kind, code) => {
    expect(canonicalDocumentType(kind)).toBe(code);
  });

  it.each([
    "official_docs_page",
    "entity_profile",
    "research_report",
    "official_homepage",
    "unregistered_kind",
    "constructor",
  ])("preserves unaliased document type %s for canonical database validation", (kind) => {
    expect(canonicalDocumentType(kind)).toBe(kind);
  });
});
