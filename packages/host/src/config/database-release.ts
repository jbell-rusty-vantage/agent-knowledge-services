import {
  TenantPostgres,
  checkDatabaseRelease,
  serviceReleaseRange,
  type DatabaseReleaseCheckMode,
  type DatabaseReleaseObservation,
  type DatabaseReleaseReport,
  type DatabaseReleaseStatus,
} from "@aiengineer/knowledge-persistence";
import {
  AIENG_DB_RELEASE_CHECK_VARIABLE,
  ksDbVariable,
  loadKsDatabaseConfig,
  type KsDatabaseConfig,
  type KsDatabaseEnvironment,
} from "./database.js";

/**
 * Where a Knowledge Services process applies the AI Engineer database release check (VER-S1, D-117): the rule and
 * this service's range live in `packages/persistence/src/database-release.ts`; the mode comes from
 * `loadKsDatabaseConfig` (`AIENG_DB_RELEASE_CHECK`). A process that opens the AI Engineer database calls one of the
 * two functions below before it serves or writes. Neither ever asks a Biotech database.
 */

export type { DatabaseReleaseCheckMode, DatabaseReleaseObservation, DatabaseReleaseReport, DatabaseReleaseStatus };
export { DatabaseReleaseRefused, databaseReleaseStatus } from "@aiengineer/knowledge-persistence";

/** A pool that can ask its database for its release (`PostgresCanonicalRepository`, `TenantPostgres`). */
export interface DatabaseReleaseProbe {
  databaseRelease(): Promise<DatabaseReleaseObservation>;
}

/** The component login of the AI Engineer plane: a binding that names it works in the AI Engineer database. */
export const AIENG_COMPONENT_DSN_VARIABLE = ksDbVariable("AIENG", "COMPONENT_DSN");

/** What a process that has not asked yet can say: the range it works with and the mode it would check in. */
export function databaseReleaseExpectation(environment: KsDatabaseEnvironment): {
  readonly range: string;
  readonly check: DatabaseReleaseCheckMode;
  readonly variable: string;
} {
  return {
    range: serviceReleaseRange(),
    check: loadKsDatabaseConfig(environment, "ai-engineer", { log: false }).releaseCheck ?? "enforce",
    variable: AIENG_DB_RELEASE_CHECK_VARIABLE,
  };
}

/**
 * The startup check of a process that holds an open pool on the plane `selection` names. On the AIENG plane it asks
 * the database for its release and, in enforce mode, throws `DatabaseReleaseRefused` unless the release is one this
 * service works with; the report is what the process then states on its status and health surfaces. A database
 * without the `api` schema holds no AI Engineer contract: the verdict is `not_applicable` and the process starts.
 * On any other plane it asks nothing and returns `undefined`. The log line is silent when `NODE_ENV=test`.
 */
export async function startOnAiEngineerDatabase(
  database: DatabaseReleaseProbe,
  selection: Pick<KsDatabaseConfig, "plane" | "releaseCheck">,
  environment: KsDatabaseEnvironment = {},
): Promise<DatabaseReleaseReport | undefined> {
  if (selection.plane !== "AIENG") return undefined;
  return checkDatabaseRelease(() => database.databaseRelease(), {
    mode: selection.releaseCheck ?? "enforce",
    ...(environment.NODE_ENV === "test" ? { log: false as const } : {}),
  });
}

/**
 * The same check for a path that holds only a DSN of the AI Engineer database (a binding's component login, a
 * one-off CLI write): one connection is opened, asked and closed. In `off` mode nothing is opened.
 */
export async function startOnAiEngineerDatabaseAt(
  connectionString: string,
  environment: KsDatabaseEnvironment,
  open: (connectionString: string) => DatabaseReleaseProbe & { close(): Promise<void> } = (dsn) =>
    new TenantPostgres({
      connectionString: dsn,
      maximumPoolSize: 1,
      applicationName: "knowledge-services-release-check",
    }),
): Promise<DatabaseReleaseReport> {
  const mode = loadKsDatabaseConfig(environment, "ai-engineer", { log: false }).releaseCheck ?? "enforce";
  const options = { mode, ...(environment.NODE_ENV === "test" ? { log: false as const } : {}) };
  if (mode === "off") return checkDatabaseRelease(async () => ({ contract: true, answer: null }), options);
  const database = open(connectionString);
  try {
    return await checkDatabaseRelease(() => database.databaseRelease(), options);
  } finally {
    await database.close().catch(() => undefined);
  }
}
