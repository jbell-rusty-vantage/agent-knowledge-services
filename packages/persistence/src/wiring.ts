import { SupabaseArtifactStore, type ArtifactStore } from "@aiengineer/knowledge-core";
import { PostgresCanonicalRepository, type PostgresPersistenceConfig } from "./postgres.js";

export interface CanonicalPersistenceConfig {
  readonly postgres: PostgresPersistenceConfig;
  readonly supabaseUrl: string;
  readonly supabaseSecretKey: string;
  readonly storageBucket: "source-captures" | "content-derivatives";
  readonly maximumArtifactBytes?: number;
}

export interface CanonicalPersistence {
  readonly database: PostgresCanonicalRepository;
  readonly artifacts: ArtifactStore;
  close(): Promise<void>;
}

export type CanonicalPersistenceEnvironment = Readonly<Record<string, string | undefined>>;

function required(environment: CanonicalPersistenceEnvironment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

/** Parse the one admitted Postgres + private Storage configuration used by deployed processes. */
export function canonicalPersistenceConfigFromEnvironment(
  environment: CanonicalPersistenceEnvironment,
): CanonicalPersistenceConfig {
  const storageBucket = environment.SUPABASE_STORAGE_BUCKET?.trim() || "source-captures";
  if (storageBucket !== "source-captures" && storageBucket !== "content-derivatives")
    throw new Error("CANONICAL_STORAGE_BUCKET_REQUIRED");
  const maximumArtifactBytesValue = environment.MAXIMUM_ARTIFACT_BYTES?.trim();
  const maximumArtifactBytes = maximumArtifactBytesValue ? Number(maximumArtifactBytesValue) : undefined;
  if (maximumArtifactBytes !== undefined && (!Number.isSafeInteger(maximumArtifactBytes) || maximumArtifactBytes < 1))
    throw new Error("INVALID_MAXIMUM_ARTIFACT_BYTES");
  return {
    postgres: {
      connectionString: required(environment, "POSTGRES_URL"),
      ...(environment.CANONICAL_LOCAL_ONLY === "1" ? { localOnly: true } : {}),
    },
    supabaseUrl: required(environment, "SUPABASE_URL"),
    supabaseSecretKey: required(environment, "SUPABASE_SECRET_KEY"),
    storageBucket,
    ...(maximumArtifactBytes === undefined ? {} : { maximumArtifactBytes }),
  };
}

export function createCanonicalPersistence(config: CanonicalPersistenceConfig): CanonicalPersistence {
  const database = new PostgresCanonicalRepository(config.postgres);
  const artifacts = new SupabaseArtifactStore({
    projectUrl: config.supabaseUrl,
    serviceRoleKey: config.supabaseSecretKey,
    bucket: config.storageBucket,
    maximumBytes: config.maximumArtifactBytes ?? 1_073_741_824,
  });
  return { database, artifacts, close: () => database.close() };
}

export function createCanonicalPersistenceFromEnvironment(
  environment: CanonicalPersistenceEnvironment = process.env,
): CanonicalPersistence {
  return createCanonicalPersistence(canonicalPersistenceConfigFromEnvironment(environment));
}
