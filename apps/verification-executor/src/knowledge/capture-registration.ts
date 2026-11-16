import { mediaTypeForFilename, normalizeMediaType } from "../capture.js";
import type { CaptureRecord, FilesystemStore } from "../store.js";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";

/**
 * What `source_prepare_captured` registers: one capture of this executor's store, read back with its digests checked,
 * in the shape knowledge-db's `CaptureRegistrar` validates. The capture row hashes the bytes the executor kept (the
 * HTML page when it kept one, otherwise the captured text); the units are read from the captured text, the same text
 * `verify_locate_quote` locates a quote in.
 */
export interface ExecutorCapturedSource {
  readonly executorCaptureId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly title?: string;
  readonly capturedAt: string;
  readonly captureMethod: string;
  readonly captureMethodVersion: string;
  readonly sourceKind: CaptureRecord["sourceKind"];
  readonly sourceMediaType: string;
  readonly capture: ArtifactRef;
  readonly representation: ArtifactRef & { readonly text: string };
  readonly custody: "remote" | "local";
}

interface ArtifactRef {
  readonly artifactId: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly byteLength: number;
}

const ref = (handle: VerificationArtifactHandle): ArtifactRef => ({
  artifactId: handle.artifactId,
  digest: handle.digest,
  mediaType: handle.mediaType,
  byteLength: handle.byteLength,
});

/**
 * The media type of what was captured. A kept original decides (an HTML page, or a PDF or office file, which is
 * refused downstream). Without one: an HTTPS GET of a web page kept only its text rendering, a Firecrawl scrape kept
 * Firecrawl's Markdown, and a text capture is JSON when the executor classified it as an API response, otherwise
 * what its name says, otherwise Markdown.
 */
export function capturedMediaType(record: CaptureRecord): string {
  if (record.originalArtifact)
    return normalizeMediaType(record.originalArtifact.mediaType) ?? "application/octet-stream";
  if (record.sourceKind === "pdf") return "application/pdf";
  if (record.captureMethod === "https_get" && record.sourceKind === "web_page") return "text/html";
  if (record.sourceKind === "api") return "application/json";
  if (record.captureMethod === "firecrawl") return "text/markdown";
  const named = mediaTypeForFilename(record.requestedUrl) ?? mediaTypeForFilename(record.finalUrl);
  return named === "text/plain" || named === "application/json" ? named : "text/markdown";
}

export async function executorCapturedSource(
  store: FilesystemStore,
  captureId: string,
  options: { readonly remoteCustody: boolean; readonly registrable: (mediaType: string) => boolean },
): Promise<ExecutorCapturedSource> {
  const remoteCustody = options.remoteCustody;
  const record = await store.readCapture(captureId);
  const sourceMediaType = capturedMediaType(record);
  const original = record.originalArtifact;
  // The text the units are read from; `store.text` checks the bytes against the handle's digest and length.
  const text = await store.text(record.contentArtifact);
  const capture = original && sourceMediaType === "text/html" ? original : record.contentArtifact;
  if (remoteCustody && options.registrable(sourceMediaType)) {
    // Captures made before custody was attached are registered now; registered ones are verified, not rewritten.
    await store.preserve(capture.artifactId);
    if (capture.artifactId !== record.contentArtifact.artifactId)
      await store.preserve(record.contentArtifact.artifactId);
  }
  return {
    executorCaptureId: record.captureId,
    requestedUrl: record.requestedUrl,
    finalUrl: record.finalUrl,
    ...(record.title ? { title: record.title } : {}),
    capturedAt: record.capturedAt,
    captureMethod: record.captureMethod,
    captureMethodVersion: record.captureMethodVersion,
    sourceKind: record.sourceKind,
    sourceMediaType,
    capture: ref(capture),
    representation: { ...ref(record.contentArtifact), text },
    custody: remoteCustody ? "remote" : "local",
  };
}
