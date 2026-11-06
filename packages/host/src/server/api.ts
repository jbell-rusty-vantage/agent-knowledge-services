import {
  apiOwnedOperationKinds,
  type CallbackReplayStore,
  type KnowledgeOperationPort,
} from "@aiengineer/knowledge-application";
import {
  PostgresCallbackReplayStore,
  PostgresCanonicalRepository,
  PostgresKnowledgeOperationService,
} from "@aiengineer/knowledge-persistence";
import { loadServerConfig, type ServerConfig } from "../config/index.js";
import { constructWithResources } from "../lifecycle/resources.js";
import { composeKnowledgeServices, type KnowledgeServices } from "./knowledge.js";
import { openCanonicalRepository, type HostEnvironment } from "./shared.js";
import { composeVerificationServices, type VerificationServices } from "./verification.js";

export interface ApiHostOptions {
  readonly profile: "server";
  readonly role: "api";
  readonly environment: HostEnvironment;
  /** Transport-owned public-origin validation, applied before any resource opens. Required so production cannot skip it. */
  readonly resolvePublicOrigin: (config: ServerConfig) => string | undefined;
}

export interface ApiHost {
  readonly profile: "server";
  readonly role: "api";
  readonly config: ServerConfig;
  readonly publicOrigin: string | undefined;
  readonly capabilities: {
    readonly persistence: boolean;
    readonly retrieval: boolean;
    readonly citationReplay: boolean;
    readonly verification: boolean;
  };
  readonly operations?: {
    readonly service: KnowledgeOperationPort;
    readonly retrieval: KnowledgeOperationPort;
    readonly callbackReplay: CallbackReplayStore;
  };
  readonly knowledge: KnowledgeServices;
  readonly verify: VerificationServices;
  close(): Promise<void>;
}

/**
 * Server API composition. Construction order and configuration failures match the
 * previous API bootstrap; any failure releases the database pool before rethrowing.
 */
export async function createApiHost(options: ApiHostOptions): Promise<ApiHost> {
  const { environment } = options;
  const config = loadServerConfig(environment as NodeJS.ProcessEnv);
  const production = config.NODE_ENV === "production";
  const connectionString = environment.POSTGRES_URL?.trim();
  if (production && !connectionString) throw new Error("POSTGRES_URL_REQUIRED");
  const publicOrigin = options.resolvePublicOrigin(config);
  const { value, resources } = await constructWithResources((resources) => {
    const database = connectionString ? openCanonicalRepository(resources, connectionString, environment) : undefined;
    // SV-17: the verification drift revalidation queue is retired with its AIDB outbox; refuse its configuration.
    for (const name of [
      "VERIFICATION_DRIFT_REVALIDATION_ENABLED",
      "VERIFICATION_DRIFT_CONSUMER_SERVICE_IDENTITIES_JSON",
      "VERIFICATION_COMPONENT_DRIFT_MONITORS_JSON",
      "VERIFICATION_COMPONENT_DRIFT_PUBLIC_KEYS_JSON",
    ])
      if (environment[name]?.trim() && environment[name]?.trim() !== "0")
        throw new Error(`VERIFICATION_RETIRED_CONFIGURATION:${name}`);
    const knowledge = composeKnowledgeServices(database, environment);
    const verify = composeVerificationServices(database, environment, { production });
    return {
      config,
      publicOrigin,
      capabilities: {
        persistence: Boolean(database),
        retrieval: Boolean(knowledge.canonicalRetrievalExecutor),
        citationReplay: Boolean(knowledge.replayEvidencePacketCitations),
        verification: verify.runtime.verificationConfigured,
      },
      ...(database
        ? {
            operations: {
              service: new PostgresKnowledgeOperationService(database),
              retrieval: new PostgresKnowledgeOperationService(database, {
                admittedOperationKinds: apiOwnedOperationKinds,
              }),
              callbackReplay: new PostgresCallbackReplayStore(database),
            },
          }
        : {}),
      knowledge,
      verify,
    };
  });
  return { profile: "server", role: "api", ...value, close: () => resources.close() };
}
