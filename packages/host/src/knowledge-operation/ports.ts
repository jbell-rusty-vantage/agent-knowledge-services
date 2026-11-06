import type {
  AuditorDiscovery,
  OperationStore,
  ReportAssessmentService,
  ReviewService,
  ReportKindCatalog,
  ResearchBinding,
  ResearchCoordinator,
} from "@aiengineer/knowledge-application";
import type {
  Delivery,
  EffectBinding,
  JsonDocument,
  KnowledgePlanPreview,
  KnowledgeReadIntentRequest,
  KnowledgeReadIntentResult,
  OperationEnvelope,
  OperationReceipt,
  Ref,
} from "@aiengineer/knowledge-operation-protocol";
import type { AuthScope } from "@aiengineer/knowledge-research-core";
import type { BackendCapability } from "./registry.js";

/**
 * Ports of the K01 knowledge-operation service (transport-free). One {@link KnowledgeOperationBackend} per installed
 * (application, binding); the service selects it from the authenticated scope. A backend declares the capabilities it
 * serves ({@link BackendCapability}); the accessor of an undeclared one throws `BackendCapabilityMissing`, the service
 * refuses it typed (`SCHEMA_UNSUPPORTED`) and `describe` leaves it out, so the descriptor and the backend conformance
 * suite state the same facts.
 */
export type { BackendCapability };

/** One journaled K01 dispatch of an effect (component 2.5.0 `effect_dispatch`), written before native dispatch. */
export interface JournaledDispatch {
  readonly effectKey: string;
  readonly dispatchId: string;
  /** Dense per effect, durable across executor restarts (the receipt's `dispatchSequence`). */
  readonly dispatchSequence: number;
  readonly envelopeDigest: string;
  /** The original envelope (no credential): the request, its caller origin, use and governors. */
  readonly envelope: OperationEnvelope;
  /** The authenticated current caller origin of this dispatch (the receipt's `currentCallerOrigin`). */
  readonly callerOrigin: OperationReceipt["effect"]["currentCallerOrigin"];
}

/** Which journaled dispatch committed the effect natively (component 2.5.0 `effect_commit`, inside the native txn). */
export interface EffectCommit {
  readonly dispatchId: string;
  /** Locates the native receipt: AI Engineer `{receiptId}`, Biotech `{outboxDispatchId}`. */
  readonly nativeRef: JsonDocument;
  readonly committedAt: string;
}

/**
 * `native_only`: the native store committed the effect but no K01 document exists for it. `commit` names the
 * journaled dispatch that committed it (null for a commit written before 2.5.0 or outside K01: it cannot be
 * reconstructed and stays unresolved, never applied again).
 */
export interface NativeOnly {
  readonly state: "native_only";
  readonly commit: EffectCommit | null;
}

export type EffectLookup = { readonly state: "found"; readonly receipt: OperationReceipt } | NativeOnly | null;

/**
 * Durable per-effect record (capability `native_receipt_lookup`): the component `effect` / `effect_receipt` rows plus
 * the K01 receipt document, looked up by effect key (`receipt.get`).
 */
export interface EffectLedger {
  /** Bind the effect once (idempotent for the same key and bound digest); another digest refuses `EFFECT_CONFLICT`. */
  bind(scope: AuthScope, effect: EffectBinding): Promise<void>;
  /**
   * `found`: the K01 receipt of the dispatch that applied it. `native_only`: the native store committed the effect but
   * no K01 document exists for it (lost between the native commit and the protocol receipt). `null`: no receipt.
   */
  lookup(scope: AuthScope, effectKey: string): Promise<EffectLookup>;
  /**
   * Journal a dispatch before native dispatch (WI-05; component 2.5.0), in its own committed transaction: idempotent
   * for the same dispatch id and envelope; `EFFECT_CONFLICT` when the bound bytes or originating origin differ from an
   * earlier dispatch or the bound effect. Absent on a ledger that cannot reconstruct receipts.
   */
  journal?(scope: AuthScope, envelope: OperationEnvelope): Promise<JournaledDispatch>;
  /** The journaled dispatch of an effect (the original request a reconstructed receipt names). */
  journaled?(scope: AuthScope, effectKey: string, dispatchId: string): Promise<JournaledDispatch | null>;
  /**
   * Fence a journaled dispatch before reporting it not committed (component 2.5.0 `abandon_effect_dispatch`): under
   * the commit stamp's per-effect lock, `committed` when the effect is committed natively (a commit in flight is
   * waited for), else `abandoned`, after which the dispatch's native commit refuses `DISPATCH_ABANDONED`.
   */
  abandon?(scope: AuthScope, effectKey: string, dispatchId: string): Promise<"abandoned" | "committed">;
  /**
   * Persist the K01 receipt document (first writer wins); returns the stored receipt, which may be a concurrent
   * winner's. `native: true` also writes the component `effect_receipt` row (an effect whose native store is this
   * component, e.g. `report.register`); `false` when the native transaction already wrote its own (`knowledge.apply`).
   */
  record(
    scope: AuthScope,
    receipt: OperationReceipt,
    options?: { readonly native?: boolean },
  ): Promise<OperationReceipt>;
}

/** The authoritative revocation epoch an admission is checked against (capability `revocation`). */
export interface RevocationEpochReader {
  epoch(scope: AuthScope): Promise<number>;
}

/** Find the run that holds an exact report revision (the binding indexes revisions by id). */
export interface ReportLocator {
  runOf(scope: AuthScope, report: Ref<"report">): Promise<string | null>;
  /** Whether a revision id (`<reportId>-r<revision>`) is already registered in this scope (any content). */
  revisionExists(scope: AuthScope, revisionId: string): Promise<boolean>;
  remember?(scope: AuthScope, report: Ref<"report">, runId: string): void;
}

/**
 * Read-time delivery state of a `pending_dispatch` effect (capability `delivery`; marker_plus_outbox bindings; the
 * receipt is immutable).
 */
export interface DeliveryReader {
  delivery(scope: AuthScope, receipt: OperationReceipt): Promise<Delivery | null>;
}

/** Durable single use of credentials (K07; component 2.3.0 `credential_use`), checked before any operation. */
export interface CredentialUseStore {
  consume(
    scope: AuthScope,
    input: {
      readonly issuer: string;
      readonly jti: string;
      readonly dispatchId: string;
      readonly expiresAt: Date;
      /** The verifier clock (the same instant the credential window was checked at). */
      readonly now: Date;
    },
  ): Promise<"consumed" | "replay" | "dispatch_reused" | "expired">;
}

/**
 * `knowledge.apply` through a native exact-use transaction (capability `apply`; SV-08 AI Engineer ingestion, K06 Biotech
 * admission). The port lives in its binding package; the host keeps only this type.
 */
export interface NativeApplied {
  readonly outcome: OperationReceipt["outcome"];
  readonly nativeReceiptRef: Ref;
  readonly affectedRefs: readonly Ref[];
  readonly concurrencyToken: OperationReceipt["concurrencyToken"];
  readonly processedRevocationEpoch: number;
  readonly details: JsonDocument | null;
}

export interface KnowledgeApplyPort {
  /** The native contract the envelope must name for `knowledge.apply` on this binding. */
  readonly nativeContract: { readonly name: string; readonly version: string };
  /**
   * Apply natively. With `journaled` (the host journaled this dispatch first), a port that `reconstruct`s stamps its
   * native commit with that dispatch inside the native transaction (component `record_effect_commit`), so a lost
   * protocol receipt can be rebuilt for it. Without it, no stamp is written.
   */
  apply(
    scope: AuthScope,
    input: {
      readonly envelope: OperationEnvelope;
      readonly intent: JsonDocument;
      readonly journaled?: JournaledDispatch | null;
    },
  ): Promise<NativeApplied>;
  /**
   * WI-05: read back the committed native receipt `commit` names and return exactly what `apply` returned for the
   * original dispatch (`envelope` is that journaled dispatch's envelope). Read-only: never applies. Throws when the
   * native receipt cannot be read back (the effect stays unresolved).
   */
  reconstruct?(
    scope: AuthScope,
    input: { readonly envelope: OperationEnvelope; readonly commit: EffectCommit },
  ): Promise<NativeApplied>;
  /**
   * Sprint OC `knowledge.plan_preview`: run the native planner for the same envelope and intent `apply` takes, without
   * the use-decision fields, and answer exactly the plan-level values `apply` would compute in the current native state
   * (`knowledge-plan-preview.v1`). Read-only: binds no effect, journals nothing, admits nothing. A port without it does
   * not serve the operation (the descriptor leaves it out; the service refuses `SCHEMA_UNSUPPORTED`).
   */
  preview?(
    scope: AuthScope,
    input: { readonly envelope: OperationEnvelope; readonly intent: JsonDocument },
  ): Promise<KnowledgePlanPreview>;
}

/**
 * What a native read-intent port answers: the `knowledge-read-intent-result.v1` document without the fields the host
 * owns (`schemaVersion`, the recorded `operationId`, the custody `retainedRef`). Bodies are complete (`bodyWithheld`
 * false); the host applies the inline budget. Digests are K01 `digestCanonical` over protocol JSON.
 */
export type ReadIntentAnswer = Omit<KnowledgeReadIntentResult, "schemaVersion" | "operationId" | "retainedRef">;

/**
 * `knowledge.read_intent` over a binding's knowledge store (capability `read_intent`; OVE-204 slice 4). The port lives in
 * its binding package and enforces that binding's allowlist and tenant mapping; the host records the operation.
 * Read-only: with `request.persist` it may retain the native snapshot in the binding's own artifact ledger.
 */
export interface KnowledgeReadIntentPort {
  /** The native contract the envelope must name (`knowledge-read-intent/v1`). */
  readonly nativeContract: { readonly name: string; readonly version: string };
  run(
    scope: AuthScope,
    input: { readonly envelope: OperationEnvelope; readonly request: KnowledgeReadIntentRequest },
  ): Promise<ReadIntentAnswer>;
}

export interface ResearchServices {
  readonly binding: ResearchBinding;
  readonly coordinator: ResearchCoordinator;
  /** Reviewer adjudication and exact successor decisions (`report.review`, WI-03). */
  readonly review: ReviewService;
  readonly operations: OperationStore;
  readonly kinds: ReportKindCatalog;
  /** `null` when no independent auditor is configured: `report.assess` then refuses `INDEPENDENCE_UNPROVEN`. */
  readonly assessment: ReportAssessmentService | null;
  readonly auditor: AuditorDiscovery | null;
  readonly locator: ReportLocator;
}

export interface KnowledgeOperationBackend {
  readonly application: string;
  readonly binding: string;
  /** What this instance serves; each accessor below throws `BackendCapabilityMissing` for an undeclared capability. */
  readonly capabilities: ReadonlySet<BackendCapability>;
  /** Why the backend serves nothing yet (e.g. the Biotech binding is not wired); answered as `SCHEMA_UNSUPPORTED`. */
  readonly unsupportedReason: string | null;
  readonly pinnedSchema: { readonly name: string; readonly version: string; readonly digest: string };
  readonly coreSchemas: readonly string[];
  readonly writeAtomicity: "single_transaction" | "marker_plus_outbox";
  readonly nativeCancellation: "native" | "stop_dispatch_and_reconcile";
  readonly credentials: CredentialUseStore;
  /** `research`: register/assess/read/derive/status/cancel. */
  research(): ResearchServices;
  /** `native_receipt_lookup`: the effect ledger (`receipt.get`, receipt-first deduplication). */
  effects(): EffectLedger;
  /** `revocation`: the authoritative revocation epoch. */
  revocation(): RevocationEpochReader;
  /** `apply`: `knowledge.apply` through the binding's native exact-use port. */
  apply(): KnowledgeApplyPort;
  /** `delivery`: the delivery state of a `pending_dispatch` receipt. */
  delivery(): DeliveryReader;
  /** `read_intent`: `knowledge.read_intent` through the binding's native read port. */
  readIntent(): KnowledgeReadIntentPort;
  close(): Promise<void>;
}
