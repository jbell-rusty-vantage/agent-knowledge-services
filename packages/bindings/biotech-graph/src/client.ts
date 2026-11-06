import {
  ADMISSION_CONSUME_REQUEST_V1,
  type ConsumeReport,
  ConsumeReportSchema,
  type Marker,
  MarkerSchema,
  READ_INTENT_V3,
  READ_RESULT_DIGEST_V2,
  type ReadResultV3,
  ReadResultV3Schema,
} from "./contracts.js";
import { jcsDigest } from "./jcs.js";

/**
 * HTTP client of the BKS native executor (the only path from KS to the graph; KS holds no Neo4j driver). Configuration
 * is by environment variable NAME; values are never printed or echoed into errors:
 *
 *   KS_BIOTECH_EXECUTOR_URL         base URL of the BKS executor (default port 4020)
 *   KS_BIOTECH_EXECUTOR_TOKEN       service token: BKS_EXECUTOR_TOKENS entry with class service, role writer, grant
 *                                   admission.dispatch, applicationId biotech and the knowledge_verification tenant uuid
 *   KS_BIOTECH_EXECUTOR_READ_TOKEN  optional reader token for official reads (defaults to the service token)
 *   KS_BIOTECH_EXECUTOR_TIMEOUT_MS  optional request timeout (default 30000)
 */
export const EXECUTOR_URL_ENV = "KS_BIOTECH_EXECUTOR_URL";
export const EXECUTOR_TOKEN_ENV = "KS_BIOTECH_EXECUTOR_TOKEN";
export const EXECUTOR_READ_TOKEN_ENV = "KS_BIOTECH_EXECUTOR_READ_TOKEN";
export const EXECUTOR_TIMEOUT_ENV = "KS_BIOTECH_EXECUTOR_TIMEOUT_MS";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  readonly status: number;
  text(): Promise<string>;
}>;

export interface BksExecutorConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly readToken?: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

export type BksExecutorErrorCode =
  | "BKS_UNAUTHORIZED"
  | "BKS_FORBIDDEN_SCOPE"
  | "BKS_AUTHORITY_UNAVAILABLE"
  | "BKS_PARSE_REJECTED"
  | "BKS_NOT_CONFIGURED"
  | "BKS_UNAVAILABLE"
  | "BKS_RESPONSE_INVALID"
  | "BKS_RESULT_DIGEST_MISMATCH"
  | "BKS_ERROR";

export class BksExecutorError extends Error {
  readonly code: BksExecutorErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  /** The executor's own error code (never contains credentials). */
  readonly nativeCode: string | null;
  constructor(code: BksExecutorErrorCode, message: string, status: number | null, nativeCode: string | null = null) {
    super(`${code}: ${message}`);
    this.name = "BksExecutorError";
    this.code = code;
    this.status = status;
    this.nativeCode = nativeCode;
    this.retryable = code === "BKS_AUTHORITY_UNAVAILABLE" || code === "BKS_UNAVAILABLE";
  }
}

function mapStatus(status: number, nativeCode: string | null): BksExecutorErrorCode {
  if (status === 401) return "BKS_UNAUTHORIZED";
  if (status === 403) return "BKS_FORBIDDEN_SCOPE";
  if (status === 503)
    return nativeCode === "BKS_AUTHORITY_UNAVAILABLE" ? "BKS_AUTHORITY_UNAVAILABLE" : "BKS_UNAVAILABLE";
  if (status === 400) return "BKS_PARSE_REJECTED";
  if (status === 404) return "BKS_NOT_CONFIGURED";
  if (status >= 500) return "BKS_UNAVAILABLE";
  return "BKS_ERROR";
}

/** Recompute the v3 result digest over the raw response (BKS `bks-read-result-digest.v2` / v1 for non-official reads). */
export function readResultDigest(raw: Record<string, unknown>): string {
  const parts = (raw.parts as Array<Record<string, unknown>>).map((p) => ({
    opId: p.opId,
    op: p.op,
    status: p.status,
    reasons: p.reasons,
    columns: p.columns,
    rows: p.rows,
    truncations: p.truncations,
  }));
  const eligibility = raw.eligibility as Record<string, unknown> | null;
  if (eligibility === null || eligibility === undefined) {
    return jcsDigest({
      format: "bks-read-result-digest.v1",
      status: raw.status,
      reasons: raw.reasons,
      ordering: raw.ordering,
      parts,
    });
  }
  return jcsDigest({
    format: READ_RESULT_DIGEST_V2,
    status: raw.status,
    reasons: raw.reasons,
    ordering: raw.ordering,
    parts,
    eligibility: {
      state: eligibility.state,
      authoritativeEpoch: eligibility.authoritativeEpoch,
      items: eligibility.items,
    },
  });
}

export interface ReadIntentV3 {
  readonly schemaVersion: typeof READ_INTENT_V3;
  readonly intentId: string;
  readonly pins: { readonly schemaReleaseDigest: string };
  readonly purpose: string;
  readonly use: { readonly officialUse: boolean; readonly useName?: string; readonly audience?: string };
  readonly operations: readonly Record<string, unknown>[];
}

export type MarkerSelector =
  | { readonly dispatchId: string }
  | { readonly markerDigest: string }
  | { readonly effectKey: string };

export class BksExecutorClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #readToken: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(config: BksExecutorConfig) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new BksExecutorError("BKS_NOT_CONFIGURED", "executor URL must be http(s)", null);
    if (config.token.trim() === "") throw new BksExecutorError("BKS_NOT_CONFIGURED", "service token is empty", null);
    this.#baseUrl = url.toString().replace(/\/+$/, "");
    this.#token = config.token;
    this.#readToken = config.readToken ?? config.token;
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    this.#fetch = config.fetch ?? ((u, init) => fetch(u, init));
  }

  /** `null` when the executor is not configured (callers then refuse with BKS_NOT_CONFIGURED; nothing is guessed). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): BksExecutorClient | null {
    const baseUrl = env[EXECUTOR_URL_ENV]?.trim();
    const token = env[EXECUTOR_TOKEN_ENV]?.trim();
    if (!baseUrl || !token) return null;
    const readToken = env[EXECUTOR_READ_TOKEN_ENV]?.trim();
    const timeout = Number(env[EXECUTOR_TIMEOUT_ENV] ?? 30_000);
    return new BksExecutorClient({
      baseUrl,
      token,
      ...(readToken ? { readToken } : {}),
      timeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : 30_000,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }

  private async request(method: "GET" | "POST", path: string, token: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw new BksExecutorError(
        "BKS_UNAVAILABLE",
        `executor ${method} ${path} failed: ${(error as Error).name}`,
        null,
      );
    } finally {
      clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      throw new BksExecutorError(
        "BKS_RESPONSE_INVALID",
        `executor ${method} ${path} returned non-JSON (HTTP ${status})`,
        status,
      );
    }
    if (status < 200 || status >= 300) {
      const nativeCode =
        typeof (json as { code?: unknown })?.code === "string" ? ((json as { code: string }).code as string) : null;
      const message =
        typeof (json as { message?: unknown })?.message === "string"
          ? (json as { message: string }).message.slice(0, 500)
          : `HTTP ${status}`;
      throw new BksExecutorError(mapStatus(status, nativeCode), message, status, nativeCode);
    }
    return json;
  }

  /** Push trigger of the BKS dispatch consumer for the token's tenant (idempotent; concurrent calls claim disjoint rows). */
  async consume(tenantId: string, limit = 10): Promise<ConsumeReport> {
    const raw = await this.request("POST", "/kg/admission/dispatch/consume", this.#token, {
      schemaVersion: ADMISSION_CONSUME_REQUEST_V1,
      tenantId,
      limit,
    });
    const parsed = ConsumeReportSchema.safeParse(raw);
    if (!parsed.success)
      throw new BksExecutorError(
        "BKS_RESPONSE_INVALID",
        "consume report does not match biotech-knowledge-admission-consume.v1",
        200,
      );
    if (parsed.data.tenantId !== tenantId)
      throw new BksExecutorError("BKS_RESPONSE_INVALID", "consume report names another tenant", 200);
    return parsed.data;
  }

  /** A v3 typed read; the result digest is recomputed over the raw response and must match `digests.resultDigest`. */
  async read(intent: ReadIntentV3): Promise<{ readonly result: ReadResultV3; readonly raw: Record<string, unknown> }> {
    const raw = (await this.request("POST", "/kg/read", this.#readToken, intent)) as Record<string, unknown>;
    const parsed = ReadResultV3Schema.safeParse(raw);
    if (!parsed.success)
      throw new BksExecutorError(
        "BKS_RESPONSE_INVALID",
        "read result does not match biotech-knowledge-read-result.v3",
        200,
      );
    if (parsed.data.intentId !== intent.intentId)
      throw new BksExecutorError("BKS_RESPONSE_INVALID", "read result answers another intent", 200);
    if (readResultDigest(raw) !== parsed.data.digests.resultDigest) {
      throw new BksExecutorError(
        "BKS_RESULT_DIGEST_MISMATCH",
        "recomputed result digest differs from digests.resultDigest",
        200,
      );
    }
    return { result: parsed.data, raw };
  }

  /** The principal-scoped marker of one dispatch / effect / marker digest (at most one row; two rows refuse). */
  async marker(
    selector: MarkerSelector,
    pins: { schemaReleaseDigest: string },
    intentId: string,
  ): Promise<{ marker: Marker | null; result: ReadResultV3 }> {
    const { result } = await this.read({
      schemaVersion: READ_INTENT_V3,
      intentId,
      pins,
      purpose: "Knowledge Services verified acknowledgment of a biotech-graph dispatch",
      use: { officialUse: false },
      operations: [{ opId: "marker", op: "marker", ...selector }],
    });
    const part = result.parts[0];
    if (part === undefined || part.status === "failed")
      throw new BksExecutorError("BKS_RESPONSE_INVALID", "marker part missing or failed", 200);
    if (part.rows.length > 1)
      throw new BksExecutorError("BKS_RESPONSE_INVALID", "marker selector matched two markers", 200);
    const row = part.rows[0];
    if (row === undefined) return { marker: null, result };
    const marker = MarkerSchema.safeParse(row.marker);
    if (!marker.success) {
      const issues = marker.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.code}`)
        .join("; ");
      throw new BksExecutorError(
        "BKS_RESPONSE_INVALID",
        `marker row does not match bks-intent-marker.v2 (${issues})`,
        200,
      );
    }
    return { marker: marker.data, result };
  }

  /** `GET /describe`: the release pin the executor serves (`schemaReleaseDigest`) is read from here when not configured. */
  async describe(): Promise<Record<string, unknown>> {
    return (await this.request("GET", "/describe", this.#readToken)) as Record<string, unknown>;
  }
}
