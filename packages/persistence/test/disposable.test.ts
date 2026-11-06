import { describe, expect, it } from "vitest";
import { disposableDatabaseUrl, validateDisposableTarget } from "./disposable.mjs";

const target = () => ({
  databaseUrl: "postgresql://postgres:fixture@127.0.0.1:54322/postgres",
  projectDirectory: "C:/fixture/disposable-proof01",
  config: 'project_id = "disposable-proof01"',
  container: {
    Name: "/supabase_db_disposable-proof01",
    State: { Running: true },
    Config: {
      Labels: {
        "com.supabase.cli.project": "disposable-proof01",
        "com.supabase.cli.workdir": "C:/fixture/disposable-proof01",
      },
    },
    NetworkSettings: { Ports: { "5432/tcp": [{ HostPort: "54322" }] } },
  },
});

describe("disposable database identity", () => {
  it("requires matching project, container, checkout and exposed port", () => {
    expect(validateDisposableTarget(target())).toBe("disposable-proof01");
    for (const field of ["Name", "State", "Config", "NetworkSettings"] as const) {
      const input = target();
      const replacements = {
        Name: "/supabase_db_aiengineer",
        State: { Running: false },
        Config: { Labels: { "com.supabase.cli.project": "aiengineer", "com.supabase.cli.workdir": "C:/shared" } },
        NetworkSettings: { Ports: { "5432/tcp": [{ HostPort: "5433" }] } },
      };
      expect(() =>
        validateDisposableTarget({ ...input, container: { ...input.container, [field]: replacements[field] } }),
      ).toThrow(/IDENTITY_MISMATCH/);
    }
  });
  it("rejects shared, remote, overridden and missing required targets", () => {
    expect(() => validateDisposableTarget({ ...target(), config: 'project_id = "aiengineer"' })).toThrow(
      /DISPOSABLE_PROJECT_REQUIRED/,
    );
    for (const databaseUrl of [
      "postgresql://example.com:54322/postgres",
      "postgresql://localhost:54322/shared",
      "postgresql://localhost:54322/postgres?options=override",
    ]) {
      expect(() => validateDisposableTarget({ ...target(), databaseUrl })).toThrow(/URL_DENIED/);
    }
    expect(() => disposableDatabaseUrl({ KS_REQUIRE_CURRENT_SCHEMA: "1" })).toThrow(/URL_REQUIRED/);
    expect(disposableDatabaseUrl({ POSTGRES_URL: "postgresql://shared" })).toBeUndefined();
  });
});
