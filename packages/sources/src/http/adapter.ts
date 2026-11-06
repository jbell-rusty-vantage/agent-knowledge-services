import { sha256Digest } from "@aiengineer/knowledge-core";
import type { ArtifactStore } from "@aiengineer/knowledge-core";
import type {
  AcquisitionAdapter,
  AcquisitionObservation,
  AcquisitionPlan,
  AcquisitionRequest,
  AcquisitionResult,
  AcquisitionVerification,
  AdmittedAcquisitionPlan,
  SupportDecision,
} from "../types.js";
import { boundedBody } from "./body.js";
import {
  assertSafeHttpUrl,
  defaultResolver,
  resolveSafeHttpTarget,
  type DnsResolver,
  type HttpPolicy,
  type SafeHttpTarget,
} from "./policy.js";
import { nodePinnedHttpTransport, type HttpFetch, type PinnedHttpTransport } from "./transport.js";

const REDACTED_HEADER = /authorization|cookie|api[-_]?key|secret|token/i;
const USER_AGENT = "ai-engineer-knowledge-services/1";
const FALLBACK_MEDIA_TYPE = "application/octet-stream";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class ExactHttpAcquisitionAdapter implements AcquisitionAdapter {
  readonly adapterKey = "direct-http";
  readonly version = "1.0.0";
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly policy: HttpPolicy,
    private readonly resolver: DnsResolver = defaultResolver,
    private readonly fetcher?: HttpFetch,
    private readonly pinnedTransport: PinnedHttpTransport = nodePinnedHttpTransport,
  ) {}
  supports(request: AcquisitionRequest): SupportDecision {
    return request.target.kind === "http"
      ? { supported: true, reason: "exact HTTP capture" }
      : { supported: false, reason: "HTTP target required" };
  }
  async plan(request: AcquisitionRequest): Promise<AcquisitionPlan> {
    if (request.target.kind !== "http") throw new Error("UNSUPPORTED_TARGET");
    const url = await assertSafeHttpUrl(request.target.url, this.policy, this.resolver);
    return {
      adapterKey: this.adapterKey,
      adapterVersion: this.version,
      request,
      normalizedTarget: url.href,
      policyDigest: sha256Digest(httpPolicySnapshot(this.policy)),
    };
  }
  async execute(plan: AdmittedAcquisitionPlan): Promise<AcquisitionResult> {
    return withDeadline(this.policy.timeoutMs, (signal) => this.capture(plan, signal));
  }
  async verify(result: AcquisitionResult): Promise<AcquisitionVerification> {
    const findings: string[] = [];
    if (!hasSingleSealedArtifact(result)) findings.push("artifact_digest_mismatch");
    if (REDACTED_HEADER.test(observationValue(result, "headers"))) findings.push("headers_not_redacted");
    return {
      accepted: findings.length === 0 && result.errors.length === 0,
      checks: ["artifact_sealed", "response_body_hashed", "headers_redacted"],
      findings,
    };
  }
  private async capture(plan: AdmittedAcquisitionPlan, signal: AbortSignal): Promise<AcquisitionResult> {
    const arrived = await this.followRedirects(plan, signal);
    const bytes = await boundedBody({
      response: arrived.response,
      maximumBytes: Math.min(plan.request.maximumBytes, this.policy.maximumBytes),
      maximumDecompressionRatio: this.policy.maximumDecompressionRatio,
      signal,
    });
    signal.throwIfAborted();
    const mediaType = observedMediaType(arrived.response);
    const artifact = await this.artifacts.put({
      tenantId: plan.request.tenantId,
      mediaType,
      bytes,
    });
    return {
      plan,
      artifacts: [artifact],
      contentDigests: [artifact.digest],
      observations: captureObservations(arrived, mediaType),
      discoveredCanonicalIdentifiers: [arrived.url],
      captureMethod: `${this.adapterKey}@${this.version}`,
      retryAdvice: arrived.response.status >= 500 ? "retry" : "none",
      costMicros: 0,
      errors: arrived.response.ok ? [] : [{ code: "HTTP_STATUS", message: String(arrived.response.status) }],
    };
  }
  private async followRedirects(plan: AdmittedAcquisitionPlan, signal: AbortSignal): Promise<ArrivedResponse> {
    let url = plan.normalizedTarget;
    const redirects: string[] = [];
    let response: Response | undefined;
    for (let count = 0; count <= this.policy.maximumRedirects; count++) {
      response = await this.fetchHop(url, plan.request.preferredMediaTypes, signal);
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("REDIRECT_WITHOUT_LOCATION");
      if (count === this.policy.maximumRedirects) throw new Error("REDIRECT_LIMIT_EXCEEDED");
      url = new URL(location, url).href;
      redirects.push(url);
    }
    if (!response) throw new Error("HTTP_NO_RESPONSE");
    return { response, url, redirects };
  }
  private async fetchHop(url: string, preferredMediaTypes: readonly string[], signal: AbortSignal): Promise<Response> {
    const target = await resolveSafeHttpTarget(url, this.policy, this.resolver);
    signal.throwIfAborted();
    const response = await this.dispatchFetch(target, {
      redirect: "manual",
      signal,
      headers: captureRequestHeaders(preferredMediaTypes),
    });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    return response;
  }
  private dispatchFetch(target: SafeHttpTarget, init: RequestInit): Promise<Response> {
    return this.fetcher
      ? this.fetcher(target.url.href, init)
      : this.pinnedTransport.fetch(target.url, init, target.addresses);
  }
}

async function withDeadline<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("ACQUISITION_TIMEOUT");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

interface ArrivedResponse {
  response: Response;
  url: string;
  redirects: readonly string[];
}

function captureRequestHeaders(preferredMediaTypes: readonly string[]): Record<string, string> {
  return {
    accept: preferredMediaTypes.join(", ") || "*/*",
    "accept-encoding": "identity",
    "user-agent": USER_AGENT,
  };
}

function observedMediaType(response: Response): string {
  return response.headers.get("content-type")?.split(";")[0]?.trim() || FALLBACK_MEDIA_TYPE;
}

function redactedHeaders(response: Response): readonly [string, string][] {
  return [...response.headers.entries()]
    .filter(([key]) => !REDACTED_HEADER.test(key))
    .sort(([left], [right]) => left.localeCompare(right));
}

function captureObservations(arrived: ArrivedResponse, mediaType: string): AcquisitionObservation[] {
  return [
    { key: "status", value: String(arrived.response.status) },
    { key: "final_url", value: arrived.url },
    { key: "redirects", value: JSON.stringify(arrived.redirects) },
    { key: "headers", value: JSON.stringify(redactedHeaders(arrived.response)) },
    {
      key: "declared_content_type",
      value: arrived.response.headers.get("content-type") ?? "",
    },
    { key: "observed_media_type", value: mediaType },
  ];
}

function observationValue(result: AcquisitionResult, key: string): string {
  return result.observations.find((item) => item.key === key)?.value ?? "";
}

function hasSingleSealedArtifact(result: AcquisitionResult): boolean {
  return result.artifacts.length === 1 && result.artifacts[0]?.digest === result.contentDigests[0];
}

type HttpPolicySnapshot = {
  allowedProtocols: HttpPolicy["allowedProtocols"][number][];
  allowedPorts: number[];
  maximumRedirects: number;
  timeoutMs: number;
  maximumBytes: number;
  maximumDecompressionRatio: number;
  allowedHosts?: string[];
  deniedHosts?: string[];
};

function httpPolicySnapshot(policy: HttpPolicy): HttpPolicySnapshot {
  return {
    allowedProtocols: [...policy.allowedProtocols],
    allowedPorts: [...policy.allowedPorts],
    maximumRedirects: policy.maximumRedirects,
    timeoutMs: policy.timeoutMs,
    maximumBytes: policy.maximumBytes,
    maximumDecompressionRatio: policy.maximumDecompressionRatio,
    ...(policy.allowedHosts === undefined ? {} : { allowedHosts: [...policy.allowedHosts] }),
    ...(policy.deniedHosts === undefined ? {} : { deniedHosts: [...policy.deniedHosts] }),
  };
}
