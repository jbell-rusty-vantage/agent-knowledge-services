import {
  type ComponentDatabase,
  type PostgresBackendOptions,
  type PostgresResearchBinding,
  createComponentBackend,
} from "@aiengineer/knowledge-binding-aiengineer-postgres";
import {
  type BackendRegistration,
  type KnowledgeOperationBackend,
  bindingConnectionString,
  createUnwiredBackend,
} from "@aiengineer/knowledge-host/knowledge-operation";
import { BiotechGraphAdmission, biotechEffect } from "./admission.js";
import { BIOTECH_APPLY_CONTRACT, createBiotechApplyPort } from "./apply-port.js";
import { TARGET_BINDING } from "./contracts.js";
import { createDispatchDrain } from "./drain.js";
import { PostgresOutboxDelivery } from "./outbox-delivery.js";
import { biotechResearchBinding } from "./research-binding.js";

/**
 * The research store implementation this binding reuses: the AI Engineer binding's `PostgresResearchBinding` over the
 * common `knowledge_verification` component (binding-to-binding reuse, design §6.2), named in the descriptor.
 */
export const BIOTECH_RESEARCH_STORE = "aiengineer-postgres/PostgresResearchBinding";

/**
 * The K06 Biotech graph backend (moved home from the host's `backends.ts`, Sprint OC R5): research records in the
 * Biotech component installation; `knowledge.apply` admits the exact use and enqueues the dispatch in one PostgreSQL
 * transaction (receipt outcome `pending_dispatch`), and the delivery reader composes the outbox acknowledgment state.
 * The graph itself is written by the BKS consumer; this binding holds no Neo4j driver.
 */
export async function createBiotechGraphPostgresBackend(
  options: PostgresBackendOptions,
  drain?: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly tenants: readonly string[];
    readonly onError?: (error: unknown) => void;
  },
): Promise<KnowledgeOperationBackend> {
  let componentDb: Parameters<typeof createDispatchDrain>[0]["db"] | null = null;
  const backend = await createComponentBackend(options, {
    store: (db: ComponentDatabase): PostgresResearchBinding =>
      biotechResearchBinding(db, {
        ...(options.seal ? { sealVerifier: options.seal.verifier } : {}),
        ...(options.externalCustody ? { externalCustody: options.externalCustody } : {}),
      }),
    apply: (db) =>
      createBiotechApplyPort(
        new BiotechGraphAdmission(db, { installationId: options.installationId, applicationId: options.application }),
        (intent, origin) => biotechEffect(intent, origin).boundEffectDigest,
      ),
    delivery: (db) => {
      componentDb = db;
      return new PostgresOutboxDelivery(db);
    },
    writeAtomicity: "marker_plus_outbox",
    nativeCancellation: "stop_dispatch_and_reconcile",
  });
  // OVE-169: the production dispatch drain (biotech-graph only; off unless its interval is configured).
  const drainer =
    drain === undefined || componentDb === null
      ? null
      : createDispatchDrain({
          db: componentDb,
          env: drain.env,
          binding: options.binding,
          tenants: drain.tenants,
          ...(drain.onError ? { onError: drain.onError } : {}),
        });
  if (drainer === null) return backend;
  drainer.start();
  const close = backend.close.bind(backend);
  return Object.assign(backend, {
    close: async () => {
      await drainer.stop();
      await close();
    },
  });
}

export const BACKEND: BackendRegistration = {
  id: TARGET_BINDING,
  describe: () => ({
    id: TARGET_BINDING,
    capabilities: ["research", "apply", "delivery", "native_receipt_lookup", "revocation"],
    storageClass: "graph",
    writeAtomicity: "marker_plus_outbox",
    nativeCancellation: "stop_dispatch_and_reconcile",
    nativeContract: BIOTECH_APPLY_CONTRACT,
    researchStore: BIOTECH_RESEARCH_STORE,
    conditionalCapabilities: [],
  }),
  create: async (config, injection) => {
    const connectionString = bindingConnectionString(config, injection.env);
    // Installed without its component database: the binding answers SCHEMA_UNSUPPORTED (it serves nothing yet).
    if (connectionString === null) {
      return createUnwiredBackend({
        application: config.application,
        binding: config.binding,
        reason: "the biotech-graph binding has no component database configured (databaseUrlEnv)",
      });
    }
    return createBiotechGraphPostgresBackend(
      {
        application: config.application,
        binding: config.binding,
        installationId: config.installationId,
        connectionString,
        kinds: injection.kinds,
        auditor: injection.auditor,
        authority: injection.authority ?? null,
        seal: injection.seal,
        ...(injection.externalCustody ? { externalCustody: injection.externalCustody } : {}),
      },
      { env: injection.env, tenants: config.tenants ?? [] },
    );
  },
};
