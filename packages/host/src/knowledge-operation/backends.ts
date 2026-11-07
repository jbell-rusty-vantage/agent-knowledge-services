import { resolveComponentDsn } from "../config/database.js";
import type { ExternalCustodyReader } from "@aiengineer/knowledge-research-core";
import {
  type AuditorDiscovery,
  Ed25519SealSigner,
  type ReportKindCatalog,
  ReportAssessmentService,
  type ResearchBinding,
  ResearchCoordinator,
  ReviewService,
  type SourceAuthorityCatalog,
  StaticSealVerifier,
} from "@aiengineer/knowledge-application";
import {
  type JsonValue,
  type OperationReceipt,
  OperationReceiptSchema,
  digestCanonical,
} from "@aiengineer/knowledge-operation-protocol";
import type { AuthScope, SealSigner } from "@aiengineer/knowledge-research-core";
import type {
  CredentialUseStore,
  KnowledgeApplyPort,
  KnowledgeReadIntentPort,
  KnowledgeOperationBackend,
  ReportLocator,
  ResearchServices,
} from "./ports.js";
import type { BindingConfig } from "./config.js";
import { composeBackend } from "./registry.js";

/**
 * Neutral building blocks every backend registration composes from (the factories themselves live in their binding
 * packages, and the in-memory one in `./in-memory.ts`): the research services over a `ResearchBinding`, the K01 core
 * schemas, run-seal keys, the K01 receipt verification a durable ledger applies on read, and the unwired backend.
 */
export const CORE_SCHEMAS: readonly string[] = [
  "research-core.task.v2",
  "research-core.assertion.v2",
  "research-core.support_set.v2",
  "research-core.observation.v2",
  "research-core.mapping.v2",
  "research-report.v2",
  "research-report-kind.v1",
  "research-core.report_assessment.v1",
];

/** A sealer that refuses: K01 operations served here never seal; a configured key replaces it. */
export const REFUSING_SEAL_SIGNER: SealSigner = {
  keyId: "unconfigured",
  sign: async () => {
    throw new Error("SEAL_KEY_UNCONFIGURED: set KS_KNOWLEDGE_SEAL_KEY_ID and KS_KNOWLEDGE_SEAL_KEY_FILE");
  },
};

export interface SealKeys {
  readonly signer: SealSigner;
  readonly verifier: StaticSealVerifier;
}

export function sealKeysFromFile(keyId: string, path: string): SealKeys {
  const signer = Ed25519SealSigner.fromKeyFile(keyId, path);
  return {
    signer,
    verifier: new StaticSealVerifier([{ keyId, publicKey: signer.publicKeyRaw(), status: "active" }]),
  };
}

export const SYSTEM_CLOCK = {
  now: () => new Date().toISOString().replace(/\.(\d*?)0+Z$/, (_m, d: string) => (d ? `.${d}Z` : "Z")),
};

function stripDigest(receipt: OperationReceipt): JsonValue {
  const { digest: _digest, ...body } = receipt;
  return body as unknown as JsonValue;
}

/** A stored K01 receipt document, re-verified against its scope, effect key and own digest. */
export function verifiedReceipt(document: unknown, scope: AuthScope, effectKey: string): OperationReceipt {
  const receipt = OperationReceiptSchema.parse(document);
  if (receipt.effect.effectKey !== effectKey || receipt.handle.tenant !== scope.tenant) {
    throw new Error("PROTOCOL_RECEIPT_MISMATCH");
  }
  if (digestCanonical(stripDigest(receipt)) !== receipt.digest) throw new Error("PROTOCOL_RECEIPT_TAMPERED");
  return receipt;
}

/**
 * The component DSN a binding configuration names by variable (`databaseUrlEnv`, one of
 * `KS_{AIENG,BIOTECH}_DB_COMPONENT_DSN`), resolved by the database config module and never logged. `null` when the
 * configuration names no variable; a named variable that is unset or empty refuses `KNOWLEDGE_BINDING_DATABASE_REQUIRED`.
 */
export function bindingConnectionString(
  config: BindingConfig,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const variable = config.databaseUrlEnv;
  if (!variable) return null;
  const { dsn } = resolveComponentDsn(env, variable, config.application);
  if (!dsn) throw new Error(`KNOWLEDGE_BINDING_DATABASE_REQUIRED: ${variable} is not set`);
  return dsn;
}

export interface ResearchBackendOptions {
  readonly externalCustody?: ExternalCustodyReader;
  readonly application: string;
  readonly binding: string;
  readonly kinds: ReportKindCatalog;
  /** The independent census auditor; `null` makes `report.assess` refuse `INDEPENDENCE_UNPROVEN`. */
  readonly auditor: AuditorDiscovery | null;
  /** K08 use classes and judgment policies the coordinator decides under (WI-03); `null`: every use is internal. */
  readonly authority?: SourceAuthorityCatalog | null;
  readonly seal?: SealKeys | null;
  readonly clock?: { now(): string };
  readonly apply?: KnowledgeApplyPort | null;
  readonly readIntent?: KnowledgeReadIntentPort | null;
  readonly retryAfterMs?: number;
}

/** The research services (capability `research`) over one binding's record store. */
export function researchServices(
  store: ResearchBinding & {
    readonly operations: ConstructorParameters<typeof ReportAssessmentService>[0]["operations"];
  },
  options: ResearchBackendOptions,
  locator: ReportLocator,
): ResearchServices {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const coordinator = new ResearchCoordinator(store, clock, options.kinds, {
    signer: options.seal?.signer ?? REFUSING_SEAL_SIGNER,
    authority: options.authority ?? null,
  });
  const assessment =
    options.auditor === null
      ? null
      : new ReportAssessmentService({
          binding: store,
          coordinator,
          operations: store.operations,
          auditor: options.auditor,
          clock,
          retryAfterMs: options.retryAfterMs ?? 500,
        });
  return {
    binding: store,
    coordinator,
    review: new ReviewService(store, coordinator, clock),
    operations: store.operations,
    kinds: options.kinds,
    assessment,
    auditor: options.auditor,
    locator,
  };
}

/** Process-local single use of credentials (in-memory and unwired backends; no durability across restarts). */
export class InMemoryCredentialUseStore implements CredentialUseStore {
  private readonly jtis = new Map<string, number>();
  private readonly dispatches = new Set<string>();

  async consume(
    scope: AuthScope,
    input: { issuer: string; jti: string; dispatchId: string; expiresAt: Date; now: Date },
  ): Promise<"consumed" | "replay" | "dispatch_reused" | "expired"> {
    const now = input.now.getTime();
    if (input.expiresAt.getTime() <= now) return "expired";
    const jti = `${scope.tenant}/${input.issuer}/${input.jti}`;
    const dispatch = `${scope.tenant}/${input.issuer}/${input.dispatchId}`;
    if (this.jtis.has(jti)) return "replay";
    if (this.dispatches.has(dispatch)) return "dispatch_reused";
    this.jtis.set(jti, input.expiresAt.getTime());
    this.dispatches.add(dispatch);
    return "consumed";
  }
}

/**
 * A registered binding that serves nothing (its native store is not configured on this executor): no capability, and
 * every operation but `knowledge.describe` refuses `SCHEMA_UNSUPPORTED` with `reason`.
 */
export function createUnwiredBackend(options: {
  application: string;
  binding: string;
  reason: string;
}): KnowledgeOperationBackend {
  return composeBackend(
    {
      application: options.application,
      binding: options.binding,
      unsupportedReason: options.reason,
      pinnedSchema: {
        name: `${options.binding}-unwired`,
        version: "knowledge-verification.v2",
        digest: digestCanonical({ binding: options.binding, state: "unwired" }),
      },
      coreSchemas: [],
      writeAtomicity: "marker_plus_outbox",
      nativeCancellation: "stop_dispatch_and_reconcile",
      credentials: new InMemoryCredentialUseStore(),
      close: async () => undefined,
    },
    {},
  );
}
