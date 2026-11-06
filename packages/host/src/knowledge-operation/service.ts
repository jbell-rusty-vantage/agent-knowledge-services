import {
  type BindingDescriptor,
  BindingDescriptorSchema,
  type CredentialClaims,
  DECIDE_CONTRACT,
  DecisionResolveRequestSchema,
  type JsonDocument,
  type JsonValue,
  KNOWLEDGE_READ_CONTRACT,
  type KnowledgePlanPreview,
  KnowledgePlanPreviewSchema,
  type KnowledgeReadIntentResult,
  KnowledgeReadIntentRequestSchema,
  KnowledgeReadIntentResultSchema,
  READ_INTENT_INLINE_MAX_BYTES,
  READ_INTENT_RESULT_VERSION,
  EVALUATION_CONTEXT_CONTRACT,
  EVALUATION_CONTEXT_VERSION,
  EvaluationContextRequestSchema,
  OBSERVE_CONTRACT,
  OPERATIONS,
  type OperationEnvelope,
  OperationEnvelopeSchema,
  type OperationHandle,
  type OperationName,
  type OperationReceipt,
  OperationReceiptSchema,
  type OperationStatus,
  PROTOCOL_VERSION,
  type ProtocolErrorCode,
  type QualificationReceiptSchema,
  REPORT_PACKAGE_VERSION,
  RESOLVE_CONTRACT,
  REVIEW_CONTRACT,
  ReadPurposeSchema,
  type ReadRefusalReason,
  type ReceiptLookup,
  ReceiptLookupSchema,
  type Ref,
  RefSchema,
  ReportObservationRequestSchema,
  ReportReviewRequestSchema,
  ReportSealRequestSchema,
  ReportUseRequestSchema,
  ResearchReportPackageSchema,
  SEAL_CONTRACT,
  type SelectedReportRead,
  SelectedReportReadSchema,
  boundEffectDigest,
  canonicalJson,
  checkCapabilities,
  digestBytes,
  digestCanonical,
  envelopeDigest,
  isTerminal,
  refOf,
  sameRef,
  selectedReadDigest,
} from "@aiengineer/knowledge-operation-protocol";
import { ScriptedAuditorDiscovery } from "@aiengineer/knowledge-application";
import { type AuthScope, recordRef } from "@aiengineer/knowledge-research-core";
import type { z } from "zod";
import { z as zod } from "zod";
import {
  CredentialRefusal,
  type DispatchRegistry,
  type InstalledBinding,
  type KnowledgeCredentialVerifier,
  authorize,
} from "./auth.js";
import {
  type AssessmentResult,
  decideUse,
  evaluationContext,
  observeReport,
  resolveDecision,
  reviewDecision,
  sealReport,
} from "./assessment.js";
import { DeriveRequestSchema, deriveReport } from "./derive.js";
import { type Correlation, ProtocolRefusal, nowInstant, refusal, toProtocolError } from "./errors.js";
import type {
  EffectLedger,
  JournaledDispatch,
  KnowledgeOperationBackend,
  NativeApplied,
  NativeOnly,
  ResearchServices,
} from "./ports.js";
import type { BackendCapability } from "./registry.js";
import { RegistrationPayloadSchema, assertRecordsInScope } from "./payloads.js";

/**
 * `ks.knowledge_operation.v2` over the Sprint V application services (SV-16, design §4/§5). Transport-free: HTTP and MCP
 * call these methods with the bearer credential and the JSON body; every refusal is a {@link ProtocolRefusal} carrying
 * a K01 `protocol-error.v2`.
 *
 * Operation map (per installed backend):
 *  - `report.register` (effectful)  -> bind effect -> receipt-first dedup -> coordinator openRun/registerEvidence/
 *    registerReport -> K01 receipt persisted with the component effect receipt -> `operation-receipt.v2`;
 *  - `report.assess`                -> ReportAssessmentService.start (durable handle) and an in-process runner;
 *  - `knowledge.read`               -> `selected-report-read/v2` (WI-02 readSelected): exactly the selected content of
 *                                      one exact revision (the whole revision with body + ledger digests re-verified,
 *                                      or named assertion/evidence handles) for a declared purpose, frozen into
 *                                      custody as `research-report-package.v2`; a terminal handle whose `resultRef`
 *                                      names the package manifest;
 *  - `knowledge.apply` (effectful)  -> the backend's native exact-use port (its contract is the port's own
 *                                      `nativeContract`), or `SCHEMA_UNSUPPORTED` when the backend declares no `apply`;
 *  - `knowledge.plan_preview`       -> the apply port's read-only `preview` over the same envelope/intent without the
 *                                      use-decision fields: `knowledge-plan-preview.v1` in the same call (nothing bound,
 *                                      journaled or admitted); listed only when the apply port previews;
 *  - `knowledge.read_intent`        -> the backend's native read port (`knowledge-read-intent/v1`, OVE-204): allowlisted
 *                                      named queries and schema reads answered as `knowledge-read-intent-result.v1`
 *                                      in the same call, each served read recorded as one operation row (verified
 *                                      origin, no run, no subject); frozen into custody only with `persist`; listed only
 *                                      when the backend serves `read_intent` and `research` (the operation store);
 *  - `verify.claims`                -> `SCHEMA_UNSUPPORTED`: the executor's file-store claims chain is retired (SV-17);
 *  - `report.derive`                -> deterministic derived proposals through a declared mapping (handle);
 *  - `report.observe` / `report.seal` / `report.decide` / `report.review` / `decision.resolve` (Sprint OC WI-03) ->
 *                                      the trusted assessment transport (`assessment.ts`): an independent evaluator's
 *                                      observations (role from the credential's `evaluation` grant), the sealed
 *                                      VerificationRun, the exact use decision, the reviewer's successor decision and
 *                                      the current successor with its exact-use eligibility; each a terminal handle
 *                                      whose `resultRef` names the result document;
 *  - `operation.get` / `operation.cancel` / `receipt.get` / `knowledge.describe` -> their own routes.
 */
export interface KnowledgeOperationServiceOptions {
  readonly verifier: KnowledgeCredentialVerifier;
  readonly backends: readonly KnowledgeOperationBackend[];
  readonly installed: readonly InstalledBinding[];
  readonly dispatches: DispatchRegistry;
  /** Issuer name of the run seal signer this executor uses (descriptor `signingIssuer`). */
  readonly signingIssuer: string;
  readonly qualification?: readonly z.infer<typeof QualificationReceiptSchema>[];
  readonly retryAfterMs?: number;
  readonly clock?: () => string;
  /** Called with background runner failures (never with credentials or bodies). */
  readonly onBackgroundError?: (error: unknown) => void;
}

const NATIVE_CONTRACTS: Partial<Record<OperationName, { name: string; version: string }>> = {
  "report.register": { name: "research-report", version: "v2" },
  "report.assess": { name: "research-report-assessment", version: "v1" },
  "knowledge.read": KNOWLEDGE_READ_CONTRACT,
  "report.derive": { name: "research-report-derive", version: "v1" },
  "report.observe": OBSERVE_CONTRACT,
  "report.seal": SEAL_CONTRACT,
  "report.decide": DECIDE_CONTRACT,
  "report.review": REVIEW_CONTRACT,
  "decision.resolve": RESOLVE_CONTRACT,
};
/** Result document versions of the trusted assessment operations (`resultRef.version`). */
const ASSESSMENT_RESULTS: Partial<Record<OperationName, string>> = {
  "knowledge.read": EVALUATION_CONTEXT_VERSION,
  "report.observe": "report-observation-result.v1",
  "report.seal": "report-seal-result.v1",
  "report.decide": "use-decision-result.v1",
  "report.review": "report-review-result.v1",
  "decision.resolve": "use-decision-resolution.v1",
};
const ROUTED: ReadonlySet<OperationName> = new Set([
  "knowledge.describe",
  "operation.get",
  "operation.cancel",
  "receipt.get",
]);
const CancelBodySchema = zod.strictObject({
  cancelRequestId: zod.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/),
});

function shortDigest(value: JsonValue): string {
  return digestCanonical(value).slice(7, 39);
}

/**
 * WI-05: what a `knowledge.apply` refusal says about the refused dispatch (`details.dispatch`, a K01 detail field):
 * `not_journaled` (nothing was sent natively), `journaled_uncommitted` (sent; the native transaction ended without a
 * commit of the effect), `committed` (the effect is committed natively: its receipt is recoverable) or `unknown`
 * (whether it committed cannot be established now). A refusal that already names its dispatch state keeps it.
 */
export type DispatchState = "not_journaled" | "journaled_uncommitted" | "committed" | "unknown";

/**
 * Typed refusals a native port raises only before its native commit (validation and exact-use admission; the native
 * transaction rolled back). Infrastructure failures (`INTERNAL`, `CAPABILITY_UNAVAILABLE`), raw errors and timeouts are
 * not: their commit may still be in flight.
 */
const KNOWN_ROLLBACK_CODES: ReadonlySet<string> = new Set([
  "EFFECT_CONFLICT",
  "STALE_DECISION",
  "REVIEW_REQUIRED",
  "UNRESOLVED_EFFECT",
  "EXACT_REVISION_UNAVAILABLE",
  "SCHEMA_UNSUPPORTED",
  "SCOPE_DENIED",
  "INVALID_ENVELOPE",
  "BUDGET_EXHAUSTED",
  "UNSUPPORTED_MEDIA",
]);

function knownRollback(error: unknown): boolean {
  return error instanceof ProtocolRefusal && KNOWN_ROLLBACK_CODES.has(error.error.code);
}

function withDispatchState(error: unknown, state: DispatchState, correlation: Correlation): ProtocolRefusal {
  const protocol = toProtocolError(error, correlation);
  const details = (protocol.details ?? {}) as Record<string, JsonValue>;
  if ("dispatch" in details) return new ProtocolRefusal(protocol);
  // EFFECT_CONFLICT: the presented bytes differ from the bound or committed effect, so they can never apply under
  // this key whatever this dispatch did (`not_journaled`: nothing of THESE bytes is or can be committed).
  const effective = protocol.code === "EFFECT_CONFLICT" ? "not_journaled" : state;
  // `fenced`: a journaled_uncommitted dispatch was abandoned under the commit lock; it can never commit later.
  const fenced = effective === "journaled_uncommitted" ? { fenced: true } : {};
  return new ProtocolRefusal({ ...protocol, details: { ...details, dispatch: effective, ...fenced } as JsonDocument });
}

export class KnowledgeOperationService {
  private readonly clock: () => string;
  private readonly retryAfterMs: number;
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly dispatchCounts = new Map<string, number>();

  private readonly startedAt: string;

  constructor(private readonly options: KnowledgeOperationServiceOptions) {
    this.clock = options.clock ?? (() => nowInstant());
    this.startedAt = this.clock();
    this.retryAfterMs = Math.min(300_000, Math.max(100, options.retryAfterMs ?? 500));
  }

  // ------------------------------------------------------------------------------------------ credential + scope

  private async authenticate(token: string | null | undefined): Promise<CredentialClaims> {
    return this.options.verifier.verify(token);
  }

  /**
   * K07 binding of the claims to this executor and the request, then DURABLE single use (component 2.3.0
   * `credential_use`): a replayed jti or a reused dispatch id refuses, also after an executor restart.
   */
  private async admit(claims: CredentialClaims, request: Parameters<typeof authorize>[2]): Promise<AuthScope> {
    const scope = authorize(claims, this.options.installed, request);
    const backend = this.options.backends.find(
      (candidate) => candidate.application === scope.application && candidate.binding === scope.binding,
    );
    if (backend === undefined)
      throw refusal("SCOPE_DENIED", "binding not installed", { dispatchId: claims.dispatchId });
    let outcome: Awaited<ReturnType<KnowledgeOperationBackend["credentials"]["consume"]>>;
    try {
      outcome = await backend.credentials.consume(scope, {
        issuer: claims.iss,
        jti: claims.jti,
        dispatchId: claims.dispatchId,
        expiresAt: new Date((claims.exp + this.options.verifier.skewSeconds) * 1000),
        now: new Date(this.options.verifier.now() * 1000),
      });
    } catch {
      throw new CredentialRefusal("credential_store_unavailable");
    }
    if (outcome !== "consumed") throw new CredentialRefusal(outcome);
    return scope;
  }

  private backendFor(scope: AuthScope, correlation: Correlation = {}): KnowledgeOperationBackend {
    const backend = this.options.backends.find(
      (candidate) => candidate.application === scope.application && candidate.binding === scope.binding,
    );
    if (backend === undefined) throw refusal("SCOPE_DENIED", "binding not installed", correlation);
    if (backend.unsupportedReason !== null) {
      throw refusal("SCHEMA_UNSUPPORTED", backend.unsupportedReason, correlation);
    }
    return backend;
  }

  private research(backend: KnowledgeOperationBackend, correlation: Correlation): ResearchServices {
    if (!backend.capabilities.has("research")) {
      throw refusal("SCHEMA_UNSUPPORTED", `${backend.binding} serves no research operations`, correlation);
    }
    return backend.research();
  }

  /** The effect ledger, when the backend declares `native_receipt_lookup`. */
  private effects(backend: KnowledgeOperationBackend): EffectLedger | null {
    return backend.capabilities.has("native_receipt_lookup") ? backend.effects() : null;
  }

  private handleOf(scope: AuthScope, operationId: string): OperationHandle {
    return {
      protocolVersion: PROTOCOL_VERSION,
      tenant: scope.tenant,
      application: scope.application,
      binding: scope.binding,
      operationId,
    };
  }

  // ------------------------------------------------------------------------------------------ invoke

  async invoke(
    token: string | null | undefined,
    body: unknown,
  ): Promise<OperationHandle | OperationReceipt | KnowledgePlanPreview | KnowledgeReadIntentResult> {
    const claims = await this.authenticate(token);
    const parsed = OperationEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProtocolRefusal(toProtocolError(parsed.error, { dispatchId: claims.dispatchId }));
    }
    const envelope = parsed.data;
    const correlation: Correlation = {
      dispatchId: envelope.dispatchId,
      effectKey: envelope.effect?.effectKey ?? null,
    };
    try {
      const scope = await this.admit(claims, { operation: envelope.operation, envelope });
      this.options.dispatches.record(envelope.dispatchId, envelopeDigest(envelope));
      if (ROUTED.has(envelope.operation)) {
        throw refusal("INVALID_ENVELOPE", `${envelope.operation} is addressed through its own route`, correlation);
      }
      const backend = this.backendFor(scope, correlation);
      this.checkEnvelope(backend, envelope, correlation);
      switch (envelope.operation) {
        case "report.register":
          return await this.registerReport(scope, backend, envelope, correlation);
        case "report.assess":
          return await this.startAssessment(scope, backend, envelope, correlation);
        case "knowledge.read":
          // OVE-169: the independent evaluator's context read is a trusted (grant-scoped) operation.
          if (envelope.input?.nativeContract.name === EVALUATION_CONTEXT_CONTRACT.name) {
            return await this.assess(claims, scope, backend, envelope, correlation);
          }
          return await this.read(scope, backend, envelope, correlation);
        case "knowledge.apply":
          return await this.apply(scope, backend, envelope, correlation);
        case "knowledge.plan_preview":
          return await this.planPreview(scope, backend, envelope, correlation);
        case "knowledge.read_intent":
          return await this.readIntent(scope, backend, envelope, correlation);
        case "report.derive":
          return await this.derive(scope, backend, envelope, correlation);
        case "report.observe":
        case "report.seal":
        case "report.decide":
        case "report.review":
        case "decision.resolve":
          return await this.assess(claims, scope, backend, envelope, correlation);
        default:
          throw refusal("SCHEMA_UNSUPPORTED", `${envelope.operation} is not served by ${backend.binding}`, correlation);
      }
    } catch (error) {
      // A knowledge.apply refused before `apply` ran (credential, admission, envelope checks) sent nothing natively.
      if (envelope.operation === "knowledge.apply") throw withDispatchState(error, "not_journaled", correlation);
      throw new ProtocolRefusal(toProtocolError(error, correlation));
    }
  }

  private checkEnvelope(backend: KnowledgeOperationBackend, envelope: OperationEnvelope, correlation: Correlation) {
    const descriptor = this.descriptorFor(backend);
    const capabilities = checkCapabilities(descriptor, envelope.requiredCapabilities);
    if (!capabilities.ok) {
      throw refusal("CAPABILITY_UNAVAILABLE", "required capabilities are not advertised and qualified", correlation, {
        missing: [...capabilities.missing],
        unqualified: [...capabilities.unqualified],
      });
    }
    if (
      envelope.operation === "report.assess" &&
      backend.capabilities.has("research") &&
      backend.research().assessment === null
    ) {
      throw refusal(
        "INDEPENDENCE_UNPROVEN",
        "no independent auditor is configured for this binding; report.assess cannot run",
        correlation,
      );
    }
    if (!descriptor.operations.includes(envelope.operation)) {
      throw refusal("SCHEMA_UNSUPPORTED", `${envelope.operation} is not served by ${backend.binding}`, correlation);
    }
    if (Date.parse(envelope.governors.deadline) <= Date.parse(this.clock())) {
      throw refusal("BUDGET_EXHAUSTED", "the request deadline has passed", correlation);
    }
    // `knowledge.apply` is listed only when the backend declares `apply`; its contract is the port's own.
    const expected =
      envelope.operation === "knowledge.apply" || envelope.operation === "knowledge.plan_preview"
        ? backend.apply().nativeContract
        : envelope.operation === "knowledge.read_intent"
          ? backend.readIntent().nativeContract
          : envelope.operation === "knowledge.read" &&
              envelope.input?.nativeContract.name === EVALUATION_CONTEXT_CONTRACT.name
            ? EVALUATION_CONTEXT_CONTRACT
            : NATIVE_CONTRACTS[envelope.operation];
    const input = envelope.input;
    if (expected !== undefined) {
      if (input === null)
        throw refusal("INVALID_ENVELOPE", `${envelope.operation} needs its native input`, correlation);
      if (input.nativeContract.name !== expected.name || input.nativeContract.version !== expected.version) {
        throw refusal(
          "SCHEMA_UNSUPPORTED",
          `${envelope.operation} takes ${expected.name}/${expected.version}, not ${input.nativeContract.name}/${input.nativeContract.version}`,
          correlation,
        );
      }
      if (input.inlinePayload === null) {
        throw refusal("UNSUPPORTED_MEDIA", "this binding takes the native payload inline only", correlation);
      }
      const bytes = Buffer.from(canonicalJson(input.inlinePayload as JsonValue), "utf8");
      if (bytes.byteLength !== input.payloadBytes) {
        throw refusal("INVALID_ENVELOPE", "payloadBytes differs from the canonical inline payload", correlation);
      }
    }
    if (
      envelope.pinnedSchema !== null &&
      envelope.operation !== "knowledge.apply" &&
      envelope.operation !== "knowledge.plan_preview" &&
      (envelope.pinnedSchema.name !== descriptor.pinnedSchema.name ||
        envelope.pinnedSchema.version !== descriptor.pinnedSchema.version ||
        envelope.pinnedSchema.digest !== descriptor.pinnedSchema.digest)
    ) {
      throw refusal("SCHEMA_UNSUPPORTED", "pinned schema differs from the installed component", correlation);
    }
  }

  /** Bind, verify the bound digest covers these exact bytes and this origin, and answer an existing receipt first. */
  private async bindEffect(
    scope: AuthScope,
    backend: KnowledgeOperationBackend,
    envelope: OperationEnvelope,
    correlation: Correlation,
  ): Promise<OperationReceipt | null> {
    const effect = envelope.effect;
    const effects = this.effects(backend);
    if (effect === null || effects === null || envelope.input === null) {
      throw refusal("SCHEMA_UNSUPPORTED", "this binding records no effects", correlation);
    }
    const bytes = Buffer.from(canonicalJson(envelope.input.inlinePayload as JsonValue), "utf8");
    if (
      digestBytes(bytes) !== effect.semanticPayloadDigest ||
      boundEffectDigest(bytes, effect.originatingOrigin) !== effect.boundEffectDigest
    ) {
      throw refusal(
        "EFFECT_CONFLICT",
        "the bound effect digest does not bind these exact bytes and originating origin",
        correlation,
      );
    }
    await effects.bind(scope, effect);
    this.dispatchCounts.set(effect.effectKey, (this.dispatchCounts.get(effect.effectKey) ?? 0) + 1);
    const existing = await effects.lookup(scope, effect.effectKey);
    if (existing?.state === "found") return existing.receipt;
    if (existing?.state === "native_only") {
      throw refusal(
        "UNRESOLVED_EFFECT",
        "the native receipt exists but its protocol receipt is unavailable",
        correlation,
      );
    }
    return null;
  }

  private async buildReceipt(
    scope: AuthScope,
    backend: KnowledgeOperationBackend,
    envelope: OperationEnvelope,
    applied: {
      outcome: OperationReceipt["outcome"];
      nativeReceiptRef: Ref;
      affectedRefs: readonly Ref[];
      concurrencyToken: OperationReceipt["concurrencyToken"];
      processedRevocationEpoch?: number;
      details: JsonDocument | null;
    },
    persist: "native" | "protocol" | false = "native",
    /**
     * WI-05: the journaled dispatch the receipt names. Its envelope, caller origin and durable sequence replace the
     * live request's, so a receipt rebuilt after a crash is the ORIGINAL caller's receipt, never the recovering one's.
     */
    journaled: JournaledDispatch | null = null,
    appliedAt: string | null = null,
  ): Promise<OperationReceipt> {
    const effect = envelope.effect as NonNullable<OperationEnvelope["effect"]>;
    const effects = this.effects(backend);
    const body = {
      handle: this.handleOf(scope, `op-effect-${shortDigest({ tenant: scope.tenant, effectKey: effect.effectKey })}`),
      effect: {
        ...effect,
        currentCallerOrigin: journaled?.callerOrigin ?? scope.origin,
        dispatchId: envelope.dispatchId,
        envelopeDigest: journaled?.envelopeDigest ?? envelopeDigest(envelope),
        dispatchSequence: journaled?.dispatchSequence ?? this.dispatchCounts.get(effect.effectKey) ?? 1,
      },
      outcome: applied.outcome,
      nativeReceiptRef: applied.nativeReceiptRef,
      affectedRefs: [...applied.affectedRefs],
      concurrencyToken: applied.concurrencyToken,
      processedRevocationEpoch:
        applied.processedRevocationEpoch ??
        (backend.capabilities.has("revocation") ? await backend.revocation().epoch(scope) : 0),
      itemOutcomes: [],
      appliedAt: appliedAt ?? this.clock(),
      details: applied.details,
    };
    const receipt = OperationReceiptSchema.parse({ ...body, digest: digestCanonical(body as unknown as JsonValue) });
    if (persist === false || effects === null) return receipt;
    return effects.record(scope, receipt, { native: persist === "native" });
  }

  private async registerReport(
    scope: AuthScope,
    backend: KnowledgeOperationBackend,
    envelope: OperationEnvelope,
    correlation: Correlation,
  ): Promise<OperationReceipt> {
    const research = this.research(backend, correlation);
    // Deterministic payload checks run BEFORE the effect is bound, so a refusal leaves no effect row behind.
    const payload = RegistrationPayloadSchema.parse(envelope.input?.inlinePayload);
    assertRecordsInScope(scope, payload, correlation);
    // The envelope's declared use (K01, optional) must be the frozen task's own use and audience.
    if (
      envelope.use !== undefined &&
      (payload.task.use !== envelope.use || payload.task.audience !== envelope.audience)
    ) {
      throw refusal("SCHEMA_UNSUPPORTED", "the envelope declares another use than the registered task", correlation);
    }
    if (payload.assertions.length > envelope.governors.maxItems) {
      throw refusal("BUDGET_EXHAUSTED", "more assertions than the request's maxItems", correlation);
    }
    const effect = envelope.effect as NonNullable<OperationEnvelope["effect"]>;
    const { coordinator, kinds } = research;
    const kind =
      typeof payload.report.kind === "string" ? safeKindRef(kinds, scope, payload.report.kind) : payload.report.kind;
    if (kind === null) {
      throw refusal("SCHEMA_UNSUPPORTED", `unknown report kind ${String(payload.report.kind)}`, correlation);
    }
    // An applied registration answers its receipt first (review S5): a retry is never re-validated against a kind or
    // schema that changed since.
    const existing = await this.bindEffect(scope, backend, envelope, correlation);
    if (existing !== null) return existing;
    try {
      // One report revision per (reportId, revision): another effect cannot re-register it (checked before a run opens).
      if (await research.locator.revisionExists(scope, `${payload.report.reportId}-r${payload.report.revision}`)) {
        throw refusal(
          "EFFECT_CONFLICT",
          `report ${payload.report.reportId} revision ${payload.report.revision} is already registered by another effect`,
          correlation,
        );
      }
      // W1 D19: every check `registerReport` runs (records, body, report kind, rendering, the ledger and the revision
      // record), a superseded revision that exists, and every record id/digest against the store, BEFORE the first
      // write, so a refused registration writes nothing. This is not one transaction: an infrastructure failure
      // mid-write leaves write-once records an identical retry re-uses (and that block a rename of those ids).
      coordinator.validateRegistration(scope, {
        task: payload.task,
        fragments: payload.fragments,
        assertions: payload.assertions,
        supportSets: payload.supportSets,
        kind: kind as Ref<"report_kind">,
        structuredBody: payload.report.structuredBody,
        reportId: payload.report.reportId,
        revision: payload.report.revision,
        timeCoverage: payload.report.timeCoverage,
        supersedes: payload.report.supersedes as Ref<"report"> | null,
      });
      const superseded = payload.report.supersedes;
      if (superseded !== null) {
        const predecessorRun = await research.locator.runOf(scope, superseded);
        if (predecessorRun === null) {
          throw refusal("NOT_FOUND", `the superseded report revision ${superseded.id} is not registered`, correlation, {
            reason: "supersedes_unknown",
          });
        }
        const predecessor = await research.binding.loadRunContext(scope, predecessorRun);
        if (predecessor.report === null || !sameRef(recordRef("report", predecessor.report.revision), superseded)) {
          throw refusal(
            "EXACT_REVISION_UNAVAILABLE",
            "the exact superseded report revision is unavailable",
            correlation,
            {
              reason: "supersedes_mismatch",
            },
          );
        }
      }
      const collisions = await coordinator.registrationCollisions(scope, {
        task: payload.task as never,
        fragments: payload.fragments as never,
        assertions: payload.assertions as never,
        supportSets: payload.supportSets as never,
      });
      const first = collisions[0];
      if (first !== undefined) throw collisionRefusal(first, correlation, collisions);
      // Evidence first (write-once, idempotent for identical bytes): a genuine id collision refuses before a run opens.
      const evidence = await coordinator.registerEvidence(scope, {
        fragments: payload.fragments as never,
        assertions: payload.assertions as never,
        supportSets: payload.supportSets as never,
      });
      const { runId } = await coordinator.openRun(scope, {
        task: payload.task as never,
        originatingOrigin: effect.originatingOrigin,
      });
      const registered = await coordinator.registerReport(scope, {
        runId,
        reportId: payload.report.reportId,
        revision: payload.report.revision,
        kind: kind as Ref<"report_kind">,
        structuredBody: payload.report.structuredBody as never,
        assertions: evidence.assertions,
        timeCoverage: payload.report.timeCoverage,
        supersedes: payload.report.supersedes as Ref<"report"> | null,
      });
      research.locator.remember?.(scope, registered.report, runId);
      return await this.buildReceipt(scope, backend, envelope, {
        outcome: "applied",
        nativeReceiptRef: registered.report,
        affectedRefs: [registered.report, registered.revision.body, registered.revision.ledger],
        concurrencyToken: { before: null, after: registered.revision.bodyDigest },
        details: {
          runId,
          reportId: payload.report.reportId,
          revision: payload.report.revision,
          kind: kind.id,
          task: registered.revision.task.id,
        },
      });
    } catch (error) {
      // A concurrent identical registration may have won the receipt; answer it (native durable deduplication).
      const winner = await this.effects(backend)
        ?.lookup(scope, effect.effectKey)
        .catch(() => null);
      if (winner?.state === "found") return winner.receipt;
      // K02 records are write-once per id in the binding: another effect that reuses a task, fragment, assertion or
      // support-set id conflicts (a new registration mints new record ids; identical ids are not deduplicated).
      const message = error instanceof Error ? error.message : "";
      // W1 D19: a record id another registration holds with other bytes (or these bytes under another id) is a typed
      // conflict the producer can act on (register under new ids), never an internal error.
      // A concurrent registration can still race the preflight; the binding's typed error code is read first.
      const collision = recordCollision(message, (error as { code?: unknown } | null)?.code);
      if (collision !== null) throw collisionRefusal(collision, correlation);
      const constraint = /violates unique constraint "([a-z0-9_]+)"/.exec(message)?.[1];
      if (constraint !== undefined) {
        throw refusal(
          "EFFECT_CONFLICT",
          "a registered record id is already used by another registration",
          correlation,
          {
            constraint,
          },
        );
      }
      throw error;
    }
  }

  private reportOf(envelope: OperationEnvelope, correlation: Correlation): Ref<"report"> {
    const inline = envelope.input?.inlinePayload;
    const candidate =
      inline !== null && typeof inline === "object" && !Array.isArray(inline) && "report" in inline
        ? (inline as Record<string, unknown>).report
        : envelope.input?.upstream.find((ref) => ref.kind === "report");
    const parsed = refOf("report").safeParse(candidate);
    if (!parsed.success) throw refusal("INVALID_ENVELOPE", "the request names no exact report handle", correlation);
    const upstream = envelope.input?.upstream.find((ref) => ref.kind === "report");
    if (upstream !== undefined && !sameRef(upstream, parsed.data)) {
      throw refusal("INVALID_ENVELOPE", "payload report and upstream report differ", correlation);
    }
    return parsed.data as Ref<"report">;
  }

  private async startAssessment(
    scope: AuthScope,
    backend: KnowledgeOperationBackend,
    envelope: OperationEnvelope,
    correlation: Correlation,
  ): Promise<OperationHandle> {
    const research = this.research(backend, correlation);
    if (research.assessment === null) {
      throw refusal(
        "INDEPENDENCE_UNPROVEN",
        "no independent auditor is configured for this binding; report.assess cannot run",
        correlation,
      );
    }
    const report = this.reportOf(envelope, correlation);
    const runId = await research.locator.runOf(scope, report);
    if (runId === null)
      throw refusal("EXACT_REVISION_UNAVAILABLE", "the exact report revision is unknown", correlation);
    const handle = await research.assessment.start(scope, { runId, reportRef: report, requestId: envelope.requestId });
    this.drive(scope, backend, handle);
    return handle;
  }

  /** Run (or resume) an assessment in process; idempotent (the store's compare-and-set arbitrates across processes). */
  private drive(scope: AuthScope, backend: KnowledgeOperationBackend, handle: OperationHandle): void {
    const assessment = backend.capabilities.has("research") ? backend.research().assessment : null;
    if (!assessment) return;
    const key = `${handle.tenant}/${handle.operationId}`;
    if (this.running.has(key)) return;
    const run = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return assessment.run(scope, handle);
    })()
      .catch((error: unknown) => this.options.onBackgroundError?.(error))
      .finally(() => this.running.delete(key));
    this.running.set(key, run);
  }

  /** Test seam: wait for in-process runners. */
  async settled(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  /**
   * `knowledge.read` (`selected-report-read/v2`, Sprint OC WI-02 readSelected): exactly the selected content of one exact
   * revision for a declared purpose. Every refusal is typed and names its `details.reason` (`ReadRefusalReason`).
   * The purpose is recorded with the operation request and in the manifest; it is not a use decision.
   */
  private async read(
    scope: AuthScope,
    backend: KnowledgeOperationBackend,
    envelope: OperationEnvelope,
    correlation: Correlation,
  ): Promise<OperationHandle> {
    const research = this.research(backend, correlation);
    const selected = this.selectedRead(scope, envelope, correlation);
    const report = selected.report as Ref<"report">;
    const operationId = `op-read-${shortDigest({ tenant: scope.tenant, operation: "knowledge.read", requestId: envelope.requestId })}`;
    const requestValue = { operation: "knowledge.read", read: selected } as unknown as JsonValue;
    const prior = await research.operations.get(scope, operationId);
    if (prior !== null) {
      if (prior.requestDigest !== digestCanonical(requestValue)) {
        throw refusal("EFFECT_CONFLICT", "the request id already names another read", correlation);
      }
      return prior.status.handle;
    }
    const refuse = (code: ProtocolErrorCode, reason: ReadRefusalReason, message: string, handle?: Ref) =>
      refusal(code, message, { ...correlation, operationId }, readRefusal(reason, handle));
    const corrupt = (handle: Ref) =>
      refuse("EXACT_REVISION_UNAVAILABLE", "content_integrity", "stored content no longer matches its handle", handle);
    const unavailable = () =>
      refuse("EXACT_REVISION_UNAVAILABLE", "revision_unavailable", "the exact report revision is not available");
    const runId = await research.locator.runOf(scope, report);
    if (runId === null) throw unavailable();
    const context = await research.binding.loadRunContext(scope, runId);
    if (context.report === null || !sameRef(recordRef("report", context.report.revision), report)) throw unavailable();
    const revision = context.report.revision;

    // The revision's members: its assertions and the evidence fragments their support sets name, sorted by id.
    const assertionHandles = byId(revision.assertions);
    const evidenceHandles = byId(
      context.supportSets
        .filter((set) => revision.assertions.some((assertion) => sameRef(assertion, set.assertion)))
        .flatMap((set) => [...set.required.flatMap((premise) => premise.evidence), ...set.contrary]),
    );
    const pick = <K extends "assertion" | "fragment">(available: readonly Ref<K>[], wanted: readonly Ref<K>[]) =>
      wanted.map((handle) => {
        const member = available.find((candidate) => candidate.id === handle.id);
        if (member === undefined) {
          throw refuse("NOT_FOUND", "member_unknown", `the revision names no ${handle.kind} ${handle.id}`, handle);
        }
        if (!sameRef(member, handle)) {
          throw refuse(
            "EXACT_REVISION_UNAVAILABLE",
            "member_revision_mismatch",
            `the revision names ${handle.kind} ${handle.id} under another version or digest`,
            handle,
          );
        }
        return member;
      });
    const selection = selected.selection;
    const assertionRefs =
      selection.mode === "revision" ? assertionHandles : pick(assertionHandles, selection.assertions);
    const evidenceRefs = selection.mode === "revision" ? evidenceHandles : pick(evidenceHandles, selection.evidence);

    // The exact records: each record's canonical digest is its handle's digest, or the read refuses.
    const fragments = evidenceRefs.length === 0 ? [] : await research.binding.loadFragments(scope, evidenceRefs);
    const exactRecords = <K extends "assertion" | "fragment">(
      kind: K,
      refs: readonly Ref<K>[],
      records: readonly { readonly id: string }[],
    ) =>
      refs.map((handle) => {
        const record = records.find(
          (candidate) => candidate.id === handle.id && sameRef(recordRef(kind, candidate as never), handle),
        );
        if (record === undefined) throw corrupt(handle);
        return { handle, record: record as unknown as JsonDocument };
      });
    const assertions = exactRecords("assertion", assertionRefs, context.assertions);
    const evidence = exactRecords("fragment", evidenceRefs, fragments);

    // The whole revision adds its body and ledger, re-verified byte for byte; a members read carries neither.
    const custody = research.binding.custody;
    let body: JsonDocument | null = null;
    let ledger: JsonDocument | null = null;
    if (selection.mode === "revision") {
      const bodyBytes = await custody.get(scope, revision.body);
      const ledgerBytes = await custody.get(scope, revision.ledger);
      if (digestBytes(bodyBytes) !== revision.bodyDigest || digestBytes(bodyBytes) !== revision.body.digest) {
        throw corrupt(revision.body);
      }
      if (digestBytes(ledgerBytes) !== revision.ledger.digest) throw corrupt(revision.ledger);
      body = { path: "body.md", digest: revision.bodyDigest, bytes: bodyBytes.byteLength, artifact: revision.body };
      ledger = {
        path: "ledger.json",
        digest: revision.ledger.digest,
        bytes: ledgerBytes.byteLength,
        artifact: revision.ledger,
      };
    }
    const manifest = ResearchReportPackageSchema.parse({
      schema: REPORT_PACKAGE_VERSION,
      report,
      revision: revision.id,
      kind: revision.kind,
      purpose: selected.purpose,
      request: selectedReadDigest(selected),
      selection,
      body,
      ledger,
      assertions,
      evidence,
    });
    const stored = await custody.put(
      scope,
      Buffer.from(canonicalJson(manifest as unknown as JsonValue), "utf8"),
      "application/json",
    );
    const resultRef: Ref = { ...stored, version: REPORT_PACKAGE_VERSION };
    const at = this.clock();
    const started = await research.operations.start(scope, {
      operationId,
      operation: "knowledge.read",
      requestId: envelope.requestId,
      request: requestValue,
      requestDigest: digestCanonical(requestValue),
      runId,
      subject: report,
      retryAfterMs: this.retryAfterMs,
      at,
    });
    if (!isTerminal(started.status.state)) {
      const running = await research.operations.transition(scope, {
        operationId,
        expectedRevision: started.status.revision,
        to: "running",
        at,
        retryAfterMs: this.retryAfterMs,
      });
      await research.operations.transition(scope, {
        operationId,
        expectedRevision: running.status.revision,
        to: "succeeded",
        at,
        resultRef,
      });
    }
    return started.status.handle;
  }

  /**
   * The exact `selected-report-read.v2` payload, checked before any store is touched: a declared purpose, the strict
   * shape, the payload report equal to any upstream report, and every handle in the credential's tenant and binding.
   */
  private selectedRead(scope: AuthScope, envelope: OperationEnvelope, correlation: Correlation): SelectedReportRead {
    const inline = envelope.input?.inlinePayload ?? null;
    const purpose =
      inline !== null && typeof inline === "object" && !Array.isArray(inline) ? inline.purpose : undefined;
    if (!ReadPurposeSchema.safeParse(purpose).success) {
      throw refusal(
        "INVALID_ENVELOPE",
        "knowledge.read declares no purpose (selected-report-read.v2 `purpose`)",
        correlation,
        readRefusal("purpose_undeclared"),
      );
    }
    const parsed = SelectedReportReadSchema.safeParse(inline);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 20)
        .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`);
      throw refusal("INVALID_ENVELOPE", "the payload is not an exact selected-report-read.v2", correlation, {
        ...readRefusal("selection_invalid"),
        issues,
      });
    }
    const selected = parsed.data;
    const upstream = envelope.input?.upstream.find((ref) => ref.kind === "report");
    if (upstream !== undefined && !sameRef(upstream, selected.report)) {
      throw refusal(
        "INVALID_ENVELOPE",
        "payload report and upstream report differ",
        correlation,
        readRefusal("report_upstream_mismatch", selected.report),
      );
    }
    const handles: Ref[] = [selected.report];
    if (selected.selection.mode === "members") {
      handles.push(...selected.selection.assertions, ...selected.selection.evidence);
    }
    const foreign = handles.find((handle) => handle.tenant !== scope.tenant || handle.binding !== scope.binding);
    if (foreign !== undefined) {
      throw refusal(
        "SCOPE_DENIED",
        `${foreign.kind} ${foreign.id} is outside the credential's tenant and binding`,
        correlation,
        readRefusal("handle_out_of_scope", foreign),
      );
    }
    return selected;
  }

  private async apply(
    scope: AuthScope,
    backend: KnowledgeOperationBackend,
    envelope: OperationEnvelope,
    correlation: Correlation,
  ): Promise<OperationReceipt> {
    // WI-05: every refusal says what THIS dispatch did natively (`details.dispatch`), so the caller rejects only what
    // provably did nothing and keeps everything else uncertain for receipt-first recovery.
    let phase: DispatchState = "not_journaled";
    try {
      if (!backend.capabilities.has("apply")) {
        throw refusal(
          "SCHEMA_UNSUPPORTED",
          `knowledge.apply is not wired for ${backend.binding} on this executor (native exact-use ingestion port absent)`,
          correlation,
        );
      }
      const effect = envelope.effect as NonNullable<OperationEnvelope["effect"]>;
      // Integrator decision 2026-10-25: `effect.boundEffectDigest` is the plan-level digest of the native proposal
      // bytes with the originating origin (the use decision binds it; the native path recomputes and compares it), and
      // `semanticPayloadDigest` over the request bytes is diagnostic. The native transaction binds the component effect
      // itself, so the effect is not pre-bound here; receipt-first: an effect with a protocol receipt answers it.
      const effects = this.effects(backend);
      const existing = await effects?.lookup(scope, effect.effectKey);
      if (existing?.state === "found") {
        if (existing.receipt.effect.boundEffectDigest !== effect.boundEffectDigest) {
          throw refusal("EFFECT_CONFLICT", "same effect key with different bound bytes", correlation);
        }
        return existing.receipt;
      }
      // WI-05: committed natively, protocol receipt lost. Reconstruct the original dispatch's receipt; never apply
      // again. This dispatch sends nothing, but the effect it names IS committed (unless its bytes differ).
      if (existing?.state === "native_only") {
        phase = "committed";
        return await this.recoverNative(
          scope,
          backend,
          effect.effectKey,
          existing,
          correlation,
          effect.boundEffectDigest,
        );
      }
      // Journal the original request before native dispatch (its own committed transaction): a crash after the native
      // commit and before the protocol receipt can then rebuild this dispatch's receipt. A bound effect with other
      // bytes refuses here; an earlier uncommitted (refused) dispatch never pins the key.
      const journaled = effects?.journal ? await effects.journal(scope, envelope) : null;
      // From here until the native call returns, its commit may be in flight: unknown unless proven otherwise.
      phase = "unknown";
      this.dispatchCounts.set(effect.effectKey, (this.dispatchCounts.get(effect.effectKey) ?? 0) + 1);
      // The native store may hold a commit of this effect: this dispatch's own (its answer lost) or another one's (a
      // concurrent dispatch, or an earlier one that crashed before its protocol receipt; the store answers it as a
      // duplicate or refuses the second commit EFFECT_ALREADY_COMMITTED). The effect's receipt is the committing one's.
      const committedReceipt = async (ownCommitToo: boolean): Promise<OperationReceipt | null> => {
        if (journaled === null || effects === null) return null;
        const after = await effects.lookup(scope, effect.effectKey);
        if (after?.state === "found") {
          if (after.receipt.effect.boundEffectDigest !== effect.boundEffectDigest) {
            // Another dispatch committed OTHER bytes under this key (concurrent different-bytes applies).
            throw refusal("EFFECT_CONFLICT", "the effect key is committed with other bound bytes", correlation);
          }
          phase = "committed";
          return after.receipt;
        }
        if (
          after?.state === "native_only" &&
          after.commit !== null &&
          (ownCommitToo || after.commit.dispatchId !== envelope.dispatchId)
        ) {
          phase = "committed";
          return this.recoverNative(scope, backend, effect.effectKey, after, correlation, effect.boundEffectDigest);
        }
        return null;
      };
      let applied: NativeApplied;
      try {
        applied = await backend.apply().apply(scope, {
          envelope,
          intent: envelope.input?.inlinePayload as JsonDocument,
          journaled,
        });
      } catch (error) {
        let winner: OperationReceipt | null;
        try {
          winner = await committedReceipt(true);
        } catch (lookupError) {
          // Whether the native transaction committed cannot be established now: the caller keeps it uncertain.
          // (`committedReceipt` may have advanced `phase` before it failed.)
          if ((phase as DispatchState) === "committed") throw lookupError;
          phase = "unknown";
          throw error;
        }
        if (winner !== null) return winner;
        // `journaled_uncommitted` is reported only for a typed pre-commit refusal (a known rollback) AND after the
        // dispatch is fenced: under the commit lock it can then never commit later. Anything else stays `unknown`.
        if (!knownRollback(error) || journaled === null || effects?.abandon === undefined) throw error;
        let fence: "abandoned" | "committed";
        try {
          fence = await effects.abandon(scope, effect.effectKey, envelope.dispatchId);
        } catch {
          throw error;
        }
        if (fence === "committed") {
          const late = await committedReceipt(true);
          if (late !== null) return late;
          phase = "committed";
          throw error;
        }
        phase = "journaled_uncommitted";
        throw error;
      }
      phase = "committed";
      return (
        (await committedReceipt(false)) ??
        (await this.buildReceipt(scope, backend, envelope, applied, "protocol", journaled))
      );
    } catch (error) {
      throw withDispatchState(error, phase, correlation);
    }
  }

  /**
   * `knowledge.plan_preview` (Sprint OC): the apply port's read-only native planner. No effect is bound, no dispatch is
   * journaled and no admission runs; the answer is exactly what `apply` would compute for the same request now.
   */
  private async planPreview(
    scope: AuthScope,
    backend: KnowledgeOperationBackend,
    envelope: OperationEnvelope,
    correlation: Correlation,
  ): Promise<KnowledgePlanPreview> {
    const port = backend.capabilities.has("apply") ? backend.apply() : null;
    if (port?.preview === undefined) {
      throw refusal(
        "SCHEMA_UNSUPPORTED",
        `knowledge.plan_preview is not served by ${backend.binding} on this executor (no native planner preview)`,
        correlation,
      );
    }
    const preview = await port.preview(scope, {
      envelope,
      intent: envelope.input?.inlinePayload as JsonDocument,
    });
    const parsed = KnowledgePlanPreviewSchema.safeParse(preview);
    if (!parsed.success) throw refusal("INTERNAL", "the native planner answered a malformed plan preview", correlation);
    return parsed.data;
  }

  /**
   * `knowledge.read_intent` (`knowledge-read-intent/v1`, OVE-204 slice 4): the backend's native read port answers the
   * allowlisted reads; the host records one operation row per served request (op id from tenant + operation +
   * request id; request `{operation, readIntent}`; verified origin; `runId`/`subject` null), applies the inline body
   * budget and, with `persist`, freezes the result document into custody (`retainedRef` = `resultRef`).
   *
   * Replay (same request id): a different request refuses `EFFECT_CONFLICT`; the same request answers the same
   * operation id, from custody when it was persisted, otherwise by reading again (the row is not rewritten).
   * A refused read (allowlist, tenant, schema, store) records nothing.
   */
  private async readIntent(
    scope: AuthScope,
    backend: KnowledgeOperationBackend,
    envelope: OperationEnvelope,
    correlation: Correlation,
  ): Promise<KnowledgeReadIntentResult> {
    const research = this.research(backend, correlation);
    const port = backend.capabilities.has("read_intent") ? backend.readIntent() : null;
    if (port === null) {
      throw refusal("SCHEMA_UNSUPPORTED", `knowledge.read_intent is not served by ${backend.binding}`, correlation);
    }
    const inline = (envelope.input?.inlinePayload ?? null) as JsonValue;
    const parsed = KnowledgeReadIntentRequestSchema.safeParse(inline);
    if (!parsed.success) {
      throw refusal("INVALID_ENVELOPE", "the inline payload is not a knowledge-read-intent-request.v1", correlation, {
        issues: parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }
    const request = parsed.data;
    const operationId = `op-read_intent-${shortDigest({ tenant: scope.tenant, operation: "knowledge.read_intent", requestId: envelope.requestId })}`;
    const requestValue = { operation: "knowledge.read_intent", readIntent: inline } as unknown as JsonValue;
    const requestDigest = digestCanonical(requestValue);
    const located = { ...correlation, operationId };
    const custody = research.binding.custody;
    const prior = await research.operations.get(scope, operationId);
    if (prior !== null) {
      if (prior.requestDigest !== requestDigest) {
        throw refusal("EFFECT_CONFLICT", "the request id already names another read intent", located);
      }
      const retained = prior.status.resultRef;
      if (retained !== null && retained.kind === "artifact") {
        const bytes = await custody.get(scope, retained as Ref<"artifact">);
        if (digestBytes(bytes) !== retained.digest) {
          throw refusal("EXACT_REVISION_UNAVAILABLE", "the retained read no longer matches its handle", located);
        }
        const stored = KnowledgeReadIntentResultSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
        return { ...stored, retainedRef: retained };
      }
    }
    const answer = await port.run(scope, { envelope, request });
    // The inline budget: bodies in request order until their canonical bytes would pass the cap; digests always kept.
    let budget = READ_INTENT_INLINE_MAX_BYTES;
    const operations = answer.operations.map((operation) => {
      const body = operation.rows ?? operation.value;
      if (body === undefined) return { ...operation, bodyWithheld: false };
      const bytes = Buffer.byteLength(canonicalJson(body as JsonValue), "utf8");
      if (bytes <= budget) {
        budget -= bytes;
        return { ...operation, bodyWithheld: false };
      }
      const { rows: _rows, value: _value, ...withheld } = operation;
      return { ...withheld, bodyWithheld: true };
    });
    const document = KnowledgeReadIntentResultSchema.safeParse({
      ...answer,
      schemaVersion: READ_INTENT_RESULT_VERSION,
      operationId,
      operations,
      retainedRef: null,
    });
    if (!document.success) {
      throw refusal("INTERNAL", "the native read port answered a malformed read intent result", located);
    }
    let retainedRef: Ref | null = null;
    if (request.persist) {
      const stored = await custody.put(
        scope,
        Buffer.from(canonicalJson(document.data as unknown as JsonValue), "utf8"),
        "application/json",
      );
      retainedRef = { ...stored, version: READ_INTENT_RESULT_VERSION };
    }
    if (prior === null) {
      const at = this.clock();
      const started = await research.operations.start(scope, {
        operationId,
        operation: "knowledge.read_intent",
        requestId: envelope.requestId,
        request: requestValue,
        requestDigest,
        runId: null,
        subject: null,
        retryAfterMs: this.retryAfterMs,
        at,
      });
      if (!isTerminal(started.status.state)) {
        const running = await research.operations.transition(scope, {
          operationId,
          expectedRevision: started.status.revision,
          to: "running",
          at,
          retryAfterMs: this.retryAfterMs,
        });
        await research.operations.transition(scope, {
          operationId,
          expectedRevision: running.status.revision,
          to: "succeeded",
          at,
          resultRef: retainedRef,
        });
      }
    }
    return { ...document.data, retainedRef };
  }

  /**
   * WI-05 native receipt reconstruction (OUTPUT-CONTRACTS §5, RV-06): the native store committed the effect and its
   * protocol receipt was lost (crash after the native commit, before the K01 acknowledgment). The receipt is rebuilt
   * from the journaled ORIGINAL dispatch (envelope, caller origin, sequence) and the native receipt read back by the
   * binding, recorded first-writer-wins, and answered. Nothing is applied again. Not reconstructable (no commit stamp,
   * no journal, no read-back port) stays `UNRESOLVED_EFFECT`; presented other bytes refuse `EFFECT_CONFLICT`.
   */
  private async recoverNative(
    scope: AuthScope,
    backend: KnowledgeOperationBackend,
    effectKey: string,
    nativeOnly: NativeOnly,
    correlation: Correlation,
    presentedBoundDigest: string | null = null,
  ): Promise<OperationReceipt> {
    const effects = this.effects(backend);
    const commit = nativeOnly.commit;
    const port = backend.capabilities.has("apply") ? backend.apply() : null;
    const original =
      commit !== null && effects?.journaled !== undefined
        ? await effects.journaled(scope, effectKey, commit.dispatchId)
        : null;
    if (
      presentedBoundDigest !== null &&
      original !== null &&
      original.envelope.effect?.boundEffectDigest !== presentedBoundDigest
    ) {
      throw refusal("EFFECT_CONFLICT", "same effect key with different bound bytes", correlation);
    }
    if (commit === null || original === null || port?.reconstruct === undefined) {
      throw refusal(
        "UNRESOLVED_EFFECT",
        "the native receipt exists but its protocol receipt is unavailable and cannot be reconstructed",
        correlation,
      );
    }
    let applied: NativeApplied;
    try {
      applied = await port.reconstruct(scope, { envelope: original.envelope, commit });
    } catch (error) {
      throw refusal(
        "UNRESOLVED_EFFECT",
        `the committed native receipt cannot be read back: ${error instanceof Error ? error.message.slice(0, 300) : "unknown"}`,
        correlation,
      );
    }
    return this.buildReceipt(scope, backend, original.envelope, applied, "protocol", original, commit.committedAt);
  }

  /**
   * The trusted assessment operations (WI-03). The request is parsed strictly before any store is touched; the same
   * request id with other bytes refuses `EFFECT_CONFLICT`, the same bytes answer the recorded handle (a restart answers
   * it too: the operation row is durable). The result document is frozen into custody and named by `resultRef`.
   */
  private async assess(
    claims: CredentialClaims,
    scope: AuthScope,
    backend: KnowledgeOperationBackend,
    envelope: OperationEnvelope,
    correlation: Correlation,
  ): Promise<OperationHandle> {
    const research = this.research(backend, correlation);
    const operation = envelope.operation;
    const inline = envelope.input?.inlinePayload;
    const parse = <T>(schema: zod.ZodType<T>): T => {
      const parsed = schema.safeParse(inline);
      if (parsed.success) return parsed.data;
      throw refusal("INVALID_ENVELOPE", `the payload is not an exact ${operation} request`, correlation, {
        reason: "request_invalid",
        issues: parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`),
      });
    };
    let compute: () => Promise<AssessmentResult>;
    switch (operation) {
      case "report.observe": {
        const request = parse(ReportObservationRequestSchema);
        compute = () => observeReport(claims, scope, research, request, correlation);
        break;
      }
      case "report.seal": {
        const request = parse(ReportSealRequestSchema);
        compute = () => sealReport(scope, research, request, this.options.signingIssuer, correlation);
        break;
      }
      case "report.decide": {
        const request = parse(ReportUseRequestSchema);
        compute = () => decideUse(scope, research, request, correlation);
        break;
      }
      case "report.review": {
        const request = parse(ReportReviewRequestSchema);
        compute = () => reviewDecision(claims, scope, research, request, this.options.signingIssuer, correlation);
        break;
      }
      case "knowledge.read": {
        const request = parse(EvaluationContextRequestSchema);
        compute = () => evaluationContext(claims, scope, research, request, correlation);
        break;
      }
      default: {
        const request = parse(DecisionResolveRequestSchema);
        compute = () => resolveDecision(scope, research, request, this.clock(), correlation);
      }
    }
    const operationId = `op-${operation.replace(".", "-")}-${shortDigest({ tenant: scope.tenant, operation, requestId: envelope.requestId })}`;
    // The authenticated grant is part of the request identity: the same request id under another role conflicts.
    const requestValue = {
      operation,
      input: inline,
      caller: claims.origin.subject,
      evaluation: claims.evaluation ?? null,
    } as unknown as JsonValue;
    const prior = await research.operations.get(scope, operationId);
    if (prior !== null) {
      if (prior.requestDigest !== digestCanonical(requestValue)) {
        throw refusal("EFFECT_CONFLICT", `the request id already names another ${operation}`, correlation);
      }
      if (isTerminal(prior.status.state)) return prior.status.handle;
      // WI-03 B2: a crash after `start` left the operation open. Every compute is idempotent (records are
      // read through or replayed by id), so recompute and finish the same operation.
    }
    const result = await compute();
    const stored = await research.binding.custody.put(
      scope,
      Buffer.from(canonicalJson(result.document as JsonValue), "utf8"),
      "application/json",
    );
    const resultRef: Ref = { ...stored, version: ASSESSMENT_RESULTS[operation] ?? "artifact.v1" };
    const started =
      prior ??
      (await research.operations.start(scope, {
        operationId,
        operation,
        requestId: envelope.requestId,
        request: requestValue,
        requestDigest: digestCanonical(requestValue),
        runId: result.runId,
        subject: result.subject,
        retryAfterMs: this.retryAfterMs,
        at: this.clock(),
      }));
    await this.finishOperation(research, scope, operationId, started, resultRef);
    return started.status.handle;
  }

  /**
   * Drive one open operation to `succeeded` with `resultRef` by compare-and-set. A concurrent caller that already
   * advanced it wins: on a revision conflict the current record is re-read and the transitions continue from it.
   */
  private async finishOperation(
    research: ResearchServices,
    scope: AuthScope,
    operationId: string,
    record: Awaited<ReturnType<ResearchServices["operations"]["start"]>>,
    resultRef: Ref,
  ): Promise<void> {
    let current = record;
    for (let attempt = 0; attempt < 8 && !isTerminal(current.status.state); attempt += 1) {
      const to = current.status.state === "running" ? "succeeded" : "running";
      try {
        current = await research.operations.transition(scope, {
          operationId,
          expectedRevision: current.status.revision,
          to,
          at: this.clock(),
          ...(to === "succeeded" ? { resultRef } : { retryAfterMs: this.retryAfterMs }),
        });
      } catch (error) {
        const latest = await research.operations.get(scope, operationId);
        if (latest === null || latest.status.revision === current.status.revision) throw error;
        current = latest;
      }
    }
  }

  /** `report.derive`: deterministic compilation of supported assertion fields through a declared mapping (handle). */
  private async derive(
    scope: AuthScope,
    backend: KnowledgeOperationBackend,
    envelope: OperationEnvelope,
    correlation: Correlation,
  ): Promise<OperationHandle> {
    const research = this.research(backend, correlation);
    const request = DeriveRequestSchema.parse(envelope.input?.inlinePayload);
    const report = this.reportOf(envelope, correlation);
    const operationId = `op-derive-${shortDigest({ tenant: scope.tenant, operation: "report.derive", requestId: envelope.requestId })}`;
    const requestValue = { operation: "report.derive", input: envelope.input?.inlinePayload } as unknown as JsonValue;
    const prior = await research.operations.get(scope, operationId);
    if (prior !== null) {
      if (prior.requestDigest !== digestCanonical(requestValue)) {
        throw refusal("EFFECT_CONFLICT", "the request id already names another derivation", correlation);
      }
      return prior.status.handle;
    }
    const runId = await research.locator.runOf(scope, report);
    if (runId === null)
      throw refusal("EXACT_REVISION_UNAVAILABLE", "the exact report revision is unknown", correlation);
    const derived = await deriveReport(
      scope,
      research.binding,
      { runId, report, mapping: request.mapping },
      correlation,
    );
    const stored = await research.binding.custody.put(
      scope,
      Buffer.from(canonicalJson(derived.document as unknown as JsonValue), "utf8"),
      "application/json",
    );
    const resultRef: Ref = { ...stored, version: "research-core.derived_proposals.v1" };
    const at = this.clock();
    const started = await research.operations.start(scope, {
      operationId,
      operation: "report.derive",
      requestId: envelope.requestId,
      request: requestValue,
      requestDigest: digestCanonical(requestValue),
      runId,
      subject: report,
      retryAfterMs: this.retryAfterMs,
      at,
    });
    if (!isTerminal(started.status.state)) {
      const running = await research.operations.transition(scope, {
        operationId,
        expectedRevision: started.status.revision,
        to: "running",
        at,
        retryAfterMs: this.retryAfterMs,
      });
      await research.operations.transition(scope, {
        operationId,
        expectedRevision: running.status.revision,
        to: derived.state,
        at,
        resultRef,
      });
    }
    return started.status.handle;
  }

  async status(token: string | null | undefined, operationId: string): Promise<OperationStatus> {
    const claims = await this.authenticate(token);
    const correlation: Correlation = { operationId, dispatchId: claims.dispatchId };
    try {
      const scope = await this.admit(claims, { operation: "operation.get", envelope: null });
      const backend = this.backendFor(scope, correlation);
      const research = this.research(backend, correlation);
      const record = await research.operations.get(scope, operationId);
      if (record === null || !sameHandle(record.status.handle, this.handleOf(scope, operationId))) {
        throw refusal("NOT_FOUND", "unknown operation handle", correlation);
      }
      if (record.operation === "report.assess" && !isTerminal(record.status.state)) {
        this.drive(scope, backend, record.status.handle);
      }
      return record.status;
    } catch (error) {
      throw new ProtocolRefusal(toProtocolError(error, correlation));
    }
  }

  async cancel(token: string | null | undefined, operationId: string, body: unknown): Promise<OperationStatus> {
    const claims = await this.authenticate(token);
    const correlation: Correlation = { operationId, dispatchId: claims.dispatchId };
    try {
      const scope = await this.admit(claims, { operation: "operation.cancel", envelope: null });
      const { cancelRequestId } = CancelBodySchema.parse(body);
      this.options.dispatches.record(claims.dispatchId, digestCanonical({ cancel: operationId, cancelRequestId }));
      const backend = this.backendFor(scope, correlation);
      const research = this.research(backend, correlation);
      const record = await research.operations.get(scope, operationId);
      if (record === null || !sameHandle(record.status.handle, this.handleOf(scope, operationId))) {
        throw refusal("NOT_FOUND", "unknown operation handle", correlation);
      }
      const cancelled = await research.operations.cancel(scope, { operationId, cancelRequestId, at: this.clock() });
      if (record.operation === "report.assess" && cancelled.status.state === "cancelling" && research.assessment) {
        // Native cancellation: the runner settles `cancelling -> cancelled` at its next boundary; settle now if idle.
        const key = `${scope.tenant}/${operationId}`;
        if (!this.running.has(key)) return await research.assessment.run(scope, cancelled.status.handle);
      }
      return cancelled.status;
    } catch (error) {
      throw new ProtocolRefusal(toProtocolError(error, correlation));
    }
  }

  async receipt(token: string | null | undefined, effectKey: string): Promise<ReceiptLookup> {
    const claims = await this.authenticate(token);
    const correlation: Correlation = { effectKey, dispatchId: claims.dispatchId };
    try {
      const scope = await this.admit(claims, {
        operation: "receipt.get",
        envelope: null,
        effectKey,
      });
      const backend = this.backendFor(scope, correlation);
      const effects = this.effects(backend);
      if (effects === null) throw refusal("SCHEMA_UNSUPPORTED", "this binding records no effects", correlation);
      let found: Awaited<ReturnType<EffectLedger["lookup"]>>;
      try {
        found = await effects.lookup(scope, effectKey);
      } catch (error) {
        return ReceiptLookupSchema.parse({
          disposition: "unresolved",
          error: toProtocolError(error, correlation),
        });
      }
      if (found === null) return { disposition: "not_found", checkedAt: this.clock() };
      if (found.state === "native_only") {
        // WI-05: reconcile the committed native effect into its original protocol receipt (read-back only; nothing is
        // applied). What cannot be reconstructed stays `unresolved`.
        try {
          found = { state: "found", receipt: await this.recoverNative(scope, backend, effectKey, found, correlation) };
        } catch (error) {
          return ReceiptLookupSchema.parse({ disposition: "unresolved", error: toProtocolError(error, correlation) });
        }
      }
      // A `pending_dispatch` receipt is immutable; its delivery state is composed now from the outbox acknowledgment.
      // The host settles the effect only on delivery `applied` (verified acknowledgment) or `revoked`.
      if (found.receipt.outcome === "pending_dispatch" && backend.capabilities.has("delivery")) {
        try {
          const delivery = await backend.delivery().delivery(scope, found.receipt);
          if (delivery !== null)
            return ReceiptLookupSchema.parse({ disposition: "found", receipt: found.receipt, delivery });
        } catch (error) {
          return ReceiptLookupSchema.parse({ disposition: "unresolved", error: toProtocolError(error, correlation) });
        }
      }
      return { disposition: "found", receipt: found.receipt };
    } catch (error) {
      throw new ProtocolRefusal(toProtocolError(error, correlation));
    }
  }

  async describe(token: string | null | undefined): Promise<BindingDescriptor> {
    const claims = await this.authenticate(token);
    const correlation: Correlation = { dispatchId: claims.dispatchId };
    try {
      const scope = await this.admit(claims, { operation: "knowledge.describe", envelope: null });
      const backend = this.options.backends.find(
        (candidate) => candidate.application === scope.application && candidate.binding === scope.binding,
      );
      if (backend === undefined) throw refusal("SCOPE_DENIED", "binding not installed", correlation);
      return this.descriptorFor(backend);
    } catch (error) {
      throw new ProtocolRefusal(toProtocolError(error, correlation));
    }
  }

  /**
   * Exact bytes of one custody artifact this binding holds (report body, ledger, package manifest, assessment result),
   * re-verified against the requested digest. An executor extension beside the five K01 routes (K01 v2 defines no
   * bytes route); authorized by a `knowledge.read` grant in the credential's scope.
   */
  async artifact(
    token: string | null | undefined,
    artifactId: string,
    digest: string,
  ): Promise<{ bytes: Uint8Array; digest: string }> {
    const claims = await this.authenticate(token);
    const correlation: Correlation = { dispatchId: claims.dispatchId };
    try {
      const scope = await this.admit(claims, { operation: "knowledge.read", envelope: null });
      const backend = this.backendFor(scope, correlation);
      const research = this.research(backend, correlation);
      const ref = RefSchema.parse({
        kind: "artifact",
        id: artifactId,
        version: "artifact.v1",
        digest,
        tenant: scope.tenant,
        binding: scope.binding,
      }) as Ref<"artifact">;
      let bytes: Uint8Array;
      try {
        bytes = await research.binding.custody.get(scope, ref);
      } catch {
        throw refusal("EXACT_REVISION_UNAVAILABLE", "no artifact with that id in this scope", correlation);
      }
      if (digestBytes(bytes) !== digest) {
        throw refusal("EXACT_REVISION_UNAVAILABLE", "the artifact bytes do not have the requested digest", correlation);
      }
      return { bytes, digest };
    } catch (error) {
      throw new ProtocolRefusal(toProtocolError(error, correlation));
    }
  }

  /** The K01 descriptor, read from the backend's declared capabilities only. */
  descriptorFor(backend: KnowledgeOperationBackend): BindingDescriptor {
    const has = (capability: BackendCapability) =>
      backend.unsupportedReason === null && backend.capabilities.has(capability);
    const research = has("research") ? backend.research() : null;
    const operations: OperationName[] = ["knowledge.describe"];
    if (research !== null) {
      operations.push("knowledge.read", "report.register", "operation.get", "operation.cancel");
      if (research.assessment !== null) operations.push("report.assess");
      operations.push("report.derive", "report.observe", "report.seal", "report.decide", "report.review");
      operations.push("decision.resolve");
    }
    if (has("apply")) operations.push("knowledge.apply");
    if (has("apply") && backend.apply().preview !== undefined) operations.push("knowledge.plan_preview");
    // `knowledge.read_intent` records each read in the research operation store.
    if (has("read_intent") && research !== null) operations.push("knowledge.read_intent");
    if (has("native_receipt_lookup")) operations.push("receipt.get");
    const ordered = OPERATIONS.filter((operation) => operations.includes(operation));
    return BindingDescriptorSchema.parse({
      protocolVersions: [PROTOCOL_VERSION],
      binding: backend.binding,
      application: backend.application,
      coreSchemas: [...backend.coreSchemas],
      operations: ordered,
      // WI-03 S7: what runs the census of `report.assess` (a scripted double only on a disposable installation).
      auditorKind:
        research === null || research.auditor === null
          ? "none"
          : research.auditor instanceof ScriptedAuditorDiscovery
            ? "scripted"
            : "independent",
      reportKinds: research === null ? [] : [...new Set(research.kinds.list().map((kind) => kind.id))].sort(),
      media: research === null ? [] : ["text.markdown", "application.json"],
      guarantees: {
        exactRead: "exact_revision",
        receiptLookup: has("native_receipt_lookup") ? "by_effect_key" : "unsupported",
        nativeCancellation: backend.nativeCancellation,
        admission: has("apply") ? "exact_use_decision" : "unsupported",
        // Epoch-checked revocation is an admission guarantee: the apply port checks the decision against the epoch.
        revocation: has("apply") && has("revocation") ? "epoch_checked" : "unsupported",
        writeAtomicity: backend.writeAtomicity,
      },
      signingIssuer: this.options.signingIssuer,
      pinnedSchema: backend.pinnedSchema,
      qualification: [...(this.options.qualification ?? [])],
      // The service start instant: the descriptor (and its digest, which MC records at startup) is stable per process.
      describedAt: this.startedAt,
    });
  }
}

function safeKindRef(kinds: ResearchServices["kinds"], scope: AuthScope, id: string): Ref<"report_kind"> | null {
  try {
    return kinds.ref(scope, id);
  } catch {
    return null;
  }
}

/** `details` of a selected-read refusal: the reason and, when one handle is at fault, its kind and id (never content). */
function readRefusal(reason: ReadRefusalReason, handle?: Ref): { [key: string]: JsonDocument } {
  return handle === undefined ? { reason } : { reason, handle: { kind: handle.kind, id: handle.id } };
}

/** Distinct handles sorted by id (first occurrence wins; a revision names one version per id). */
function byId<K extends Ref["kind"]>(refs: readonly Ref<K>[]): Ref<K>[] {
  const seen = new Map<string, Ref<K>>();
  for (const ref of refs) if (!seen.has(ref.id)) seen.set(ref.id, ref);
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sameHandle(a: OperationHandle, b: OperationHandle): boolean {
  return (
    a.protocolVersion === b.protocolVersion &&
    a.tenant === b.tenant &&
    a.application === b.application &&
    a.binding === b.binding &&
    a.operationId === b.operationId
  );
}

export type { ProtocolErrorCode };

const RECORD_KINDS: Readonly<Record<string, string>> = {
  TASK: "task",
  FRAGMENT: "fragment",
  ASSERTION: "assertion",
  SUPPORT_SET: "support_set",
};

/**
 * W1 D19: a binding's write-once refusal (`<KIND>_CONFLICT: <id> holds another record`, `<KIND>_DIGEST_EXISTS: this
 * record is stored as <id>`; the in-memory and PostgreSQL bindings share the wording) as a typed collision.
 */
export function recordCollision(
  message: string,
  code?: unknown,
): { reason: "record_id_conflict" | "record_digest_exists"; record: string; id: string } | null {
  // A typed binding error (`ComponentError.code`, review N3) decides the kind; the message supplies the id.
  if (typeof code === "string" && !/^(TASK|FRAGMENT|ASSERTION|SUPPORT_SET)_(CONFLICT|DIGEST_EXISTS)$/.test(code)) {
    return null;
  }
  const patterns = [
    ["record_id_conflict", /^(TASK|FRAGMENT|ASSERTION|SUPPORT_SET)_CONFLICT: (\S+) holds another record/],
    ["record_digest_exists", /^(TASK|FRAGMENT|ASSERTION|SUPPORT_SET)_DIGEST_EXISTS: this record is stored as (\S+)/],
  ] as const;
  for (const [reason, pattern] of patterns) {
    const [, kind, id] = pattern.exec(message) ?? [];
    const record = kind === undefined ? undefined : RECORD_KINDS[kind];
    if (record !== undefined && id !== undefined) return { reason, record, id };
  }
  return null;
}

/** The typed refusal of a record collision (review B2): the first collision named, every collision listed. */
function collisionRefusal(
  collision: { reason: "record_id_conflict" | "record_digest_exists"; record: string; id: string },
  correlation: Correlation,
  all: readonly { reason: string; record: string; id: string }[] = [collision],
): ProtocolRefusal {
  return refusal(
    "EFFECT_CONFLICT",
    collision.reason === "record_id_conflict"
      ? `${collision.record} ${collision.id} is already registered with other content; register it under a new id`
      : `this ${collision.record} is already registered as ${collision.id}; reference that id`,
    correlation,
    {
      reason: collision.reason,
      record: collision.record,
      id: collision.id,
      collisions: all.slice(0, 50).map((item) => ({ reason: item.reason, record: item.record, id: item.id })),
    },
  );
}
