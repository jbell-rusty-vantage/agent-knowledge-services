import { PostgresCanonicalRepository } from "@aiengineer/knowledge-persistence";
import type { HostResources } from "../lifecycle/resources.js";

export type HostEnvironment = Readonly<Record<string, string | undefined>>;

/** Opens the canonical pool under host ownership; the pool connects lazily on first query. */
export function openCanonicalRepository(
  resources: HostResources,
  connectionString: string,
  environment: HostEnvironment,
): PostgresCanonicalRepository {
  return resources.own(
    "postgres",
    new PostgresCanonicalRepository({
      connectionString,
      ...(environment.CANONICAL_LOCAL_ONLY === "1" ? { localOnly: true } : {}),
    }),
    (database) => database.close(),
  );
}

/** Parses a positive integer setting; failures keep the historical `INVALID_<NAME>` code. */
export function positiveIntegerSetting(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`INVALID_${name}`);
  return parsed;
}
