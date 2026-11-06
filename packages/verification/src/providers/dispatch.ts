import {
  abortFailure,
  boundedJsonBytes,
  boundedResponseBytes,
  requestSignal,
  requireActive,
  type ProviderExecution,
} from "./http.js";
import {
  artifactFailure,
  ProviderFailure,
  providerDigest,
  type ProviderArtifactSink,
  type ProviderModality,
} from "./port.js";

/** Canonical request bytes and their digest, prepared before any signal or side effect exists. */
export interface BoundedRequest {
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
}

export function boundedRequest(body: unknown, maximumBytes: number): BoundedRequest {
  return {
    bytes: boundedJsonBytes(body, maximumBytes),
    digest: providerDigest(body),
  };
}

/** What a vendor interpreter receives once the exchange is retained: the bytes, the status, and two hooks. */
export interface CapturedCompletion {
  readonly request: BoundedRequest;
  readonly rawResponseBytes: Uint8Array;
  readonly httpStatus: number;
  readonly startedEpochMs: number;
  /** Throws the cancellation/deadline failure when the dispatch signal has fired. */
  readonly assertActive: () => void;
  /** Vendor hook: retains an additional response projection (e.g. Interfaze precontext) against the same request. */
  readonly persistPrecontext: (precontextBytes: Uint8Array) => Promise<void>;
}

export interface BoundedCompletionDispatch<Result> {
  readonly sink: ProviderArtifactSink;
  readonly providerId: string;
  readonly modality: ProviderModality;
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly request: BoundedRequest;
  readonly maxResponseBytes: number;
  readonly execution: ProviderExecution;
  readonly fetch: typeof fetch;
  readonly interpret: (captured: CapturedCompletion) => Promise<Result> | Result;
}

/**
 * The one external-call procedure every adapter uses:
 * admission → persist request → fetch → bounded read → persist response (with
 * HTTP status) → status check → vendor interpretation. The request is retained
 * before the network is touched and the response before it is parsed, so an
 * audit can always replay what was sent and what came back. Cancellation and
 * deadline are mapped to `ProviderFailure` in one place.
 */
export async function dispatchBoundedCompletion<Result>(dispatch: BoundedCompletionDispatch<Result>): Promise<Result> {
  const { sink, request, execution } = dispatch;
  const active = requestSignal(execution);
  const startedEpochMs = Date.now();
  const assertActive = () => requireActive(active.signal, execution);
  try {
    await admit(dispatch, assertActive);
    const response = await dispatch.fetch(dispatch.endpoint, {
      method: "POST",
      redirect: "error",
      headers: dispatch.headers,
      body: request.bytes,
      signal: active.signal,
    });
    const rawResponseBytes = await boundedResponseBytes(response, dispatch.maxResponseBytes, active.signal);
    const httpStatus = response.status;
    await retain(sink, assertActive, {
      requestDigest: request.digest,
      rawResponseBytes,
      httpStatus,
    });
    if (!response.ok) throw new ProviderFailure("PROVIDER_HTTP_FAILURE", isRetryableHttpStatus(httpStatus));
    return await dispatch.interpret({
      request,
      rawResponseBytes,
      httpStatus,
      startedEpochMs,
      assertActive,
      persistPrecontext: (precontextBytes) =>
        retain(sink, assertActive, {
          requestDigest: request.digest,
          rawResponseBytes,
          precontextBytes,
          httpStatus,
        }),
    });
  } catch (error) {
    if (active.signal.aborted) throw abortFailure(execution);
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure("PROVIDER_NETWORK_FAILURE", true);
  } finally {
    active.release();
  }
}

export const isRetryableHttpStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** External processing must be admitted and the request retained before the network is touched. */
async function admit(dispatch: BoundedCompletionDispatch<unknown>, assertActive: () => void): Promise<void> {
  try {
    await dispatch.sink.assertExternalProcessingAdmission({
      providerId: dispatch.providerId,
      modality: dispatch.modality,
    });
    assertActive();
    await dispatch.sink.persistBeforeDispatch({
      requestDigest: dispatch.request.digest,
      requestBytes: dispatch.request.bytes,
    });
    assertActive();
  } catch (error) {
    throw artifactFailure(error);
  }
}

async function retain(
  sink: ProviderArtifactSink,
  assertActive: () => void,
  input: Parameters<ProviderArtifactSink["persistAfterResponse"]>[0],
): Promise<void> {
  try {
    await sink.persistAfterResponse(input);
    assertActive();
  } catch (error) {
    throw artifactFailure(error);
  }
}
