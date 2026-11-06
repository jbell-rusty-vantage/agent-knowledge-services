import { describe, expect, it } from "vitest";
import { canonicalPersistenceConfigFromEnvironment } from "./wiring.js";

describe("canonical persistence environment", () => {
  const valid = {
    POSTGRES_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SECRET_KEY: "test-secret",
    SUPABASE_STORAGE_BUCKET: "source-captures",
  };

  it("builds the canonical Postgres and Storage pair", () => {
    expect(canonicalPersistenceConfigFromEnvironment(valid)).toMatchObject({
      postgres: { connectionString: valid.POSTGRES_URL },
      supabaseUrl: valid.SUPABASE_URL,
      storageBucket: "source-captures",
    });
  });

  it("fails closed for partial or non-canonical configuration", () => {
    expect(() => canonicalPersistenceConfigFromEnvironment({ ...valid, SUPABASE_SECRET_KEY: "" })).toThrow(
      "SUPABASE_SECRET_KEY_REQUIRED",
    );
    expect(() => canonicalPersistenceConfigFromEnvironment({ ...valid, SUPABASE_STORAGE_BUCKET: "public" })).toThrow(
      "CANONICAL_STORAGE_BUCKET_REQUIRED",
    );
    expect(() => canonicalPersistenceConfigFromEnvironment({ ...valid, MAXIMUM_ARTIFACT_BYTES: "0" })).toThrow(
      "INVALID_MAXIMUM_ARTIFACT_BYTES",
    );
  });
});
