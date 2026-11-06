import { describe, expect, it } from "vitest";
import { digestBytes } from "@aiengineer/knowledge-core";
import { observeSealedCapture, readSealedCapture, searchSealedCapture } from "./index.js";

const text = 'Public statement. token = "super-secret-value". Public statement.';
const bytes = new TextEncoder().encode(text);
const digest = digestBytes(bytes);

describe("sealed capture inspection", () => {
  it("returns an excerpt handle, not a locator, and keeps search offsets display-only", () => {
    const excerpt = readSealedCapture({ bytes, digest, offset: 0, length: 16 });
    expect(excerpt.excerpt).toBe("Public statement");
    expect(excerpt).not.toHaveProperty("locator");
    expect(excerpt.hasMore).toBe(true);
    const search = searchSealedCapture({ bytes, digest, query: "Public statement" });
    expect(search.hits[0]?.occurrenceCount).toBe(2);
    expect(search.hits[0]).not.toHaveProperty("selector");
  });

  it("records secret class without the secret value and flags digest mismatch", () => {
    const observation = observeSealedCapture({
      bytes,
      digest,
      declaredMediaType: "text/plain",
      acquireObservations: [
        { key: "observed_media_type", value: "text/plain" },
        { key: "declared_content_type", value: "text/plain" },
        { key: "redirects", value: "[]" },
        { key: "final_url", value: "https://example.com/a" },
      ],
    });
    const secret = observation.findings.find((item) => item.dimension === "secret_class" && item.secretClass);
    expect(secret?.status).toBe("observed");
    expect(JSON.stringify(observation)).not.toContain("super-secret-value");
    expect(() => readSealedCapture({ bytes, digest: "sha256:bad" })).toThrow("CAPTURE_DIGEST_MISMATCH");
  });
});
