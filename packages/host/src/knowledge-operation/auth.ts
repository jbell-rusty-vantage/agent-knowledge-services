import { type KeyObject, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  CREDENTIAL_TOKEN_TYPE,
  type CredentialClaims,
  CredentialClaimsSchema,
  DEFAULT_CLOCK_SKEW_SECONDS,
  EFFECTFUL_OPERATIONS,
  type EffectBinding,
  type OperationName,
  admitDispatch,
  credentialWindow,
} from "@aiengineer/knowledge-operation-protocol";
import type { AuthScope } from "@aiengineer/knowledge-research-core";

/**
 * K07: executor-side credential validation for `ks.knowledge_operation.v2` (design §5, RFC 8725).
 *
 * A bearer credential is a compact JWS whose payload is K01 `credential-claims.v2`:
 *  - header: exactly `{alg, kid, typ}`; `alg` in the allowlist (`EdDSA` over Ed25519, `ES256` over P-256),
 *    `typ` = `ks-knowledge-operation+jwt`; any other header member (`jku`, `jwk`, `x5u`, `crit`, ...) fails closed;
 *  - key: pinned by `kid` in the issuer's JWKS (loaded from a file or URL), bounded cache, active and retiring keys; a
 *    retiring key (`retire_at`, epoch seconds) verifies until its retire time (plus skew), then refuses; an unknown kid
 *    triggers at most one rate-limited refresh and then fails closed;
 *  - claims: strict K01 schema (scope, lifetime <= 300 s, recovery scope rules), pinned issuer, exact audience,
 *    `nbf`/`exp` with 30 s skew, `jti` single use within its lifetime (bounded replay cache).
 * Authorization then binds the claims to this executor's installation (application -> binding, installation id,
 * optional tenant allowlist), the operation grant, the envelope scope and dispatch id, and for effectful calls the exact
 * effect key + bound digest and the origin (K01 `admitDispatch`: the originator, or a new attempt holding an
 * effect-scoped recovery grant for that exact key/digest).
 *
 * The legacy static bearer (`VERIFY_EXECUTOR_TOKEN`) guards only the old routes; these routes never accept it.
 * No token, key material or claim body is logged: refusals carry a reason code only.
 */
export const ALLOWED_ALGORITHMS = ["EdDSA", "ES256"] as const;
export type AllowedAlgorithm = (typeof ALLOWED_ALGORITHMS)[number];

export type CredentialRefusalReason =
  | "missing"
  | "malformed"
  | "header_not_allowed"
  | "algorithm_not_allowed"
  | "wrong_token_type"
  | "unknown_kid"
  | "algorithm_mismatch"
  | "bad_signature"
  | "key_retired"
  | "claims_invalid"
  | "wrong_issuer"
  | "wrong_audience"
  | "not_yet_valid"
  | "expired"
  | "replay"
  | "replay_cache_full"
  | "dispatch_reused"
  | "credential_store_unavailable"
  | "jwks_unavailable";

export class CredentialRefusal extends Error {
  override readonly name = "CredentialRefusal";
  constructor(readonly reason: CredentialRefusalReason) {
    super(`CREDENTIAL_REFUSED: ${reason}`);
  }
}

/** An authorization refusal with its K01 code (SCOPE_DENIED or ORIGIN_MISMATCH; EFFECT_CONFLICT comes from the ledger). */
export class AuthorizationRefusal extends Error {
  override readonly name = "AuthorizationRefusal";
  constructor(
    readonly code: "SCOPE_DENIED" | "ORIGIN_MISMATCH" | "EFFECT_CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------------------------------------ JWKS

export interface JwksSource {
  readonly description: string;
  load(): Promise<unknown>;
}

export function fileJwksSource(path: string): JwksSource {
  return {
    description: `file:${path}`,
    load: async () => JSON.parse(await readFile(path, "utf8")) as unknown,
  };
}

export function urlJwksSource(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): JwksSource {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new Error("KS_KNOWLEDGE_JWKS_URL must be https (or http on loopback)");
  }
  return {
    description: `url:${parsed.origin}${parsed.pathname}`,
    load: async () => {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`JWKS_HTTP_${response.status}`);
      return (await response.json()) as unknown;
    },
  };
}

export function staticJwksSource(document: unknown): JwksSource {
  return { description: "static", load: async () => document };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

export interface PinnedJwk {
  readonly kid: string;
  readonly alg: AllowedAlgorithm;
  readonly key: KeyObject;
  /** Epoch seconds; `null` for an active key. */
  readonly retireAt: number | null;
}

const MAX_KEYS = 16;

/** Parse a public JWKS strictly: public OKP/Ed25519 or EC/P-256 keys only, distinct kids, at most 16 keys. */
export function parseJwks(document: unknown): Map<string, PinnedJwk> {
  if (typeof document !== "object" || document === null || !Array.isArray((document as { keys?: unknown }).keys)) {
    throw new Error("JWKS_INVALID: no keys array");
  }
  const keys = (document as { keys: unknown[] }).keys;
  if (keys.length === 0 || keys.length > MAX_KEYS) throw new Error(`JWKS_INVALID: 1..${MAX_KEYS} keys`);
  const pinned = new Map<string, PinnedJwk>();
  for (const item of keys) {
    if (typeof item !== "object" || item === null) throw new Error("JWKS_INVALID: key is not an object");
    const jwk = item as Record<string, unknown>;
    const kid = jwk.kid;
    if (typeof kid !== "string" || kid.length === 0 || kid.length > 200) throw new Error("JWKS_INVALID: kid");
    if (pinned.has(kid)) throw new Error(`JWKS_INVALID: duplicate kid ${kid}`);
    if ("d" in jwk || "p" in jwk || "k" in jwk) throw new Error(`JWKS_INVALID: ${kid} carries private material`);
    if (jwk.use !== undefined && jwk.use !== "sig") throw new Error(`JWKS_INVALID: ${kid} is not a signing key`);
    let alg: AllowedAlgorithm;
    if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string") alg = "EdDSA";
    else if (jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.x === "string" && typeof jwk.y === "string")
      alg = "ES256";
    else throw new Error(`JWKS_INVALID: ${kid} is not an allowed key type`);
    if (jwk.alg !== undefined && jwk.alg !== alg) throw new Error(`JWKS_INVALID: ${kid} alg ${String(jwk.alg)}`);
    const retireAt = jwk.retire_at;
    if (retireAt !== undefined && (typeof retireAt !== "number" || !Number.isSafeInteger(retireAt) || retireAt < 0)) {
      throw new Error(`JWKS_INVALID: ${kid} retire_at`);
    }
    const material =
      alg === "EdDSA"
        ? { kty: "OKP", crv: "Ed25519", x: jwk.x as string }
        : { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string };
    pinned.set(kid, {
      kid,
      alg,
      key: createPublicKey({ key: material, format: "jwk" }),
      retireAt: typeof retireAt === "number" ? retireAt : null,
    });
  }
  return pinned;
}

/**
 * Bounded JWKS cache: the document is reloaded after `ttlMs`; an unknown kid forces at most one reload per
 * `minRefreshMs` (so a flood of forged kids cannot hammer the issuer), then fails closed. A failed reload keeps the
 * last good key set until it is older than `maxStaleMs`, after which every verification refuses `jwks_unavailable`.
 */
export class JwksCache {
  private keys: Map<string, PinnedJwk> | null = null;
  private loadedAt = 0;
  private lastAttempt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly source: JwksSource,
    private readonly options: {
      readonly ttlMs?: number;
      readonly minRefreshMs?: number;
      readonly maxStaleMs?: number;
      readonly nowMs?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private async refresh(): Promise<void> {
    this.inflight ??= (async () => {
      this.lastAttempt = this.now();
      try {
        this.keys = parseJwks(await this.source.load());
        this.loadedAt = this.now();
      } catch {
        // keep the last good key set (bounded by maxStaleMs below)
      }
    })().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  async key(kid: string): Promise<PinnedJwk | null> {
    const ttl = this.options.ttlMs ?? 60_000;
    if (this.keys === null || this.now() - this.loadedAt >= ttl) await this.refresh();
    let found = this.keys?.get(kid) ?? null;
    if (found === null && this.now() - this.lastAttempt >= (this.options.minRefreshMs ?? 5_000)) {
      await this.refresh();
      found = this.keys?.get(kid) ?? null;
    }
    if (this.keys === null || this.now() - this.loadedAt > (this.options.maxStaleMs ?? 600_000)) {
      throw new CredentialRefusal("jwks_unavailable");
    }
    return found;
  }
}

// ------------------------------------------------------------------------------------------------ verification

export interface CredentialVerifierConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwks: JwksCache;
  readonly skewSeconds?: number;
  readonly replayCacheSize?: number;
  readonly nowSeconds?: () => number;
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;

function decodeJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
}

export class KnowledgeCredentialVerifier {
  private readonly seen = new Map<string, number>();
  readonly skewSeconds: number;

  constructor(private readonly config: CredentialVerifierConfig) {
    this.skewSeconds = config.skewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  }

  get issuer(): string {
    return this.config.issuer;
  }

  get audience(): string {
    return this.config.audience;
  }

  now(): number {
    return this.config.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Verify one bearer credential; refuses with a reason code (fail closed). Consumes its `jti`. */
  async verify(token: string | null | undefined): Promise<CredentialClaims> {
    if (!token) throw new CredentialRefusal("missing");
    const parts = token.split(".");
    if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part)) || token.length > 16_384) {
      throw new CredentialRefusal("malformed");
    }
    const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
    let header: unknown;
    let payload: unknown;
    try {
      header = decodeJson(headerSegment);
      payload = decodeJson(payloadSegment);
    } catch {
      throw new CredentialRefusal("malformed");
    }
    if (typeof header !== "object" || header === null || Array.isArray(header))
      throw new CredentialRefusal("malformed");
    const fields = header as Record<string, unknown>;
    if (Object.keys(fields).some((name) => name !== "alg" && name !== "kid" && name !== "typ")) {
      throw new CredentialRefusal("header_not_allowed");
    }
    if (!(ALLOWED_ALGORITHMS as readonly unknown[]).includes(fields.alg)) {
      throw new CredentialRefusal("algorithm_not_allowed");
    }
    if (fields.typ !== CREDENTIAL_TOKEN_TYPE) throw new CredentialRefusal("wrong_token_type");
    if (typeof fields.kid !== "string") throw new CredentialRefusal("unknown_kid");
    const key = await this.config.jwks.key(fields.kid);
    if (key === null) throw new CredentialRefusal("unknown_kid");
    if (key.alg !== fields.alg) throw new CredentialRefusal("algorithm_mismatch");
    const signingInput = Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii");
    const signature = Buffer.from(signatureSegment, "base64url");
    const ok =
      key.alg === "EdDSA"
        ? verifySignature(null, signingInput, key.key, signature)
        : signature.byteLength === 64 &&
          verifySignature("sha256", signingInput, { key: key.key, dsaEncoding: "ieee-p1363" }, signature);
    if (!ok) throw new CredentialRefusal("bad_signature");
    const now = this.now();
    if (key.retireAt !== null && now - this.skewSeconds >= key.retireAt) throw new CredentialRefusal("key_retired");
    const parsed = CredentialClaimsSchema.safeParse(payload);
    if (!parsed.success) throw new CredentialRefusal("claims_invalid");
    const claims = parsed.data;
    if (claims.iss !== this.config.issuer) throw new CredentialRefusal("wrong_issuer");
    if (claims.aud !== this.config.audience) throw new CredentialRefusal("wrong_audience");
    const window = credentialWindow(claims, now, this.skewSeconds);
    if (!window.valid) throw new CredentialRefusal(window.reason);
    this.consume(claims, now);
    return claims;
  }

  private consume(claims: CredentialClaims, now: number): void {
    for (const [jti, exp] of this.seen) if (exp + this.skewSeconds < now) this.seen.delete(jti);
    if (this.seen.has(claims.jti)) throw new CredentialRefusal("replay");
    if (this.seen.size >= (this.config.replayCacheSize ?? 100_000)) throw new CredentialRefusal("replay_cache_full");
    this.seen.set(claims.jti, claims.exp);
  }
}

// ------------------------------------------------------------------------------------------------ authorization

/** One installed (application, binding) pair of this executor. */
export interface InstalledBinding {
  readonly application: string;
  readonly binding: string;
  readonly installationId: string;
  /** Optional tenant allowlist; `null` admits any tenant of the installation (the component's RLS still applies). */
  readonly tenants: readonly string[] | null;
}

export interface AuthorizationRequest {
  readonly operation: OperationName;
  /** The envelope's scope; `null` for routes whose scope is the credential's (status, cancel, receipt, describe). */
  readonly envelope: {
    readonly tenant: string;
    readonly application: string;
    readonly binding: string;
    readonly dispatchId: string;
    readonly effect: EffectBinding | null;
  } | null;
  /** `receipt.get`: the effect key addressed by the route. */
  readonly effectKey?: string;
}

/** Bounded record of dispatch ids seen with the digest of what they carried; a dispatch id names one transmission. */
export class DispatchRegistry {
  private readonly seen = new Map<string, string>();

  constructor(private readonly capacity = 10_000) {}

  record(dispatchId: string, digest: string): void {
    const previous = this.seen.get(dispatchId);
    if (previous !== undefined && previous !== digest) {
      throw new AuthorizationRefusal("SCOPE_DENIED", "dispatch id already carried another transmission");
    }
    if (previous === undefined) {
      if (this.seen.size >= this.capacity) {
        const oldest = this.seen.keys().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
      this.seen.set(dispatchId, digest);
    }
  }

  get(dispatchId: string): string | undefined {
    return this.seen.get(dispatchId);
  }
}

/**
 * Bind verified claims to this executor and one request; returns the authenticated scope the application services
 * receive (K03: services never construct or widen it). Throws {@link AuthorizationRefusal}.
 */
export function authorize(
  claims: CredentialClaims,
  installed: readonly InstalledBinding[],
  request: AuthorizationRequest,
): AuthScope {
  const installation = installed.find(
    (candidate) => candidate.application === claims.application && candidate.binding === claims.binding,
  );
  if (installation === undefined) {
    throw new AuthorizationRefusal("SCOPE_DENIED", "the credential names a binding this executor does not install");
  }
  if (claims.origin.installationId !== installation.installationId) {
    throw new AuthorizationRefusal("SCOPE_DENIED", "the credential origin names another installation");
  }
  if (installation.tenants !== null && !installation.tenants.includes(claims.tenant)) {
    throw new AuthorizationRefusal("SCOPE_DENIED", "tenant is not served by this installation");
  }
  if (!claims.operations.includes(request.operation)) {
    throw new AuthorizationRefusal("SCOPE_DENIED", `the credential does not grant ${request.operation}`);
  }
  const envelope = request.envelope;
  if (envelope !== null) {
    if (
      envelope.tenant !== claims.tenant ||
      envelope.application !== claims.application ||
      envelope.binding !== claims.binding
    ) {
      throw new AuthorizationRefusal("SCOPE_DENIED", "envelope scope differs from the credential");
    }
    if (envelope.dispatchId !== claims.dispatchId) {
      throw new AuthorizationRefusal("SCOPE_DENIED", "envelope dispatch id differs from the credential");
    }
    const effectful = EFFECTFUL_OPERATIONS.has(request.operation);
    if (effectful) {
      const effect = envelope.effect;
      if (
        effect === null ||
        claims.effect === null ||
        claims.effect.effectKey !== effect.effectKey ||
        claims.effect.boundEffectDigest !== effect.boundEffectDigest
      ) {
        throw new AuthorizationRefusal("SCOPE_DENIED", "credential effect differs from the envelope effect");
      }
      // The origin rule (design §5): the caller is the originator, or a new attempt holding an effect-scoped recovery
      // grant for this exact key and bound digest (K01 admitDispatch; the claims schema already ties the grant to
      // claims.effect, and claims.effect equals the envelope's here).
      const admission = admitDispatch({
        existing: null,
        incoming: effect,
        caller: claims.origin,
        recovery: claims.recovery,
      });
      if (!admission.admitted) throw new AuthorizationRefusal(admission.code, admission.reason);
    } else if (claims.effect !== null) {
      throw new AuthorizationRefusal("SCOPE_DENIED", "a non-effect operation carries no effect grant");
    }
  }
  if (request.operation === "receipt.get") {
    const named = claims.effect?.effectKey ?? claims.recovery?.effectKey ?? null;
    if (claims.origin.kind === "recovery" && named === null) {
      throw new AuthorizationRefusal("SCOPE_DENIED", "read-only recovery names the exact effect it looks up");
    }
    if (named !== null && named !== request.effectKey) {
      throw new AuthorizationRefusal("SCOPE_DENIED", "the credential names another effect key");
    }
  }
  return {
    tenant: claims.tenant,
    application: claims.application,
    binding: claims.binding,
    origin: claims.origin,
    grants: [...claims.operations],
  };
}

// ------------------------------------------------------------------------------------------------ configuration

export interface KnowledgeAuthConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly jwks: JwksSource;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `KS_KNOWLEDGE_ISSUER` (pinned issuer), `KS_KNOWLEDGE_AUDIENCE` (this executor's exact audience) and exactly one of
 * `KS_KNOWLEDGE_JWKS_FILE` / `KS_KNOWLEDGE_JWKS_URL`. `undefined` when no issuer is configured (routes then answer
 * `CAPABILITY_UNAVAILABLE`); a partial configuration refuses at startup.
 */
export function loadKnowledgeAuthConfig(env: Env = process.env): KnowledgeAuthConfig | undefined {
  const issuer = env.KS_KNOWLEDGE_ISSUER?.trim();
  const audience = env.KS_KNOWLEDGE_AUDIENCE?.trim();
  const file = env.KS_KNOWLEDGE_JWKS_FILE?.trim();
  const url = env.KS_KNOWLEDGE_JWKS_URL?.trim();
  if (!issuer) {
    if (audience || file || url) throw new Error("KS_KNOWLEDGE_ISSUER_REQUIRED");
    return undefined;
  }
  if (!audience) throw new Error("KS_KNOWLEDGE_AUDIENCE_REQUIRED");
  if ((file ? 1 : 0) + (url ? 1 : 0) !== 1) throw new Error("KS_KNOWLEDGE_JWKS_FILE_OR_URL_REQUIRED");
  return { issuer, audience, jwks: file ? fileJwksSource(file) : urlJwksSource(url as string) };
}
