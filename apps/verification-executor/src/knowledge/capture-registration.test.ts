import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { captureFile } from "../capture.js";
import { FilesystemStore, type CaptureRecord } from "../store.js";
import { capturedMediaType, executorCapturedSource } from "./capture-registration.js";

const TENANT = "00000000-0000-7000-8000-000000000001";
const record = (overrides: Partial<CaptureRecord>): CaptureRecord =>
  ({
    captureId: "c",
    sourceId: "s",
    requestedUrl: "https://example.test/page",
    finalUrl: "https://example.test/page",
    capturedAt: "2026-11-16T00:00:00.000Z",
    captureMethod: "https_get",
    captureMethodVersion: "v",
    characters: 1,
    sourceKind: "other",
    logicalIdentity: "https://example.test/page",
    ...overrides,
  }) as CaptureRecord;

describe("an executor capture as a registrable source", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  it("names what was captured: a kept original decides, else how the executor captured it", () => {
    const original = { mediaType: "text/html" } as CaptureRecord["originalArtifact"];
    expect(capturedMediaType(record({ originalArtifact: original }))).toBe("text/html");
    expect(capturedMediaType(record({ originalArtifact: { mediaType: "application/pdf" } as never }))).toBe(
      "application/pdf",
    );
    expect(capturedMediaType(record({ captureMethod: "firecrawl", sourceKind: "pdf" }))).toBe("application/pdf");
    expect(capturedMediaType(record({ sourceKind: "web_page" }))).toBe("text/html");
    expect(capturedMediaType(record({ captureMethod: "firecrawl", sourceKind: "web_page" }))).toBe("text/markdown");
    expect(capturedMediaType(record({ captureMethod: "file_text", sourceKind: "api" }))).toBe("application/json");
    expect(capturedMediaType(record({ captureMethod: "file_text", requestedUrl: "file:///notes.txt" }))).toBe(
      "text/plain",
    );
    expect(capturedMediaType(record({ captureMethod: "file_text", requestedUrl: "file:///notes.md" }))).toBe(
      "text/markdown",
    );
  });

  it("reads a capture back with its digests: the HTML page is the capture, its text the representation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ks-capture-registration-"));
    roots.push(root);
    const store = new FilesystemStore(root, TENANT);
    await store.init();
    const html = await captureFile(store, {
      bytes: new TextEncoder().encode("<html><body><p>One paragraph here.</p></body></html>"),
      filename: "page.html",
      sourceUri: "https://example.test/page",
    });
    const source = await executorCapturedSource(store, html.record.captureId, {
      remoteCustody: false,
      registrable: () => true,
    });
    expect(source).toMatchObject({
      executorCaptureId: html.record.captureId,
      sourceMediaType: "text/html",
      capture: { artifactId: html.record.originalArtifact?.artifactId, mediaType: "text/html" },
      representation: { artifactId: html.record.contentArtifact.artifactId, text: html.content },
      custody: "local",
    });
    const text = await captureFile(store, { bytes: new TextEncoder().encode('{"a": 1}'), filename: "run.json" });
    const json = await executorCapturedSource(store, text.record.captureId, {
      remoteCustody: false,
      registrable: () => true,
    });
    expect(json).toMatchObject({
      sourceMediaType: "application/json",
      capture: { artifactId: text.record.contentArtifact.artifactId },
    });
    expect(json.capture).toEqual({
      artifactId: json.representation.artifactId,
      digest: json.representation.digest,
      mediaType: json.representation.mediaType,
      byteLength: json.representation.byteLength,
    });
    await expect(
      executorCapturedSource(store, "missing", { remoteCustody: false, registrable: () => true }),
    ).rejects.toThrow("CAPTURE_NOT_FOUND:missing");
  });
});
