import { type KeyObject, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CREDENTIAL_TOKEN_TYPE,
  type CredentialClaims,
  CredentialClaimsSchema,
  type JsonValue,
  type OperationEnvelope,
  OperationEnvelopeSchema,
  type OperationName,
  type Origin,
  type Ref,
  bindEffect,
  canonicalJson,
  digestBytes,
} from "@aiengineer/knowledge-operation-protocol";

/**
 * Test and disposable-proof support for `ks.knowledge_operation.v2` (never deployment keys).
 *
 * Key file format (shared with Mission Control's `load_signing_key` / `publish_jwks`):
 *  - private key file: ONE Ed25519 private JWK as a JSON object
 *      {"kty":"OKP","crv":"Ed25519","x":"<b64url public>","d":"<b64url private>","kid":"<key id>","alg":"EdDSA"}
 *  - public JWKS file: {"keys":[{"kty":"OKP","crv":"Ed25519","x":"...","kid":"...","alg":"EdDSA","use":"sig"}]}
 *    (active key first; a retiring key may carry `"retire_at": <epoch seconds>`, after which the executor refuses it).
 *  ES256 keys use {"kty":"EC","crv":"P-256","x","y"[,"d"]} with `"alg":"ES256"`.
 * The executor reads the JWKS through `KS_KNOWLEDGE_JWKS_FILE` (or `_URL`); the issuer (MC) signs with the private file.
 */
export type TestAlgorithm = "EdDSA" | "ES256";

export interface IssuerKey {
  readonly kid: string;
  readonly alg: TestAlgorithm;
  readonly privateKey: KeyObject;
  readonly privateJwk: Record<string, string>;
  readonly publicJwk: Record<string, string>;
}

export function generateIssuerKey(kid: string, alg: TestAlgorithm = "EdDSA"): IssuerKey {
  const pair =
    alg === "EdDSA" ? generateKeyPairSync("ed25519") : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateJwk: Record<string, string> = {
    ...(pair.privateKey.export({ format: "jwk" }) as Record<string, string>),
    kid,
    alg,
  };
  const { d: _d, ...publicPart } = privateJwk;
  return { kid, alg, privateKey: pair.privateKey, privateJwk, publicJwk: { ...publicPart, use: "sig" } };
}

/** Load a private JWK file written by {@link writeIssuerKeyFiles} (or by Mission Control's `write_private_jwk`). */
export function issuerKeyFromJwk(jwk: Record<string, string>): IssuerKey {
  const alg: TestAlgorithm = jwk.kty === "EC" ? "ES256" : "EdDSA";
  const kid = jwk.kid;
  if (!kid) throw new Error("the JWK names no kid");
  const { d: _d, ...publicPart } = jwk;
  return {
    kid,
    alg,
    privateKey: createPrivateKey({ key: jwk, format: "jwk" }),
    privateJwk: { ...jwk, alg },
    publicJwk: { ...publicPart, alg, use: "sig" },
  };
}

export function jwksOf(keys: readonly IssuerKey[], retireAt: Readonly<Record<string, number>> = {}) {
  return {
    keys: keys.map((key) =>
      retireAt[key.kid] === undefined ? key.publicJwk : { ...key.publicJwk, retire_at: retireAt[key.kid] },
    ),
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/** Sign claims as a compact JWS (no schema check, so conformance tests can sign deliberately bad claims). */
export function signCredential(
  key: IssuerKey,
  claims: unknown,
  header: Record<string, unknown> = { alg: key.alg, kid: key.kid, typ: CREDENTIAL_TOKEN_TYPE },
): string {
  const input = `${b64(header)}.${b64(claims)}`;
  const signature =
    key.alg === "EdDSA"
      ? sign(null, Buffer.from(input, "ascii"), key.privateKey)
      : sign("sha256", Buffer.from(input, "ascii"), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${signature.toString("base64url")}`;
}

/** Write a disposable issuer key pair: `<dir>/<kid>.private.jwk.json` and `<dir>/jwks.json`. */
export function writeIssuerKeyFiles(directory: string, kid: string): { privateJwk: string; jwks: string } {
  mkdirSync(directory, { recursive: true });
  const key = generateIssuerKey(kid);
  const privateJwk = resolve(directory, `${kid}.private.jwk.json`);
  const jwks = resolve(directory, "jwks.json");
  writeFileSync(privateJwk, `${JSON.stringify(key.privateJwk)}\n`, { mode: 0o600 });
  writeFileSync(jwks, `${JSON.stringify(jwksOf([key]), null, 2)}\n`);
  return { privateJwk, jwks };
}

// ------------------------------------------------------------------------------------------------ claims + envelopes

export const TEST_ISSUER = "mission-control";
export const TEST_AUDIENCE = "knowledge-services-executor";
export const TEST_INSTALLATION = "0192a4f0-0000-7000-8000-0000000a1e00";

export function liveOrigin(
  tenant: string,
  options: { attempt?: number; installationId?: string; application?: string; invocation?: string } = {},
): Origin {
  const attempt = options.attempt ?? 1;
  return {
    kind: "mission_invocation",
    installationId: options.installationId ?? TEST_INSTALLATION,
    applicationId: options.application ?? "ai-engineer",
    tenantId: tenant,
    issuer: TEST_ISSUER,
    subject: "mission-control-runtime",
    mission: {
      missionId: "mission-sv16",
      runId: "run-sv16",
      activationId: null,
      operationId: "op-sv16-research",
      operationAttempt: attempt,
      executionGeneration: 1,
      lane: "deep_agents",
    },
    recoveryAuthorityRef: null,
    invocationId: options.invocation ?? `inv-${randomUUID()}`,
    authenticatedAt: "2026-10-25T10:00:00Z",
  };
}

export function recoveryOriginFor(tenant: string, authorityRef: string, installationId = TEST_INSTALLATION): Origin {
  return {
    kind: "recovery",
    installationId,
    applicationId: "ai-engineer",
    tenantId: tenant,
    issuer: TEST_ISSUER,
    subject: "mission-control-reconciler",
    mission: null,
    recoveryAuthorityRef: authorityRef,
    invocationId: `inv-${randomUUID()}`,
    authenticatedAt: "2026-10-25T10:00:00Z",
  };
}

export interface ClaimsInput {
  readonly origin: Origin;
  readonly operations: readonly OperationName[];
  readonly dispatchId: string;
  readonly binding?: string;
  readonly effect?: { effectKey: string; boundEffectDigest: string } | null;
  readonly recovery?: CredentialClaims["recovery"];
  readonly evaluation?: CredentialClaims["evaluation"];
  readonly now?: number;
  readonly lifetime?: number;
  readonly issuer?: string;
  readonly audience?: string;
  readonly jti?: string;
}

export function claimsFor(input: ClaimsInput): CredentialClaims {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  return CredentialClaimsSchema.parse({
    typ: CREDENTIAL_TOKEN_TYPE,
    iss: input.issuer ?? TEST_ISSUER,
    aud: input.audience ?? TEST_AUDIENCE,
    sub: input.origin.subject,
    jti: input.jti ?? `jti-${randomUUID()}`,
    iat: now,
    nbf: now,
    exp: now + (input.lifetime ?? 300),
    tenant: input.origin.tenantId,
    application: input.origin.applicationId,
    binding: input.binding ?? "in-memory",
    origin: input.origin,
    operations: [...input.operations],
    effect: input.effect ?? null,
    dispatchId: input.dispatchId,
    recovery: input.recovery ?? null,
    ...(input.evaluation === undefined ? {} : { evaluation: input.evaluation }),
  });
}

const NATIVE: Record<string, { name: string; version: string }> = {
  "report.register": { name: "research-report", version: "v2" },
  "report.assess": { name: "research-report-assessment", version: "v1" },
  "knowledge.read": { name: "selected-report-read", version: "v2" },
  "knowledge.apply": { name: "knowledge-ingestion-intent", version: "v1" },
  "knowledge.plan_preview": { name: "knowledge-ingestion-intent", version: "v1" },
  "report.derive": { name: "research-report-derive", version: "v1" },
};

export interface EnvelopeInput {
  readonly operation: OperationName;
  readonly origin: Origin;
  readonly payload: JsonValue;
  readonly binding?: string;
  readonly requestId?: string;
  readonly dispatchId?: string;
  readonly effectKey?: string;
  /** The originating origin of the effect (defaults to `origin`); a retry keeps the original. */
  readonly originatingOrigin?: Origin;
  readonly upstream?: readonly Ref[];
  readonly deadline?: string;
  /** knowledge.apply: the plan-level bound digest the use decision binds (defaults to the digest over the payload). */
  readonly boundEffectDigest?: string;
  /** Native contract override (e.g. biotech-knowledge-apply/v1). */
  readonly nativeContract?: { readonly name: string; readonly version: string };
  /** Effectful operations: the declared use and audience (K01 envelope fields). */
  readonly declaredUse?: { readonly use: string; readonly audience: string };
  /** knowledge.plan_preview: send no effect binding (the intent's exactUse names the effect). */
  readonly withoutEffect?: boolean;
}

/** A K01 envelope whose native input is the canonical inline payload (the shape MC's gateway sends). */
export function envelopeFor(input: EnvelopeInput): OperationEnvelope {
  const bytes = Buffer.from(canonicalJson(input.payload), "utf8");
  const effectful = input.operation === "report.register" || input.operation === "knowledge.apply";
  // `knowledge.plan_preview` carries the same effect binding as the `knowledge.apply` it previews, unless told not to.
  const describing = input.operation === "knowledge.plan_preview" && input.withoutEffect !== true;
  const effect =
    effectful || describing
      ? bindEffect({
          effectKey: input.effectKey ?? `effect-${randomUUID()}`,
          nativePayload: bytes,
          originatingOrigin: input.originatingOrigin ?? input.origin,
        })
      : null;
  const bound = effect && input.boundEffectDigest ? { ...effect, boundEffectDigest: input.boundEffectDigest } : effect;
  const native = input.nativeContract ?? NATIVE[input.operation];
  return OperationEnvelopeSchema.parse({
    protocolVersion: "ks.knowledge_operation.v2",
    requestId: input.requestId ?? `req-${randomUUID()}`,
    dispatchId: input.dispatchId ?? `dispatch-${randomUUID()}`,
    tenant: input.origin.tenantId,
    application: input.origin.applicationId,
    binding: input.binding ?? "in-memory",
    operation: input.operation,
    effect: bound,
    ...(input.declaredUse ? { use: input.declaredUse.use, audience: input.declaredUse.audience } : {}),
    target: { handle: null, effectKey: null },
    cancelRequestId: null,
    input: native
      ? {
          nativeContract: native,
          payloadDigest: digestBytes(bytes),
          payloadBytes: bytes.byteLength,
          payloadRef: null,
          inlinePayload: input.payload,
          upstream: [...(input.upstream ?? [])],
        }
      : null,
    governors: {
      deadline: input.deadline ?? "2099-01-01T00:00:00Z",
      maxItems: 64,
      partialResults: "forbid",
      budget: { calls: 0, tokens: 0, costUsd: "0" },
    },
    requiredCapabilities: [],
    pinnedSchema: null,
    issuedAt: "2026-10-25T10:00:01Z",
  });
}

/**
 * A `report.register` inline payload (research-report/v2) from the deterministic evidence_report fixture, for one
 * tenant. K02 records are write-once per id in a binding, so one payload registers once per tenant (use a fresh
 * tenant per proof run). Dump one for a parity run:
 *   corepack pnpm exec tsx -e "import('./src/knowledge-operation/test-support.ts').then(async (m) => console.log(JSON.stringify(await m.registrationFixture('<tenant uuid>', 'aiengineer-postgres', '<installation id>'))))"
 */
export async function registrationFixture(
  tenant: string,
  binding: string,
  installationId: string,
  reportId = "report-sv16-fixture",
): Promise<JsonValue> {
  const { reportKindCases } = await import("@aiengineer/knowledge-application/testing");
  const origin = liveOrigin(tenant, { installationId, invocation: "inv-fixture" });
  const kase = reportKindCases(tenant, binding, origin).find((candidate) => candidate.kindId === "evidence_report");
  if (kase === undefined) throw new Error("fixture");
  return JSON.parse(
    JSON.stringify({
      task: kase.task,
      fragments: kase.fragments,
      assertions: kase.assertions,
      supportSets: kase.supportSets,
      report: {
        reportId,
        revision: 1,
        kind: "evidence_report",
        structuredBody: kase.body,
        timeCoverage: { world: null, observed: null, knowledgeHead: null },
        supersedes: null,
      },
    }),
  ) as JsonValue;
}
