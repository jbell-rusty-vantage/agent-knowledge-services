import {
  type BackendRegistration,
  type KnowledgeOperationBackend,
  bindingConnectionString,
} from "@aiengineer/knowledge-host/knowledge-operation";
import { type PostgresBackendOptions, createComponentBackend } from "./component-backend.js";
import { READ_INTENT_CONTRACT } from "@aiengineer/knowledge-operation-protocol";
import { INGESTION_APPLY_CONTRACT } from "./ingestion-apply.js";
import { PostgresResearchBinding } from "./research-binding.js";

/** The registry id of this binding. */
export const AIENGINEER_POSTGRES_BINDING = "aiengineer-postgres";

/**
 * The K05 AI Engineer PostgreSQL backend (moved home from the host's `backends.ts`, Sprint OC R5): research records,
 * effect ledger, revocation epoch, operations and credential nonces in the component installation; `knowledge.apply`
 * through the injected native ingestion port (`options.apply`), whose contract must be `knowledge-ingestion-intent/v1`;
 * `knowledge.read_intent` through the injected native read port (`options.readIntent`, `knowledge-read-intent/v1`).
 */
export async function createAiEngineerPostgresBackend(
  options: PostgresBackendOptions,
): Promise<KnowledgeOperationBackend> {
  const apply = options.apply ?? null;
  const readIntent = options.readIntent ?? null;
  if (
    readIntent !== null &&
    (readIntent.nativeContract.name !== READ_INTENT_CONTRACT.name ||
      readIntent.nativeContract.version !== READ_INTENT_CONTRACT.version)
  ) {
    throw new Error(
      `BACKEND_READ_INTENT_CONTRACT_MISMATCH: ${AIENGINEER_POSTGRES_BINDING} reads ${READ_INTENT_CONTRACT.name}/${READ_INTENT_CONTRACT.version}`,
    );
  }
  if (
    apply !== null &&
    (apply.nativeContract.name !== INGESTION_APPLY_CONTRACT.name ||
      apply.nativeContract.version !== INGESTION_APPLY_CONTRACT.version)
  ) {
    throw new Error(
      `BACKEND_APPLY_CONTRACT_MISMATCH: ${AIENGINEER_POSTGRES_BINDING} applies ${INGESTION_APPLY_CONTRACT.name}/${INGESTION_APPLY_CONTRACT.version}`,
    );
  }
  return createComponentBackend(options, {
    store: (db) =>
      new PostgresResearchBinding(db, options.binding, {
        ...(options.externalCustody ? { externalCustody: options.externalCustody } : {}),
        ...(options.seal ? { sealVerifier: options.seal.verifier } : {}),
      }),
    apply: () => apply,
    delivery: () => null,
    readIntent: () => readIntent,
    writeAtomicity: "single_transaction",
    nativeCancellation: "native",
  });
}

export const BACKEND: BackendRegistration = {
  id: AIENGINEER_POSTGRES_BINDING,
  describe: () => ({
    id: AIENGINEER_POSTGRES_BINDING,
    capabilities: ["research", "native_receipt_lookup", "revocation"],
    // `apply` is served only when the executable injects the native ingestion port (it needs the AI Engineer
    // knowledge database); without it `knowledge.apply` refuses SCHEMA_UNSUPPORTED and describe omits it.
    // `read_intent` likewise needs the injected native read port (OVE-204: the AIDB ReadExecutor + workspace).
    conditionalCapabilities: [
      { capability: "apply", condition: "host_injected_apply_port" },
      { capability: "read_intent", condition: "host_injected_read_intent_port" },
    ],
    storageClass: "relational",
    writeAtomicity: "single_transaction",
    nativeCancellation: "native",
    nativeContract: INGESTION_APPLY_CONTRACT,
    researchStore: null,
  }),
  create: async (config, injection) => {
    const connectionString = bindingConnectionString(config, injection.env);
    if (connectionString === null) {
      throw new Error(`KNOWLEDGE_BINDING_DATABASE_REQUIRED: ${config.binding} needs databaseUrlEnv set`);
    }
    return createAiEngineerPostgresBackend({
      application: config.application,
      binding: config.binding,
      installationId: config.installationId,
      connectionString,
      kinds: injection.kinds,
      auditor: injection.auditor,
      authority: injection.authority ?? null,
      seal: injection.seal,
      apply: injection.apply,
      readIntent: injection.readIntent ?? null,
      ...(injection.externalCustody ? { externalCustody: injection.externalCustody } : {}),
    });
  },
};
