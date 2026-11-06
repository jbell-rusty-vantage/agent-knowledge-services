import {
  disposableDatabaseUrl,
  disposableStorageConfig,
} from "../../../../../packages/persistence/test/disposable.mjs";

export const databaseUrl = disposableDatabaseUrl();
export const storage = disposableStorageConfig();

export const runLocalPersistenceTests = process.env.RUN_LOCAL_PERSISTENCE_TESTS === "1" && Boolean(databaseUrl);
export const runLocalStorageTests = runLocalPersistenceTests && Boolean(storage);

export function requireDisposableDatabaseUrl(): string {
  if (!databaseUrl) throw new Error("KS_TEST_DATABASE_URL_REQUIRED");
  return databaseUrl;
}
