import {
  apiOwnedOperationKinds,
  VerificationOperationApplicationService,
  type KnowledgeOperationPort,
} from "@aiengineer/knowledge-application";
import { PostgresKnowledgeOperationService } from "@aiengineer/knowledge-persistence";
import { loadServerConfig, type ServerConfig } from "../config/index.js";
import { constructWithResources } from "../lifecycle/resources.js";
import { composeKnowledgeServices, type KnowledgeServices } from "./knowledge.js";
import { openCanonicalRepository, type HostEnvironment } from "./shared.js";
import { composeVerificationServices, type VerificationServices } from "./verification.js";

export interface McpHostOptions {
  readonly profile: "server";
  readonly role: "mcp";
  readonly environment: HostEnvironment;
  /** Transport-owned API origin validation, applied before the database pool opens. */
  readonly resolveApiOrigin: (config: ServerConfig) => string;
}

/**
 * The API role's knowledge, verify and operations groups minus transport-only pieces
 * (callback replay, the service-only drift queue and API public-origin handling).
 */
export interface McpHost {
  readonly profile: "server";
  readonly role: "mcp";
  readonly config: ServerConfig;
  /** Public API origin advertised in accepted-operation poll links; MCP never calls it. */
  readonly apiOrigin: string;
  readonly operations: {
    readonly service: KnowledgeOperationPort;
    /** Admits the API-owned synchronous kinds (retrieval_run), exactly as the API role does. */
    readonly retrieval: KnowledgeOperationPort;
  };
  readonly knowledge: KnowledgeServices;
  readonly verify: VerificationServices & {
    /** Verification submissions whose accepted links are rooted at the API origin. */
    readonly operations?: VerificationOperationApplicationService;
  };
  close(): Promise<void>;
}

/** Server MCP composition. MCP always requires persistence and a validated API origin. */
export async function createMcpHost(options: McpHostOptions): Promise<McpHost> {
  const { environment } = options;
  const config = loadServerConfig({ ...environment, PORT: environment.PORT ?? "4101" });
  const connectionString = environment.POSTGRES_URL?.trim();
  if (!connectionString) throw new Error("POSTGRES_URL_REQUIRED");
  const apiOrigin = options.resolveApiOrigin(config);
  const { value, resources } = await constructWithResources((resources) => {
    const database = openCanonicalRepository(resources, connectionString, environment);
    const operationService = new PostgresKnowledgeOperationService(database);
    const knowledge = composeKnowledgeServices(database, environment);
    const verify = composeVerificationServices(database, environment, {
      production: config.NODE_ENV === "production",
    });
    const { runtime } = verify;
    return {
      operations: {
        service: operationService,
        retrieval: new PostgresKnowledgeOperationService(database, { admittedOperationKinds: apiOwnedOperationKinds }),
      },
      knowledge,
      verify: {
        ...verify,
        ...(runtime.verificationOperationService
          ? {
              operations: new VerificationOperationApplicationService(
                runtime.verificationOperationService,
                apiOrigin,
                runtime.verificationCaptureCatalog,
              ),
            }
          : {}),
      },
    };
  });
  return { profile: "server", role: "mcp", config, apiOrigin, ...value, close: () => resources.close() };
}
