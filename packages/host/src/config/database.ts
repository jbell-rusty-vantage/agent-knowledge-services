import {
  DATABASE_RELEASE_CHECK_VARIABLE,
  checkMode,
  type DatabaseReleaseCheckMode,
} from "@aiengineer/knowledge-persistence";
import { z } from "zod";

/**
 * Knowledge Services database environment (contract: BellLabs `platform/ENV-DB-CONTRACT-2026-11-07.md`).
 *
 * This module is the ONLY code that reads the `KS_{AIENG,BIOTECH}_DB_*` variables and `AIENG_DB_RELEASE_CHECK`.
 * Callers receive the resolved plane object. There are no aliases and no fallback to earlier names. Values are never
 * logged; the startup selection record carries only the plane, the project ref and the host(s).
 *
 * Local by default (SPEC-03 K3): a process that names no application (`KS_APPLICATION` unset and no explicit
 * argument) may only reach loopback databases and endpoints; any remote URL or DSN is refused with
 * `KS_DB_REMOTE_REQUIRES_APPLICATION`. Setting `KS_APPLICATION=ai-engineer` (or `biotech`) names the plane and
 * allows its remote values.
 */

/** Plane token -> the application it serves. */
export const KS_DB_PLANE_APPLICATIONS = { AIENG: "ai-engineer", BIOTECH: "biotech" } as const;
export type KsDbPlane = keyof typeof KS_DB_PLANE_APPLICATIONS;
export const KS_DB_PLANES = Object.keys(KS_DB_PLANE_APPLICATIONS) as readonly KsDbPlane[];

export const KS_DB_ROLES = ["PROJECT_REF", "URL", "SECRET_KEY", "ADMIN_DSN", "RUNTIME_DSN", "COMPONENT_DSN"] as const;
export type KsDbRole = (typeof KS_DB_ROLES)[number];

/** `KS_<PLANE>_DB_<ROLE>`. */
export function ksDbVariable(plane: KsDbPlane, role: KsDbRole): string {
  return `KS_${plane}_DB_${role}`;
}

/** Every database variable name this module reads (the registry `config/env.registry.yaml` must list exactly these). */
export const KS_DB_VARIABLE_NAMES: readonly string[] = KS_DB_PLANES.flatMap((plane) =>
  KS_DB_ROLES.map((role) => ksDbVariable(plane, role)),
);

/** The two names a binding's `databaseUrlEnv` may carry. */
export const KS_DB_COMPONENT_DSN_VARIABLES = KS_DB_PLANES.map((plane) => ksDbVariable(plane, "COMPONENT_DSN")) as [
  string,
  ...string[],
];

/** The one variable that names a process's application, and with it the plane it may reach remotely. */
export const KS_APPLICATION_VARIABLE = "KS_APPLICATION";

/**
 * How a process checks the release of the AI Engineer database before it starts (VER-S1): `enforce` (default),
 * `warn` or `off`. The name is the contract's, shared with the AI Engineer service and Mission Control, so it carries
 * no `KS_` prefix. It applies to the AIENG plane only; the Biotech database has no release check.
 */
export const AIENG_DB_RELEASE_CHECK_VARIABLE = DATABASE_RELEASE_CHECK_VARIABLE;

/** `ai-engineer` -> AIENG, `biotech` -> BIOTECH; a process started without an application uses AIENG (loopback only). */
export function ksDbPlaneForApplication(application?: string): KsDbPlane {
  if (application === undefined) return "AIENG";
  for (const plane of KS_DB_PLANES) if (KS_DB_PLANE_APPLICATIONS[plane] === application) return plane;
  throw new Error("KS_DB_APPLICATION_UNKNOWN");
}

export type KsDatabaseEnvironment = Readonly<Record<string, string | undefined>>;

const optional = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

const dsn = optional.refine(
  (value) => value === undefined || /^postgres(?:ql)?:\/\//i.test(value),
  "must be a postgres:// or postgresql:// DSN",
);
const httpUrl = optional.refine(
  (value) => value === undefined || /^https?:\/\//i.test(value),
  "must be an http(s) URL",
);
const projectRef = optional.refine(
  (value) => value === undefined || /^[a-z0-9][a-z0-9-]{0,62}$/.test(value),
  "must be a project ref (lowercase letters, digits, hyphen)",
);

const PlaneSchema = z.object({
  PROJECT_REF: projectRef,
  URL: httpUrl,
  SECRET_KEY: optional,
  ADMIN_DSN: dsn,
  RUNTIME_DSN: dsn,
  COMPONENT_DSN: dsn,
});

/** What a startup log line may carry. */
export interface KsDatabaseSelection {
  readonly plane: KsDbPlane;
  readonly projectRef: string | undefined;
  readonly hosts: readonly string[];
}

export interface KsDatabaseConfig {
  readonly plane: KsDbPlane;
  /** The application that named the plane (argument or `KS_APPLICATION`); `undefined` = loopback-only. */
  readonly application?: string;
  /** The variable names of this plane, for "set X" error messages and docs. */
  readonly names: Readonly<Record<KsDbRole, string>>;
  readonly projectRef?: string;
  /** Supabase project URL. */
  readonly url?: string;
  /** Supabase secret (service) key. Never logged. */
  readonly secretKey?: string;
  /** Schema-owner / installer login. */
  readonly adminDsn?: string;
  /** Canonical runtime pool login. */
  readonly runtimeDsn?: string;
  /** Binding component database login. */
  readonly componentDsn?: string;
  /** The release-check mode (`AIENG_DB_RELEASE_CHECK`); present on the AIENG plane only. */
  readonly releaseCheck?: DatabaseReleaseCheckMode;
  readonly selection: KsDatabaseSelection;
}

export interface LoadKsDatabaseOptions {
  /** Receives the selection record (plane, ref, host only). Default: one stderr JSON line per distinct selection, silent when NODE_ENV=test. */
  readonly log?: ((selection: KsDatabaseSelection) => void) | false;
}

function namesOf(plane: KsDbPlane): Readonly<Record<KsDbRole, string>> {
  return Object.fromEntries(KS_DB_ROLES.map((role) => [role, ksDbVariable(plane, role)])) as Record<KsDbRole, string>;
}

function hostAndUser(value: string): { host: string; user: string } | undefined {
  try {
    const parsed = new URL(value);
    return { host: parsed.hostname.toLowerCase(), user: decodeURIComponent(parsed.username).toLowerCase() };
  } catch {
    return undefined;
  }
}

/** Loopback hosts, plus the empty host of a Unix-socket DSN. Anything else counts as remote. */
export function isLoopbackHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "" ||
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(value)
  );
}

function namedApplication(environment: KsDatabaseEnvironment, application?: string): string | undefined {
  if (application !== undefined) return application;
  const value = environment[KS_APPLICATION_VARIABLE]?.trim();
  return value ? value : undefined;
}

const logged = new Set<string>();
function defaultLog(environment: KsDatabaseEnvironment, selection: KsDatabaseSelection): void {
  if (!selection.projectRef || environment.NODE_ENV === "test") return;
  const key = `${selection.plane}|${selection.projectRef}|${selection.hosts.join(",")}`;
  if (logged.has(key)) return;
  logged.add(key);
  process.stderr.write(`${JSON.stringify({ event: "ks.database.selected", ...selection })}\n`);
}

/**
 * Resolves the plane for `application` (argument, else `KS_APPLICATION`; `ai-engineer`, `biotech`; neither = AIENG
 * restricted to loopback), validates the shape of each value present, refuses a remote value when no application is
 * named (`KS_DB_REMOTE_REQUIRES_APPLICATION`), and refuses when `KS_<PLANE>_DB_PROJECT_REF` is set but does not appear
 * in the host or user of a sibling URL/DSN (contract rule 3). With no project ref (a disposable loopback database)
 * the ref check is skipped. Which values a process needs is the caller's decision; absent values are `undefined`.
 * On the AIENG plane it also reads the release-check mode and refuses a word other than enforce, warn or off.
 */
export function loadKsDatabaseConfig(
  environment: KsDatabaseEnvironment = process.env,
  application?: string,
  options: LoadKsDatabaseOptions = {},
): KsDatabaseConfig {
  const named = namedApplication(environment, application);
  const plane = ksDbPlaneForApplication(named);
  const names = namesOf(plane);
  const raw = Object.fromEntries(KS_DB_ROLES.map((role) => [role, environment[names[role]]]));
  const parsed = PlaneSchema.safeParse(raw);
  if (!parsed.success) {
    const role = String(parsed.error.issues[0]?.path[0] ?? "") as KsDbRole;
    throw new Error(`KS_DB_INVALID: ${names[role] ?? "value"} ${parsed.error.issues[0]?.message ?? "is invalid"}`);
  }
  const value = parsed.data;

  const hosts = new Set<string>();
  for (const role of ["URL", "ADMIN_DSN", "RUNTIME_DSN", "COMPONENT_DSN"] as const) {
    const candidate = value[role];
    if (!candidate) continue;
    const parts = hostAndUser(candidate);
    if (!parts) throw new Error(`KS_DB_INVALID: ${names[role]} is not a parseable URL`);
    hosts.add(parts.host);
    if (named === undefined && !isLoopbackHost(parts.host))
      throw new Error(
        `KS_DB_REMOTE_REQUIRES_APPLICATION: ${names[role]} points at a remote host and no application is named; set ${KS_APPLICATION_VARIABLE}=ai-engineer (or biotech) to use that plane, or point it at a loopback database`,
      );
    if (value.PROJECT_REF) {
      const ref = value.PROJECT_REF.toLowerCase();
      if (!parts.host.includes(ref) && !parts.user.includes(ref))
        throw new Error(`KS_DB_PROJECT_REF_MISMATCH: ${names[role]} does not belong to ${names.PROJECT_REF}`);
    }
  }

  const selection: KsDatabaseSelection = { plane, projectRef: value.PROJECT_REF, hosts: [...hosts].sort() };
  const config: KsDatabaseConfig = {
    plane,
    ...(named !== undefined ? { application: named } : {}),
    names,
    ...(value.PROJECT_REF ? { projectRef: value.PROJECT_REF } : {}),
    ...(value.URL ? { url: value.URL } : {}),
    ...(value.SECRET_KEY ? { secretKey: value.SECRET_KEY } : {}),
    ...(value.ADMIN_DSN ? { adminDsn: value.ADMIN_DSN } : {}),
    ...(value.RUNTIME_DSN ? { runtimeDsn: value.RUNTIME_DSN } : {}),
    ...(value.COMPONENT_DSN ? { componentDsn: value.COMPONENT_DSN } : {}),
    ...(plane === "AIENG" ? { releaseCheck: checkMode(environment) } : {}),
    selection,
  };
  if (options.log === undefined) defaultLog(environment, selection);
  else if (options.log) options.log(selection);
  return config;
}

/**
 * The component DSN a binding or tool names by variable (`databaseUrlEnv`). The name must be one of
 * {@link KS_DB_COMPONENT_DSN_VARIABLES}; when `application` is a known application its own plane's name is required.
 * `undefined` when the named variable is unset.
 */
export function resolveComponentDsn(
  environment: KsDatabaseEnvironment,
  variable: string,
  application?: string,
): { readonly variable: string; readonly dsn: string | undefined } {
  const plane = KS_DB_PLANES.find((candidate) => ksDbVariable(candidate, "COMPONENT_DSN") === variable);
  if (!plane)
    throw new Error(
      `KS_DB_COMPONENT_VARIABLE_UNKNOWN: ${variable} is not one of ${KS_DB_COMPONENT_DSN_VARIABLES.join(", ")}`,
    );
  if (application !== undefined && KS_DB_PLANE_APPLICATIONS[plane] !== application && isKnownApplication(application))
    throw new Error(`KS_DB_COMPONENT_VARIABLE_PLANE_MISMATCH: ${variable} does not serve application ${application}`);
  return { variable, dsn: loadKsDatabaseConfig(environment, KS_DB_PLANE_APPLICATIONS[plane]).componentDsn };
}

function isKnownApplication(application: string): boolean {
  return (Object.values(KS_DB_PLANE_APPLICATIONS) as string[]).includes(application);
}
