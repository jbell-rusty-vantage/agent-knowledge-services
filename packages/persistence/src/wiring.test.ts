import { describe, expect, it } from "vitest";
import { canonicalPersistenceConfigFromEnvironment } from "./wiring.js";

describe("canonical persistence environment", () => {
  const names = {
    RUNTIME_DSN: "KS_AIENG_DB_RUNTIME_DSN",
    URL: "KS_AIENG_DB_URL",
    SECRET_KEY: "KS_AIENG_DB_SECRET_KEY",
  } as const;
  const database = {
    runtimeDsn: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    url: "http://127.0.0.1:54321",
    secretKey: "test-secret",
    names,
  };
  const environment = { SUPABASE_STORAGE_BUCKET: "source-captures" };

  it("builds the canonical Postgres and Storage pair", () => {
    expect(canonicalPersistenceConfigFromEnvironment(database, environment)).toMatchObject({
      postgres: { connectionString: database.runtimeDsn },
      supabaseUrl: database.url,
      storageBucket: "source-captures",
    });
  });

  it("fails closed for partial or non-canonical configuration", () => {
    expect(() => canonicalPersistenceConfigFromEnvironment({ ...database, secretKey: "" }, environment)).toThrow(
      "KS_AIENG_DB_SECRET_KEY_REQUIRED",
    );
    expect(() =>
      canonicalPersistenceConfigFromEnvironment({ ...database, runtimeDsn: undefined }, environment),
    ).toThrow("KS_AIENG_DB_RUNTIME_DSN_REQUIRED");
    expect(() => canonicalPersistenceConfigFromEnvironment(database, { SUPABASE_STORAGE_BUCKET: "public" })).toThrow(
      "CANONICAL_STORAGE_BUCKET_REQUIRED",
    );
    expect(() =>
      canonicalPersistenceConfigFromEnvironment(database, { ...environment, MAXIMUM_ARTIFACT_BYTES: "0" }),
    ).toThrow("INVALID_MAXIMUM_ARTIFACT_BYTES");
  });
});
