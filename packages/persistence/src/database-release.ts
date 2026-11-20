import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiDatabaseReleaseState, ApiReleaseVerdict } from "@aiengineer/database-contract/api";

/**
 * The AI Engineer database release check (VER-S1, D-117).
 *
 * One release number covers the whole AI Engineer database: the contract version. The database states it through
 * `api.database_release()`; a service states the releases it works with (its range) and refuses to start on any
 * other. The rule here is a port of the contract repository's `scripts/database-release.mjs` (`inRange`,
 * `releaseVerdict`, `checkMode`, `readDatabaseRelease`); the AI Engineer service and Mission Control apply the same
 * rule, and all three run the cases the contract package ships as `release-check.cases.json`.
 *
 * This service's range is the `version` of the vendored `@aiengineer/database-contract` package, read from its
 * `contract.version.json` ({@link serviceReleaseRange}). Until 1.0.0 a range is that exact version. It applies to
 * the AI Engineer database only, never to the Biotech database.
 *
 * One outcome is this consumer's own and precedes the shared rule, as in Mission Control: a database without the
 * `api` schema does not hold the AI Engineer contract at all (a disposable database with only the verification
 * component, for example). There is no release to check, so the verdict is `not_applicable` and the process starts.
 * A database that has the `api` schema but no `api.database_release()` is an AI Engineer database that states no
 * release: the shared rule calls that `unknown` and refuses it.
 */

export const DATABASE_RELEASE_FORMAT = "ai-engineer-database-release/1";
/** The variable that sets the mode. Read from a process environment only by the host's database config module. */
export const DATABASE_RELEASE_CHECK_VARIABLE = "AIENG_DB_RELEASE_CHECK";
export const DATABASE_RELEASE_CHECK_MODES = ["enforce", "warn", "off"] as const;
/** `enforce` (the default) refuses to start, `warn` always starts and logs the verdict, `off` does not ask. */
export type DatabaseReleaseCheckMode = (typeof DATABASE_RELEASE_CHECK_MODES)[number];
export type DatabaseReleaseState = ApiDatabaseReleaseState;
/** `start`: whether a service in enforce mode starts. `warning`: it starts on a database that is not exactly the stamped release. */
export type DatabaseReleaseVerdict = ApiReleaseVerdict;

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const RANGE = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/;

function parts(version: unknown): [number, number, number] {
  const match = VERSION.exec(String(version));
  if (!match) throw new Error(`not a release version: ${String(version)}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1, 0 or 1: numeric comparison of two X.Y.Z versions. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [x, y] = [parts(a), parts(b)];
  for (const index of [0, 1, 2] as const) if (x[index] !== y[index]) return x[index] < y[index] ? -1 : 1;
  return 0;
}

/** Whether a release is inside a consumer's range: an exact version, or ">=A.B.C <D.E.F". */
export function inRange(version: string, range: string): boolean {
  if (VERSION.test(range)) return compareVersions(version, range) === 0;
  const match = RANGE.exec(range);
  if (!match?.[1] || !match[2]) throw new Error(`not a release range: ${range} (write X.Y.Z or ">=A.B.C <D.E.F")`);
  return compareVersions(version, match[1]) >= 0 && compareVersions(version, match[2]) < 0;
}

const WARNINGS: Readonly<Record<string, string>> = {
  ahead: "migrations were applied after the stamp (unreleased changes)",
  component_drift: "a guest component differs from the version the release pins",
  unverifiable: "the migration list could not be read, so the stamp is unchecked",
};

/**
 * The verdict on what `api.database_release()` returned (null when the database gave no answer) for a range.
 * Nothing or another format is `unknown`, a null release `unstamped`, a release outside the range `incompatible`,
 * state `inconsistent` is `inconsistent`: all four refuse. In range with state `current` is `ok`; with `ahead`,
 * `component_drift` or `unverifiable` it is `ok` with a warning.
 */
export function releaseVerdict(observed: unknown, range: string): DatabaseReleaseVerdict {
  const answer = (observed !== null && typeof observed === "object" ? observed : {}) as {
    readonly format?: unknown;
    readonly release?: string | null;
    readonly state?: DatabaseReleaseState | null;
  };
  const facts = { range, release: answer.release ?? null, state: answer.state ?? null };
  const refuse = (verdict: DatabaseReleaseVerdict["verdict"], reason: string): DatabaseReleaseVerdict => ({
    verdict,
    start: false,
    warning: false,
    ...facts,
    reason,
  });
  if (answer.format !== DATABASE_RELEASE_FORMAT)
    return refuse(
      "unknown",
      "the database does not state a release (api.database_release() is missing or answered in another format)",
    );
  if (facts.release === null) return refuse("unstamped", "the database has never been stamped with a release");
  if (!inRange(facts.release, range))
    return refuse("incompatible", `the database is release ${facts.release}; this service works with ${range}`);
  if (facts.state === "inconsistent")
    return refuse(
      "inconsistent",
      `the database is stamped ${facts.release} but its migrations are behind that release`,
    );
  if (facts.state === "current")
    return { verdict: "ok", start: true, warning: false, ...facts, reason: `the database is release ${facts.release}` };
  const why = WARNINGS[String(facts.state)] ?? `state ${String(facts.state)}`;
  return {
    verdict: "ok",
    start: true,
    warning: true,
    ...facts,
    reason: `the database is release ${facts.release}; ${why}`,
  };
}

/** `enforce` (default), `warn` or `off`, from `AIENG_DB_RELEASE_CHECK` in the given environment. */
export function checkMode(env: Readonly<Record<string, string | undefined>>): DatabaseReleaseCheckMode {
  const mode = String(env[DATABASE_RELEASE_CHECK_VARIABLE] ?? "enforce")
    .trim()
    .toLowerCase();
  if (!(DATABASE_RELEASE_CHECK_MODES as readonly string[]).includes(mode))
    throw new Error(
      `${DATABASE_RELEASE_CHECK_VARIABLE} must be enforce, warn or off (got ${env[DATABASE_RELEASE_CHECK_VARIABLE]})`,
    );
  return mode as DatabaseReleaseCheckMode;
}

/** The part of a connection the read needs; `TenantSqlClient`, a pool client and a test double all fit. */
export interface DatabaseReleaseClient {
  query(text: string): Promise<{ rows: readonly Record<string, unknown>[] }>;
}

/** What the database says: the JSON of `api.database_release()`, or null when the function is not there. Reads only. */
export async function readDatabaseRelease(client: DatabaseReleaseClient): Promise<unknown> {
  const present = (await client.query("select to_regprocedure('api.database_release()') is not null as ok")).rows[0]
    ?.ok;
  if (present !== true) return null;
  return (await client.query("select api.database_release() as r")).rows[0]?.r ?? null;
}

/** What a database says before the rule applies. */
export interface DatabaseReleaseObservation {
  /** Whether the database holds the AI Engineer contract at all: it has the `api` schema. */
  readonly contract: boolean;
  /** The JSON of `api.database_release()`, or null when the function is not there. Never read without the contract. */
  readonly answer: unknown;
}

/**
 * Asks one connection: first whether the `api` schema exists (`to_regnamespace`, which needs no privilege), and only
 * then for the release. A database without the schema is never asked for the function. Reads only.
 */
export async function observeDatabaseRelease(client: DatabaseReleaseClient): Promise<DatabaseReleaseObservation> {
  const absent = (await client.query("select to_regnamespace('api') is null as absent")).rows[0]?.absent;
  if (absent === true) return { contract: false, answer: null };
  return { contract: true, answer: await readDatabaseRelease(client) };
}

const CONTRACT_PACKAGE = "@aiengineer/database-contract";

/** The record of the vendored contract package: the release this service was built for. */
export interface PinnedContractRelease {
  readonly version: string;
  readonly migrationHead: string;
  /** The installed package directory; it also holds `release-check.cases.json` and `releases/`. */
  readonly packageRoot: string;
}

let pinned: PinnedContractRelease | undefined;

/** Reads `contract.version.json` of the installed `@aiengineer/database-contract` package (once per process). */
export function pinnedContractRelease(): PinnedContractRelease {
  if (pinned) return pinned;
  const missing = `DATABASE_CONTRACT_PACKAGE_MISSING: ${CONTRACT_PACKAGE} is not installed beside this package`;
  let directory: string;
  try {
    directory = dirname(fileURLToPath(import.meta.resolve(CONTRACT_PACKAGE)));
  } catch {
    throw new Error(missing);
  }
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(directory, "package.json");
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === CONTRACT_PACKAGE
    ) {
      const record = JSON.parse(readFileSync(join(directory, "contract.version.json"), "utf8")) as {
        version?: unknown;
        migration_head?: unknown;
      };
      if (typeof record.version !== "string" || !VERSION.test(record.version))
        throw new Error(`DATABASE_CONTRACT_VERSION_INVALID: ${CONTRACT_PACKAGE} contract.version.json names no X.Y.Z`);
      pinned = { version: record.version, migrationHead: String(record.migration_head ?? ""), packageRoot: directory };
      return pinned;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(missing);
}

/** The database releases this service works with: the exact version of the vendored contract (until 1.0.0). */
export function serviceReleaseRange(): string {
  return pinnedContractRelease().version;
}

/** What a process reports about the database release it runs on (status, health, startup log). */
export interface DatabaseReleaseReport {
  /** The mode the check ran in (`AIENG_DB_RELEASE_CHECK`). */
  readonly check: DatabaseReleaseCheckMode;
  /** The releases this service works with. */
  readonly range: string;
  /** The release the database stated; null when it stated none or was not asked. */
  readonly release: string | null;
  readonly state: string | null;
  /**
   * The verdict of the shared rule, or one of this consumer's own two: `not_checked` when the mode is `off`,
   * `not_applicable` when the database does not hold the AI Engineer contract (no `api` schema).
   */
  readonly verdict: DatabaseReleaseVerdict["verdict"] | "not_checked" | "not_applicable";
  readonly warning: boolean;
  readonly reason: string;
  /** When the database was asked (ISO 8601); the report is not refreshed afterwards. */
  readonly checkedAt: string;
}

/** The report without its free-text reason: what an unauthenticated status or health answer may carry. */
export type DatabaseReleaseStatus = Omit<DatabaseReleaseReport, "reason">;

export function databaseReleaseStatus(report: DatabaseReleaseReport): DatabaseReleaseStatus {
  return {
    check: report.check,
    range: report.range,
    release: report.release,
    state: report.state,
    verdict: report.verdict,
    warning: report.warning,
    checkedAt: report.checkedAt,
  };
}

/** Startup was refused: the database is not a release this service works with (enforce mode). */
export class DatabaseReleaseRefused extends Error {
  readonly code = "AIENG_DB_RELEASE_REFUSED";
  constructor(readonly report: DatabaseReleaseReport) {
    super(
      `AIENG_DB_RELEASE_REFUSED: the AI Engineer database is not a release this service works with ` +
        `(verdict ${report.verdict}: ${report.reason}). Database release: ${report.release ?? "none stated"}; ` +
        `state: ${report.state ?? "none stated"}; this service works with: ${report.range}. ` +
        `${DATABASE_RELEASE_CHECK_VARIABLE}=warn starts anyway and logs this verdict; ` +
        `${DATABASE_RELEASE_CHECK_VARIABLE}=off does not ask the database.`,
    );
    this.name = "DatabaseReleaseRefused";
  }
}

export interface DatabaseReleaseCheckOptions {
  readonly mode: DatabaseReleaseCheckMode;
  /** The range, or how to read it. Default: {@link serviceReleaseRange}. */
  readonly range?: string | (() => string);
  /** Receives the report when there is something to say. Default: one JSON line on stderr; `false` is silent. */
  readonly log?: ((event: DatabaseReleaseReport & { readonly event: string }) => void) | false;
  readonly now?: () => Date;
}

function withoutDsn(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<dsn>");
}

/**
 * The startup check. Asks the database through `read` (for example `() => repository.databaseRelease()`), applies
 * the rule and decides:
 *
 * - `off`: the database is not asked; the report says `not_checked`.
 * - a database without the AI Engineer contract (no `api` schema): `not_applicable`; the process starts in either
 *   mode and the report is logged once.
 * - `enforce`: a verdict that does not start throws {@link DatabaseReleaseRefused}; a warning is logged.
 * - `warn`: the verdict is logged and the process starts whatever it is.
 *
 * A database that cannot be asked (unreachable, no permission) gave no answer: the verdict is `unknown`. So is a
 * process that cannot read its own range (the contract package is not installed beside it): it reports the range
 * as `unknown`, asks nothing and, in enforce mode, refuses.
 */
export async function checkDatabaseRelease(
  read: () => Promise<DatabaseReleaseObservation>,
  options: DatabaseReleaseCheckOptions,
): Promise<DatabaseReleaseReport> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const log = (report: DatabaseReleaseReport): void => {
    if (options.log === false) return;
    const event = { event: "ks.database.release", ...report };
    if (options.log) options.log(event);
    else process.stderr.write(`${JSON.stringify(event)}\n`);
  };
  const said = (error: unknown) => withoutDsn(error instanceof Error ? error.message : String(error));
  let range = "unknown";
  let rangeless: string | undefined;
  try {
    range = typeof options.range === "string" ? options.range : (options.range ?? serviceReleaseRange)();
  } catch (error) {
    rangeless = `this service cannot state the releases it works with (${said(error)})`;
  }
  if (rangeless === undefined) inRange("0.0.0", range); // a malformed range is this service's own error: throw
  if (options.mode === "off")
    return {
      check: "off",
      range,
      release: null,
      state: null,
      verdict: "not_checked",
      warning: false,
      reason: `${DATABASE_RELEASE_CHECK_VARIABLE}=off: the database was not asked`,
      checkedAt,
    };
  const noAnswer = (reason: string): DatabaseReleaseVerdict => ({
    verdict: "unknown",
    start: false,
    warning: false,
    range,
    release: null,
    state: null,
    reason,
  });
  let verdict: DatabaseReleaseVerdict;
  if (rangeless !== undefined) verdict = noAnswer(rangeless);
  else
    try {
      const observed = await read();
      if (!observed.contract) {
        const outside: DatabaseReleaseReport = {
          check: options.mode,
          range,
          release: null,
          state: null,
          verdict: "not_applicable",
          warning: false,
          reason: "the database does not hold the AI Engineer contract (no api schema), so it has no release to check",
          checkedAt,
        };
        log(outside);
        return outside;
      }
      try {
        verdict = releaseVerdict(observed.answer, range);
      } catch (error) {
        verdict = noAnswer(`the database stated a release this service cannot read (${said(error)})`);
      }
    } catch (error) {
      verdict = noAnswer(`the database could not be asked for its release (${said(error)})`);
    }
  const report: DatabaseReleaseReport = {
    check: options.mode,
    range,
    release: verdict.release,
    state: verdict.state,
    verdict: verdict.verdict,
    warning: verdict.warning,
    reason: verdict.reason,
    checkedAt,
  };
  if (!verdict.start && options.mode === "enforce") throw new DatabaseReleaseRefused(report);
  log(report);
  return report;
}
