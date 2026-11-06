import { sha256Digest } from "@aiengineer/knowledge-core";
import type { ArtifactStore, StoredArtifact } from "@aiengineer/knowledge-core";
import { assertSafeHttpUrl, type DnsResolver, type HttpFetch, type HttpPolicy } from "../http/index.js";
import type {
  AcquisitionAdapter,
  AcquisitionPlan,
  AcquisitionRequest,
  AcquisitionResult,
  AcquisitionVerification,
  AdmittedAcquisitionPlan,
  SupportDecision,
} from "../types.js";

export interface SecretResolver {
  resolve(reference: string): Promise<string>;
}
export interface FirecrawlConfiguration {
  endpoint: string;
  authenticationReference: string;
  apiVersion: string;
  timeoutMs: number;
  maximumResponseBytes: number;
  maximumDecompressionRatio: number;
  allowedApiHosts: readonly string[];
  targetPolicy: HttpPolicy;
}
type JsonRecord = Record<string, unknown>;

async function boundedProviderBody(
  response: Response,
  maximumBytes: number,
  maximumRatio: number,
): Promise<Uint8Array> {
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
  const encoded = Boolean(
    response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity",
  );
  if (encoded && (!Number.isFinite(declared) || declared <= 0)) throw new Error("ENCODED_LENGTH_REQUIRED");
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("BYTE_LIMIT_EXCEEDED");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("BYTE_LIMIT_EXCEEDED");
    }
    chunks.push(item.value);
  }
  if (encoded && size / declared > maximumRatio) throw new Error("DECOMPRESSION_RATIO_EXCEEDED");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
function redact(value: unknown, secret: string): unknown {
  if (typeof value === "string") return secret ? value.replaceAll(secret, "[REDACTED]") : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /authorization|cookie|api[-_]?key|secret|token/i.test(key) ? "[REDACTED]" : redact(item, secret),
      ]),
    );
  return value;
}
function dataRecord(value: JsonRecord): JsonRecord {
  const data = value.data;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonRecord) : value;
}

// Library only; do not grow it. Agents use the Firecrawl skill and import the
// receipt through source_import (docs/operations/reviews/acquisition.md).
export class FirecrawlAcquisitionAdapter implements AcquisitionAdapter {
  readonly adapterKey = "firecrawl-scrape";
  readonly version: string;
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly config: FirecrawlConfiguration,
    private readonly secrets: SecretResolver,
    private readonly resolver: DnsResolver,
    private readonly fetcher: HttpFetch = fetch,
  ) {
    this.version = config.apiVersion;
  }
  supports(request: AcquisitionRequest): SupportDecision {
    return request.target.kind === "http"
      ? { supported: true, reason: "configured Firecrawl extraction" }
      : { supported: false, reason: "HTTP target required" };
  }
  private async endpoint(): Promise<URL> {
    const url = new URL(this.config.endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !this.config.allowedApiHosts.includes(url.hostname.toLowerCase())
    )
      throw new Error("FIRECRAWL_ENDPOINT_DENIED");
    return url;
  }
  async plan(request: AcquisitionRequest): Promise<AcquisitionPlan> {
    if (request.target.kind !== "http") throw new Error("UNSUPPORTED_TARGET");
    const target = await assertSafeHttpUrl(request.target.url, this.config.targetPolicy, this.resolver);
    await this.endpoint();
    if (request.authenticationReference && request.authenticationReference !== this.config.authenticationReference)
      throw new Error("AUTHENTICATION_REFERENCE_MISMATCH");
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.version,
      request,
      normalizedTarget: target.href,
      policyDigest: sha256Digest({
        endpoint: this.config.endpoint,
        apiVersion: this.config.apiVersion,
        timeoutMs: this.config.timeoutMs,
        maximumResponseBytes: this.config.maximumResponseBytes,
        maximumDecompressionRatio: this.config.maximumDecompressionRatio,
        allowedApiHosts: [...this.config.allowedApiHosts],
      }),
    };
  }
  async execute(plan: AdmittedAcquisitionPlan): Promise<AcquisitionResult> {
    if (plan.request.target.kind !== "http") throw new Error("UNSUPPORTED_TARGET");
    await assertSafeHttpUrl(plan.normalizedTarget, this.config.targetPolicy, this.resolver);
    const endpoint = await this.endpoint();
    const secret = await this.secrets.resolve(this.config.authenticationReference);
    if (!secret) throw new Error("AUTHENTICATION_SECRET_UNAVAILABLE");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(endpoint.href, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          url: plan.normalizedTarget,
          formats: ["markdown", "html", "rawHtml"],
          onlyMainContent: false,
          maxAge: 0,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("PROVIDER_REDIRECT_DENIED");
    const raw = await boundedProviderBody(
      response,
      this.config.maximumResponseBytes,
      this.config.maximumDecompressionRatio,
    );
    let parsed: JsonRecord;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw)) as JsonRecord;
    } catch {
      throw new Error("FIRECRAWL_RESPONSE_INVALID");
    }
    const sanitized = redact(parsed, secret) as JsonRecord;
    const nativeBytes = new TextEncoder().encode(JSON.stringify(sanitized));
    const outputs = dataRecord(sanitized);
    const artifacts: StoredArtifact[] = [
      await this.artifacts.put({
        tenantId: plan.request.tenantId,
        mediaType: "application/vnd.firecrawl+json",
        bytes: nativeBytes,
      }),
    ];
    let extractedBytes = 0;
    for (const [field, mediaType] of [
      ["markdown", "text/markdown"],
      ["html", "text/html"],
      ["rawHtml", "text/html"],
    ] as const) {
      const content = outputs[field];
      if (typeof content !== "string") continue;
      const bytes = new TextEncoder().encode(content);
      extractedBytes += bytes.byteLength;
      if (extractedBytes > plan.request.maximumBytes) throw new Error("BYTE_LIMIT_EXCEEDED");
      artifacts.push(
        await this.artifacts.put({
          tenantId: plan.request.tenantId,
          mediaType,
          bytes,
        }),
      );
    }
    const jobId = typeof sanitized.id === "string" ? sanitized.id : typeof outputs.id === "string" ? outputs.id : "";
    const cost =
      typeof sanitized.creditsUsed === "number" && Number.isFinite(sanitized.creditsUsed)
        ? Math.max(0, Math.round(sanitized.creditsUsed * 1000))
        : 0;
    return {
      plan,
      artifacts,
      contentDigests: artifacts.map((item) => item.digest),
      observations: [
        { key: "provider_job_id", value: jobId },
        { key: "provider_status", value: String(response.status) },
        { key: "provider_version", value: this.config.apiVersion },
        { key: "representations", value: String(artifacts.length - 1) },
      ],
      discoveredCanonicalIdentifiers: [plan.normalizedTarget],
      captureMethod: `${this.adapterKey}@${this.version}`,
      retryAdvice: response.status >= 500 ? "retry" : "none",
      costMicros: cost,
      errors:
        response.ok && sanitized.success !== false
          ? []
          : [
              {
                code: "FIRECRAWL_ERROR",
                message: `provider status ${response.status}`,
              },
            ],
    };
  }
  async verify(result: AcquisitionResult): Promise<AcquisitionVerification> {
    const findings: string[] = [];
    if (
      result.artifacts.length === 0 ||
      result.artifacts.some((item, index) => item.digest !== result.contentDigests[index])
    )
      findings.push("artifact_digest_mismatch");
    const serialized = JSON.stringify(result);
    if (/bearer\s+[a-z0-9._-]+/i.test(serialized)) findings.push("credential_exposure");
    return {
      accepted: findings.length === 0 && result.errors.length === 0,
      checks: [
        "target_ssrf",
        "configured_endpoint",
        "credential_redaction",
        "bounded_response",
        "provider_identity",
        "artifact_digest",
      ],
      findings,
    };
  }
}
