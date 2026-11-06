import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { SourceDiscoveryHost } from "@aiengineer/knowledge-application";
import { SourceDiscoveryResultSchema, type ManagedSourceDiscoveryRequest } from "@aiengineer/knowledge-contracts";
import { canonicalizeJson, sha256Digest } from "@aiengineer/knowledge-verification";

const MAXIMUM_RESPONSE_BYTES = 8_000_000;
const REQUEST_TIMEOUT_MS = 60_000;
const domains = z.array(z.string().min(1).max(253)).max(100).optional();
const parameters = {
  tavily: z.strictObject({
    max_results: z.int().min(1).max(20).optional(),
    search_depth: z.enum(["basic", "advanced", "fast", "ultra-fast"]).optional(),
    include_domains: domains,
    exclude_domains: domains,
  }),
  firecrawl: z.strictObject({
    limit: z.int().min(1).max(20).optional(),
    includeDomains: domains,
    excludeDomains: domains,
    country: z.string().length(2).optional(),
  }),
};

type ProviderCode = keyof typeof parameters;
export interface DiscoveryHostConfig {
  readonly tavilyApiKey?: string;
  readonly firecrawlApiKey?: string;
}

export function validateManagedDiscoveryRequest(request: ManagedSourceDiscoveryRequest): void {
  if (!Object.hasOwn(parameters, request.providerCode)) throw new Error("SOURCE_DISCOVERY_PROVIDER_UNSUPPORTED");
  parameters[request.providerCode as ProviderCode].parse(request.parameters);
  if (request.requestedUrls.length) throw new Error("SOURCE_DISCOVERY_SEARCH_REQUESTED_URLS_UNSUPPORTED");
}

function providerRequest(request: ManagedSourceDiscoveryRequest, config: DiscoveryHostConfig) {
  validateManagedDiscoveryRequest(request);
  if (request.providerCode === "tavily")
    return {
      endpoint: "https://api.tavily.com/search",
      key: config.tavilyApiKey,
      body: {
        query: request.queryText,
        max_results: 5,
        search_depth: "basic",
        ...parameters.tavily.parse(request.parameters),
        include_answer: false,
        include_raw_content: false,
        auto_parameters: false,
      },
    };
  return {
    endpoint: "https://api.firecrawl.dev/v2/search",
    key: config.firecrawlApiKey,
    body: { query: request.queryText, limit: 5, ...parameters.firecrawl.parse(request.parameters), sources: ["web"] },
  };
}

interface ProviderBody {
  readonly bytes: Uint8Array;
  readonly interruption?: "limit" | "transport";
  readonly observedByteLength: number;
}

async function boundedBody(response: Response): Promise<ProviderBody> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), observedByteLength: 0 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (size + next.value.byteLength > MAXIMUM_RESPONSE_BYTES) {
        chunks.push(next.value.subarray(0, MAXIMUM_RESPONSE_BYTES - size));
        await reader.cancel().catch(() => undefined);
        return {
          bytes: Buffer.concat(chunks),
          interruption: "limit",
          observedByteLength: size + next.value.byteLength,
        };
      }
      size += next.value.byteLength;
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { bytes: Buffer.concat(chunks), interruption: "transport", observedByteLength: size };
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks), observedByteLength: size };
}

const resultRow = z
  .object({
    url: z.string().url(),
    title: z.string().optional(),
    content: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();
function sanitizeResponse(bytes: Uint8Array, secret: string) {
  const original = Buffer.from(bytes);
  const credential = Buffer.from(secret);
  const replacement = credential.length >= 10 ? Buffer.from("[REDACTED]") : Buffer.alloc(credential.length, "*");
  const chunks: Buffer[] = [];
  let offset = 0;
  for (let found = original.indexOf(credential); found !== -1; found = original.indexOf(credential, offset)) {
    chunks.push(original.subarray(offset, found), replacement);
    offset = found + credential.length;
  }
  chunks.push(original.subarray(offset));
  const sanitized = Buffer.concat(chunks);
  try {
    return {
      sanitizedBytes: sanitized,
      validEncoding: true as const,
      text: new TextDecoder("utf-8", { fatal: true }).decode(sanitized),
      rawOutput: sanitized,
    };
  } catch {
    return {
      sanitizedBytes: sanitized,
      validEncoding: false as const,
      rawOutput: new TextEncoder().encode(
        canonicalizeJson({
          bodyEncoding: "base64",
          originalByteLength: bytes.byteLength,
          credentialRedacted: offset > 0,
          body: sanitized.toString("base64"),
        }),
      ),
    };
  }
}

function normalizeResults(providerCode: string, body: unknown) {
  const rows =
    providerCode === "tavily"
      ? z.object({ results: z.array(resultRow).max(20) }).parse(body).results
      : z.object({ success: z.literal(true), data: z.object({ web: z.array(resultRow).max(20) }) }).parse(body).data
          .web;
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const duplicate = seen.has(row.url);
    seen.add(row.url);
    return SourceDiscoveryResultSchema.parse({
      rank: index + 1,
      requestedUrl: row.url,
      finalUrl: row.url,
      redirectUrls: [],
      disposition: duplicate ? "duplicate" : "unreviewed",
      sourceClass: "web_page",
      ...(row.title ? { title: row.title } : {}),
      ...(row.content || row.description ? { snippet: row.content || row.description } : {}),
      payloadDigest: sha256Digest(canonicalizeJson(row)),
    });
  });
}

/** Host credentials and fixed endpoints cannot be supplied by the research caller. */
export function createSourceDiscoveryHost(
  config: DiscoveryHostConfig,
  fetcher: typeof fetch = fetch,
): SourceDiscoveryHost {
  return {
    holderIdentity: `source-discovery-host:${randomUUID()}`,
    prepareRequest(request) {
      validateManagedDiscoveryRequest(request);
      return {
        ...request,
        providerVersion: request.providerCode === "tavily" ? "tavily-search.unversioned" : "firecrawl-search.v2",
      };
    },
    async executeManaged(request) {
      const provider = providerRequest(request, config);
      const synthetic = (failureCode: string) => ({
        state: "failed" as const,
        failureCode,
        rawOutput: new TextEncoder().encode(canonicalizeJson({ failureCode, dispatched: false })),
      });
      if (!provider.key) return synthetic("SOURCE_DISCOVERY_PROVIDER_UNCONFIGURED");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetcher(provider.endpoint, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${provider.key}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(provider.body),
        });
        const body = await boundedBody(response);
        const sanitized = sanitizeResponse(body.bytes, provider.key);
        const rawOutput = sanitized.rawOutput;
        if (body.interruption)
          return {
            state: body.interruption === "transport" ? "uncertain" : "failed",
            failureCode:
              body.interruption === "transport"
                ? "SOURCE_DISCOVERY_RESPONSE_INTERRUPTED"
                : "SOURCE_DISCOVERY_RESPONSE_TOO_LARGE",
            rawOutput: new TextEncoder().encode(
              canonicalizeJson({
                schemaVersion: "source-discovery-partial-response.v1",
                responseComplete: false,
                httpStatus: response.status,
                observedByteLength: body.observedByteLength,
                maximumRetainedBytes: MAXIMUM_RESPONSE_BYTES,
                retainedEncoding: "base64",
                retained: sanitized.sanitizedBytes.toString("base64"),
                retainedIsEncodingEnvelope: false,
                retainedUtf8Valid: sanitized.validEncoding,
              }),
            ),
          };
        if (!sanitized.validEncoding)
          return { state: "failed", failureCode: "SOURCE_DISCOVERY_RESPONSE_ENCODING_INVALID", rawOutput };
        if (!response.ok) return { state: "failed", failureCode: `PROVIDER_HTTP_${response.status}`, rawOutput };
        try {
          return {
            state: "succeeded",
            rawOutput,
            results: normalizeResults(request.providerCode, JSON.parse(sanitized.text)),
          };
        } catch {
          return { state: "failed", failureCode: "SOURCE_DISCOVERY_RESPONSE_INVALID", rawOutput };
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
