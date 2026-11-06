import { digestBytes, type Ref } from "@aiengineer/knowledge-operation-protocol";

export interface CapturedSource {
  captureId?: string;
  url: string;
  text: string;
  ref: Ref<"artifact">;
  retrievedAt: string;
  title?: string;
  completeness?: "complete" | "partial" | "truncated" | "unknown";
}

export function assertQualiaCaptureId(captureId: unknown): asserts captureId is string {
  if (typeof captureId !== "string" || !/^[a-f0-9]{32}$/.test(captureId)) {
    throw new Error("captureId must be an exact host-owned 32-character lowercase hex identity");
  }
}

/** Retain the first immutable capture; a URL can identify several different snapshots. */
export function retainQualiaCapture(captures: Map<string, CapturedSource>, source: CapturedSource): CapturedSource {
  assertQualiaCaptureId(source.captureId);
  if (digestBytes(source.text) !== source.ref.digest) throw new Error("Captured source bytes fail custody digest");
  const prior = captures.get(source.captureId);
  if (prior) {
    if (prior.url !== source.url || prior.ref.digest !== source.ref.digest || prior.text !== source.text) {
      throw new Error(`Capture identity ${source.captureId} was reused with different source bytes or URL`);
    }
    return prior;
  }
  captures.set(source.captureId, source);
  return source;
}

/** Resolve by snapshot plus exact URL. Legacy URL-only selection requires one candidate. */
export function selectQualiaCapture(
  sources: Iterable<CapturedSource>,
  sourceUrl: string,
  captureId?: string,
): CapturedSource {
  const candidates = [...sources].filter((source) => source.url === sourceUrl);
  if (captureId !== undefined) assertQualiaCaptureId(captureId);
  const selected = captureId === undefined ? candidates : candidates.filter((source) => source.captureId === captureId);
  if (selected.length !== 1) {
    const available = candidates.map((source) => source.captureId ?? "legacy-unidentified").join(", ") || "none";
    throw new Error(
      `Captured source ${selected.length > 1 ? "is ambiguous" : "unavailable"} for ${sourceUrl}; select capture_id exactly (available: ${available})`,
    );
  }
  const source = selected[0];
  if (!source || digestBytes(source.text) !== source.ref.digest)
    throw new Error(`Captured source bytes unavailable for ${sourceUrl}`);
  return source;
}

/** Fixture selectors never enter BKS's native schema; bytes and custody remain host-owned. */
export function bindQualiaNativeCaptures(
  sources: Iterable<CapturedSource>,
  captures: ReadonlyArray<{ canonicalUri: string; captureId?: string; [key: string]: unknown }>,
  includeHostIdentity = false,
) {
  const retained = [...sources];
  return captures.map(({ captureId, ...capture }) => {
    const source = selectQualiaCapture(retained, capture.canonicalUri, captureId);
    return {
      ...capture,
      contentUtf8: source.text,
      storageUri: `ks-custody:${source.ref.id}`,
      retrievedAt: source.retrievedAt,
      ...(includeHostIdentity ? { captureId: source.captureId } : {}),
    };
  });
}
