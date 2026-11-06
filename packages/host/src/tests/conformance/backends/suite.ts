import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";
import {
  type ReportKindCatalog,
  ScriptedAuditorDiscovery,
  SourceAuthorityCatalog,
} from "@aiengineer/knowledge-application";
import {
  EVIDENCE_REPORT_SCRIPT,
  fixtureSupportObservation,
  reportKindCases,
} from "@aiengineer/knowledge-application/testing";
import {
  CREDENTIAL_TOKEN_TYPE,
  type CredentialEvaluation,
  EVALUATION_CONTEXT_CONTRACT,
  EvaluationContextSchema,
  CredentialClaimsSchema,
  DECIDE_CONTRACT,
  DecisionResolutionSchema,
  OBSERVE_CONTRACT,
  RESOLVE_CONTRACT,
  REVIEW_CONTRACT,
  SEAL_CONTRACT,
  type JsonValue,
  KNOWLEDGE_READ_CONTRACT,
  KnowledgeReadIntentResultSchema,
  READ_INTENT_CONTRACT,
  type OperationEnvelope,
  OperationEnvelopeSchema,
  type OperationName,
  type OperationReceipt,
  OperationReceiptSchema,
  type OperationStatus,
  type Origin,
  type ProtocolError,
  type Ref,
  type ResearchReportPackage,
  ResearchReportPackageSchema,
  bindEffect,
  canonicalJson,
  digestBytes,
  digestCanonical,
  selectedReadDigest,
} from "@aiengineer/knowledge-operation-protocol";
import {
  type AuthScope,
  normalizedValuesDigest,
  qualifiersDigest,
  recordRef,
  renderReport,
} from "@aiengineer/knowledge-research-core";
import {
  DispatchRegistry,
  JwksCache,
  KnowledgeCredentialVerifier,
  staticJwksSource,
} from "../../../knowledge-operation/auth.js";
import { ProtocolRefusal } from "../../../knowledge-operation/errors.js";
import type { EffectLedger, KnowledgeOperationBackend } from "../../../knowledge-operation/ports.js";
import {
  BACKEND_CAPABILITIES,
  type BackendCapability,
  BackendCapabilityMissing,
  CAPABILITY_ACCESSORS,
  CAPABILITY_CONDITIONS,
  type BackendDescriptor,
  type HostInjection,
  expectedCapabilities,
} from "../../../knowledge-operation/registry.js";
import { KnowledgeOperationService } from "../../../knowledge-operation/service.js";
import {
  type ApplyPlan,
  type BackendConformance,
  CONFORMANCE_CHECKS,
  type ConformanceCheck,
  type DisposableStore,
} from "./contract.js";

export * from "./contract.js";

/**
 * The knowledge backend conformance suite (Sprint OC R5; design §10): the checks every registered backend runs on its
 * disposable store, selected by its declared capabilities. Everything runs through the backend port and the K01 service
 * with real K07 credentials (a disposable issuer key) and real credential single use on the backend's store; only the
 * native apply payload and native write counts are store-specific ({@link ApplyFixture}). Test-runner neutral (node
 * assertions): {@link defineBackendConformance} wires it into vitest; each package that owns registrations runs it.
 */
const ISSUER = "conformance-issuer";
const AUDIENCE = "conformance-executor";
const TIMEOUT_MS = 120_000;

/** What each check needs declared (unconditionally or conditionally); `null` runs for every backend. */
const REQUIRES: Readonly<Record<ConformanceCheck, readonly BackendCapability[] | null>> = {
  declaration: null,
  describe_honesty: null,
  report_register_read: ["research"],
  selected_read: ["research"],
  trusted_assessment: ["research"],
  read_intent_recorded: ["research", "read_intent"],
  apply_receipt: ["research", "apply"],
  lost_ack_reconciliation: ["research", "apply"],
  revocation_before_dispatch: ["research", "apply"],
  data_class_premise: null,
  no_driver_type: null,
};
/** Checks that never open the store (they run for every backend, also without a database). */
const STORELESS: ReadonlySet<ConformanceCheck> = new Set(["declaration", "data_class_premise"]);

export interface PlannedCheck {
  readonly check: ConformanceCheck;
  readonly disposition: "run" | "declared_exception" | "not_declared" | "store_unavailable";
  readonly title: string;
}

/** Every capability a registration may serve: the declared ones and the conditional ones. */
function mayServe(entry: BackendConformance): ReadonlySet<BackendCapability> {
  const descriptor = entry.registration.describe();
  return new Set([...descriptor.capabilities, ...descriptor.conditionalCapabilities.map((item) => item.capability)]);
}

/**
 * Which checks run, which are declared exceptions (a check the backend cannot run with its store present), which do
 * not apply (a capability it does not declare) and which cannot run here (no disposable store).
 */
export function planConformance(entry: BackendConformance): readonly PlannedCheck[] {
  const declared = mayServe(entry);
  return CONFORMANCE_CHECKS.map((check) => {
    const exception = entry.exceptions.find((candidate) => candidate.check === check);
    if (exception !== undefined) {
      return { check, disposition: "declared_exception", title: `${check}: declared exception (${exception.reason})` };
    }
    const missing = (REQUIRES[check] ?? []).filter((capability) => !declared.has(capability));
    if (missing.length > 0) {
      return { check, disposition: "not_declared", title: `${check}: ${missing.join(" and ")} undeclared` };
    }
    if (entry.storeUnavailable !== undefined && !STORELESS.has(check)) {
      return { check, disposition: "store_unavailable", title: `${check}: ${entry.storeUnavailable.reason}` };
    }
    return { check, disposition: "run", title: check };
  });
}

// ------------------------------------------------------------------------------------------------ K07 + K01 driver

interface Issuer {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwks: unknown;
}

function issuer(): Issuer {
  const pair = generateKeyPairSync("ed25519");
  const kid = `conformance-${randomUUID().slice(0, 8)}`;
  const publicJwk = { ...(pair.publicKey.export({ format: "jwk" }) as Record<string, string>), kid, alg: "EdDSA" };
  return { kid, privateKey: pair.privateKey, jwks: { keys: [{ ...publicJwk, use: "sig" }] } };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function liveOrigin(tenant: string, application: string, installationId: string): Origin {
  return {
    kind: "mission_invocation",
    installationId,
    applicationId: application,
    tenantId: tenant,
    issuer: ISSUER,
    subject: "conformance-runtime",
    mission: {
      missionId: "mission-conformance",
      runId: "run-conformance",
      activationId: null,
      operationId: "op-conformance",
      operationAttempt: 1,
      executionGeneration: 1,
      lane: "deep_agents",
    },
    recoveryAuthorityRef: null,
    invocationId: `inv-${randomUUID()}`,
    authenticatedAt: "2026-10-27T10:00:00Z",
  };
}

const ROUTED_NATIVE: Partial<Record<OperationName, { name: string; version: string }>> = {
  "report.register": { name: "research-report", version: "v2" },
  "report.assess": { name: "research-report-assessment", version: "v1" },
  "knowledge.read": KNOWLEDGE_READ_CONTRACT,
  "report.observe": OBSERVE_CONTRACT,
  "report.seal": SEAL_CONTRACT,
  "report.decide": DECIDE_CONTRACT,
  "report.review": REVIEW_CONTRACT,
  "decision.resolve": RESOLVE_CONTRACT,
};

class Driver {
  readonly service: KnowledgeOperationService;

  constructor(
    readonly session: Session,
    readonly backend: KnowledgeOperationBackend,
  ) {
    this.service = new KnowledgeOperationService({
      verifier: new KnowledgeCredentialVerifier({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwks: new JwksCache(staticJwksSource(session.issuer.jwks)),
      }),
      backends: [backend],
      installed: [
        {
          application: session.store.config.application,
          binding: session.store.config.binding,
          installationId: session.store.config.installationId,
          tenants: null,
        },
      ],
      dispatches: new DispatchRegistry(),
      signingIssuer: "knowledge-services",
      retryAfterMs: 100,
    });
  }

  token(
    operation: OperationName,
    envelope: OperationEnvelope | null,
    as: { readonly origin?: Origin; readonly evaluation?: CredentialEvaluation } = {},
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const origin = as.origin ?? this.session.origin;
    const claims = CredentialClaimsSchema.parse({
      typ: CREDENTIAL_TOKEN_TYPE,
      iss: ISSUER,
      aud: AUDIENCE,
      sub: origin.subject,
      jti: `jti-${randomUUID()}`,
      iat: now,
      nbf: now,
      exp: now + 300,
      tenant: this.session.scope.tenant,
      application: this.session.scope.application,
      binding: this.session.scope.binding,
      origin,
      operations: [operation],
      effect: envelope?.effect
        ? { effectKey: envelope.effect.effectKey, boundEffectDigest: envelope.effect.boundEffectDigest }
        : null,
      dispatchId: envelope?.dispatchId ?? `dispatch-${randomUUID()}`,
      recovery: null,
      ...(as.evaluation ? { evaluation: as.evaluation } : {}),
    });
    const input = `${b64({ alg: "EdDSA", kid: this.session.issuer.kid, typ: CREDENTIAL_TOKEN_TYPE })}.${b64(claims)}`;
    return `${input}.${sign(null, Buffer.from(input, "ascii"), this.session.issuer.privateKey).toString("base64url")}`;
  }

  /** The response, or the refusal (both recorded for `no_driver_type`). */
  private async answer<T>(work: Promise<T>): Promise<T> {
    try {
      return this.session.saw(await work);
    } catch (error) {
      this.session.thrown(error);
      throw error;
    }
  }

  invoke(
    envelope: OperationEnvelope,
    as: { readonly origin?: Origin; readonly evaluation?: CredentialEvaluation } = {},
  ) {
    return this.answer(this.service.invoke(this.token(envelope.operation, envelope, as), envelope));
  }

  status(operationId: string): Promise<OperationStatus> {
    return this.answer(this.service.status(this.token("operation.get", null), operationId));
  }

  receipt(effectKey: string) {
    return this.answer(this.service.receipt(this.token("receipt.get", null), effectKey));
  }

  async artifact(ref: Ref): Promise<Uint8Array> {
    const { bytes } = await this.service.artifact(this.token("knowledge.read", null), ref.id, ref.digest);
    return bytes;
  }

  /** Poll a handle to its terminal status, running the in-process assessment between polls. */
  async terminal(operationId: string): Promise<OperationStatus> {
    let status = await this.status(operationId);
    for (let attempt = 0; attempt < 60 && status.retryAfterMs !== null; attempt += 1) {
      await this.service.settled();
      await new Promise((done) => setTimeout(done, 100));
      status = await this.status(operationId);
    }
    return status;
  }
}

async function refusal(work: Promise<unknown>): Promise<ProtocolError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProtocolRefusal) return error.error;
    throw error;
  }
  throw new assert.AssertionError({ message: "expected a typed K01 refusal" });
}

async function refusedCode(work: Promise<unknown>): Promise<string> {
  return (await refusal(work)).code;
}

/** A typed refusal with its code and the selected-read `details.reason`. */
async function refusedWith(work: Promise<unknown>): Promise<[string, unknown]> {
  const error = await refusal(work);
  return [error.code, (error.details as { reason?: unknown } | null)?.reason];
}

/** A K01 envelope whose native input is the canonical inline payload (the shape Mission Control's gateway sends). */
function envelopeFor(
  session: Session,
  input: {
    readonly operation: OperationName;
    readonly payload: JsonValue;
    readonly effectKey?: string;
    readonly boundEffectDigest?: string;
    readonly nativeContract?: { readonly name: string; readonly version: string };
    readonly upstream?: readonly Ref[];
    readonly requestId?: string;
  },
): OperationEnvelope {
  const bytes = Buffer.from(canonicalJson(input.payload), "utf8");
  const effectful = input.operation === "report.register" || input.operation === "knowledge.apply";
  const effect = effectful
    ? bindEffect({
        effectKey: input.effectKey ?? `effect-${randomUUID()}`,
        nativePayload: bytes,
        originatingOrigin: session.origin,
      })
    : null;
  const native = input.nativeContract ?? ROUTED_NATIVE[input.operation];
  return OperationEnvelopeSchema.parse({
    protocolVersion: "ks.knowledge_operation.v2",
    requestId: input.requestId ?? `req-${randomUUID()}`,
    dispatchId: `dispatch-${randomUUID()}`,
    tenant: session.scope.tenant,
    application: session.scope.application,
    binding: session.scope.binding,
    operation: input.operation,
    effect: effect && input.boundEffectDigest ? { ...effect, boundEffectDigest: input.boundEffectDigest } : effect,
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
      deadline: "2099-01-01T00:00:00Z",
      maxItems: 64,
      partialResults: "forbid",
      budget: { calls: 0, tokens: 0, costUsd: "0" },
    },
    requiredCapabilities: [],
    pinnedSchema: null,
    issuedAt: "2026-10-27T10:00:01Z",
  });
}

// ------------------------------------------------------------------------------------------------ session

interface Registered {
  readonly receipt: OperationReceipt;
  readonly runId: string;
  readonly report: Ref<"report">;
  readonly kase: ReturnType<typeof reportKindCases>[number];
}

interface PreparedApply {
  readonly envelope: OperationEnvelope;
  readonly effectKey: string;
  readonly plan: ApplyPlan;
}

class Session {
  readonly issuer = issuer();
  readonly scope: AuthScope;
  readonly origin: Origin;
  readonly responses: unknown[] = [];
  private registered: Registered | null = null;
  private sealed = false;
  primary: Driver | null = null;
  private readonly opened: KnowledgeOperationBackend[] = [];

  constructor(
    readonly entry: BackendConformance,
    readonly store: DisposableStore,
    readonly kinds: ReportKindCatalog,
    /** A sibling session (its own tenant) shares the store and leaves closing it to the owner. */
    private readonly ownsStore = true,
  ) {
    // A fresh tenant per session: K02 records are write-once per id in a binding.
    const tenant = randomUUID();
    this.origin = liveOrigin(tenant, store.config.application, store.config.installationId);
    this.scope = {
      tenant,
      application: store.config.application,
      binding: store.config.binding,
      origin: this.origin,
      grants: [],
    };
  }

  /** Errors that crossed the service other than a K01 refusal (names only); `no_driver_type` fails on any. */
  readonly foreign: string[] = [];

  saw<T>(value: T): T {
    this.responses.push(value);
    return value;
  }

  /** A thrown answer: its K01 error is recorded as a response; anything else crossing the service is foreign. */
  thrown(error: unknown): void {
    if (!(error instanceof ProtocolRefusal)) {
      this.foreign.push(error instanceof Error ? error.name : typeof error);
      return;
    }
    this.saw(error.error);
    const extra = Object.keys(error).filter((key) => key !== "error" && key !== "name");
    if (extra.length > 0) this.foreign.push(`ProtocolRefusal carries ${extra.join(", ")}`);
  }

  injection(overrides: Partial<HostInjection> = {}): HostInjection {
    return {
      kinds: this.kinds,
      auditor: new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT),
      seal: this.store.injection?.seal ?? null,
      apply: this.store.injection?.apply ?? null,
      readIntent: this.store.injection?.readIntent ?? null,
      env: this.store.env ?? {},
      ...overrides,
    };
  }

  async create(overrides: Partial<HostInjection> = {}): Promise<KnowledgeOperationBackend> {
    const backend = await this.entry.registration.create(this.store.config, this.injection(overrides));
    this.opened.push(backend);
    return backend;
  }

  async driver(): Promise<Driver> {
    this.primary ??= new Driver(this, await this.create());
    return this.primary;
  }

  get fixture() {
    const fixture = this.store.apply;
    assert.ok(
      fixture,
      `${this.entry.registration.id} declares apply but its conformance store supplies no apply fixture`,
    );
    return fixture;
  }

  /** Register one evidence report through K01 (memoized). */
  async register(): Promise<Registered> {
    if (this.registered !== null) return this.registered;
    const driver = await this.driver();
    const kase = reportKindCases(this.scope.tenant, this.scope.binding, this.origin).find(
      (candidate) => candidate.kindId === "evidence_report",
    );
    assert.ok(kase, "evidence_report fixture");
    const envelope = envelopeFor(this, {
      operation: "report.register",
      payload: JSON.parse(
        JSON.stringify({
          task: kase.task,
          fragments: kase.fragments,
          assertions: kase.assertions,
          supportSets: kase.supportSets,
          report: {
            reportId: "report-conformance",
            revision: 1,
            kind: "evidence_report",
            structuredBody: kase.body,
            timeCoverage: { world: null, observed: null, knowledgeHead: null },
            supersedes: null,
          },
        }),
      ) as JsonValue,
    });
    const receipt = OperationReceiptSchema.parse(await driver.invoke(envelope));
    this.registered = {
      receipt,
      runId: (receipt.details as { runId: string }).runId,
      report: receipt.nativeReceiptRef as Ref<"report">,
      kase,
    };
    return this.registered;
  }

  /** Judge observation, assessment and verification-snapshot seal of the registered run (memoized). */
  async seal(): Promise<Registered> {
    const registered = await this.register();
    if (this.sealed) return registered;
    const driver = await this.driver();
    const research = driver.backend.research();
    const { kase, runId, report } = registered;
    const set = kase.supportSets[0] as (typeof kase.supportSets)[number];
    const assertion = kase.assertions[0] as (typeof kase.assertions)[number];
    await research.coordinator.observe(
      this.scope,
      runId,
      fixtureSupportObservation({
        tenant: this.scope.tenant,
        binding: this.scope.binding,
        id: "obs-judge-conformance",
        set,
        fragment: kase.fragments[0] as (typeof kase.fragments)[number],
        role: "judge",
        verdict: "full_support",
        qualifiersDigest: qualifiersDigest(assertion.qualifiers),
      }),
    );
    const assess = envelopeFor(this, {
      operation: "report.assess",
      payload: { report } as unknown as JsonValue,
      upstream: [report],
      requestId: `assess-${randomUUID()}`,
    });
    const handle = (await driver.invoke(assess)) as { operationId: string };
    const status = await driver.terminal(handle.operationId);
    assert.ok(["succeeded", "partial"].includes(status.state), `assessment ended ${status.state}`);
    await research.coordinator.sealVerificationSnapshot(this.scope, {
      runId,
      build: { buildId: "build-conformance", runtime: "node24", dirty: true },
      signer: "ks-sealer",
    });
    this.sealed = true;
    return registered;
  }

  /** An admitted report-use decision for one fresh effect, and the `knowledge.apply` envelope that applies it. */
  async prepareApply(suffix: string): Promise<PreparedApply> {
    const { runId, kase } = await this.seal();
    const driver = await this.driver();
    const research = driver.backend.research();
    const context = await research.binding.loadRunContext(this.scope, runId);
    const plan = this.fixture.plan({ scope: this.scope, runId, revision: context.report?.revision, suffix });
    const decided = await research.coordinator.decideReportUse(this.scope, {
      runId,
      use: kase.task.use,
      audience: "official",
      boundEffectDigest: plan.boundEffectDigest,
      targetSchema: plan.targetSchema,
      normalizedValues: plan.normalizedValues,
      policy: kase.task.policy,
      rubric: kase.task.rubric,
    });
    assert.equal(decided.decision.disposition, "admitted", `use decision ${decided.decision.conditions.join(", ")}`);
    const effectKey = `effect-${suffix}-${randomUUID().slice(0, 8)}`;
    const payload = this.fixture.payload(plan, {
      scope: this.scope,
      effectKey,
      useDecisionId: decided.decision.id,
      processedEpoch: await driver.backend.revocation().epoch(this.scope),
      normalizedValuesDigest: normalizedValuesDigest(plan.normalizedValues),
    });
    const contract = this.entry.registration.describe().nativeContract;
    assert.ok(contract, "apply declares a native contract");
    const envelope = envelopeFor(this, {
      operation: "knowledge.apply",
      payload,
      effectKey,
      boundEffectDigest: plan.boundEffectDigest,
      nativeContract: contract,
    });
    return { envelope, effectKey, plan };
  }

  /** A session over the same store under a fresh tenant (K02 record ids are write-once per tenant). */
  sibling(): Session {
    const sibling = new Session(this.entry, this.store, this.kinds, false);
    this.siblings.push(sibling);
    return sibling;
  }

  private readonly siblings: Session[] = [];

  async close(): Promise<void> {
    for (const sibling of this.siblings.splice(0)) await sibling.close();
    await this.primary?.service.settled().catch(() => undefined);
    await Promise.all(this.opened.splice(0).map((backend) => backend.close().catch(() => undefined)));
    if (this.ownsStore) await this.store.close();
  }
}

// ------------------------------------------------------------------------------------------------ checks

const ACCESSORS = Object.entries(CAPABILITY_ACCESSORS) as [keyof typeof CAPABILITY_ACCESSORS, BackendCapability][];

function assertServes(backend: KnowledgeOperationBackend, expected: ReadonlySet<BackendCapability>): void {
  assert.deepEqual([...backend.capabilities].sort(), [...expected].sort());
  for (const [accessor, capability] of ACCESSORS) {
    if (expected.has(capability)) {
      assert.ok(backend[accessor](), `${accessor}() serves ${capability}`);
    } else {
      assert.throws(
        () => backend[accessor](),
        BackendCapabilityMissing,
        `${accessor}() refuses undeclared ${capability}`,
      );
    }
  }
}

async function describeHonesty(session: Session): Promise<void> {
  const descriptor = session.entry.registration.describe();
  const driver = await session.driver();
  const backend = driver.backend;
  // Declared == served: the declaration plus each conditional capability whose condition the injection met.
  const served = expectedCapabilities(descriptor, session.injection());
  assertServes(backend, served);
  assert.equal(backend.application, session.store.config.application);
  assert.equal(backend.binding, session.store.config.binding);
  assert.equal(backend.writeAtomicity, descriptor.writeAtomicity);
  assert.equal(backend.nativeCancellation, descriptor.nativeCancellation);
  assert.equal(backend.unsupportedReason, null);
  if (served.has("apply")) assert.deepEqual({ ...backend.apply().nativeContract }, { ...descriptor.nativeContract });
  assertK01Descriptor(driver, backend, served, descriptor);
  // Each conditional capability, created again with its condition unmet, is neither served nor described.
  for (const conditional of descriptor.conditionalCapabilities) {
    const unmet = { ...session.injection(), ...CAPABILITY_CONDITIONS[conditional.condition].unmet };
    const expected = expectedCapabilities(descriptor, unmet);
    assert.ok(!expected.has(conditional.capability), `${conditional.condition} unmet`);
    const without = await session.create(unmet);
    assertServes(without, expected);
    assertK01Descriptor(new Driver(session, without), without, expected, descriptor);
  }
}

/** The K01 descriptor is read from the served capabilities only. */
function assertK01Descriptor(
  driver: Driver,
  backend: KnowledgeOperationBackend,
  served: ReadonlySet<BackendCapability>,
  descriptor: BackendDescriptor,
): void {
  const k01 = driver.session.saw(driver.service.descriptorFor(backend));
  const has = (operation: OperationName) => k01.operations.includes(operation);
  assert.equal(has("report.register") && has("knowledge.read"), served.has("research"));
  assert.equal(has("knowledge.apply"), served.has("apply"));
  assert.equal(has("knowledge.read_intent"), served.has("read_intent") && served.has("research"));
  assert.equal(has("receipt.get"), served.has("native_receipt_lookup"));
  assert.equal(k01.guarantees.receiptLookup, served.has("native_receipt_lookup") ? "by_effect_key" : "unsupported");
  assert.equal(k01.guarantees.admission, served.has("apply") ? "exact_use_decision" : "unsupported");
  // Epoch-checked revocation is an admission guarantee: it needs both apply and revocation.
  assert.equal(
    k01.guarantees.revocation,
    served.has("apply") && served.has("revocation") ? "epoch_checked" : "unsupported",
  );
  assert.equal(k01.guarantees.writeAtomicity, descriptor.writeAtomicity);
  assert.equal(k01.guarantees.nativeCancellation, descriptor.nativeCancellation);
}

/** A `selected-report-read/v2` envelope for the registered report (the payload Mission Control sends). */
function readEnvelope(
  session: Session,
  payload: Record<string, unknown>,
  options: { readonly upstream?: readonly Ref[]; readonly requestId?: string } = {},
): OperationEnvelope {
  return envelopeFor(session, {
    operation: "knowledge.read",
    payload: payload as unknown as JsonValue,
    upstream: options.upstream ?? [payload.report as Ref],
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  });
}

/** Invoke a read, wait for its terminal handle and return the parsed, exact package manifest. */
async function readPackage(
  driver: Driver,
  envelope: OperationEnvelope,
): Promise<{ readonly manifest: ResearchReportPackage; readonly operationId: string }> {
  const handle = (await driver.invoke(envelope)) as { operationId: string };
  const status = await driver.terminal(handle.operationId);
  assert.equal(status.state, "succeeded");
  assert.ok(status.resultRef, "the read names its package");
  assert.equal(status.resultRef.version, "research-report-package.v2");
  const bytes = await driver.artifact(status.resultRef);
  assert.equal(digestBytes(bytes), status.resultRef.digest);
  const manifest = ResearchReportPackageSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  return { manifest, operationId: handle.operationId };
}

/** OVE-204: a served `knowledge.read_intent` is one recorded operation row on the backend's own store. */
async function readIntentRecorded(session: Session): Promise<void> {
  const driver = await session.driver();
  const payload = {
    schemaVersion: "knowledge-read-intent-request.v1",
    purpose: "conformance",
    operations: [{ opId: "where", kind: "schema_search", query: "entity", limit: 3 }],
  } as JsonValue;
  const read = (body: JsonValue, requestId: string) =>
    envelopeFor(session, {
      operation: "knowledge.read_intent",
      payload: body,
      nativeContract: READ_INTENT_CONTRACT,
      requestId,
    });
  const requestId = `read-intent-${randomUUID()}`;
  const answer = KnowledgeReadIntentResultSchema.parse(await driver.invoke(read(payload, requestId)));
  assert.match(answer.operationId, /^op-read_intent-[0-9a-f]{32}$/);
  assert.equal(answer.retainedRef, null);
  const row = await driver.backend.research().operations.get(session.scope, answer.operationId);
  assert.ok(row, "the read is recorded");
  assert.equal(row.operation, "knowledge.read_intent");
  assert.equal(row.requestId, requestId);
  assert.deepEqual(row.request, { operation: "knowledge.read_intent", readIntent: payload });
  assert.equal(row.requestDigest, digestCanonical({ operation: "knowledge.read_intent", readIntent: payload }));
  assert.equal(row.runId, null);
  assert.equal(row.subject, null);
  assert.equal(row.status.state, "succeeded");
  assert.equal(row.status.resultRef, null);
  // A replay of the same request answers the same operation; another request under the id conflicts.
  const replay = KnowledgeReadIntentResultSchema.parse(await driver.invoke(read(payload, requestId)));
  assert.equal(replay.operationId, answer.operationId);
  const other = { ...(payload as Record<string, JsonValue>), purpose: "conformance_other" } as JsonValue;
  assert.equal(await refusedCode(driver.invoke(read(other, requestId))), "EFFECT_CONFLICT");
  // `persist` freezes the result document into the backend's custody: retainedRef is the row's resultRef.
  const persisted = { ...(payload as Record<string, JsonValue>), persist: true } as JsonValue;
  const kept = KnowledgeReadIntentResultSchema.parse(
    await driver.invoke(read(persisted, `read-intent-${randomUUID()}`)),
  );
  assert.ok(kept.retainedRef, "persist names the retained result");
  const keptRow = await driver.backend.research().operations.get(session.scope, kept.operationId);
  assert.deepEqual(keptRow?.status.resultRef, kept.retainedRef);
  const bytes = await driver.artifact(kept.retainedRef);
  assert.equal(digestBytes(bytes), kept.retainedRef.digest);
  assert.deepEqual(JSON.parse(Buffer.from(bytes).toString("utf8")), { ...kept, retainedRef: null });
}

async function reportRegisterRead(session: Session): Promise<void> {
  const driver = await session.driver();
  const { receipt, report, kase } = await session.register();
  assert.equal(receipt.outcome, "applied");
  assert.equal(report.kind, "report");
  if (driver.backend.capabilities.has("native_receipt_lookup")) {
    assert.deepEqual(await driver.receipt(receipt.effect.effectKey), { disposition: "found", receipt });
  }
  // The whole exact revision: body and ledger byte for byte, every assertion and evidence member with its record.
  const payload = { report, exact: true, purpose: "dependent_input", selection: { mode: "revision" } };
  const { manifest } = await readPackage(driver, readEnvelope(session, payload));
  assert.deepEqual(manifest.report, report);
  assert.equal(manifest.purpose, "dependent_input");
  assert.equal(manifest.request, digestCanonical(payload as unknown as JsonValue));
  assert.ok(manifest.body && manifest.ledger, "a revision read carries body and ledger");
  assert.equal(digestBytes(await driver.artifact(manifest.body.artifact)), manifest.body.digest);
  assert.equal(digestBytes(await driver.artifact(manifest.ledger.artifact)), manifest.ledger.digest);
  assert.deepEqual(
    manifest.assertions.map((member) => member.handle.id),
    kase.assertions.map((assertion) => assertion.id).sort(),
  );
  assert.ok(manifest.evidence.length > 0, "the revision's evidence is delivered");
  const fragments = new Set(kase.fragments.map((fragment) => fragment.id));
  for (const member of manifest.evidence) assert.ok(fragments.has(member.handle.id), member.handle.id);
  // Another revision of the same report is not served as this one.
  const other = { ...report, id: `${report.id}-other`, digest: digestBytes("another revision") };
  assert.deepEqual(await refusedWith(driver.invoke(readEnvelope(session, { ...payload, report: other }))), [
    "EXACT_REVISION_UNAVAILABLE",
    "revision_unavailable",
  ]);
  await registrationWritesNothingOnRefusal(session);
}

/** One `report.register` envelope of an evidence-report case under its own report id. */
function registrationEnvelope(
  session: Session,
  kase: ReturnType<typeof reportKindCases>[number],
  reportId: string,
  structuredBody: unknown = kase.body,
  effectKey?: string,
  report: Readonly<Record<string, unknown>> = {},
): OperationEnvelope {
  return envelopeFor(session, {
    operation: "report.register",
    ...(effectKey === undefined ? {} : { effectKey }),
    payload: JSON.parse(
      JSON.stringify({
        task: kase.task,
        fragments: kase.fragments,
        assertions: kase.assertions,
        supportSets: kase.supportSets,
        report: {
          reportId,
          revision: 1,
          kind: "evidence_report",
          structuredBody,
          timeCoverage: { world: null, observed: null, knowledgeHead: null },
          supersedes: null,
          ...report,
        },
      }),
    ) as JsonValue,
  });
}

/**
 * OVE-169 W1 D19: a refused registration writes nothing. The producer's corrected retry carries the same record ids
 * with other assertion bytes (Mission Control binds each effect's originating origin as the assertions' producer), so
 * any record an earlier refusal left behind would collide (`ASSERTION_CONFLICT`, an internal error before). A genuine
 * collision with a registered record is a typed `EFFECT_CONFLICT / record_id_conflict`, never `INTERNAL`.
 */
async function registrationWritesNothingOnRefusal(session: Session): Promise<void> {
  const sibling = session.sibling();
  const driver = await sibling.driver();
  const caseFor = (invocationId: string) => {
    const kase = reportKindCases(sibling.scope.tenant, sibling.scope.binding, {
      ...sibling.origin,
      invocationId,
    }).find((candidate) => candidate.kindId === "evidence_report");
    assert.ok(kase, "evidence_report fixture");
    return kase;
  };
  const first = caseFor("inv-d19-first");
  const broken = JSON.parse(JSON.stringify(first.body)) as { sections: { id: string }[] };
  (broken.sections[0] as { id: string }).id = "not a local id!";
  assert.equal(
    await refusedCode(driver.invoke(registrationEnvelope(sibling, first, "report-d19", broken))),
    "INVALID_ENVELOPE",
  );
  // Review B1: refusals only the revision record or the superseded revision would have raised, after the evidence
  // was written, now refuse before any write too (each under yet other assertion bytes).
  const head = caseFor("inv-d19-head");
  const badHead = { timeCoverage: { world: null, observed: null, knowledgeHead: "not an id!" } };
  assert.equal(
    await refusedCode(driver.invoke(registrationEnvelope(sibling, head, "report-d19", head.body, undefined, badHead))),
    "INVALID_ENVELOPE",
  );
  const ghost = caseFor("inv-d19-ghost");
  const unknownParent = {
    supersedes: {
      kind: "report",
      id: "report-never-registered-r1",
      version: "research-report.v2",
      digest: digestBytes("never registered"),
      tenant: sibling.scope.tenant,
      binding: sibling.scope.binding,
    },
  };
  assert.deepEqual(
    await refusedWith(
      driver.invoke(registrationEnvelope(sibling, ghost, "report-d19", ghost.body, undefined, unknownParent)),
    ),
    ["NOT_FOUND", "supersedes_unknown"],
  );
  // The corrected retry: same ids, other assertion bytes (another originating invocation). Nothing collides.
  const retry = caseFor("inv-d19-retry");
  const applied = OperationReceiptSchema.parse(await driver.invoke(registrationEnvelope(sibling, retry, "report-d19")));
  assert.equal(applied.outcome, "applied");
  // The identical registration again (same effect) is the same receipt (idempotent), not a conflict.
  const again = registrationEnvelope(sibling, retry, "report-d19", retry.body, applied.effect.effectKey);
  assert.deepEqual(OperationReceiptSchema.parse(await driver.invoke(again)), applied);
  // Another registration reusing the assertion id with other bytes: a typed conflict naming the record.
  const other = caseFor("inv-d19-other");
  const error = await refusal(driver.invoke(registrationEnvelope(sibling, other, "report-d19-other")));
  assert.equal(error.code, "EFFECT_CONFLICT");
  const details = error.details as { reason?: string; record?: string; id?: string } | null;
  assert.equal(details?.reason, "record_id_conflict");
  assert.equal(details?.record, "assertion");
  assert.equal(details?.id, (other.assertions[0] as { id: string }).id);
}

async function selectedRead(session: Session): Promise<void> {
  const driver = await session.driver();
  const { report } = await session.register();
  const whole = await readPackage(
    driver,
    readEnvelope(session, { report, exact: true, purpose: "dependent_input", selection: { mode: "revision" } }),
  );
  const assertion = whole.manifest.assertions[0]?.handle as Ref;
  const evidence = whole.manifest.evidence[0]?.handle as Ref;
  assert.ok(assertion && evidence, "the registered revision names an assertion and evidence");

  // Exactly the selected members, each with its exact handle and record; no body, no ledger; purpose recorded.
  const members = { mode: "members", assertions: [assertion], evidence: [evidence] };
  const payload = { report, exact: true, purpose: "evaluation_evidence", selection: members };
  const requestId = `read-members-${randomUUID()}`;
  const { manifest, operationId } = await readPackage(driver, readEnvelope(session, payload, { requestId }));
  assert.deepEqual(
    manifest.assertions.map((member) => member.handle),
    [assertion],
  );
  assert.deepEqual(
    manifest.evidence.map((member) => member.handle),
    [evidence],
  );
  assert.equal(manifest.body, null);
  assert.equal(manifest.ledger, null);
  assert.equal(manifest.purpose, "evaluation_evidence");
  assert.equal(manifest.request, selectedReadDigest(payload as never));
  assert.deepEqual(manifest.assertions[0]?.record, whole.manifest.assertions[0]?.record);
  const recorded = await driver.backend.research().operations.get(session.scope, operationId);
  assert.equal(
    (recorded?.request as { read?: { purpose?: string } } | undefined)?.read?.purpose,
    "evaluation_evidence",
  );
  // The same request id with another selection is another read.
  const widened = { ...payload, selection: { mode: "revision" } };
  assert.equal(await refusedCode(driver.invoke(readEnvelope(session, widened, { requestId }))), "EFFECT_CONFLICT");

  const refusals: [string, Record<string, unknown>, [string, unknown]][] = [
    ["an undeclared purpose", { report, exact: true, selection: members }, ["INVALID_ENVELOPE", "purpose_undeclared"]],
    ["a malformed purpose", { ...payload, purpose: "Evaluation Evidence" }, ["INVALID_ENVELOPE", "purpose_undeclared"]],
    [
      "a bare id",
      { ...payload, selection: { ...members, assertions: [assertion.id] } },
      ["INVALID_ENVELOPE", "selection_invalid"],
    ],
    [
      "an assertion handle as evidence",
      { ...payload, selection: { ...members, evidence: [assertion] } },
      ["INVALID_ENVELOPE", "selection_invalid"],
    ],
    [
      "another tenant's handle",
      { ...payload, selection: { ...members, assertions: [{ ...assertion, tenant: randomUUID() }] } },
      ["SCOPE_DENIED", "handle_out_of_scope"],
    ],
    [
      "an unknown assertion",
      { ...payload, selection: { ...members, assertions: [{ ...assertion, id: `${assertion.id}-unknown` }] } },
      ["NOT_FOUND", "member_unknown"],
    ],
    [
      "unknown evidence",
      { ...payload, selection: { ...members, evidence: [{ ...evidence, id: `${evidence.id}-unknown` }] } },
      ["NOT_FOUND", "member_unknown"],
    ],
    [
      "an edited assertion revision",
      { ...payload, selection: { ...members, assertions: [{ ...assertion, digest: digestBytes("edited") }] } },
      ["EXACT_REVISION_UNAVAILABLE", "member_revision_mismatch"],
    ],
  ];
  for (const [what, candidate, expected] of refusals) {
    assert.deepEqual(
      await refusedWith(driver.invoke(readEnvelope(session, candidate, { upstream: [report] }))),
      expected,
      what,
    );
  }
  const other = { ...report, id: `${report.id}-other`, digest: digestBytes("another revision") };
  assert.deepEqual(
    await refusedWith(driver.invoke(readEnvelope(session, payload, { upstream: [other] }))),
    ["INVALID_ENVELOPE", "report_upstream_mismatch"],
    "payload and upstream report differ",
  );
  // The legacy contract (no purpose, no selection) is no longer served.
  const legacy = envelopeFor(session, {
    operation: "knowledge.read",
    payload: { report, exact: true } as unknown as JsonValue,
    upstream: [report],
    nativeContract: { name: "research-report-package", version: "v1" },
  });
  assert.equal(await refusedCode(driver.invoke(legacy)), "SCHEMA_UNSUPPORTED");
}

/** Use classes under which every official use waits on a qualified review (test-owned K08 data, WI-03). */
const REVIEWED_USES = new SourceAuthorityCatalog(
  [],
  {
    schemaVersion: "research-use-classes.v1",
    id: "use-classes",
    version: "1.0.0",
    classes: [
      { class: "official", audiences: ["official"], uses: [], reviewAtRisk: ["low", "medium", "high", "critical"] },
    ],
    defaultClass: "internal",
  },
  null,
);

function evaluatorOrigin(session: Session, subject: string): Origin {
  const mission = session.origin.mission as NonNullable<Origin["mission"]>;
  return {
    ...session.origin,
    subject,
    mission: { ...mission, operationId: `op-${subject}` },
    invocationId: `inv-${randomUUID()}`,
  };
}

const JUDGE: CredentialEvaluation = {
  role: "judge",
  credentialRef: "judge.default",
  provider: "family-judge",
  family: "family-judge",
};
const SECOND_JUDGE: CredentialEvaluation = { ...JUDGE, role: "second_family_judge", credentialRef: "judge.second" };
const AUDITOR: CredentialEvaluation = {
  role: "auditor",
  credentialRef: "auditor.default",
  provider: null,
  family: null,
};
const REVIEWER: CredentialEvaluation = {
  role: "human_reviewer",
  credentialRef: "reviewer.grant",
  provider: null,
  family: null,
};

/** One registered evidence report in its own tenant, served by a backend deciding under {@link REVIEWED_USES}. */
async function reviewedRun(session: Session) {
  const sibling = session.sibling();
  sibling.primary = new Driver(sibling, await sibling.create({ authority: REVIEWED_USES }));
  const registered = await sibling.register();
  return { sibling, driver: sibling.primary, ...registered };
}

async function terminalDocument(driver: Driver, handle: unknown): Promise<Record<string, unknown>> {
  const status = await driver.terminal((handle as { operationId: string }).operationId);
  assert.equal(status.state, "succeeded", `${status.state}: ${JSON.stringify(status.error)}`);
  assert.ok(status.resultRef, "the operation names its result document");
  const bytes = await driver.artifact(status.resultRef);
  assert.equal(digestBytes(bytes), status.resultRef.digest);
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
}

function judgeObservation(
  run: Awaited<ReturnType<typeof reviewedRun>>,
  input: { id: string; role: "judge" | "second_family_judge"; verdict: "full_support" | "insufficient_evidence" },
) {
  const { kase, sibling } = run;
  const set = kase.supportSets[0] as (typeof kase.supportSets)[number];
  const assertion = kase.assertions[0] as (typeof kase.assertions)[number];
  return fixtureSupportObservation({
    tenant: sibling.scope.tenant,
    binding: sibling.scope.binding,
    id: input.id,
    set,
    fragment: kase.fragments[0] as (typeof kase.fragments)[number],
    role: input.role,
    verdict: input.verdict,
    qualifiersDigest: qualifiersDigest(assertion.qualifiers),
  });
}

/** The auditor's independent discovery over the exact frozen body (the scripted double stands in for the model). */
async function censusDiscovery(run: Awaited<ReturnType<typeof reviewedRun>>): Promise<JsonValue> {
  const research = run.driver.backend.research();
  const context = await research.binding.loadRunContext(run.sibling.scope, run.runId);
  const revision = context.report?.revision;
  assert.ok(revision, "the run holds its revision");
  const bytes = await research.binding.custody.get(run.sibling.scope, revision.body);
  const frozen = renderReport(run.kase.body as never);
  const found = await new ScriptedAuditorDiscovery(EVIDENCE_REPORT_SCRIPT).discover(run.sibling.scope, {
    task: context.task,
    report: run.report,
    body: { ref: revision.body, bytes, text: Buffer.from(bytes).toString("utf8") },
    units: frozen.units,
    evidence: [],
    assertions: context.assertions,
  });
  return JSON.parse(JSON.stringify(found)) as JsonValue;
}

function assessEnvelope(session: Session, operation: OperationName, payload: unknown, requestId?: string) {
  return envelopeFor(session, {
    operation,
    payload: JSON.parse(JSON.stringify(payload)) as JsonValue,
    ...(requestId ? { requestId } : {}),
  });
}

async function trustedAssessment(session: Session): Promise<void> {
  // ---------------------------------------------------------------- run B: a clean report waits on review
  const run = await reviewedRun(session);
  const { sibling, driver, report, kase } = run;
  const judge = { origin: evaluatorOrigin(sibling, "conformance-judge"), evaluation: JUDGE };
  const auditor = { origin: evaluatorOrigin(sibling, "conformance-auditor"), evaluation: AUDITOR };

  // OVE-169: the independent evaluator's context read (evaluation-context-read/v1): exact revision, digest-checked,
  // role-scoped (the auditor gets no support sets or fragments; nobody the ledger), never to the producer.
  const contextRead = () =>
    envelopeFor(sibling, {
      operation: "knowledge.read",
      nativeContract: EVALUATION_CONTEXT_CONTRACT,
      payload: { schema: "evaluation-context-read.v1", report } as unknown as JsonValue,
    });
  assert.deepEqual(await refusedWith(driver.invoke(contextRead(), { origin: sibling.origin, evaluation: JUDGE })), [
    "INDEPENDENCE_UNPROVEN",
    "evaluator_is_producer",
  ]);
  assert.deepEqual(await refusedWith(driver.invoke(contextRead(), { origin: judge.origin })), [
    "ORIGIN_MISMATCH",
    "evaluator_role_required",
  ]);
  const judged = EvaluationContextSchema.parse(
    await terminalDocument(driver, await driver.invoke(contextRead(), judge)),
  );
  assert.equal(judged.role, "judge");
  assert.deepEqual(judged.report, report);
  assert.equal(digestBytes(judged.body.text), judged.body.digest);
  assert.ok(judged.units.length > 0 && judged.assertions.length > 0);
  assert.ok((judged.supportSets ?? []).length > 0 && (judged.evidence ?? []).length > 0);
  assert.deepEqual([judged.task.policy, judged.task.rubric], [kase.task.policy, kase.task.rubric]);
  assert.ok(!("ledger" in judged), "no evaluator reads the producer ledger");
  const auditorContext = EvaluationContextSchema.parse(
    await terminalDocument(driver, await driver.invoke(contextRead(), auditor)),
  );
  assert.equal(auditorContext.role, "auditor");
  assert.equal(auditorContext.supportSets, null);
  assert.equal(auditorContext.evidence, null);
  assert.deepEqual(auditorContext.units, judged.units);

  const observe = (observations: unknown[], census: unknown = null, requestId?: string) =>
    assessEnvelope(
      sibling,
      "report.observe",
      { schema: "report-observation.v1", report, observations, census },
      requestId,
    );
  const supported = judgeObservation(run, { id: "obs-judge-trusted", role: "judge", verdict: "full_support" });

  // The producer's own subject cannot act as an evaluator, whatever grant it presents.
  assert.deepEqual(
    await refusedWith(driver.invoke(observe([supported]), { origin: sibling.origin, evaluation: JUDGE })),
    ["INDEPENDENCE_UNPROVEN", "evaluator_is_producer"],
  );
  // The role is the credential's: a payload naming another role conflicts.
  assert.deepEqual(
    await refusedWith(driver.invoke(observe([supported]), { origin: judge.origin, evaluation: SECOND_JUDGE })),
    ["ORIGIN_MISMATCH", "evaluator_identity_conflict"],
  );
  // S5: a judge is a model on exactly the granted provider and family.
  const deterministicJudge = {
    ...supported,
    evaluator: { ...supported.evaluator, kind: "deterministic", provider: null, family: null, model: null },
  };
  assert.deepEqual(await refusedWith(driver.invoke(observe([deterministicJudge]), judge)), [
    "ORIGIN_MISMATCH",
    "evaluator_identity_conflict",
  ]);
  const otherFamily = { ...supported, evaluator: { ...supported.evaluator, family: "family-other" } };
  assert.deepEqual(await refusedWith(driver.invoke(observe([otherFamily]), judge)), [
    "ORIGIN_MISMATCH",
    "evaluator_identity_conflict",
  ]);
  const ungranted = { origin: judge.origin, evaluation: { ...JUDGE, provider: null, family: null } };
  assert.deepEqual(await refusedWith(driver.invoke(observe([supported]), ungranted)), [
    "ORIGIN_MISMATCH",
    "evaluator_identity_conflict",
  ]);
  const census = await censusDiscovery(run);
  assert.deepEqual(await refusedWith(driver.invoke(observe([], census), judge)), [
    "ORIGIN_MISMATCH",
    "census_requires_auditor",
  ]);
  const observeId = `observe-${randomUUID()}`;
  const observed = await terminalDocument(driver, await driver.invoke(observe([supported], null, observeId), judge));
  assert.equal(observed.role, "judge");
  assert.equal((observed.observations as unknown[]).length, 1);
  // Same request id, same bytes and grant: the recorded handle. Other bytes under that id: EFFECT_CONFLICT.
  const replay = (await driver.invoke(observe([supported], null, observeId), judge)) as { operationId: string };
  assert.equal(
    replay.operationId,
    ((await driver.invoke(observe([supported], null, observeId), judge)) as { operationId: string }).operationId,
  );
  const other = judgeObservation(run, { id: "obs-judge-other", role: "judge", verdict: "full_support" });
  assert.equal(await refusedCode(driver.invoke(observe([other], null, observeId), judge)), "EFFECT_CONFLICT");
  // N2: under a new request id the judge still cannot add another verdict to the run (no judge shopping).
  assert.deepEqual(await refusedWith(driver.invoke(observe([other]), judge)), [
    "EFFECT_CONFLICT",
    "evaluator_role_observed",
  ]);
  const audited = await terminalDocument(driver, await driver.invoke(observe([], census), auditor));
  assert.equal((audited.census as { status: string }).status, "assessed");

  const host = {}; // the host's own credential (no evaluator grant)
  const useRequest = {
    schema: "report-use.v1",
    report,
    subject: report,
    use: kase.task.use,
    audience: "official",
    purpose: "official",
    boundEffectDigest: digestCanonical({ report: report.digest, use: kase.task.use }),
    targetSchema: "research-report.v2",
    normalizedValues: {},
    policy: kase.task.policy,
    rubric: kase.task.rubric,
    expiresAt: null,
  };
  assert.deepEqual(await refusedWith(driver.invoke(assessEnvelope(sibling, "report.decide", useRequest), host)), [
    "EXACT_REVISION_UNAVAILABLE",
    "run_not_sealed",
  ]);
  const sealRequest = {
    schema: "report-seal.v1",
    report,
    build: { buildId: "build-conformance", runtime: "node24", dirty: true },
  };
  const sealed = await terminalDocument(
    driver,
    await driver.invoke(assessEnvelope(sibling, "report.seal", sealRequest)),
  );
  const context = await driver.backend.research().binding.loadRunContext(sibling.scope, run.runId);
  assert.ok(context.run, "the seal wrote the exact VerificationRun");
  assert.deepEqual(sealed.run, recordRef("verification_run", context.run));
  assert.equal(sealed.head, context.head);
  // A second seal request answers the same exact run (the seal is never re-made).
  const resealed = await terminalDocument(
    driver,
    await driver.invoke(assessEnvelope(sibling, "report.seal", sealRequest)),
  );
  assert.deepEqual(resealed.run, sealed.run);
  assert.deepEqual(await refusedWith(driver.invoke(observe([other]), judge)), ["EFFECT_CONFLICT", "run_sealed"]);

  // B2 crash windows. (a) The decision was recorded but the operation never started (a crash after the
  // coordinator wrote it): the K01 decide reads it through by its deterministic id. (b) The operation started
  // but never reached `succeeded`: the same request id finishes it; concurrent callers converge on one handle.
  const research0 = driver.backend.research();
  const crashed = await research0.coordinator.decideReportUse(sibling.scope, {
    runId: run.runId,
    use: useRequest.use,
    audience: useRequest.audience,
    boundEffectDigest: useRequest.boundEffectDigest as never,
    targetSchema: useRequest.targetSchema,
    normalizedValues: {},
    policy: useRequest.policy,
    rubric: useRequest.rubric,
    expiresAt: null,
  });
  const decideId = `decide-${randomUUID()}`;
  const decideEnvelope = assessEnvelope(sibling, "report.decide", useRequest, decideId);
  const requestValue = {
    operation: "report.decide",
    input: decideEnvelope.input?.inlinePayload,
    caller: sibling.origin.subject,
    evaluation: null,
  } as unknown as JsonValue;
  const operationId = `op-report-decide-${digestCanonical({
    tenant: sibling.scope.tenant,
    operation: "report.decide",
    requestId: decideId,
  } as JsonValue).slice(7, 39)}`;
  await research0.operations.start(sibling.scope, {
    operationId,
    operation: "report.decide",
    requestId: decideId,
    request: requestValue,
    requestDigest: digestCanonical(requestValue),
    runId: run.runId,
    subject: report,
    retryAfterMs: 100,
    at: "2026-10-27T10:00:02Z",
  });
  const converged = await Promise.all([
    driver.invoke(assessEnvelope(sibling, "report.decide", useRequest, decideId)),
    driver.invoke(assessEnvelope(sibling, "report.decide", useRequest, decideId)),
  ]);
  assert.equal(
    (converged[0] as { operationId: string }).operationId,
    (converged[1] as { operationId: string }).operationId,
  );
  const decided = await terminalDocument(driver, converged[0]);
  const decision = decided.decision as Ref<"use_decision">;
  assert.deepEqual(decision, crashed.ref, "the recorded decision is read through, never re-minted");
  const document = decided.document as { disposition: string; conditions: string[]; boundEffectDigest: string };
  assert.equal(document.disposition, "admitted");
  assert.ok(document.conditions.includes("review_required"), document.conditions.join(", "));
  assert.equal(decided.reviewPending, true);
  const resolve = (decisionRef: Ref) =>
    assessEnvelope(sibling, "decision.resolve", { schema: "decision-resolve.v1", decision: decisionRef });
  const pending = DecisionResolutionSchema.parse(
    await terminalDocument(driver, await driver.invoke(resolve(decision))),
  );
  assert.deepEqual(pending.admissibility, { status: "held", reason: "review_required" });
  assert.equal(pending.useClass, "official");
  assert.equal(pending.reviewPending, true);

  const reviewer = { origin: evaluatorOrigin(sibling, "reviewer-1"), evaluation: REVIEWER };
  const reviewRequest = {
    schema: "report-review.v1",
    decision,
    outcome: "approve",
    boundEffectDigest: document.boundEffectDigest,
    qualifiersDigest: null,
    rationale: "the sealed evidence supports every required obligation",
  };
  const review = (body: unknown, requestId?: string) => assessEnvelope(sibling, "report.review", body, requestId);
  assert.deepEqual(await refusedWith(driver.invoke(review(reviewRequest), reviewer)), [
    "SCOPE_DENIED",
    "reviewer_not_qualified",
  ]);
  const research = driver.backend.research();
  const grant = { uses: ["*"], audiences: ["official"], reportKinds: ["evidence_report"] };
  await research.review.grantReviewer(sibling.scope, { reviewerId: "reviewer-1", scope: grant, grantedBy: "operator" });
  await research.review.grantReviewer(sibling.scope, { reviewerId: "reviewer-2", scope: grant, grantedBy: "operator" });
  // OVE-169 W1: reviewer independence is KS's own check at review time (assertIndependent reads the producer from the
  // decision's stored run context): the producer's subject is refused even holding a live reviewer grant.
  await research.review.grantReviewer(sibling.scope, {
    reviewerId: sibling.origin.subject,
    scope: grant,
    grantedBy: "operator",
  });
  const producerAsReviewer = { origin: evaluatorOrigin(sibling, sibling.origin.subject), evaluation: REVIEWER };
  assert.deepEqual(await refusedWith(driver.invoke(review(reviewRequest), producerAsReviewer)), [
    "INDEPENDENCE_UNPROVEN",
    "reviewer_is_producer",
  ]);
  const misSigned = { ...reviewRequest, boundEffectDigest: digestBytes("another effect") };
  assert.deepEqual(await refusedWith(driver.invoke(review(misSigned), reviewer)), [
    "STALE_DECISION",
    "review_binding_mismatch",
  ]);
  const reviewed = await terminalDocument(driver, await driver.invoke(review(reviewRequest), reviewer));
  const successor = reviewed.successor as Ref<"use_decision">;
  assert.notEqual(successor.id, decision.id);
  // Another reviewer's review of the superseded decision is stale; the same reviewer's replay answers its successor.
  const second = { origin: evaluatorOrigin(sibling, "reviewer-2"), evaluation: REVIEWER };
  assert.deepEqual(await refusedWith(driver.invoke(review(reviewRequest), second)), [
    "STALE_DECISION",
    "decision_superseded",
  ]);
  const replayed = await terminalDocument(driver, await driver.invoke(review(reviewRequest), reviewer));
  assert.deepEqual(replayed.successor, successor);

  // A fresh backend instance over the same store resolves the exact successor (durable, no process memory). A memory
  // store has no second instance over the same records; it resolves on the instance that holds them.
  const durable = session.entry.registration.describe().storageClass !== "memory";
  const restarted = durable ? new Driver(sibling, await sibling.create({ authority: REVIEWED_USES })) : driver;
  const current = DecisionResolutionSchema.parse(
    await terminalDocument(restarted, await restarted.invoke(resolve(decision))),
  );
  assert.deepEqual(current.current, successor);
  assert.equal(current.chain.length, 2);
  assert.deepEqual(current.admissibility, { status: "admitted", reason: null });
  assert.equal(current.reviewPending, false);

  // ---------------------------------------------------------------- run A: ungrounded disagreement holds
  const disputed = await reviewedRun(session);
  const judgeA = { origin: evaluatorOrigin(disputed.sibling, "conformance-judge"), evaluation: JUDGE };
  const secondA = { origin: evaluatorOrigin(disputed.sibling, "conformance-judge-2"), evaluation: SECOND_JUDGE };
  const auditorA = { origin: evaluatorOrigin(disputed.sibling, "conformance-auditor"), evaluation: AUDITOR };
  const observeA = (observations: unknown[], census: unknown = null) =>
    assessEnvelope(disputed.sibling, "report.observe", {
      schema: "report-observation.v1",
      report: disputed.report,
      observations,
      census,
    });
  await terminalDocument(
    disputed.driver,
    await disputed.driver.invoke(
      observeA([judgeObservation(disputed, { id: "obs-a-judge", role: "judge", verdict: "full_support" })]),
      judgeA,
    ),
  );
  await terminalDocument(
    disputed.driver,
    await disputed.driver.invoke(
      observeA([
        judgeObservation(disputed, {
          id: "obs-a-second",
          role: "second_family_judge",
          verdict: "insufficient_evidence",
        }),
      ]),
      secondA,
    ),
  );
  await terminalDocument(
    disputed.driver,
    await disputed.driver.invoke(observeA([], await censusDiscovery(disputed)), auditorA),
  );
  await terminalDocument(
    disputed.driver,
    await disputed.driver.invoke(
      assessEnvelope(disputed.sibling, "report.seal", { ...sealRequest, report: disputed.report }),
    ),
  );
  const heldDecision = await terminalDocument(
    disputed.driver,
    await disputed.driver.invoke(
      assessEnvelope(disputed.sibling, "report.decide", {
        ...useRequest,
        report: disputed.report,
        subject: disputed.report,
        purpose: "review_repair",
        policy: disputed.kase.task.policy,
        rubric: disputed.kase.task.rubric,
        boundEffectDigest: digestCanonical({ report: disputed.report.digest, use: kase.task.use }),
      }),
    ),
  );
  const held = heldDecision.document as { disposition: string; conditions: string[] };
  // Disagreement without contrary evidence holds; it never rejects.
  assert.equal(held.disposition, "held", held.conditions.join(", "));
  assert.ok(
    held.conditions.some((condition) => condition.startsWith("disputed_verdict")),
    held.conditions.join(", "),
  );
  const heldResolution = DecisionResolutionSchema.parse(
    await terminalDocument(
      disputed.driver,
      await disputed.driver.invoke(
        assessEnvelope(disputed.sibling, "decision.resolve", {
          schema: "decision-resolve.v1",
          decision: heldDecision.decision,
        }),
      ),
    ),
  );
  assert.equal(heldResolution.admissibility.status, "held");
  assert.equal(heldResolution.reviewPending, false);
}

async function applyReceipt(session: Session): Promise<void> {
  const driver = await session.driver();
  const prepared = await session.prepareApply("receipt");
  const receipt = OperationReceiptSchema.parse(await driver.invoke(prepared.envelope));
  assert.ok(["applied", "pending_dispatch"].includes(receipt.outcome), `outcome ${receipt.outcome}`);
  assert.equal(receipt.effect.boundEffectDigest, prepared.plan.boundEffectDigest);
  assert.equal(
    receipt.outcome === "pending_dispatch",
    session.entry.registration.describe().writeAtomicity === "marker_plus_outbox",
  );
  const found = await driver.receipt(prepared.effectKey);
  assert.equal(found.disposition, "found");
  assert.deepEqual(found.disposition === "found" ? found.receipt : null, receipt);
  assert.equal(await session.fixture.nativeWrites(session.scope, prepared.effectKey), 1);
  // A duplicate dispatch of the same effect answers the same receipt and writes nothing new.
  const again = { ...prepared.envelope, dispatchId: `dispatch-${randomUUID()}` };
  assert.deepEqual(await driver.invoke(again), receipt);
  assert.equal(await session.fixture.nativeWrites(session.scope, prepared.effectKey), 1);
}

async function lostAckReconciliation(session: Session): Promise<void> {
  const prepared = await session.prepareApply("lost");
  // Instance A: the native commit lands, then the protocol receipt write is lost (the executor dies before it).
  const a = await session.create();
  const ledger = a.effects();
  let lost: OperationReceipt | null = null;
  const losing: EffectLedger = {
    bind: (scope, effect) => ledger.bind(scope, effect),
    lookup: (scope, effectKey) => ledger.lookup(scope, effectKey),
    ...(ledger.journal ? { journal: ledger.journal.bind(ledger) } : {}),
    ...(ledger.journaled ? { journaled: ledger.journaled.bind(ledger) } : {}),
    record: async (_scope, receipt) => {
      lost = receipt;
      throw new Error("PROTOCOL_RECEIPT_WRITE_LOST");
    },
  };
  const crashing = new Driver(session, { ...a, effects: () => losing });
  assert.equal(await refusedCode(crashing.invoke(prepared.envelope)), "INTERNAL");
  const original = lost as OperationReceipt | null;
  assert.ok(original, "the native port answered before the protocol receipt write");
  session.saw(original);
  assert.equal(await session.fixture.nativeWrites(session.scope, prepared.effectKey), 1, "the native commit landed");
  await a.close();
  // Instance B (a restart over the same store): no protocol receipt yet. A journaling backend (component 2.5.0, WI-05)
  // reconstructs the ORIGINAL dispatch's receipt from its journal and the native read-back, even on a read-only lookup;
  // otherwise the redispatch reconciles to the native one. Either way nothing is written natively again.
  const b = new Driver(session, await session.create());
  const before = await b.receipt(prepared.effectKey);
  const journals = ledger.journal !== undefined && b.backend.apply().reconstruct !== undefined;
  if (journals) assert.equal(before.disposition, "found", "receipt.get reconstructs the lost protocol receipt");
  else
    assert.ok(["not_found", "unresolved"].includes(before.disposition), `before reconciliation: ${before.disposition}`);
  const redispatch = { ...prepared.envelope, dispatchId: `dispatch-${randomUUID()}` };
  const reconciled = OperationReceiptSchema.parse(await b.invoke(redispatch));
  assert.deepEqual(reconciled.nativeReceiptRef, original.nativeReceiptRef, "the original native receipt");
  assert.equal(reconciled.outcome, original.outcome);
  assert.equal(reconciled.effect.boundEffectDigest, original.effect.boundEffectDigest);
  if (journals) {
    // The same original caller/effect receipt: the dispatch, envelope digest, caller origin and sequence of the lost one.
    assert.equal(reconciled.effect.dispatchId, original.effect.dispatchId, "the original dispatch");
    assert.equal(reconciled.effect.envelopeDigest, original.effect.envelopeDigest);
    assert.deepEqual(reconciled.effect.currentCallerOrigin, original.effect.currentCallerOrigin);
    assert.equal(reconciled.effect.dispatchSequence, original.effect.dispatchSequence);
    assert.deepEqual(reconciled.details, original.details, "the same native view");
    assert.deepEqual(before.disposition === "found" ? before.receipt : null, reconciled);
  }
  assert.equal(await session.fixture.nativeWrites(session.scope, prepared.effectKey), 1, "no duplicate native write");
  const after = await b.receipt(prepared.effectKey);
  assert.equal(after.disposition, "found");
  assert.deepEqual(after.disposition === "found" ? after.receipt : null, reconciled);
}

async function revocationBeforeDispatch(session: Session): Promise<void> {
  const driver = await session.driver();
  const prepared = await session.prepareApply("revoked");
  const epoch = await driver.backend.revocation().epoch(session.scope);
  await session.fixture.revoke(session.scope);
  assert.ok((await driver.backend.revocation().epoch(session.scope)) > epoch, "the revocation advanced the epoch");
  assert.equal(await refusedCode(driver.invoke(prepared.envelope)), "STALE_DECISION");
  assert.equal(await session.fixture.nativeWrites(session.scope, prepared.effectKey), 0, "nothing written");
  assert.equal((await driver.receipt(prepared.effectKey)).disposition, "not_found");
  // A queued dispatch (outbox backends) stopped before the consumer claims it reads `revoked`, never `applied`.
  if (driver.backend.capabilities.has("delivery")) {
    const stopDispatch = session.fixture.stopDispatch;
    assert.ok(stopDispatch, "a delivery backend's fixture stops a queued dispatch");
    const queued = await session.prepareApply("stopped");
    const receipt = OperationReceiptSchema.parse(await driver.invoke(queued.envelope));
    assert.equal(receipt.outcome, "pending_dispatch");
    await stopDispatch.call(session.fixture, session.scope, queued.effectKey);
    const lookup = await driver.receipt(queued.effectKey);
    assert.equal(lookup.disposition === "found" ? lookup.delivery?.state : lookup.disposition, "revoked");
  }
}

/** Every object a response holds is plain JSON data: no class instance (a pg Pool/Client, a Neo4j Driver) crosses. */
function assertPlainJson(value: unknown, path = "$"): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  assert.ok(typeof value === "object", `${path} is ${typeof value}`);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertPlainJson(item, `${path}[${index}]`);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  assert.ok(
    prototype === Object.prototype || prototype === null,
    `${path} is a ${(value as object).constructor?.name ?? "non-plain"} instance`,
  );
  for (const [key, item] of Object.entries(value)) assertPlainJson(item, `${path}.${key}`);
}

async function noDriverType(session: Session): Promise<void> {
  assert.ok(session.responses.length > 0, "the session recorded responses");
  assert.deepEqual(session.foreign, [], "only K01 refusals cross the service");
  for (const [index, response] of session.responses.entries()) {
    assertPlainJson(response, `response[${index}]`);
    const details = (response as { details?: unknown } | null)?.details;
    if (details !== undefined) assertPlainJson(details, `response[${index}].details`);
  }
  assertPlainJson(session.entry.registration.describe());
}

/** A minimal valid K01 envelope (a read), used only to show that adding a data class field breaks it. */
const EXAMPLE_ENVELOPE = {
  protocolVersion: "ks.knowledge_operation.v2",
  requestId: "req-data-class-premise",
  dispatchId: "dispatch-data-class-premise",
  tenant: "00000000-0000-7000-8000-0000000000aa",
  application: "ai-engineer",
  binding: "in-memory",
  operation: "knowledge.describe",
  effect: null,
  target: { handle: null, effectKey: null },
  cancelRequestId: null,
  input: null,
  governors: {
    deadline: "2099-01-01T00:00:00Z",
    maxItems: 1,
    partialResults: "forbid",
    budget: { calls: 0, tokens: 0, costUsd: "0" },
  },
  requiredCapabilities: [],
  pinnedSchema: null,
  issuedAt: "2026-10-27T10:00:01Z",
};

/** The premise only: the strict K01 envelope has no data class field, and an envelope naming one does not parse. */
function dataClassPremise(): void {
  const keys = Object.keys((OperationEnvelopeSchema as unknown as { shape?: object }).shape ?? {});
  assert.ok(keys.length > 0, "the envelope schema exposes its fields");
  assert.ok(!keys.some((key) => /data.?class|classification|sensitivity/i.test(key)), "no envelope data class field");
  const parsed = OperationEnvelopeSchema.safeParse(EXAMPLE_ENVELOPE);
  assert.ok(parsed.success, `the example envelope is valid: ${parsed.error?.message ?? ""}`);
  const named = OperationEnvelopeSchema.safeParse({ ...EXAMPLE_ENVELOPE, dataClass: "restricted" });
  assert.equal(named.success, false, "an envelope naming a data class is refused unread");
}

function declaration(entry: BackendConformance): void {
  const descriptor = entry.registration.describe();
  assert.equal(descriptor.id, entry.registration.id);
  assert.equal(new Set(descriptor.capabilities).size, descriptor.capabilities.length, "each capability once");
  for (const capability of descriptor.capabilities) assert.ok(BACKEND_CAPABILITIES.includes(capability), capability);
  for (const conditional of descriptor.conditionalCapabilities) {
    assert.ok(BACKEND_CAPABILITIES.includes(conditional.capability), conditional.capability);
    assert.ok(Object.hasOwn(CAPABILITY_CONDITIONS, conditional.condition), `known condition ${conditional.condition}`);
    assert.ok(!descriptor.capabilities.includes(conditional.capability), `${conditional.capability} declared once`);
  }
  const may = mayServe(entry);
  assert.ok(!may.has("readback"), "no backend port serves readback");
  assert.equal(descriptor.nativeContract !== null, may.has("apply"), "apply ⇔ nativeContract");
  if (may.has("apply")) {
    // An apply needs the receipt-first ledger and the epoch it is admitted against.
    assert.ok(descriptor.capabilities.includes("native_receipt_lookup"), "apply implies native_receipt_lookup");
    assert.ok(descriptor.capabilities.includes("revocation"), "apply implies revocation");
  }
  for (const exception of entry.exceptions) {
    assert.notEqual(exception.reason, "", `${exception.check} names its reason`);
    assert.ok(exception.evidence.length > 0, `${exception.check} cites evidence`);
  }
}

const RUN: Readonly<
  Record<Exclude<ConformanceCheck, "declaration" | "data_class_premise">, (s: Session) => Promise<void>>
> = {
  describe_honesty: describeHonesty,
  report_register_read: reportRegisterRead,
  selected_read: selectedRead,
  trusted_assessment: trustedAssessment,
  read_intent_recorded: readIntentRecorded,
  apply_receipt: applyReceipt,
  lost_ack_reconciliation: lostAckReconciliation,
  revocation_before_dispatch: revocationBeforeDispatch,
  no_driver_type: noDriverType,
};

// ------------------------------------------------------------------------------------------------ vitest wiring

interface TestApi {
  describe(name: string, body: () => void): void;
  it: {
    (name: string, body: () => Promise<void> | void, timeout?: number): void;
    skip(name: string, body: () => Promise<void> | void): void;
  };
  beforeAll(body: () => Promise<void> | void, timeout?: number): void;
  afterAll(body: () => Promise<void> | void, timeout?: number): void;
}

/**
 * One `describe` per entry and one test per check, in {@link CONFORMANCE_CHECKS} order on one disposable store. A
 * declared exception is its own test that checks its reason and evidence; a check whose capability is undeclared is a
 * visible skip; without a disposable store the store-backed checks are visible skips naming why, or failures when the
 * entry says the store is required.
 */
export function defineBackendConformance(
  t: TestApi,
  entries: readonly BackendConformance[],
  options: { readonly kinds: ReportKindCatalog },
): void {
  for (const entry of entries) {
    const plan = planConformance(entry);
    const needsStore = plan.some((item) => item.disposition === "run" && !STORELESS.has(item.check));
    t.describe(`backend conformance: ${entry.registration.id}`, () => {
      let session: Session | null = null;
      if (needsStore) {
        t.beforeAll(async () => {
          session = new Session(entry, await entry.openDisposable(), options.kinds);
        }, TIMEOUT_MS);
        t.afterAll(async () => {
          await session?.close();
        }, TIMEOUT_MS);
      }
      for (const item of plan) {
        if (item.disposition === "not_declared") {
          t.it.skip(item.title, () => undefined);
          continue;
        }
        if (item.disposition === "store_unavailable") {
          const unavailable = entry.storeUnavailable as NonNullable<BackendConformance["storeUnavailable"]>;
          if (unavailable.required) {
            t.it(item.title, () => {
              throw new assert.AssertionError({
                message: `a disposable store is required here: ${unavailable.reason}`,
              });
            });
          } else {
            t.it.skip(item.title, () => undefined);
          }
          continue;
        }
        t.it(
          item.title,
          async () => {
            if (item.check === "declaration") return declaration(entry);
            if (item.check === "data_class_premise") return dataClassPremise();
            if (item.disposition === "declared_exception") {
              const exception = entry.exceptions.find((candidate) => candidate.check === item.check);
              assert.ok(exception && exception.reason !== "" && exception.evidence.length > 0, "cited exception");
              return;
            }
            const current = session;
            assert.ok(current, "the disposable store is open");
            await RUN[item.check](current);
          },
          TIMEOUT_MS,
        );
      }
    });
  }
}
