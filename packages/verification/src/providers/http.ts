import { canonicalizeJson } from "../canonical/index.js";
import { walkBoundedJson } from "../internal/bounded-json.js";
import { ProviderFailure } from "./port.js";

const encoder = new TextEncoder();
const utf8ByteLength = (value: string): number => encoder.encode(value).byteLength;

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface ProviderExecution {
  readonly signal?: AbortSignal;
  readonly deadlineEpochMs?: number;
}

export interface JsonPreflightLimits {
  readonly maximumNodes: number;
  readonly maximumDepth: number;
  readonly maximumCollection: number;
  readonly maximumStringBytes: number;
}

const REQUEST_BODY_LIMITS = {
  maximumNodes: 2_048,
  maximumDepth: 16,
  maximumCollection: 512,
} as const;
const RESPONSE_BODY_LIMITS = {
  maximumNodes: 4_096,
  maximumDepth: 20,
  maximumCollection: 512,
} as const;

/** Strings and keys are measured in UTF-8 bytes; only the aggregate string budget is a size failure. */
export function preflightJson(value: unknown, limits: JsonPreflightLimits): void {
  const violation = walkBoundedJson(value, {
    limits: { ...limits, maximumStringBudget: limits.maximumStringBytes },
    measure: { string: utf8ByteLength, key: utf8ByteLength },
    rejectNonFiniteNumbers: true,
    rejectNonJsonValues: true,
    plainObjectsOnly: false,
  });
  if (!violation) return;
  throw new ProviderFailure(
    violation.kind === "string_budget" ? "PROVIDER_RESPONSE_TOO_LARGE" : "PROVIDER_RESPONSE_INVALID",
    false,
  );
}

/** Canonical JSON bytes of an outbound body, rejected as input policy when they exceed the budget. */
export function boundedJsonBytes(value: unknown, maximumBytes: number): Uint8Array {
  preflightJson(value, {
    ...REQUEST_BODY_LIMITS,
    maximumStringBytes: maximumBytes,
  });
  const bytes = encoder.encode(canonicalizeJson(value));
  if (bytes.byteLength > maximumBytes) throw new ProviderFailure("PROVIDER_INPUT_POLICY_REJECTED", false);
  return bytes;
}

/** Reads a response body up to the limit; anything larger is cancelled and rejected before it is retained. */
export async function boundedResponseBytes(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) throw new ProviderFailure("PROVIDER_RESPONSE_INVALID", false);
  const reader = response.body.getReader();
  const pieces: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new ProviderFailure("PROVIDER_RESPONSE_TOO_LARGE", false);
      }
      pieces.push(part.value);
    }
  } catch (error) {
    if (signal?.aborted) throw new ProviderFailure("PROVIDER_DEADLINE_EXCEEDED", false);
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure("PROVIDER_NETWORK_FAILURE", true);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  return bytes;
}

export function parseBoundedResponseJson(bytes: Uint8Array, maximumBytes: number): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    preflightJson(value, {
      ...RESPONSE_BODY_LIMITS,
      maximumStringBytes: maximumBytes,
    });
    return value;
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure("PROVIDER_RESPONSE_INVALID", false);
  }
}

export async function boundedResponseJson(
  response: Response,
  maximumBytes: number,
): Promise<{ readonly value: unknown; readonly bytes: Uint8Array }> {
  const bytes = await boundedResponseBytes(response, maximumBytes);
  return Object.freeze({
    value: parseBoundedResponseJson(bytes, maximumBytes),
    bytes,
  });
}

/** One abort signal combining the caller's signal with the remaining deadline (capped at 60s). */
export function requestSignal(execution: ProviderExecution): {
  readonly signal: AbortSignal;
  readonly release: () => void;
} {
  if (execution.signal?.aborted) throw new ProviderFailure("PROVIDER_CANCELLED", false);
  const remaining =
    execution.deadlineEpochMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : execution.deadlineEpochMs - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new ProviderFailure("PROVIDER_DEADLINE_EXCEEDED", false);
  const timeout = AbortSignal.timeout(Math.min(remaining, DEFAULT_REQUEST_TIMEOUT_MS));
  const signal = execution.signal ? AbortSignal.any([execution.signal, timeout]) : timeout;
  return { signal, release: () => undefined };
}

/** Maps an aborted signal to cancellation (caller's signal) or deadline (timeout). */
export function requireActive(signal: AbortSignal, execution: { readonly signal?: AbortSignal }): void {
  if (!signal.aborted) return;
  throw abortFailure(execution);
}

export function abortFailure(execution: { readonly signal?: AbortSignal }): ProviderFailure {
  return new ProviderFailure(execution.signal?.aborted ? "PROVIDER_CANCELLED" : "PROVIDER_DEADLINE_EXCEEDED", false);
}
