import {
  nodePinnedHttpTransport,
  resolveSafeHttpTarget,
  type DnsResolver,
  type HttpPolicy,
  type PinnedHttpTransport,
} from "@aiengineer/knowledge-acquisition";

/** A server-owned, exact URL grant. Public callers select a key, never a URL. */
export interface VerificationSourceAcquisitionGrant {
  readonly sourceKey: string;
  readonly sourceUri: string;
  readonly redirectUris?: readonly string[];
  readonly acceptedMediaTypes: readonly string[];
  readonly maximumBytes: number;
  readonly timeoutMs: number;
}

export interface VerificationSourceAcquisitionRequest {
  readonly sourceKey: string;
  readonly signal?: AbortSignal;
}

export interface AcquiredVerificationSource {
  readonly sourceKey: string;
  readonly sourceUri: string;
  readonly finalUri: string;
  readonly redirectUris: readonly string[];
  readonly status: number;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly capturedAt: string;
  readonly responseMetadata: Readonly<{
    contentLength?: number;
    etag?: string;
    lastModified?: string;
  }>;
}

/** The narrow worker-facing port; persistence and admission are deliberately outside it. */
export interface VerificationSourceAcquirer {
  acquire(input: VerificationSourceAcquisitionRequest): Promise<AcquiredVerificationSource>;
}

interface TrustedGrant {
  readonly sourceKey: string;
  readonly sourceUri: string;
  readonly redirectUris: readonly string[];
  readonly acceptedMediaTypes: readonly string[];
  readonly maximumBytes: number;
  readonly timeoutMs: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 8;

function canonicalHttpsUri(value: string, code: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port) throw new Error(code);
  return url.href;
}

function checkedPositiveInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}

function mediaType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

async function readBoundedBody(response: Response, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declaredText = response.headers.get("content-length");
  const declared = declaredText === null ? undefined : Number(declaredText);
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0 || declared > maximumBytes))
    throw new Error("SOURCE_ACQUISITION_BYTE_LIMIT_EXCEEDED");
  if ((response.headers.get("content-encoding") ?? "identity").trim().toLowerCase() !== "identity")
    throw new Error("SOURCE_ACQUISITION_CONTENT_ENCODING_DENIED");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) throw new Error("SOURCE_ACQUISITION_BYTE_LIMIT_EXCEEDED");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export class VerificationSourceAcquisitionCatalog {
  readonly #grants: ReadonlyMap<string, TrustedGrant>;
  readonly #policy: HttpPolicy;

  constructor(grants: readonly VerificationSourceAcquisitionGrant[]) {
    const entries = new Map<string, TrustedGrant>();
    const hosts = new Set<string>();
    for (const raw of grants) {
      if (!/^[a-z][a-z0-9_-]{0,127}$/.test(raw.sourceKey) || entries.has(raw.sourceKey))
        throw new Error("SOURCE_ACQUISITION_GRANT_KEY_INVALID");
      const sourceUri = canonicalHttpsUri(raw.sourceUri, "SOURCE_ACQUISITION_GRANT_URI_INVALID");
      const redirects = (raw.redirectUris ?? []).map((item) =>
        canonicalHttpsUri(item, "SOURCE_ACQUISITION_GRANT_REDIRECT_INVALID"),
      );
      if (new Set(redirects).size !== redirects.length || redirects.includes(sourceUri))
        throw new Error("SOURCE_ACQUISITION_GRANT_REDIRECT_DUPLICATES_SOURCE");
      const acceptedMediaTypes = raw.acceptedMediaTypes.map((item) => item.trim().toLowerCase());
      if (
        acceptedMediaTypes.length === 0 ||
        new Set(acceptedMediaTypes).size !== acceptedMediaTypes.length ||
        acceptedMediaTypes.some((item) => !/^[a-z]+\/[a-z0-9.+-]+$/.test(item))
      )
        throw new Error("SOURCE_ACQUISITION_GRANT_MEDIA_TYPE_INVALID");
      const maximumBytes = checkedPositiveInteger(
        raw.maximumBytes,
        1,
        50 * 1024 * 1024,
        "SOURCE_ACQUISITION_GRANT_BYTE_LIMIT_INVALID",
      );
      const timeoutMs = checkedPositiveInteger(raw.timeoutMs, 100, 60_000, "SOURCE_ACQUISITION_GRANT_TIMEOUT_INVALID");
      for (const uri of [sourceUri, ...redirects]) hosts.add(new URL(uri).hostname.toLowerCase());
      entries.set(
        raw.sourceKey,
        Object.freeze({
          sourceKey: raw.sourceKey,
          sourceUri,
          redirectUris: Object.freeze([...redirects]),
          acceptedMediaTypes: Object.freeze([...acceptedMediaTypes]),
          maximumBytes,
          timeoutMs,
        }),
      );
    }
    if (entries.size === 0) throw new Error("SOURCE_ACQUISITION_GRANTS_REQUIRED");
    this.#grants = entries;
    this.#policy = Object.freeze({
      allowedProtocols: Object.freeze(["https:"] as const),
      allowedPorts: Object.freeze([443]),
      maximumRedirects: MAX_REDIRECTS,
      timeoutMs: 60_000,
      maximumBytes: 50 * 1024 * 1024,
      maximumDecompressionRatio: 1,
      allowedHosts: Object.freeze([...hosts]),
    });
  }

  resolve(sourceKey: string): TrustedGrant {
    const grant = this.#grants.get(sourceKey);
    if (!grant) throw new Error("SOURCE_ACQUISITION_NOT_ADMITTED");
    return grant;
  }

  /** Exposes immutable network constraints to the acquisition implementation only. */
  get safeHttpPolicy(): HttpPolicy {
    return this.#policy;
  }
}

/**
 * Performs a bounded capture only. It intentionally has no artifact store or
 * registration dependency, so a caller cannot mistake acquisition for admission.
 */
export class TrustedVerificationSourceAcquirer implements VerificationSourceAcquirer {
  constructor(
    private readonly catalog: VerificationSourceAcquisitionCatalog,
    private readonly resolver: DnsResolver,
    private readonly now: () => string,
    private readonly transport: PinnedHttpTransport = nodePinnedHttpTransport,
  ) {}

  async acquire(input: VerificationSourceAcquisitionRequest): Promise<AcquiredVerificationSource> {
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.sourceKey !== "string" ||
      input.sourceKey.length === 0 ||
      Object.keys(input as unknown as Record<string, unknown>).some((key) => key !== "sourceKey" && key !== "signal")
    ) {
      throw new Error("SOURCE_ACQUISITION_REQUEST_INVALID");
    }
    const grant = this.catalog.resolve(input.sourceKey);
    const timeout = AbortSignal.timeout(grant.timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let current = grant.sourceUri;
    const redirects: string[] = [];
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        signal.throwIfAborted();
        const target = await resolveSafeHttpTarget(current, this.catalog.safeHttpPolicy, this.resolver);
        const response = await this.transport.fetch(
          target.url,
          {
            method: "GET",
            redirect: "manual",
            signal,
            headers: {
              accept: grant.acceptedMediaTypes.join(", "),
              "accept-encoding": "identity",
              "user-agent": "ai-engineer-knowledge-services/verification-source-acquisition",
            },
          },
          target.addresses,
        );
        signal.throwIfAborted();
        if (!REDIRECT_STATUSES.has(response.status)) {
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("SOURCE_ACQUISITION_HTTP_STATUS");
          }
          const observedMediaType = mediaType(response.headers.get("content-type"));
          if (!grant.acceptedMediaTypes.includes(observedMediaType)) {
            await response.body?.cancel();
            throw new Error("SOURCE_ACQUISITION_MEDIA_TYPE_DENIED");
          }
          const bytes = await readBoundedBody(response, grant.maximumBytes, signal);
          const contentLength = response.headers.get("content-length");
          const parsedLength = contentLength === null ? undefined : Number(contentLength);
          return Object.freeze({
            sourceKey: grant.sourceKey,
            sourceUri: grant.sourceUri,
            finalUri: current,
            redirectUris: Object.freeze([...redirects]),
            status: response.status,
            mediaType: observedMediaType,
            bytes: new Uint8Array(bytes),
            capturedAt: new Date(this.now()).toISOString(),
            responseMetadata: Object.freeze({
              ...(parsedLength === undefined ? {} : { contentLength: parsedLength }),
              ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
              ...(response.headers.get("last-modified")
                ? { lastModified: response.headers.get("last-modified")! }
                : {}),
            }),
          });
        }
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("SOURCE_ACQUISITION_REDIRECT_WITHOUT_LOCATION");
        if (hop === MAX_REDIRECTS) throw new Error("SOURCE_ACQUISITION_REDIRECT_LIMIT_EXCEEDED");
        const next = new URL(location, current).href;
        if (!grant.redirectUris.includes(next) || redirects.includes(next))
          throw new Error("SOURCE_ACQUISITION_REDIRECT_NOT_ADMITTED");
        redirects.push(next);
        current = next;
      }
      throw new Error("SOURCE_ACQUISITION_REDIRECT_LIMIT_EXCEEDED");
    } finally {
      // AbortSignal.timeout has no explicit cleanup API; its timer is GC-owned.
    }
  }
}
