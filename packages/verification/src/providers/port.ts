import { digestCanonicalJson } from "../canonical/index.js";

export type JsonObject = Readonly<Record<string, unknown>>;
export type JsonSchema = Readonly<Record<string, unknown>>;

export type ProviderModality = "text" | "image" | "audio";

/**
 * Trusted persistence the provider adapters write to around every external
 * call. The sink decides whether external processing is admitted at all and
 * retains request/response bytes so the exchange can be replayed and audited.
 */
export interface ProviderArtifactSink {
  assertExternalProcessingAdmission(input: {
    readonly providerId: string;
    readonly modality: ProviderModality;
  }): Promise<void>;
  persistBeforeDispatch(input: {
    readonly requestDigest: `sha256:${string}`;
    readonly requestBytes: Uint8Array;
  }): Promise<void>;
  /** A missing precontext means the response had no admitted provider precontext. */
  persistAfterResponse(input: {
    readonly requestDigest: `sha256:${string}`;
    readonly rawResponseBytes: Uint8Array;
    readonly precontextBytes?: Uint8Array;
    /** Actual HTTP status when an adapter observed an HTTP response. */
    readonly httpStatus?: number;
  }): Promise<void>;
}

export type ProviderFailureCode =
  | "PROVIDER_CANCELLED"
  | "PROVIDER_DEADLINE_EXCEEDED"
  | "PROVIDER_NETWORK_FAILURE"
  | "PROVIDER_HTTP_FAILURE"
  | "PROVIDER_RESPONSE_TOO_LARGE"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_RESPONSE_SCHEMA_INVALID"
  | "PROVIDER_CONFIGURATION_INVALID"
  | "PROVIDER_UNSUPPORTED_TASK"
  | "PROVIDER_INPUT_POLICY_REJECTED"
  | "PROVIDER_ARTIFACT_PERSISTENCE_FAILURE";

/** The only error type adapters raise; `retryable` is decided at the throw site, never by callers. */
export class ProviderFailure extends Error {
  constructor(
    readonly code: ProviderFailureCode,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

/** Digest of canonical JSON; the identity of requests, schemas and configurations. */
export function providerDigest(value: unknown): `sha256:${string}` {
  return digestCanonicalJson(value);
}

/** Sink failures surface as one non-retryable code unless the sink itself raised a `ProviderFailure`. */
export function artifactFailure(error: unknown): ProviderFailure {
  return error instanceof ProviderFailure ? error : new ProviderFailure("PROVIDER_ARTIFACT_PERSISTENCE_FAILURE", false);
}
