export type ConversionFetch = (url: string, init?: RequestInit) => Promise<Response>;

const LOCAL_HTTP_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SHA256_URI_PREFIX = "sha256:";
const SEALED_FILENAME_DIGEST_CHARS = 12;
const HTTPS_PROTOCOL = "https:";
const HTTP_PROTOCOL = "http:";

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sealedArtifactFileName(digest: string, suffix: string): string {
  return `sealed-${digest.slice(
    SHA256_URI_PREFIX.length,
    SHA256_URI_PREFIX.length + SEALED_FILENAME_DIGEST_CHARS,
  )}.${suffix}`;
}

export async function readBounded(response: Response, maximumBytes: number, errorCode: string): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(errorCode);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel(errorCode).catch(() => undefined);
        throw new Error(errorCode);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonObject(
  response: Response,
  httpErrorPrefix: string,
  invalidError: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${httpErrorPrefix}${response.status}`);
  const value: unknown = await response.json();
  if (!isJsonRecord(value)) {
    throw new Error(invalidError);
  }
  return value;
}

export function denyUnsafeHttpUrl(value: string, errorCode: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(errorCode);
  }
  const localHttp = url.protocol === HTTP_PROTOCOL && LOCAL_HTTP_HOSTS.has(url.hostname);
  if (url.protocol !== HTTPS_PROTOCOL && !localHttp) throw new Error(errorCode);
  return url.href.replace(/\/$/, "");
}
