import { InMemoryResearchBinding } from "@aiengineer/knowledge-application";
import {
  type EffectBinding,
  type JsonDocument,
  type OperationEnvelope,
  type OperationReceipt,
  type Ref,
  digestCanonical,
  envelopeDigest,
} from "@aiengineer/knowledge-operation-protocol";
import type { AuthScope } from "@aiengineer/knowledge-research-core";
import {
  CORE_SCHEMAS,
  InMemoryCredentialUseStore,
  type ResearchBackendOptions,
  SYSTEM_CLOCK,
  researchServices,
} from "./backends.js";
import { refusal } from "./errors.js";
import type {
  EffectCommit,
  EffectLedger,
  EffectLookup,
  JournaledDispatch,
  KnowledgeOperationBackend,
  ReportLocator,
} from "./ports.js";
import { type BackendRegistration, composeBackend } from "./registry.js";

/**
 * The process-local backend (conformance tests, local demos): the research services over the application's
 * `InMemoryResearchBinding` and an in-memory effect ledger. Nothing survives the instance, so it declares no revocation
 * epoch (nothing can revoke) and no durable reconciliation.
 */
export class InMemoryEffectLedger implements EffectLedger {
  readonly bound = new Map<string, string>();
  readonly receipts = new Map<string, OperationReceipt>();
  /** WI-05: the dispatch journal and the native commit stamps (same rules as component 2.5.0, process-local). */
  readonly dispatches = new Map<string, JournaledDispatch[]>();
  readonly commits = new Map<string, EffectCommit>();

  async bind(scope: AuthScope, effect: EffectBinding): Promise<void> {
    const key = `${scope.tenant}/${effect.effectKey}`;
    const existing = this.bound.get(key);
    if (existing !== undefined && existing !== effect.boundEffectDigest) {
      throw refusal("EFFECT_CONFLICT", "same effect key with different bound bytes", { effectKey: effect.effectKey });
    }
    this.bound.set(key, effect.boundEffectDigest);
  }

  async lookup(scope: AuthScope, effectKey: string): Promise<EffectLookup> {
    const key = `${scope.tenant}/${effectKey}`;
    const receipt = this.receipts.get(key);
    if (receipt !== undefined) return { state: "found" as const, receipt };
    const commit = this.commits.get(key);
    return commit === undefined ? null : { state: "native_only" as const, commit };
  }

  async journal(scope: AuthScope, envelope: OperationEnvelope): Promise<JournaledDispatch> {
    const effect = envelope.effect;
    if (effect === null) throw refusal("SCHEMA_UNSUPPORTED", "only an effectful dispatch is journaled", {});
    const key = `${scope.tenant}/${effect.effectKey}`;
    const rows = this.dispatches.get(key) ?? [];
    const digest = envelopeDigest(envelope);
    const same = rows.find((row) => row.dispatchId === envelope.dispatchId);
    if (same !== undefined) {
      if (same.envelopeDigest !== digest) {
        throw refusal("EFFECT_CONFLICT", "the dispatch id is journaled with another envelope", {
          effectKey: effect.effectKey,
        });
      }
      return same;
    }
    // Only the bound effect binds the key; an uncommitted (e.g. refused) journaled dispatch never pins it.
    const bound = this.bound.get(key);
    if (bound !== undefined && bound !== effect.boundEffectDigest) {
      throw refusal("EFFECT_CONFLICT", "same effect key with different bound bytes", { effectKey: effect.effectKey });
    }
    const row: JournaledDispatch = {
      effectKey: effect.effectKey,
      dispatchId: envelope.dispatchId,
      dispatchSequence: rows.length + 1,
      envelopeDigest: digest,
      envelope,
      callerOrigin: scope.origin,
    };
    this.dispatches.set(key, [...rows, row]);
    return row;
  }

  async journaled(scope: AuthScope, effectKey: string, dispatchId: string): Promise<JournaledDispatch | null> {
    return this.dispatches.get(`${scope.tenant}/${effectKey}`)?.find((row) => row.dispatchId === dispatchId) ?? null;
  }

  readonly abandoned = new Set<string>();

  async abandon(scope: AuthScope, effectKey: string, dispatchId: string): Promise<"abandoned" | "committed"> {
    const key = `${scope.tenant}/${effectKey}`;
    if (!this.dispatches.get(key)?.some((row) => row.dispatchId === dispatchId))
      throw new Error("DISPATCH_NOT_JOURNALED");
    if (this.commits.has(key)) return "committed";
    this.abandoned.add(`${key}/${dispatchId}`);
    return "abandoned";
  }

  /** The native commit stamp an in-memory apply port writes with its "native" effect (one per effect). */
  commit(scope: AuthScope, effectKey: string, dispatchId: string, nativeRef: JsonDocument, at: string): EffectCommit {
    const key = `${scope.tenant}/${effectKey}`;
    if (this.abandoned.has(`${key}/${dispatchId}`)) throw new Error("DISPATCH_ABANDONED");
    if (!this.dispatches.get(key)?.some((row) => row.dispatchId === dispatchId))
      throw new Error("DISPATCH_NOT_JOURNALED");
    const existing = this.commits.get(key);
    if (existing !== undefined) {
      if (existing.dispatchId === dispatchId) return existing;
      throw new Error("EFFECT_ALREADY_COMMITTED");
    }
    const commit: EffectCommit = { dispatchId, nativeRef, committedAt: at };
    this.commits.set(key, commit);
    return commit;
  }

  async record(scope: AuthScope, receipt: OperationReceipt): Promise<OperationReceipt> {
    const key = `${scope.tenant}/${receipt.effect.effectKey}`;
    const bound = this.bound.get(key);
    if (bound !== undefined && bound !== receipt.effect.boundEffectDigest) {
      throw refusal("EFFECT_CONFLICT", "the receipt binds another effect digest", {
        effectKey: receipt.effect.effectKey,
      });
    }
    const winner = this.receipts.get(key);
    if (winner !== undefined) return winner;
    const commit = this.commits.get(key);
    if (commit !== undefined && commit.dispatchId !== receipt.effect.dispatchId) {
      throw new Error("RECEIPT_DISPATCH_MISMATCH");
    }
    this.bound.set(key, receipt.effect.boundEffectDigest);
    this.receipts.set(key, receipt);
    return receipt;
  }
}

export class MemoryReportLocator implements ReportLocator {
  private readonly runs = new Map<string, string>();
  private readonly revisions = new Set<string>();

  async runOf(scope: AuthScope, report: Ref<"report">): Promise<string | null> {
    return this.runs.get(`${scope.tenant}/${report.id}/${report.digest}`) ?? null;
  }

  remember(scope: AuthScope, report: Ref<"report">, runId: string): void {
    this.runs.set(`${scope.tenant}/${report.id}/${report.digest}`, runId);
    this.revisions.add(`${scope.tenant}/${report.id}`);
  }

  async revisionExists(scope: AuthScope, revisionId: string): Promise<boolean> {
    return this.revisions.has(`${scope.tenant}/${revisionId}`);
  }
}

/** `options.apply` wires an apply port directly (tests); the registered {@link BACKEND} never takes one. */
export function createInMemoryBackend(
  options: ResearchBackendOptions,
): KnowledgeOperationBackend & { readonly store: InMemoryResearchBinding; readonly ledger: InMemoryEffectLedger } {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const store = new InMemoryResearchBinding(options.binding, {
    ...(options.seal ? { sealVerifier: options.seal.verifier } : {}),
    now: () => clock.now(),
  });
  const ledger = new InMemoryEffectLedger();
  const backend = composeBackend(
    {
      application: options.application,
      binding: options.binding,
      unsupportedReason: null,
      pinnedSchema: {
        name: "knowledge-verification-in-memory",
        version: "knowledge-verification.v2",
        digest: digestCanonical({ binding: options.binding, store: "in-memory" }),
      },
      coreSchemas: CORE_SCHEMAS,
      writeAtomicity: "single_transaction",
      nativeCancellation: "native",
      credentials: new InMemoryCredentialUseStore(),
      close: async () => undefined,
    },
    {
      research: researchServices(
        store,
        { ...options, retryAfterMs: options.retryAfterMs ?? 200 },
        new MemoryReportLocator(),
      ),
      effects: ledger,
      apply: options.apply ?? null,
      readIntent: options.readIntent ?? null,
    },
  );
  return Object.assign(backend, { store, ledger });
}

export const BACKEND: BackendRegistration = {
  id: "in-memory",
  describe: () => ({
    id: "in-memory",
    capabilities: ["research", "native_receipt_lookup"],
    storageClass: "memory",
    writeAtomicity: "single_transaction",
    nativeCancellation: "native",
    nativeContract: null,
    researchStore: null,
    conditionalCapabilities: [],
  }),
  // The in-memory backend describes no `apply`: an injected apply port is not forwarded, so it cannot serve one.
  create: async (config, injection) =>
    createInMemoryBackend({
      application: config.application,
      binding: config.binding,
      kinds: injection.kinds,
      auditor: injection.auditor,
      authority: injection.authority ?? null,
      seal: injection.seal,
      apply: null,
    }),
};
