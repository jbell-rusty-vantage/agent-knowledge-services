import type { ComponentDatabase } from "@aiengineer/knowledge-binding-aiengineer-postgres";
import type { AuthScope } from "@aiengineer/knowledge-research-core";
import type { DispatchReceiptState } from "./admission.js";
import { BksExecutorClient } from "./client.js";
import { BiotechGraphDelivery, PostgresOutboxReader } from "./delivery.js";
import { BIOTECH_SCHEMA_RELEASE_V2_2_0 } from "./descriptor.js";

/**
 * The production drain of Biotech `knowledge.apply` dispatches (Sprint OC W1 / OVE-169). `knowledge.apply` commits the
 * admission and the outbox row (`pending_dispatch`) and returns; nothing else asked the BKS consumer to apply it. The
 * drain runs inside the KS executor (the holder of the `admission.dispatch` service token) for the biotech-graph binding
 * only: every interval, per configured tenant, it lists at most `limit` pending rows and, when there is one, delivers it
 * through {@link BiotechGraphDelivery.deliver} (push-trigger the BKS consumer, then receipt-first reconcile) and
 * reconciles the rest. Bounded (one pass at a time, `limit` rows per tenant) and idempotent: the consumer claims with
 * SKIP LOCKED and acknowledges duplicates with the stored marker digest; the drain itself writes no KS row and no K01
 * journal entry, so a crash or restart only re-lists what is still pending (WI-05 journal and fence semantics are
 * untouched: the receipt state is still read from the component row).
 *
 * Environment (names only): `KS_BIOTECH_DISPATCH_DRAIN_INTERVAL_MS` (0 or unset: off), `KS_BIOTECH_DISPATCH_DRAIN_LIMIT`
 * (default 10, at most 100) and optionally `KS_BIOTECH_SCHEMA_RELEASE_DIGEST` (else the binding descriptor's pin).
 * The BKS executor's `/describe` must serve that same release (never accepted alone); the pin and delivery are resolved
 * once per process, so a schema release change needs a KS executor restart. Rows not yet `available_at` are skipped.
 */
export const DRAIN_INTERVAL_ENV = "KS_BIOTECH_DISPATCH_DRAIN_INTERVAL_MS";
export const DRAIN_LIMIT_ENV = "KS_BIOTECH_DISPATCH_DRAIN_LIMIT";
export const SCHEMA_RELEASE_ENV = "KS_BIOTECH_SCHEMA_RELEASE_DIGEST";
const MAX_LIMIT = 100;

export interface DrainConfig {
  readonly intervalMs: number;
  readonly limit: number;
}

/** `null` when the drain is off; a malformed value refuses (fail closed at startup). */
export function drainConfigFromEnv(env: Readonly<Record<string, string | undefined>>): DrainConfig | null {
  const interval = env[DRAIN_INTERVAL_ENV]?.trim();
  if (!interval || interval === "0") return null;
  const intervalMs = Number(interval);
  const limit = Number(env[DRAIN_LIMIT_ENV]?.trim() || "10");
  if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 3_600_000) {
    throw new Error(`DRAIN_CONFIG_INVALID: ${DRAIN_INTERVAL_ENV} must be 250..3600000 ms`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`DRAIN_CONFIG_INVALID: ${DRAIN_LIMIT_ENV} must be 1..${MAX_LIMIT}`);
  }
  return { intervalMs, limit };
}

export interface PendingDispatches {
  pending(scope: AuthScope, limit: number): Promise<readonly string[]>;
}

/** Reader-role list of a tenant's undelivered dispatches (`pending` or `dispatched`), oldest first. */
export class PostgresPendingDispatches implements PendingDispatches {
  constructor(private readonly db: ComponentDatabase) {}

  async pending(scope: AuthScope, limit: number): Promise<readonly string[]> {
    return this.db.transaction(
      { tenantId: scope.tenant, role: "knowledge_verification_reader", readOnly: true },
      async (c) => {
        const res = await c.query<{ dispatch_id: string }>(
          "select dispatch_id::text as dispatch_id from knowledge_verification.dispatch_outbox " +
            "where tenant_id = $1 and state in ('pending', 'dispatched') and available_at <= now() " +
            "order by created_at, dispatch_id limit $2",
          [scope.tenant, limit],
        );
        return res.rows.map((row) => row.dispatch_id);
      },
    );
  }
}

export interface DrainDelivery {
  deliver(scope: AuthScope, dispatchId: string): Promise<{ readonly state: DispatchReceiptState }>;
  reconcile(scope: AuthScope, dispatchId: string): Promise<{ readonly state: DispatchReceiptState }>;
}

export interface DrainPass {
  readonly tenant: string;
  readonly results: readonly { readonly dispatchId: string; readonly state: DispatchReceiptState }[];
}

export class DispatchDrain {
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<unknown> | null = null;

  constructor(
    private readonly options: {
      readonly scopes: readonly AuthScope[];
      readonly pending: PendingDispatches;
      readonly delivery: () => Promise<DrainDelivery>;
      readonly config: DrainConfig;
      readonly onError?: (error: unknown) => void;
    },
  ) {}

  /** One bounded pass over every tenant: deliver the oldest pending dispatch, reconcile the rest. */
  async drainOnce(): Promise<readonly DrainPass[]> {
    const passes: DrainPass[] = [];
    for (const scope of this.options.scopes) {
      // Isolation (review S1): one tenant's or one row's failure never stops the others.
      try {
        const ids = await this.options.pending.pending(scope, this.options.config.limit);
        if (ids.length === 0) continue;
        const delivery = await this.options.delivery();
        const results: { dispatchId: string; state: DispatchReceiptState }[] = [];
        for (const [index, id] of ids.entries()) {
          try {
            const result = index === 0 ? await delivery.deliver(scope, id) : await delivery.reconcile(scope, id);
            results.push({ dispatchId: id, state: result.state });
          } catch (error) {
            this.options.onError?.(error);
          }
        }
        passes.push({ tenant: scope.tenant, results });
      } catch (error) {
        this.options.onError?.(error);
      }
    }
    return passes;
  }

  /** Start the interval; a pass never overlaps the previous one; the timer does not hold the process open. */
  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      if (this.#running !== null) return;
      this.#running = this.drainOnce()
        .catch((error: unknown) => this.options.onError?.(error))
        .finally(() => {
          this.#running = null;
        });
    }, this.options.config.intervalMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }
}

/** The production drain of one biotech-graph binding, or `null` when it is off or the executor is unconfigured. */
export function createDispatchDrain(input: {
  readonly db: ComponentDatabase;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly binding: string;
  readonly tenants: readonly string[];
  /** The binding's pinned BKS schema release (default the descriptor's v2.2.0 pin). */
  readonly schemaReleaseDigest?: string;
  readonly onError?: (error: unknown) => void;
}): DispatchDrain | null {
  const config = drainConfigFromEnv(input.env);
  if (config === null) return null;
  const executor = BksExecutorClient.fromEnv(input.env as NodeJS.ProcessEnv);
  if (executor === null) throw new Error("DRAIN_CONFIG_INVALID: the drain needs KS_BIOTECH_EXECUTOR_URL and token");
  if (input.tenants.length === 0) throw new Error("DRAIN_CONFIG_INVALID: the binding names no tenants");
  let delivery: BiotechGraphDelivery | null = null;
  return new DispatchDrain({
    scopes: input.tenants.map((tenant) => ({ tenant, binding: input.binding }) as AuthScope),
    pending: new PostgresPendingDispatches(input.db),
    config,
    ...(input.onError ? { onError: input.onError } : {}),
    delivery: async () => {
      if (delivery === null) {
        const pinned =
          input.env[SCHEMA_RELEASE_ENV]?.trim() || input.schemaReleaseDigest || BIOTECH_SCHEMA_RELEASE_V2_2_0;
        if (!/^sha256:[0-9a-f]{64}$/.test(pinned)) throw new Error("DRAIN_RELEASE_PIN_INVALID");
        const served = String((await executor.describe()).schemaReleaseDigest ?? "");
        if (served !== pinned) throw new Error("DRAIN_RELEASE_PIN_MISMATCH: the BKS executor serves another release");
        delivery = new BiotechGraphDelivery({
          outbox: new PostgresOutboxReader(input.db),
          executor,
          schemaReleaseDigest: pinned,
          consumeLimit: config.limit,
        });
      }
      return delivery;
    },
  });
}
