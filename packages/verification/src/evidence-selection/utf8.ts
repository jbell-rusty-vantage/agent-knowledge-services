const encoder = new TextEncoder();

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Throws on malformed UTF-8. Captured bytes that are not text must surface as `parse_error`, never as a guess. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
