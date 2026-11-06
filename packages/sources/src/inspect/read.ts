import { assertSealedCaptureDigest } from "./sealed-bytes.js";

export interface ReadSealedCaptureInput {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly offset?: number;
  readonly length?: number;
}

export interface SealedCaptureExcerpt {
  readonly digest: string;
  readonly offset: number;
  readonly length: number;
  readonly totalBytes: number;
  readonly excerpt: string;
  readonly hasMore: boolean;
}

const DEFAULT_EXCERPT_LENGTH = 6_000;
const MAXIMUM_EXCERPT_LENGTH = 20_000;

export function readSealedCapture(input: ReadSealedCaptureInput): SealedCaptureExcerpt {
  assertSealedCaptureDigest(input.bytes, input.digest);
  const totalBytes = input.bytes.byteLength;
  const offset = Math.max(0, input.offset ?? 0);
  const requested = Math.min(Math.max(1, input.length ?? DEFAULT_EXCERPT_LENGTH), MAXIMUM_EXCERPT_LENGTH);
  const length = Math.min(requested, Math.max(0, totalBytes - offset));
  const excerpt = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes.subarray(offset, offset + length));
  return {
    digest: input.digest,
    offset,
    length,
    totalBytes,
    excerpt,
    hasMore: offset + length < totalBytes,
  };
}
