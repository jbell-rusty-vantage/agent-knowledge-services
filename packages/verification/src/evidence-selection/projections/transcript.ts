import type { VerificationSelector } from "@aiengineer/knowledge-contracts";
import type { EvidenceSelection, EvidenceSelectionRequest } from "../selection.js";
import { resolvedValue, unresolved } from "./report.js";
import { boundedArray, fail, integer, isRecord, only, string, unique, type UnknownRecord } from "./shared.js";

export interface TranscriptSegment {
  readonly segmentId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker?: string;
  readonly channel?: string;
}

export interface TranscriptProjection {
  readonly kind: "transcript";
  readonly durationMs: number;
  readonly segments: readonly TranscriptSegment[];
}

type MediaTimecodeSelector = Extract<VerificationSelector, { kind: "media_timecode" }>;

export function parseTranscript(input: UnknownRecord): TranscriptProjection {
  only(input, ["kind", "durationMs", "segments"], "TRANSCRIPT");
  const durationMs = input.durationMs;
  if (!integer(durationMs) || durationMs < 0) fail("TRANSCRIPT_DURATION");
  const segments = boundedArray(input.segments, "TRANSCRIPT_SEGMENTS").map((item) => parseSegment(item, durationMs));
  unique(
    segments.map((segment) => segment.segmentId),
    "TRANSCRIPT_SEGMENT_ID",
  );
  for (let index = 1; index < segments.length; index += 1)
    if (segments[index - 1]!.endMs > segments[index]!.startMs) fail("TRANSCRIPT_OVERLAP_OR_UNSORTED");
  return { kind: "transcript", durationMs, segments };
}

function parseSegment(item: unknown, durationMs: number): TranscriptSegment {
  if (
    !isRecord(item) ||
    !string(item.segmentId) ||
    !integer(item.startMs) ||
    !integer(item.endMs) ||
    item.startMs < 0 ||
    item.endMs <= item.startMs ||
    item.endMs > durationMs ||
    !string(item.text) ||
    (item.speaker !== undefined && !string(item.speaker)) ||
    (item.channel !== undefined && !string(item.channel))
  )
    fail("TRANSCRIPT_SEGMENT");
  only(item, ["segmentId", "startMs", "endMs", "text", "speaker", "channel"], "TRANSCRIPT_SEGMENT");
  const { segmentId, startMs, endMs, text, speaker, channel } = item;
  return {
    segmentId,
    startMs,
    endMs,
    text,
    ...(speaker === undefined ? {} : { speaker }),
    ...(channel === undefined ? {} : { channel }),
  };
}

/**
 * Every segment inside the half-open interval, optionally narrowed to one speaker or channel.
 * Without a declared speaker/channel, a window that mixes them is ambiguous rather than merged.
 */
export function resolveMedia(
  request: EvidenceSelectionRequest,
  projection: TranscriptProjection,
  selector: MediaTimecodeSelector,
): EvidenceSelection {
  if (selector.endMs > projection.durationMs) return unresolved(request, "invalid");
  const segments = projection.segments.filter(
    (segment) =>
      segment.startMs >= selector.startMs &&
      segment.endMs <= selector.endMs &&
      (selector.speaker === undefined || segment.speaker === selector.speaker) &&
      (selector.channel === undefined || segment.channel === selector.channel),
  );
  if (segments.length === 0) return unresolved(request, "not_found");
  if (selector.speaker === undefined && mixes(segments, "speaker"))
    return unresolved(request, "ambiguous", segments.length);
  if (selector.channel === undefined && mixes(segments, "channel"))
    return unresolved(request, "ambiguous", segments.length);
  const value = {
    interval: {
      startMs: selector.startMs,
      endMs: selector.endMs,
      convention: "half_open" as const,
    },
    segments,
  };
  return resolvedValue(
    request,
    value,
    segments.map((segment) => ({
      start: segment.startMs,
      end: segment.endMs,
      coordinateSpace: "media_ms_half_open",
    })),
  );
}

const mixes = (segments: readonly TranscriptSegment[], field: "speaker" | "channel"): boolean =>
  new Set(segments.map((segment) => segment[field] ?? "")).size > 1;
