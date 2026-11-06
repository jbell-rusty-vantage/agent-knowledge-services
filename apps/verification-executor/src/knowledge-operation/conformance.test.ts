import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ReportKindCatalog, ScriptedAuditorDiscovery, type AuditorDiscovery } from "@aiengineer/knowledge-application";
import {
  EVIDENCE_REPORT_SCRIPT,
  fixtureSupportObservation,
  reportKindCases,
} from "@aiengineer/knowledge-application/testing";
import { qualifiersDigest } from "@aiengineer/knowledge-research-core";
import {
  type BindingDescriptor,
  type JsonValue,
  type OperationEnvelope,
  type OperationHandle,
  type OperationStatus,
  OperationStatusSchema,
  OperationReceiptSchema,
  OperationHandleSchema,
  ProtocolErrorSchema,
  ReceiptLookupSchema,
  BindingDescriptorSchema,
  digestBytes,
  digestCanonical,
  type Origin,
} from "@aiengineer/knowledge-operation-protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DispatchRegistry,
  type InstalledBinding,
  JwksCache,
  KnowledgeCredentialVerifier,
  staticJwksSource,
  type JwksSource,
} from "@aiengineer/knowledge-host/knowledge-operation";
import { startExecutorServer, type RunningExecutor } from "../serve.js";
import { createInMemoryBackend, createUnwiredBackend } from "@aiengineer/knowledge-host/knowledge-operation";
import { handleKnowledgeOperation } from "./http.js";
import type { KnowledgeApplyPort, KnowledgeOperationBackend } from "@aiengineer/knowledge-host/knowledge-operation";
import { KnowledgeOperationService } from "@aiengineer/knowledge-host/knowledge-operation";
import {
  type IssuerKey,
  TEST_AUDIENCE,
  TEST_INSTALLATION,
  TEST_ISSUER,
  claimsFor,
  envelopeFor,
  generateIssuerKey,
  jwksOf,
  liveOrigin,
  recoveryOriginFor,
  signCredential,
} from "./tests/test-support.js";

/**
 * SV-16 executor conformance over the wire (design §9 "M02/K07 ... executor conformance"): an in-process HTTP server
 * mounting the knowledge-operation routes over the in-memory research binding, driven with fetch. No database, no
 * model calls; the census auditor is the scripted test double.
 */
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../../..");
const KINDS = ReportKindCatalog.fromDirectory(resolve(ROOT, "catalog/research/report-kinds"));
const TENANT = "00000000-0000-7000-8000-0000000000aa";
const OTHER_TENANT = "00000000-0000-7000-8000-0000000000bb";
const BINDING = "in-memory";

/** A clock the tests move (seconds); the service and verifier both read it. */
class TestClock {
  seconds = Math.floor(Date.parse("2026-10-25T10:00:00Z") / 1000);
  instant(): string {
    return new Date(this.seconds * 1000).toISOString().replace(".000Z", "Z");
  }
}

class GatedAuditor implements AuditorDiscovery {
  private release!: () => void;
  readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  entered = false;
  constructor(private readonly inner: AuditorDiscovery) {}
  open(): void {
    this.release();
  }
  async discover(...args: Parameters<AuditorDiscovery["discover"]>) {
    this.entered = true;
    await this.gate;
    return this.inner.discover(...args);
  }
}

interface Harness {
  readonly url: string;
  readonly clock: TestClock;
  readonly service: KnowledgeOperationService;
  readonly backend: ReturnType<typeof createInMemoryBackend>;
  setJwks(document: unknown): void;
  close(): Promise<void>;
}

async function harness(
  options: {
    keys?: readonly IssuerKey[];
    auditor?: AuditorDiscovery | null;
    apply?: KnowledgeApplyPort | null;
    tenants?: readonly string[] | null;
    binding?: string;
    installationId?: string;
  } = {},
): Promise<Harness> {
  const clock = new TestClock();
  let jwks: unknown = jwksOf(options.keys ?? []);
  const source: JwksSource = { description: "test", load: async () => jwks };
  const binding = options.binding ?? BINDING;
  const backend = createInMemoryBackend({
    application: "ai-engineer",
    binding,
    kinds: KINDS,
    auditor: options.auditor === undefined ? new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT) : options.auditor,
    clock: { now: () => clock.instant() },
    apply: options.apply ?? null,
    retryAfterMs: 200,
  });
  const biotech = createUnwiredBackend({
    application: "biotech",
    binding: "biotech-graph",
    reason: "unwired in this test",
  });
  const installed: InstalledBinding[] = [
    {
      application: "ai-engineer",
      binding,
      installationId: options.installationId ?? TEST_INSTALLATION,
      tenants: options.tenants === undefined ? [TENANT] : options.tenants,
    },
    { application: "biotech", binding: "biotech-graph", installationId: TEST_INSTALLATION, tenants: null },
  ];
  const service = new KnowledgeOperationService({
    verifier: new KnowledgeCredentialVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwks: new JwksCache(source, { ttlMs: 0, minRefreshMs: 0, nowMs: () => clock.seconds * 1000 }),
      nowSeconds: () => clock.seconds,
    }),
    backends: [backend, biotech] as KnowledgeOperationBackend[],
    installed,
    dispatches: new DispatchRegistry(),
    signingIssuer: "knowledge-services",
    clock: () => clock.instant(),
    retryAfterMs: 200,
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    void handleKnowledgeOperation(request, response, url, service).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/knowledge-operation/v2`,
    clock,
    service,
    backend,
    setJwks: (document) => {
      jwks = document;
    },
    close: async () => {
      await service.settled();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function call(
  url: string,
  token: string | null,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(url, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: response.headers,
  };
}

function registrationPayload(tenant: string, origin: Origin, reportId = "report-sv16"): JsonValue {
  const kase = reportKindCases(tenant, BINDING, origin).find((candidate) => candidate.kindId === "evidence_report");
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
        timeCoverage: {
          world: null,
          observed: { from: "2026-10-24T22:00:00Z", to: "2026-10-24T22:00:00Z" },
          knowledgeHead: null,
        },
        supersedes: null,
      },
    }),
  ) as JsonValue;
}

function tokenFor(
  key: IssuerKey,
  clock: TestClock,
  envelope: OperationEnvelope | null,
  origin: Origin,
  overrides: Partial<Parameters<typeof claimsFor>[0]> = {},
): string {
  return signCredential(
    key,
    claimsFor({
      origin,
      operations: envelope ? [envelope.operation] : ["knowledge.describe"],
      dispatchId: envelope?.dispatchId ?? `dispatch-${Math.random().toString(36).slice(2)}`,
      binding: envelope?.binding ?? BINDING,
      effect: envelope?.effect
        ? { effectKey: envelope.effect.effectKey, boundEffectDigest: envelope.effect.boundEffectDigest }
        : null,
      now: clock.seconds,
      ...overrides,
    }),
  );
}

function expectError(result: { status: number; body: Record<string, unknown> }, code: string, status: number) {
  const parsed = ProtocolErrorSchema.parse(result.body);
  expect(parsed.code).toBe(code);
  expect(result.status).toBe(status);
  return parsed;
}

async function register(h: Harness, key: IssuerKey, origin: Origin, reportId = "report-sv16") {
  const envelope = envelopeFor({
    operation: "report.register",
    origin,
    payload: registrationPayload(TENANT, origin, reportId),
  });
  const result = await call(`${h.url}/invoke`, tokenFor(key, h.clock, envelope, origin), { body: envelope });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return { envelope, receipt: OperationReceiptSchema.parse(result.body) };
}

async function pollTerminal(h: Harness, key: IssuerKey, origin: Origin, handle: OperationHandle) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const token = tokenFor(key, h.clock, null, origin, { operations: ["operation.get"] });
    const result = await call(`${h.url}/operations/${encodeURIComponent(handle.operationId)}`, token);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const status = OperationStatusSchema.parse(result.body);
    if (status.retryAfterMs === null) return { status, headers: result.headers };
    expect(status.retryAfterMs).toBeGreaterThanOrEqual(100);
    expect(result.headers.get("retry-after")).toBe(String(Math.ceil(status.retryAfterMs / 1000)));
    await h.service.settled();
  }
  throw new Error("operation did not settle");
}

describe("ks.knowledge_operation.v2 executor conformance (K01 + K07 over the wire)", () => {
  const active = generateIssuerKey("mc-issuer-2", "EdDSA");
  const retiring = generateIssuerKey("mc-issuer-1", "EdDSA");
  const es256 = generateIssuerKey("mc-issuer-es", "ES256");
  let h: Harness;

  // A fresh harness per case: K02 records are write-once per (tenant, id), and these cases register the same fixture
  // assertion ids under different origins (B1b SV-07 follow-up: a different record under an id conflicts).
  beforeEach(async () => {
    h = await harness({ keys: [active, retiring, es256] });
  });
  afterEach(async () => {
    await h?.close();
  });

  it("registers a report: report.register -> operation-receipt.v2; a retry by the originator answers the same receipt", async () => {
    const origin = liveOrigin(TENANT);
    const { envelope, receipt } = await register(h, active, origin, "report-register-1");
    expect(receipt.outcome).toBe("applied");
    expect(receipt.effect.effectKey).toBe(envelope.effect?.effectKey);
    expect(receipt.effect.currentCallerOrigin).toEqual(origin);
    expect(receipt.nativeReceiptRef.kind).toBe("report");
    expect(receipt.digest).toBe(
      digestCanonical(Object.fromEntries(Object.entries(receipt).filter(([k]) => k !== "digest")) as JsonValue),
    );
    const retry = { ...envelope, dispatchId: "dispatch-retry-1" };
    const again = await call(`${h.url}/invoke`, tokenFor(active, h.clock, retry, origin), { body: retry });
    expect(again.status).toBe(200);
    expect(OperationReceiptSchema.parse(again.body)).toEqual(receipt);
  });

  it("refuses changed bytes under the same effect key (EFFECT_CONFLICT)", async () => {
    const origin = liveOrigin(TENANT);
    const { envelope } = await register(h, active, origin, "report-conflict-1");
    // Another effect (new key) cannot re-register the same report id + revision.
    const again = envelopeFor({
      operation: "report.register",
      origin,
      payload: registrationPayload(TENANT, origin, "report-conflict-1"),
    });
    expectError(
      await call(`${h.url}/invoke`, tokenFor(active, h.clock, again, origin), { body: again }),
      "EFFECT_CONFLICT",
      409,
    );
    const edited = envelopeFor({
      operation: "report.register",
      origin,
      payload: registrationPayload(TENANT, origin, "report-conflict-1-edited"),
      effectKey: envelope.effect?.effectKey as string,
    });
    const result = await call(`${h.url}/invoke`, tokenFor(active, h.clock, edited, origin), { body: edited });
    expectError(result, "EFFECT_CONFLICT", 409);
    // A digest that does not bind the exact bytes is refused before anything is bound.
    // (a reused dispatch id with other content is itself refused, so the forged one is a new dispatch)
    const reused = { ...edited, requestId: "req-reused-dispatch" };
    expectError(
      await call(`${h.url}/invoke`, tokenFor(active, h.clock, reused, origin), { body: reused }),
      "SCOPE_DENIED",
      401,
    );
    const forgedDigest = {
      ...edited,
      dispatchId: "dispatch-forged-digest",
      effect: {
        ...(edited.effect as NonNullable<OperationEnvelope["effect"]>),
        effectKey: "effect-forged-digest",
        boundEffectDigest: digestBytes("not these bytes"),
      },
    } as unknown as OperationEnvelope;
    const forged = await call(`${h.url}/invoke`, tokenFor(active, h.clock, forgedDigest, origin), {
      body: forgedDigest,
    });
    expectError(forged, "EFFECT_CONFLICT", 409);
  });

  it("refuses a forged originating origin (ORIGIN_MISMATCH) and a new attempt without an effect-scoped grant", async () => {
    const caller = liveOrigin(TENANT);
    const someoneElse = liveOrigin(TENANT, { attempt: 7 });
    const forged = envelopeFor({
      operation: "report.register",
      origin: caller,
      originatingOrigin: someoneElse,
      payload: registrationPayload(TENANT, caller, "report-forged-1"),
    });
    expectError(
      await call(`${h.url}/invoke`, tokenFor(active, h.clock, forged, caller), { body: forged }),
      "ORIGIN_MISMATCH",
      403,
    );
  });

  it("fresh authorized recovery: a new attempt with an effect-scoped grant re-dispatches the exact effect", async () => {
    const attempt1 = liveOrigin(TENANT, { attempt: 1 });
    const attempt2 = liveOrigin(TENANT, { attempt: 2 });
    const { envelope, receipt } = await register(h, active, attempt1, "report-recovery-1");
    const retry = { ...envelope, dispatchId: "dispatch-attempt-2" };
    const effect = retry.effect as NonNullable<OperationEnvelope["effect"]>;
    // Without the grant: a different caller is refused.
    expectError(
      await call(`${h.url}/invoke`, tokenFor(active, h.clock, retry, attempt2), { body: retry }),
      "ORIGIN_MISMATCH",
      403,
    );
    const retry2 = { ...envelope, dispatchId: "dispatch-attempt-2b" };
    const granted = tokenFor(active, h.clock, retry2, attempt2, {
      recovery: {
        scope: "effect",
        authorityRef: "recovery-grant-1",
        effectKey: effect.effectKey,
        boundEffectDigest: effect.boundEffectDigest,
      },
    });
    const recovered = await call(`${h.url}/invoke`, granted, { body: retry2 });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(OperationReceiptSchema.parse(recovered.body)).toEqual(receipt);
    // A grant for another effect cannot be minted into valid claims (K01 ties it to claims.effect) ...
    expect(() =>
      tokenFor(active, h.clock, { ...envelope, dispatchId: "dispatch-attempt-2c" }, attempt2, {
        recovery: {
          scope: "effect",
          authorityRef: "recovery-grant-1",
          effectKey: "effect-other",
          boundEffectDigest: effect.boundEffectDigest,
        },
      }),
    ).toThrow();
    // ... and signed anyway, K07 refuses the claims.
    const forged = { ...envelope, dispatchId: "dispatch-attempt-2d" };
    const raw = {
      ...claimsFor({
        origin: attempt2,
        operations: ["report.register"],
        dispatchId: forged.dispatchId,
        binding: BINDING,
        effect: { effectKey: effect.effectKey, boundEffectDigest: effect.boundEffectDigest },
        now: h.clock.seconds,
      }),
      recovery: {
        scope: "effect",
        authorityRef: "recovery-grant-1",
        effectKey: "effect-other",
        boundEffectDigest: effect.boundEffectDigest,
      },
    };
    const refused = expectError(
      await call(`${h.url}/invoke`, signCredential(active, raw), { body: forged }),
      "SCOPE_DENIED",
      401,
    );
    expect((refused.details as { reason: string }).reason).toBe("claims_invalid");
  });

  it("refuses wrong audience, issuer, tenant, installation, expired and replayed credentials (SCOPE_DENIED)", async () => {
    const origin = liveOrigin(TENANT);
    const describe = (token: string) => call(`${h.url}/describe`, token);
    const reason = (result: { status: number; body: Record<string, unknown> }) =>
      (expectError(result, "SCOPE_DENIED", 401).details as { reason?: string } | null)?.reason;
    expect(reason(await describe(tokenFor(active, h.clock, null, origin, { audience: "other-executor" })))).toBe(
      "wrong_audience",
    );
    expect(reason(await describe(tokenFor(active, h.clock, null, origin, { issuer: "rogue-issuer" })))).toBe(
      "wrong_issuer",
    );
    expect(reason(await describe(tokenFor(active, h.clock, null, origin, { now: h.clock.seconds - 400 })))).toBe(
      "expired",
    );
    expect(reason(await describe(tokenFor(active, h.clock, null, origin, { now: h.clock.seconds + 120 })))).toBe(
      "not_yet_valid",
    );
    // within skew (30 s) is still accepted
    expect((await describe(tokenFor(active, h.clock, null, origin, { now: h.clock.seconds - 320 }))).status).toBe(200);
    const once = tokenFor(active, h.clock, null, origin);
    expect((await describe(once)).status).toBe(200);
    expect(reason(await describe(once))).toBe("replay");
    const otherTenant = liveOrigin(OTHER_TENANT);
    expectError(await describe(tokenFor(active, h.clock, null, otherTenant)), "SCOPE_DENIED", 401);
    const otherInstallation = liveOrigin(TENANT, { installationId: "0192a4f0-0000-7000-8000-00000000ffff" });
    expectError(await describe(tokenFor(active, h.clock, null, otherInstallation)), "SCOPE_DENIED", 401);
    // the envelope scope must equal the credential's
    const envelope = envelopeFor({
      operation: "report.register",
      origin,
      payload: registrationPayload(TENANT, origin, "report-scope"),
    });
    const token = tokenFor(active, h.clock, envelope, origin, { dispatchId: "dispatch-other" });
    expectError(await call(`${h.url}/invoke`, token, { body: envelope }), "SCOPE_DENIED", 401);
    // an operation the credential does not grant
    const assessToken = tokenFor(active, h.clock, envelope, origin, { operations: ["report.assess"], effect: null });
    expectError(await call(`${h.url}/invoke`, assessToken, { body: envelope }), "SCOPE_DENIED", 401);
    // no credential, the legacy static bearer, garbage
    expect(reason(await call(`${h.url}/describe`, null))).toBe("missing");
    expect(reason(await call(`${h.url}/describe`, "legacy-static-token"))).toBe("malformed");
  });

  it("fails closed on unknown kid, disallowed algorithm, extra header, bad signature; accepts ES256", async () => {
    const origin = liveOrigin(TENANT);
    const claims = () =>
      claimsFor({
        origin,
        operations: ["knowledge.describe"],
        dispatchId: `d-${Math.random()}`,
        binding: BINDING,
        now: h.clock.seconds,
      });
    const reason = async (token: string) =>
      (expectError(await call(`${h.url}/describe`, token), "SCOPE_DENIED", 401).details as { reason: string }).reason;
    const stranger = generateIssuerKey("mc-issuer-unknown");
    expect(await reason(signCredential(stranger, claims()))).toBe("unknown_kid");
    expect(
      await reason(
        signCredential(active, claims(), { alg: "HS256", kid: active.kid, typ: "ks-knowledge-operation+jwt" }),
      ),
    ).toBe("algorithm_not_allowed");
    expect(
      await reason(
        signCredential(active, claims(), {
          alg: "EdDSA",
          kid: active.kid,
          typ: "ks-knowledge-operation+jwt",
          jku: "https://evil",
        }),
      ),
    ).toBe("header_not_allowed");
    expect(await reason(signCredential(active, claims(), { alg: "EdDSA", kid: active.kid, typ: "JWT" }))).toBe(
      "wrong_token_type",
    );
    // signed by another key under the active kid
    expect(await reason(signCredential({ ...stranger, kid: active.kid }, claims()))).toBe("bad_signature");
    // an ES256 header under an EdDSA kid
    expect(await reason(signCredential({ ...es256, kid: active.kid }, claims()))).toBe("algorithm_mismatch");
    expect((await call(`${h.url}/describe`, signCredential(es256, claims()))).status).toBe(200);
  });

  it("rotated key: a retiring key verifies until its retire time, then refuses; a removed kid is unknown", async () => {
    const origin = liveOrigin(TENANT);
    const token = () =>
      signCredential(
        retiring,
        claimsFor({
          origin,
          operations: ["knowledge.describe"],
          dispatchId: `d-${Math.random()}`,
          binding: BINDING,
          now: h.clock.seconds,
        }),
      );
    h.setJwks(jwksOf([active, retiring, es256], { [retiring.kid]: h.clock.seconds + 60 }));
    expect((await call(`${h.url}/describe`, token())).status).toBe(200);
    h.clock.seconds += 100; // past retire_at + skew
    const refused = expectError(await call(`${h.url}/describe`, token()), "SCOPE_DENIED", 401);
    expect((refused.details as { reason: string }).reason).toBe("key_retired");
    h.setJwks(jwksOf([active, es256]));
    const gone = expectError(await call(`${h.url}/describe`, token()), "SCOPE_DENIED", 401);
    expect((gone.details as { reason: string }).reason).toBe("unknown_kid");
    h.setJwks(jwksOf([active, retiring, es256]));
  });

  it("report.assess: handle -> status polling with retry-after -> terminal domain outcome; receipt.get finds the register receipt", async () => {
    const origin = liveOrigin(TENANT);
    const { envelope, receipt } = await register(h, active, origin, "report-assess-1");
    const report = receipt.nativeReceiptRef;
    const assess = envelopeFor({
      operation: "report.assess",
      origin,
      payload: { report, obligation: "evidence", submission: "sub-1" } as unknown as JsonValue,
      upstream: [report],
      requestId: "assess:sub-1",
    });
    const started = await call(`${h.url}/invoke`, tokenFor(active, h.clock, assess, origin), { body: assess });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const handle = OperationHandleSchema.parse(started.body);
    // idempotent start by request id
    const assess2 = { ...assess, dispatchId: "dispatch-assess-again" };
    expect(
      OperationHandleSchema.parse(
        (await call(`${h.url}/invoke`, tokenFor(active, h.clock, assess2, origin), { body: assess2 })).body,
      ),
    ).toEqual(handle);
    const { status } = await pollTerminal(h, active, origin, handle);
    // No judge observation is registered by the producer: the independent census runs and missing support holds.
    expect(status.state).toBe("held");
    expect(status.resultRef).not.toBeNull();
    // receipt-first lookup by the original effect key
    const lookupToken = tokenFor(active, h.clock, null, origin, { operations: ["receipt.get"] });
    const found = await call(
      `${h.url}/receipts/${encodeURIComponent(envelope.effect?.effectKey as string)}`,
      lookupToken,
    );
    expect(ReceiptLookupSchema.parse(found.body)).toEqual({ disposition: "found", receipt });
    // read-only recovery after the invocation ended, scoped to the exact key
    const recovery = recoveryOriginFor(TENANT, "recovery-grant-9");
    const effect = envelope.effect as NonNullable<OperationEnvelope["effect"]>;
    const recoveryClaims = {
      operations: ["receipt.get"] as const,
      recovery: {
        scope: "read_only" as const,
        authorityRef: "recovery-grant-9",
        effectKey: effect.effectKey,
        boundEffectDigest: effect.boundEffectDigest,
      },
    };
    const viaRecovery = await call(
      `${h.url}/receipts/${encodeURIComponent(effect.effectKey)}`,
      tokenFor(active, h.clock, null, recovery, { ...recoveryClaims, operations: ["receipt.get"] }),
    );
    expect(ReceiptLookupSchema.parse(viaRecovery.body).disposition).toBe("found");
    expectError(
      await call(
        `${h.url}/receipts/effect-someone-else`,
        tokenFor(active, h.clock, null, recovery, { ...recoveryClaims, operations: ["receipt.get"] }),
      ),
      "SCOPE_DENIED",
      401,
    );
    const unknown = await call(
      `${h.url}/receipts/effect-never-sent`,
      tokenFor(active, h.clock, null, recovery, {
        operations: ["receipt.get"],
        recovery: {
          scope: "read_only",
          authorityRef: "recovery-grant-9",
          effectKey: "effect-never-sent",
          boundEffectDigest: effect.boundEffectDigest,
        },
      }),
    );
    expect(ReceiptLookupSchema.parse(unknown.body).disposition).toBe("not_found");
    // the status of another tenant's handle is not found
    expectError(
      await call(
        `${h.url}/operations/op-does-not-exist`,
        tokenFor(active, h.clock, null, origin, { operations: ["operation.get"] }),
      ),
      "NOT_FOUND",
      404,
    );
  });

  it("knowledge.read: exact package handle, exact bytes by digest; an unknown revision is EXACT_REVISION_UNAVAILABLE", async () => {
    const origin = liveOrigin(TENANT);
    const { receipt } = await register(h, active, origin, "report-read-1");
    const report = receipt.nativeReceiptRef;
    const read = envelopeFor({
      operation: "knowledge.read",
      origin,
      payload: {
        report,
        exact: true,
        purpose: "dependent_input",
        selection: { mode: "revision" },
      } as unknown as JsonValue,
      upstream: [report],
      requestId: "read:report-read-1",
    });
    const started = await call(`${h.url}/invoke`, tokenFor(active, h.clock, read, origin), { body: read });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const handle = OperationHandleSchema.parse(started.body);
    const { status } = await pollTerminal(h, active, origin, handle);
    expect(status.state).toBe("succeeded");
    const manifestRef = status.resultRef as NonNullable<OperationStatus["resultRef"]>;
    expect(manifestRef.version).toBe("research-report-package.v2");
    const bytes = await fetch(`${h.url}/artifacts/${manifestRef.id}?digest=${manifestRef.digest}`, {
      headers: {
        authorization: `Bearer ${tokenFor(active, h.clock, null, origin, { operations: ["knowledge.read"] })}`,
      },
    });
    expect(bytes.status).toBe(200);
    const raw = Buffer.from(await bytes.arrayBuffer());
    expect(digestBytes(raw)).toBe(manifestRef.digest);
    const manifest = JSON.parse(raw.toString("utf8")) as {
      report: unknown;
      body: { artifact: { id: string; digest: string } };
    };
    expect(manifest.report).toEqual(report);
    const body = await fetch(
      `${h.url}/artifacts/${manifest.body.artifact.id}?digest=${manifest.body.artifact.digest}`,
      {
        headers: {
          authorization: `Bearer ${tokenFor(active, h.clock, null, origin, { operations: ["knowledge.read"] })}`,
        },
      },
    );
    expect(digestBytes(Buffer.from(await body.arrayBuffer()))).toBe(manifest.body.artifact.digest);
    // wrong digest for the same id
    const wrong = await call(
      `${h.url}/artifacts/${manifestRef.id}?digest=${digestBytes("x")}`,
      tokenFor(active, h.clock, null, origin, { operations: ["knowledge.read"] }),
    );
    expectError(wrong, "EXACT_REVISION_UNAVAILABLE", 409);
    const missing = envelopeFor({
      operation: "knowledge.read",
      origin,
      payload: {
        report: { ...report, digest: digestBytes("other revision") },
        exact: true,
        purpose: "dependent_input",
        selection: { mode: "revision" },
      } as unknown as JsonValue,
    });
    expectError(
      await call(`${h.url}/invoke`, tokenFor(active, h.clock, missing, origin), { body: missing }),
      "EXACT_REVISION_UNAVAILABLE",
      409,
    );
  });

  it("cancel is idempotent by cancel request id; the first id is kept", async () => {
    const gated = new GatedAuditor(new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT));
    const g = await harness({ keys: [active], auditor: gated });
    try {
      const origin = liveOrigin(TENANT);
      const { receipt } = await register(g, active, origin, "report-cancel-1");
      const assess = envelopeFor({
        operation: "report.assess",
        origin,
        payload: { report: receipt.nativeReceiptRef } as unknown as JsonValue,
        requestId: "assess:cancel",
      });
      const handle = OperationHandleSchema.parse(
        (await call(`${g.url}/invoke`, tokenFor(active, g.clock, assess, origin), { body: assess })).body,
      );
      for (let i = 0; i < 100 && !gated.entered; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(gated.entered).toBe(true);
      const cancel = (id: string) =>
        call(
          `${g.url}/operations/${handle.operationId}/cancel`,
          tokenFor(active, g.clock, null, origin, { operations: ["operation.cancel"] }),
          {
            body: { cancelRequestId: id },
          },
        );
      const first = OperationStatusSchema.parse((await cancel("cancel-1")).body);
      expect(first.state).toBe("cancelling");
      expect(first.cancelRequestId).toBe("cancel-1");
      const second = OperationStatusSchema.parse((await cancel("cancel-2")).body);
      expect(second.cancelRequestId).toBe("cancel-1");
      expect(second.revision).toBe(first.revision);
      gated.open();
      await g.service.settled();
      const settled = OperationStatusSchema.parse(
        (
          await call(
            `${g.url}/operations/${handle.operationId}`,
            tokenFor(active, g.clock, null, origin, { operations: ["operation.get"] }),
          )
        ).body,
      );
      expect(["cancelled", "succeeded", "partial", "held", "rejected"]).toContain(settled.state);
      expect(settled.cancelRequestId).toBe("cancel-1");
      // malformed cancel body is a typed refusal
      expectError(
        await call(
          `${g.url}/operations/${handle.operationId}/cancel`,
          tokenFor(active, g.clock, null, origin, { operations: ["operation.cancel"] }),
          {
            body: { cancelRequestId: "" },
          },
        ),
        "INVALID_ENVELOPE",
        400,
      );
    } finally {
      await g.close();
    }
  });

  it("describe advertises operations, kinds, guarantees and a stable digest; unwired capabilities refuse typed", async () => {
    const origin = liveOrigin(TENANT);
    const first = BindingDescriptorSchema.parse(
      (await call(`${h.url}/describe`, tokenFor(active, h.clock, null, origin))).body,
    );
    const second = BindingDescriptorSchema.parse(
      (await call(`${h.url}/describe`, tokenFor(active, h.clock, null, origin))).body,
    );
    expect(digestCanonical(first as unknown as JsonValue)).toBe(digestCanonical(second as unknown as JsonValue));
    expect(first.operations).toEqual([
      "knowledge.describe",
      "knowledge.read",
      "report.register",
      "report.assess",
      "report.derive",
      "report.observe",
      "report.seal",
      "report.decide",
      "report.review",
      "decision.resolve",
      "operation.get",
      "operation.cancel",
      "receipt.get",
    ]);
    expect(first.reportKinds).toEqual(["evidence_report", "study_appraisal"]);
    expect(first.guarantees).toMatchObject({
      exactRead: "exact_revision",
      receiptLookup: "by_effect_key",
      nativeCancellation: "native",
    });
    // knowledge.apply without its native port and the unwired biotech binding are SCHEMA_UNSUPPORTED
    const apply = envelopeFor({
      operation: "knowledge.apply",
      origin,
      payload: { schemaVersion: "knowledge-ingestion-intent.v1" },
    });
    expectError(
      await call(`${h.url}/invoke`, tokenFor(active, h.clock, apply, origin), { body: apply }),
      "SCHEMA_UNSUPPORTED",
      422,
    );
    const bio = liveOrigin(TENANT, { application: "biotech" });
    const bioToken = tokenFor(active, h.clock, null, bio, { binding: "biotech-graph" });
    const bioDescriptor = BindingDescriptorSchema.parse(
      (await call(`${h.url}/describe`, bioToken)).body,
    ) as BindingDescriptor;
    expect(bioDescriptor.operations).toEqual(["knowledge.describe"]);
    const bioRegister = envelopeFor({
      operation: "report.register",
      origin: bio,
      binding: "biotech-graph",
      payload: { x: 1 },
    });
    expectError(
      await call(`${h.url}/invoke`, tokenFor(active, h.clock, bioRegister, bio), { body: bioRegister }),
      "SCHEMA_UNSUPPORTED",
      422,
    );
    // a routed operation through invoke, an invalid body, and an unknown route
    expectError(
      await call(`${h.url}/invoke`, tokenFor(active, h.clock, null, origin, { operations: ["report.assess"] }), {
        body: { nope: 1 },
      }),
      "INVALID_ENVELOPE",
      400,
    );
    expectError(await call(`${h.url}/nothing-here`, tokenFor(active, h.clock, null, origin)), "NOT_FOUND", 404);
  });

  it("report.assess without an independent auditor refuses INDEPENDENCE_UNPROVEN and is not advertised", async () => {
    const g = await harness({ keys: [active], auditor: null });
    try {
      const origin = liveOrigin(TENANT);
      const { receipt } = await register(g, active, origin, "report-noauditor");
      const assess = envelopeFor({
        operation: "report.assess",
        origin,
        payload: { report: receipt.nativeReceiptRef } as unknown as JsonValue,
      });
      const descriptor = BindingDescriptorSchema.parse(
        (await call(`${g.url}/describe`, tokenFor(active, g.clock, null, origin))).body,
      );
      expect(descriptor.operations).not.toContain("report.assess");
      expectError(
        await call(`${g.url}/invoke`, tokenFor(active, g.clock, assess, origin), { body: assess }),
        "INDEPENDENCE_UNPROVEN",
        409,
      );
    } finally {
      await g.close();
    }
  });
});

describe("report.derive over the wire (design §3.2: supported fields only, unresolved mappings hold items)", () => {
  const key = generateIssuerKey("mc-issuer-derive");
  let h: Harness;
  // Fresh per case: both cases register the same fixture assertion ids (write-once per tenant and id).
  beforeEach(async () => {
    h = await harness({ keys: [key] });
  });
  afterEach(async () => {
    await h?.close();
  });

  const mapping = (tenant = TENANT) => ({
    schemaVersion: "research-core.mapping.v2",
    id: "mapping-sv16",
    tenant,
    binding: BINDING,
    targetSchema: "aiengineer.model_fact.v1",
    rules: [
      {
        ruleId: "size",
        assertionKinds: ["source_report"],
        target: "model_parameter_count",
        includeValue: true,
        qualifierFields: ["unit"],
        requiresEntity: true,
        requiresTime: false,
      },
      {
        ruleId: "size-at-time",
        assertionKinds: ["source_report"],
        target: "model_parameter_count_at",
        includeValue: true,
        qualifierFields: ["unit"],
        requiresEntity: true,
        requiresTime: true,
      },
    ],
    entityResolutions: [
      {
        surface: "model-x",
        entityId: "model/x",
        resolution: {
          kind: "artifact",
          id: "entity-resolution-1",
          version: "artifact.v1",
          digest: digestBytes("entity-resolution-1"),
          tenant,
          binding: BINDING,
        },
      },
    ],
  });

  async function deriveOf(origin: Origin, report: Record<string, unknown>, requestId: string, map = mapping()) {
    const envelope = envelopeFor({
      operation: "report.derive",
      origin,
      payload: { report, mapping: map } as unknown as JsonValue,
      upstream: [report as never],
      requestId,
    });
    return call(`${h.url}/invoke`, tokenFor(key, h.clock, envelope, origin), { body: envelope });
  }

  async function derivedDocument(origin: Origin, handle: OperationHandle) {
    const { status } = await pollTerminal(h, key, origin, handle);
    const ref = status.resultRef as NonNullable<OperationStatus["resultRef"]>;
    const bytes = await fetch(`${h.url}/artifacts/${ref.id}?digest=${ref.digest}`, {
      headers: { authorization: `Bearer ${tokenFor(key, h.clock, null, origin, { operations: ["knowledge.read"] })}` },
    });
    return {
      status,
      document: JSON.parse(Buffer.from(await bytes.arrayBuffer()).toString("utf8")) as {
        proposals: { ruleId: string; entityId: string | null; fields: Record<string, unknown>; value: unknown }[];
        held: { assertion: { id: string }; ruleId: string | null; reason: string }[];
      },
    };
  }

  it("holds every item without independent support (the producer cannot support itself)", async () => {
    const origin = liveOrigin(TENANT);
    const { receipt } = await register(h, key, origin, "report-derive-unsupported");
    const started = await deriveOf(origin, receipt.nativeReceiptRef as never, "derive:unsupported");
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const { status, document } = await derivedDocument(origin, OperationHandleSchema.parse(started.body));
    expect(status.state).toBe("held");
    expect(document.proposals).toEqual([]);
    expect(document.held.map((item) => item.reason)).toEqual(["not_supported"]);
  });

  it("compiles the supported field through the resolved rule, holds the unresolved-time rule, idempotent by request id", async () => {
    const origin = liveOrigin(TENANT);
    const { receipt } = await register(h, key, origin, "report-derive-supported");
    const runId = (receipt.details as { runId: string }).runId;
    const kase = reportKindCases(TENANT, BINDING, origin).find((candidate) => candidate.kindId === "evidence_report");
    if (kase === undefined) throw new Error("fixture");
    const set = kase.supportSets[0] as (typeof kase.supportSets)[number];
    const assertion = kase.assertions[0] as (typeof kase.assertions)[number];
    const scope = { tenant: TENANT, application: "ai-engineer", binding: BINDING, origin, grants: [] };
    // Trusted in-process setup: an independent judge's observation (never accepted from the producer over K01).
    await h.backend.research().coordinator.observe(
      scope,
      runId,
      fixtureSupportObservation({
        tenant: TENANT,
        binding: BINDING,
        id: "obs-judge-derive",
        set,
        fragment: kase.fragments[0] as (typeof kase.fragments)[number],
        role: "judge",
        verdict: "full_support",
        qualifiersDigest: qualifiersDigest(assertion.qualifiers),
      }),
    );
    const report = receipt.nativeReceiptRef as never;
    const started = await deriveOf(origin, report, "derive:supported");
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const handle = OperationHandleSchema.parse(started.body);
    const { status, document } = await derivedDocument(origin, handle);
    expect(status.state).toBe("partial");
    expect(document.proposals).toHaveLength(1);
    expect(document.proposals[0]).toMatchObject({
      ruleId: "size",
      entityId: "model/x",
      fields: { unit: "parameters" },
      value: { type: "quantity", amount: "7000000000", unit: "parameters" },
    });
    expect(document.held).toEqual([expect.objectContaining({ ruleId: "size-at-time", reason: "unresolved_time" })]);
    // Same request id: the same handle; another mapping under it conflicts.
    expect(OperationHandleSchema.parse((await deriveOf(origin, report, "derive:supported")).body)).toEqual(handle);
    const changed = { ...mapping(), id: "mapping-other" };
    expectError(await deriveOf(origin, report, "derive:supported", changed), "EFFECT_CONFLICT", 409);
    // A mapping of another tenant and an unknown exact revision refuse typed.
    expectError(await deriveOf(origin, report, "derive:foreign", mapping(OTHER_TENANT)), "SCOPE_DENIED", 401);
    const missing = { ...(receipt.nativeReceiptRef as Record<string, unknown>), digest: digestBytes("other") };
    expectError(await deriveOf(origin, missing, "derive:missing"), "EXACT_REVISION_UNAVAILABLE", 409);
  });
});

describe("report.register declared use (K01 envelope use/audience must be the task's; checked before binding)", () => {
  const key = generateIssuerKey("mc-issuer-declared-use");
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ keys: [key] });
  });
  afterEach(async () => {
    await h?.close();
  });

  it("mismatch -> SCHEMA_UNSUPPORTED with no effect bound; the task's own use -> applied", async () => {
    const origin = liveOrigin(TENANT);
    const payload = registrationPayload(TENANT, origin, "report-declared-use");
    const task = (payload as { task: { use: string; audience: string } }).task;
    const mismatch = envelopeFor({
      operation: "report.register",
      origin,
      payload,
      declaredUse: { use: "internal_research", audience: "team" },
    });
    expectError(
      await call(`${h.url}/invoke`, tokenFor(key, h.clock, mismatch, origin), { body: mismatch }),
      "SCHEMA_UNSUPPORTED",
      422,
    );
    const effectKey = mismatch.effect?.effectKey as string;
    expect(h.backend.ledger.bound.has(`${TENANT}/${effectKey}`)).toBe(false);
    expect(h.backend.ledger.receipts.size).toBe(0);
    const match = envelopeFor({
      operation: "report.register",
      origin,
      payload,
      effectKey,
      declaredUse: { use: task.use, audience: task.audience },
    });
    const applied = await call(`${h.url}/invoke`, tokenFor(key, h.clock, match, origin), { body: match });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(OperationReceiptSchema.parse(applied.body).outcome).toBe("applied");
    expect(h.backend.ledger.bound.has(`${TENANT}/${effectKey}`)).toBe(true);
  });
});

describe("golden K01 vectors through K07", () => {
  const golden = JSON.parse(
    readFileSync(
      resolve(ROOT, "packages/knowledge-operation-protocol/fixtures/knowledge-operation-protocol.v2.golden.json"),
      "utf8",
    ),
  ) as { vectors: { id: string; envelope?: OperationEnvelope; credentialClaims?: Record<string, unknown> }[] };
  const vector = (id: string) => {
    const found = golden.vectors.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(id);
    return found;
  };

  async function goldenService(key: IssuerKey, apply: KnowledgeApplyPort | null, at = "2026-10-24T20:05:30Z") {
    const clock = new TestClock();
    clock.seconds = Math.floor(Date.parse(at) / 1000);
    const backend = createInMemoryBackend({
      application: "ai-engineer",
      binding: "aiengineer-postgres",
      kinds: KINDS,
      auditor: null,
      clock: { now: () => clock.instant() },
      apply,
    });
    return new KnowledgeOperationService({
      verifier: new KnowledgeCredentialVerifier({
        issuer: "mission-control",
        audience: "knowledge-services",
        jwks: new JwksCache(staticJwksSource(jwksOf([key]))),
        nowSeconds: () => clock.seconds,
      }),
      backends: [backend],
      installed: [
        {
          application: "ai-engineer",
          binding: "aiengineer-postgres",
          installationId: "00000000-0000-7000-8000-000000000001",
          tenants: null,
        },
      ],
      dispatches: new DispatchRegistry(),
      signingIssuer: "knowledge-services",
      clock: () => clock.instant(),
    });
  }

  it("admits the effect-scoped recovery dispatch vector through K07; without its grant it is ORIGIN_MISMATCH", async () => {
    const key = generateIssuerKey("golden-issuer");
    const service = await goldenService(key, null);
    const recovery = vector("effect-scoped-recovery-dispatch");
    const envelope = recovery.envelope as OperationEnvelope;
    const claims = recovery.credentialClaims as Record<string, unknown>;
    // K07 admits it (credential, scope, effect, origin + grant); only then does the binding refuse it, typed, because
    // the vector requires capabilities (knowledge.apply, receipt lookup) this in-memory binding does not advertise.
    const admitted = await service
      .invoke(signCredential(key, claims), envelope)
      .catch((error: { error: { code: string } }) => error.error.code);
    expect(admitted).toBe("CAPABILITY_UNAVAILABLE");
    const withoutGrant = { ...claims, jti: "jti-no-grant", recovery: null };
    const refused = await service
      .invoke(signCredential(key, withoutGrant), { ...envelope })
      .catch((error: { error: { code: string } }) => error.error.code);
    expect(refused).toBe("ORIGIN_MISMATCH");
  });

  it("answers the read-only recovery lookup vector (not_found for a never-applied effect)", async () => {
    const key = generateIssuerKey("golden-issuer");
    const service = await goldenService(key, null, "2026-10-24T20:30:30Z");
    const lookup = vector("read-only-recovery-lookup");
    const claims = lookup.credentialClaims as { recovery: { effectKey: string } };
    const result = await service.receipt(signCredential(key, claims), claims.recovery.effectKey);
    expect(result.disposition).toBe("not_found");
  });
});

describe("serve composition (env) mounts the routes ahead of the legacy static bearer", () => {
  let running: RunningExecutor;
  const key = generateIssuerKey("mc-serve-1");
  const origin = liveOrigin(TENANT);

  beforeAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "ks-kop-serve-"));
    const jwksFile = join(directory, "jwks.json");
    await writeFile(jwksFile, JSON.stringify(jwksOf([key])));
    running = await startExecutorServer({
      port: 0,
      host: "127.0.0.1",
      token: "legacy-static-token",
      knowledgeOperationAuditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT),
      env: {
        VERIFY_STORE_DIR: join(directory, "store"),
        KS_KNOWLEDGE_ISSUER: TEST_ISSUER,
        KS_KNOWLEDGE_AUDIENCE: TEST_AUDIENCE,
        KS_KNOWLEDGE_JWKS_FILE: jwksFile,
        KS_KNOWLEDGE_BINDINGS_JSON: JSON.stringify([
          { application: "ai-engineer", binding: "in-memory", installationId: TEST_INSTALLATION, tenants: [TENANT] },
          { application: "biotech", binding: "biotech-graph", installationId: TEST_INSTALLATION },
        ]),
      },
    });
  });
  afterAll(async () => {
    await running?.close();
  });

  it("serves describe with the issuer credential; the legacy token neither opens the new routes nor is needed", async () => {
    const token = signCredential(
      key,
      claimsFor({ origin, operations: ["knowledge.describe"], dispatchId: "d-serve-1", binding: BINDING }),
    );
    const ok = await call(`${running.url}/knowledge-operation/v2/describe`, token);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(BindingDescriptorSchema.parse(ok.body).operations).toContain("report.assess");
    const legacy = await call(`${running.url}/knowledge-operation/v2/describe`, "legacy-static-token");
    expectError(legacy, "SCOPE_DENIED", 401);
    // the old routes keep their static bearer
    expect((await call(`${running.url}/captures`, null)).status).toBe(401);
    expect((await call(`${running.url}/captures`, "legacy-static-token")).status).toBe(200);
  });

  it("mirrors the operations as MCP tools (credential out of band of the tool arguments)", async () => {
    const token = signCredential(
      key,
      claimsFor({ origin, operations: ["knowledge.describe"], dispatchId: "d-serve-mcp", binding: BINDING }),
    );
    const response = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer legacy-static-token",
        "x-knowledge-operation-credential": token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "knowledge_describe", arguments: {} },
      }),
    });
    expect(response.status).toBe(200);
    const rpc = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(rpc.result.isError ?? false).toBe(false);
    expect(BindingDescriptorSchema.parse(JSON.parse(rpc.result.content[0]?.text as string)).binding).toBe(BINDING);
    const missing = await fetch(`${running.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer legacy-static-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "knowledge_describe", arguments: {} },
      }),
    });
    const refused = (await missing.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(refused.result.isError).toBe(true);
    expect(ProtocolErrorSchema.parse(JSON.parse(refused.result.content[0]?.text as string)).code).toBe("SCOPE_DENIED");
  });
});
