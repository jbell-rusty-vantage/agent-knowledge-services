import {
  CORE_SCHEMAS,
  type CredentialUseStore,
  type EffectLedger,
  type EffectLookup,
  type JournaledDispatch,
  type KnowledgeApplyPort,
  type KnowledgeReadIntentPort,
  type KnowledgeOperationBackend,
  type BackendPorts,
  type DeliveryReader,
  type ReportLocator,
  type ResearchBackendOptions,
  type RevocationEpochReader,
  composeBackend,
  refusal,
  researchServices,
  verifiedReceipt,
} from "@aiengineer/knowledge-host/knowledge-operation";
import {
  type EffectBinding,
  type JsonDocument,
  type JsonValue,
  type OperationEnvelope,
  OperationEnvelopeSchema,
  type OperationReceipt,
  OriginSchema,
  type Ref,
  RefSchema,
  canonicalJson,
  digestBytes,
  digestCanonical,
  envelopeDigest,
} from "@aiengineer/knowledge-operation-protocol";
import type { AuthScope, CustodyStore } from "@aiengineer/knowledge-research-core";
import { ComponentDatabase, type SqlClient } from "./client.js";
import type { PostgresResearchBinding } from "./research-binding.js";
import {
  ComponentError,
  bindEffect,
  componentError,
  currentRevocationEpoch,
  recordEffectReceipt,
  registerOrigin,
} from "./stores.js";

interface JournalRow {
  readonly effect_key: string;
  readonly dispatch_id: string;
  readonly dispatch_sequence: number;
  readonly envelope_digest: string;
  readonly envelope: unknown;
  readonly caller_origin: unknown;
}

/** A journaled dispatch, re-verified: the stored envelope must recompute its journaled digest (tamper check). */
function journaledOf(row: JournalRow): JournaledDispatch {
  const envelope = OperationEnvelopeSchema.parse(row.envelope);
  if (envelopeDigest(envelope) !== row.envelope_digest || envelope.dispatchId !== row.dispatch_id) {
    throw new Error("DISPATCH_JOURNAL_TAMPERED");
  }
  return {
    effectKey: row.effect_key,
    dispatchId: row.dispatch_id,
    dispatchSequence: Number(row.dispatch_sequence),
    envelopeDigest: row.envelope_digest,
    envelope,
    callerOrigin: OriginSchema.parse(row.caller_origin),
  };
}

/** K01 instant (UTC, no trailing zero fraction) of a database timestamp. */
function instant(date: Date): string {
  return date.toISOString().replace(/\.(\d*?)0+Z$/, (_m, d: string) => (d ? `.${d}Z` : "Z"));
}

/**
 * The K01 backend over one installation of the common `knowledge_verification` component (>= 2.4.0): research
 * services, effect ledger with protocol receipts, revocation epoch, durable operations, custody and credential
 * nonces. Both PostgreSQL bindings compose from it (AI Engineer directly; Biotech reuses it as its research store,
 * named in its descriptor `researchStore`). Moved from the host's `backends.ts` (Sprint OC R5).
 */
export const MIN_COMPONENT_VERSION = "2.5.0";

const WRITER = "knowledge_verification_writer" as const;
const READER = "knowledge_verification_reader" as const;
/** Installation-level reads (component release, installation row) run under a fixed, non-nil probe tenant. */
const PROBE_TENANT = "00000000-0000-7000-8000-000000000000";

function componentRefusal(error: unknown, effectKey: string): never {
  if (error instanceof ComponentError && error.code === "EFFECT_CONFLICT") {
    throw refusal("EFFECT_CONFLICT", "same effect key with different bound bytes or originating origin", { effectKey });
  }
  if (error instanceof Error && /EFFECT_CONFLICT/.test(error.message)) {
    throw refusal("EFFECT_CONFLICT", "the receipt binds another effect digest than the component effect", {
      effectKey,
    });
  }
  throw error;
}

/** Component 2.3.0 `credential_use`: durable single use of jti and dispatch id across executor restarts. */
export class PostgresCredentialUseStore implements CredentialUseStore {
  private consumed = 0;

  constructor(private readonly db: ComponentDatabase) {}

  async consume(
    scope: AuthScope,
    input: { issuer: string; jti: string; dispatchId: string; expiresAt: Date; now: Date },
  ): Promise<"consumed" | "replay" | "dispatch_reused" | "expired"> {
    const outcome = await this.db.transaction({ tenantId: scope.tenant, role: WRITER }, async (c) => {
      const rows = await c.query<{ outcome: "consumed" | "replay" | "dispatch_reused" | "expired" }>(
        "select knowledge_verification.consume_credential($1, $2, $3, $4, $5, $6) as outcome",
        [scope.tenant, input.issuer, input.jti, input.dispatchId, input.expiresAt, input.now],
      );
      this.consumed += 1;
      if (this.consumed % 500 === 0) {
        await c.query("select knowledge_verification.purge_credential_use($1, $2)", [scope.tenant, input.now]);
      }
      return rows.rows[0]?.outcome ?? "replay";
    });
    return outcome;
  }
}

/**
 * Component `effect` + `effect_receipt` + `protocol_receipt` (2.3.0). The K01 receipt document (which names the
 * applying dispatch, its envelope digest and the current caller origin) is stored in `protocol_receipt`, bound by the
 * component to the effect's bound digest. Rows written by 2.2.0 executors kept the document in custody, referenced
 * from `effect_receipt.native_receipt_ref.k01Receipt`; those stay readable.
 */
export class PostgresEffectLedger implements EffectLedger {
  constructor(
    private readonly db: ComponentDatabase,
    private readonly custody: CustodyStore,
  ) {}

  async bind(scope: AuthScope, effect: EffectBinding): Promise<void> {
    try {
      await this.db.transaction({ tenantId: scope.tenant, role: WRITER }, (c) => bindEffect(c, scope.tenant, effect));
    } catch (error) {
      componentRefusal(error, effect.effectKey);
    }
  }

  async lookup(scope: AuthScope, effectKey: string): Promise<EffectLookup> {
    const { protocol, native, commit } = await this.db.transaction(
      { tenantId: scope.tenant, role: READER, readOnly: true },
      async (c) => ({
        protocol: (
          await c.query<{ receipt: unknown }>(
            "select receipt from knowledge_verification.protocol_receipt where tenant_id = $1 and effect_key = $2",
            [scope.tenant, effectKey],
          )
        ).rows[0],
        native: (
          await c.query<{ native_receipt_ref: unknown }>(
            "select native_receipt_ref from knowledge_verification.effect_receipt where tenant_id = $1 and effect_key = $2",
            [scope.tenant, effectKey],
          )
        ).rows[0],
        // 2.5.0: the journaled dispatch that committed the effect natively (written inside the native transaction).
        commit: (
          await c.query<{ dispatch_id: string; native_ref: JsonDocument; committed_at: Date }>(
            "select dispatch_id, native_ref, committed_at from knowledge_verification.effect_commit where tenant_id = $1 and effect_key = $2",
            [scope.tenant, effectKey],
          )
        ).rows[0],
      }),
    );
    if (protocol !== undefined) {
      return { state: "found" as const, receipt: verifiedReceipt(protocol.receipt, scope, effectKey) };
    }
    const committed =
      commit === undefined
        ? null
        : { dispatchId: commit.dispatch_id, nativeRef: commit.native_ref, committedAt: instant(commit.committed_at) };
    // Biotech commits natively without an effect_receipt row (admission + outbox enqueue): the commit stamp alone.
    if (native === undefined) return committed === null ? null : { state: "native_only" as const, commit: committed };
    const pointer = RefSchema.safeParse((native.native_receipt_ref as { k01Receipt?: unknown } | null)?.k01Receipt);
    if (!pointer.success) return { state: "native_only" as const, commit: committed };
    const bytes = await this.custody.get(scope, pointer.data as Ref<"artifact">);
    if (digestBytes(bytes) !== pointer.data.digest) throw new Error("PROTOCOL_RECEIPT_TAMPERED");
    return {
      state: "found" as const,
      receipt: verifiedReceipt(JSON.parse(Buffer.from(bytes).toString("utf8")), scope, effectKey),
    };
  }

  /** Journal one dispatch before native dispatch (2.5.0 `journal_effect_dispatch`), registering both origins. */
  async journal(scope: AuthScope, envelope: OperationEnvelope): Promise<JournaledDispatch> {
    const effect = envelope.effect;
    if (effect === null) throw refusal("SCHEMA_UNSUPPORTED", "only an effectful dispatch is journaled", {});
    const digest = envelopeDigest(envelope);
    try {
      const row = await this.db.transaction({ tenantId: scope.tenant, role: WRITER }, async (c) => {
        const originating = await registerOrigin(c, scope.tenant, effect.originatingOrigin);
        const caller = await registerOrigin(c, scope.tenant, scope.origin);
        const rows = await c.query<JournalRow>(
          `select effect_key, dispatch_id, dispatch_sequence, envelope_digest, envelope, caller_origin
             from knowledge_verification.journal_effect_dispatch($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)`,
          [
            scope.tenant,
            effect.effectKey,
            envelope.dispatchId,
            envelope.operation,
            digest,
            effect.semanticPayloadDigest,
            effect.boundEffectDigest,
            originating,
            caller,
            canonicalJson(scope.origin as unknown as JsonValue),
            canonicalJson(envelope as unknown as JsonValue),
          ],
        );
        return rows.rows[0];
      });
      if (row === undefined) throw new Error("DISPATCH_NOT_JOURNALED");
      return journaledOf(row);
    } catch (error) {
      if (error instanceof Error && /DISPATCH_CONFLICT/.test(error.message)) {
        throw refusal("EFFECT_CONFLICT", "the dispatch id is journaled with another envelope", {
          dispatchId: envelope.dispatchId,
          effectKey: effect.effectKey,
        });
      }
      componentRefusal(componentError(error), effect.effectKey);
    }
  }

  async abandon(scope: AuthScope, effectKey: string, dispatchId: string): Promise<"abandoned" | "committed"> {
    const rows = await this.db.transaction({ tenantId: scope.tenant, role: WRITER }, (c) =>
      c.query<{ state: string }>("select knowledge_verification.abandon_effect_dispatch($1, $2, $3) as state", [
        scope.tenant,
        effectKey,
        dispatchId,
      ]),
    );
    const state = rows.rows[0]?.state;
    if (state !== "abandoned" && state !== "committed") throw new Error("DISPATCH_FENCE_UNKNOWN");
    return state;
  }

  async journaled(scope: AuthScope, effectKey: string, dispatchId: string): Promise<JournaledDispatch | null> {
    const rows = await this.db.transaction({ tenantId: scope.tenant, role: READER, readOnly: true }, (c) =>
      c.query<JournalRow>(
        `select effect_key, dispatch_id, dispatch_sequence, envelope_digest, envelope, caller_origin
           from knowledge_verification.effect_dispatch where tenant_id = $1 and effect_key = $2 and dispatch_id = $3`,
        [scope.tenant, effectKey, dispatchId],
      ),
    );
    const row = rows.rows[0];
    return row === undefined ? null : journaledOf(row);
  }

  async record(
    scope: AuthScope,
    receipt: OperationReceipt,
    options: { native?: boolean } = {},
  ): Promise<OperationReceipt> {
    const effectKey = receipt.effect.effectKey;
    try {
      const stored = await this.db.transaction({ tenantId: scope.tenant, role: WRITER }, async (c: SqlClient) => {
        if (options.native ?? true) {
          await recordEffectReceipt(c, scope.tenant, {
            effectKey,
            outcome: receipt.outcome === "pending_dispatch" ? "noop" : receipt.outcome,
            nativeReceiptRef: receipt.nativeReceiptRef as unknown as JsonValue,
            affectedRefs: receipt.affectedRefs as unknown as JsonValue[],
            concurrencyBefore: receipt.concurrencyToken.before,
            concurrencyAfter: receipt.concurrencyToken.after,
            processedEpoch: receipt.processedRevocationEpoch,
            itemOutcomes: receipt.itemOutcomes as unknown as JsonValue[],
            useDecisionId: null,
          });
        }
        const rows = await c.query<{ receipt: unknown }>(
          "select receipt from knowledge_verification.record_protocol_receipt($1, $2, $3::jsonb)",
          [scope.tenant, effectKey, canonicalJson(receipt as unknown as JsonValue)],
        );
        return rows.rows[0]?.receipt;
      });
      return verifiedReceipt(stored, scope, effectKey);
    } catch (error) {
      // First writer wins: a concurrent dispatch of the same effect recorded its receipt; answer that one.
      const winner = await this.lookup(scope, effectKey).catch(() => null);
      if (winner?.state === "found") return winner.receipt;
      componentRefusal(error, effectKey);
    }
  }
}

/** The component's authoritative revocation epoch (`current_revocation_epoch`). */
export class PostgresRevocationEpoch implements RevocationEpochReader {
  constructor(private readonly db: ComponentDatabase) {}

  async epoch(scope: AuthScope): Promise<number> {
    return this.db.transaction({ tenantId: scope.tenant, role: READER, readOnly: true }, (c) =>
      currentRevocationEpoch(c, scope.tenant),
    );
  }
}

/** The run of an exact report revision (component `report_revision` is keyed by revision id within the tenant). */
export class PostgresReportLocator implements ReportLocator {
  constructor(private readonly db: ComponentDatabase) {}

  async runOf(scope: AuthScope, report: Ref<"report">): Promise<string | null> {
    if (report.tenant !== scope.tenant || report.binding !== scope.binding) return null;
    const rows = await this.db.transaction({ tenantId: scope.tenant, role: READER, readOnly: true }, (c) =>
      c.query<{ run_id: string }>(
        "select run_id::text as run_id from knowledge_verification.report_revision where tenant_id = $1 and report_revision_id = $2",
        [scope.tenant, report.id],
      ),
    );
    return rows.rows[0]?.run_id ?? null;
  }

  async revisionExists(scope: AuthScope, revisionId: string): Promise<boolean> {
    const rows = await this.db.transaction({ tenantId: scope.tenant, role: READER, readOnly: true }, (c) =>
      c.query("select 1 from knowledge_verification.report_revision where tenant_id = $1 and report_revision_id = $2", [
        scope.tenant,
        revisionId,
      ]),
    );
    return rows.rows.length > 0;
  }
}

export interface InstalledComponent {
  readonly installationId: string;
  readonly applicationId: string;
  readonly binding: string;
  readonly componentVersion: string;
  /** Canonical digest over the applied (migration key, sha256) list: pins the exact installed component. */
  readonly releaseDigest: string;
}

/** Read the component release and installation rows; refuse a component older than {@link MIN_COMPONENT_VERSION}. */
export async function inspectComponent(db: ComponentDatabase): Promise<InstalledComponent> {
  return db.transaction({ tenantId: PROBE_TENANT, role: READER, readOnly: true }, async (c) => {
    const installation = (
      await c.query<{ installation_id: string; application_id: string; binding: string }>(
        "select installation_id::text as installation_id, application_id, binding from knowledge_verification.installation",
      )
    ).rows[0];
    const releases = (
      await c.query<{ migration_key: string; sha256: string; component_version: string }>(
        "select migration_key, sha256, component_version from knowledge_verification.component_release where component = 'knowledge_verification' order by migration_key",
      )
    ).rows;
    if (installation === undefined || releases.length === 0) throw new Error("COMPONENT_NOT_INSTALLED");
    const version = releases
      .map((row) => row.component_version)
      .sort(compareSemver)
      .at(-1) as string;
    if (compareSemver(version, MIN_COMPONENT_VERSION) < 0) {
      throw new Error(
        `COMPONENT_TOO_OLD: ${version} < ${MIN_COMPONENT_VERSION} (credential_use, protocol_receipt, effect_dispatch journal)`,
      );
    }
    return {
      installationId: installation.installation_id,
      applicationId: installation.application_id,
      binding: installation.binding,
      componentVersion: version,
      releaseDigest: digestCanonical(
        releases.map((row) => ({ migration: row.migration_key, sha256: row.sha256 })) as unknown as JsonValue,
      ),
    };
  });
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export interface PostgresBackendOptions extends ResearchBackendOptions {
  readonly connectionString: string;
  /** The installation id the executor pins for this binding; the database's installation row must equal it. */
  readonly installationId: string;
}

/**
 * A backend over one component installation: the research store, apply and delivery ports come from the binding; the
 * effect ledger, revocation epoch, report locator and credential store are the component's own.
 */
export async function createComponentBackend(
  options: PostgresBackendOptions,
  shape: {
    readonly store: (db: ComponentDatabase) => PostgresResearchBinding;
    readonly apply: (db: ComponentDatabase) => KnowledgeApplyPort | null;
    readonly delivery: (db: ComponentDatabase) => DeliveryReader | null;
    /** The native `knowledge.read_intent` port (capability `read_intent`), when the binding serves one. */
    readonly readIntent?: (db: ComponentDatabase) => KnowledgeReadIntentPort | null;
    readonly writeAtomicity: KnowledgeOperationBackend["writeAtomicity"];
    readonly nativeCancellation: KnowledgeOperationBackend["nativeCancellation"];
  },
): Promise<KnowledgeOperationBackend> {
  const db = new ComponentDatabase({
    connectionString: options.connectionString,
    applicationName: "knowledge-operation-executor",
  });
  try {
    const component = await inspectComponent(db);
    if (
      component.installationId !== options.installationId ||
      component.applicationId !== options.application ||
      component.binding !== options.binding
    ) {
      throw new Error(
        "COMPONENT_INSTALLATION_MISMATCH: the database installs another installation/application/binding",
      );
    }
    const store = shape.store(db);
    const ports: BackendPorts = {
      research: researchServices(store, options, new PostgresReportLocator(db)),
      effects: new PostgresEffectLedger(db, store.custody),
      revocation: new PostgresRevocationEpoch(db),
      apply: shape.apply(db),
      delivery: shape.delivery(db),
      readIntent: shape.readIntent?.(db) ?? null,
    };
    return composeBackend(
      {
        application: options.application,
        binding: options.binding,
        unsupportedReason: null,
        pinnedSchema: {
          name: `knowledge-verification-${component.componentVersion}`,
          version: "knowledge-verification.v2",
          digest: component.releaseDigest,
        },
        coreSchemas: CORE_SCHEMAS,
        writeAtomicity: shape.writeAtomicity,
        nativeCancellation: shape.nativeCancellation,
        credentials: new PostgresCredentialUseStore(db),
        close: () => db.end(),
      },
      ports,
    );
  } catch (error) {
    await db.end().catch(() => undefined);
    throw error;
  }
}
