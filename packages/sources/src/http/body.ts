interface BoundedBodyInput {
  response: Response;
  maximumBytes: number;
  maximumDecompressionRatio: number;
  signal: AbortSignal;
}

export async function boundedBody(input: BoundedBodyInput): Promise<Uint8Array> {
  const { response, maximumBytes, maximumDecompressionRatio, signal } = input;
  const reader = response.body?.getReader();
  const cancel = () => {
    void reader?.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const declared = declaredLength(response);
    const encoded = isCompressed(response);
    if (encoded && (!Number.isFinite(declared) || declared <= 0)) throw new Error("ENCODED_LENGTH_REQUIRED");
    if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("BYTE_LIMIT_EXCEEDED");
    if (!reader) return new Uint8Array();
    return await readBoundedChunks({
      reader,
      maximumBytes,
      maximumDecompressionRatio,
      encoded,
      declared,
      signal,
    });
  } catch (error) {
    void reader?.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader?.releaseLock();
  }
}

function isCompressed(response: Response): boolean {
  const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  return Boolean(contentEncoding && contentEncoding !== "identity");
}

function declaredLength(response: Response): number {
  const declaredHeader = response.headers.get("content-length");
  return declaredHeader === null ? Number.NaN : Number(declaredHeader);
}

interface ReadBoundedChunksInput {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  maximumBytes: number;
  maximumDecompressionRatio: number;
  encoded: boolean;
  declared: number;
  signal: AbortSignal;
}

async function readBoundedChunks(input: ReadBoundedChunksInput): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await input.reader.read();
    input.signal.throwIfAborted();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > input.maximumBytes) throw new Error("BYTE_LIMIT_EXCEEDED");
    if (input.encoded && size / input.declared > input.maximumDecompressionRatio)
      throw new Error("DECOMPRESSION_RATIO_EXCEEDED");
    chunks.push(item.value);
  }
  return concatChunks(chunks, size);
}

function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
