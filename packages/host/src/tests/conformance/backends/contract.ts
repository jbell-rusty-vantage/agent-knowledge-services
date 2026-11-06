import type { Digest, JsonValue } from "@aiengineer/knowledge-operation-protocol";
import type { AuthScope } from "@aiengineer/knowledge-research-core";
import type { BindingConfig } from "../../../knowledge-operation/config.js";
import type { BackendRegistration, HostInjection } from "../../../knowledge-operation/registry.js";

/**
 * Knowledge backend conformance (Sprint OC R0 froze the entry shape; R5 adds the store-backed checks; design §10). One
 * entry per registered backend, each opening its own disposable store (the `sprint-v-pg17` PostgreSQL container for both
 * PostgreSQL bindings). The checks a backend runs are selected by `registration.describe().capabilities`; a check a
 * backend cannot run is a declared exception citing where it is proven instead, reported as its own test, never skipped.
 */
export const CONFORMANCE_CHECKS = [
  /**
   * The declaration alone: known capabilities, once each; conditional capabilities name a known condition; no
   * `readback` (no port serves it); apply ⇔ nativeContract; apply ⇒ native_receipt_lookup and revocation.
   */
  "declaration",
  /** A created instance serves exactly what `describe()` declares (plus each met condition), as the K01 descriptor says. */
  "describe_honesty",
  /** `research`: report.register receipt, receipt.get, and the exact report package read back byte for byte. */
  "report_register_read",
  /**
   * `research` (WI-02 readSelected): a members read answers exactly the selected assertion/evidence handles with their
   * exact records and records the purpose; an undeclared purpose, a foreign, unknown or edited handle, an unknown
   * revision and a legacy `research-report-package/v1` read each refuse with their typed code and reason.
   */
  "selected_read",
  /**
   * `research` (Sprint OC WI-03 trusted assessment): observe -> seal -> decideUse -> review -> resolve through K01 with
   * separate evaluator credentials. The producer credential cannot observe; a self-asserted role conflicts; only the
   * auditor submits the census; the seal is the exact VerificationRun; an ungrounded disagreement holds; an official
   * use waits on review; an unqualified, stale or mis-signed review refuses; the exact successor resolves from a fresh
   * backend instance; a request id names one request.
   */
  "trusted_assessment",
  /**
   * `read_intent` (OVE-204): `knowledge.read_intent` answers `knowledge-read-intent-result.v1` in the same call and is
   * recorded as one operation row on the backend's store (operation name, request id, `{operation, readIntent}`
   * request, no run, no subject, succeeded, no result ref); the same request id answers the same operation id, another
   * request under it refuses EFFECT_CONFLICT; `persist` names the frozen result (`retainedRef` = row `resultRef`).
   */
  "read_intent_recorded",
  /** `apply`: knowledge.apply answers a receipt receipt.get finds; a duplicate dispatch answers the same, one native write. */
  "apply_receipt",
  /** `apply`: the native commit lands, the protocol receipt write is lost, a fresh instance reconciles to the native receipt. */
  "lost_ack_reconciliation",
  /** `apply`: a revocation before dispatch refuses STALE_DECISION with nothing written (and stops a queued dispatch). */
  "revocation_before_dispatch",
  /**
   * Only the premise of data class admission at this port: the strict K01 envelope has no data class field, so one
   * that names a data class is refused unread. The ceiling itself is enforced by Mission Control's resolver.
   */
  "data_class_premise",
  /**
   * No response, refusal or thrown error of the session carries a driver object (pg Pool/Client, Neo4j Driver):
   * receipts (including `details`), descriptors, lookups, statuses and protocol errors are plain JSON, and no error
   * other than a K01 refusal crosses the service.
   */
  "no_driver_type",
] as const;
export type ConformanceCheck = (typeof CONFORMANCE_CHECKS)[number];

export interface DeclaredException {
  readonly check: ConformanceCheck;
  readonly reason: string;
  readonly evidence: readonly string[];
}

/** A native apply plan for one fresh effect against the sealed conformance run. */
export interface ApplyPlan {
  /** The plan-level bound effect digest the use decision binds (K01 `effect.boundEffectDigest`). */
  readonly boundEffectDigest: Digest;
  readonly targetSchema: string;
  readonly normalizedValues: Readonly<Record<string, string>>;
  /** Fixture state the payload builder needs (opaque to the suite). */
  readonly state: JsonValue;
}

/**
 * Store-specific apply fixtures (the suite drives everything else through the K01 service and the backend port). The
 * suite registers, assesses and seals a report run and decides its use; the fixture shapes the native payload.
 */
export interface ApplyFixture {
  plan(input: {
    readonly scope: AuthScope;
    readonly runId: string;
    /** The frozen report revision of the run (`loadRunContext(...).report.revision`). */
    readonly revision: unknown;
    readonly suffix: string;
  }): ApplyPlan;
  /** The `knowledge.apply` inline payload for the admitted decision. */
  payload(
    plan: ApplyPlan,
    exactUse: {
      readonly scope: AuthScope;
      readonly effectKey: string;
      readonly useDecisionId: string;
      readonly processedEpoch: number;
      readonly normalizedValuesDigest: string;
    },
  ): JsonValue;
  /** Native writes the store holds for an effect key (domain rows, outbox rows): 0 or 1. */
  nativeWrites(scope: AuthScope, effectKey: string): Promise<number>;
  /** Advance the tenant's authoritative revocation epoch (an invalidation), as a reviewer correction would. */
  revoke(scope: AuthScope): Promise<void>;
  /** `delivery` backends: stop an admitted, not yet consumed dispatch of the effect (stop-dispatch cancellation). */
  stopDispatch?(scope: AuthScope, effectKey: string): Promise<void>;
}

export interface DisposableStore {
  readonly config: BindingConfig;
  /** The executor environment the configuration's `databaseUrlEnv` names (never logged). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Host injection beyond the suite's own (report kinds, the scripted auditor): run-seal keys, an apply port. */
  readonly injection?: Partial<Pick<HostInjection, "seal" | "apply" | "readIntent">>;
  /** Required when the registration declares `apply`. */
  readonly apply?: ApplyFixture;
  close(): Promise<void>;
}

export interface BackendConformance {
  readonly registration: BackendRegistration;
  openDisposable(): Promise<DisposableStore>;
  /** Only checks the backend genuinely cannot run with its store present. */
  readonly exceptions: readonly DeclaredException[];
  /**
   * Set when this environment has no disposable store: the store-backed checks are visible skips naming `reason`,
   * or failures when `required` (CI, `KS_REQUIRE_CONFORMANCE_STORE=1`). Never a passing exception.
   */
  readonly storeUnavailable?: { readonly reason: string; readonly required: boolean };
}
