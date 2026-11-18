import { describe, expect, it } from "vitest";
import { disposableAdminDsn } from "./disposable-admin.js";

describe("disposable administrator DSN", () => {
  it("is undefined when unset so the integration suites skip", () => {
    expect(disposableAdminDsn({})).toBeUndefined();
    expect(disposableAdminDsn({ KS_AIENG_DB_ADMIN_DSN: "  " })).toBeUndefined();
  });

  it("accepts loopback hosts only", () => {
    for (const dsn of [
      "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
      "postgresql://u:p@localhost:55433/postgres",
      "postgresql://u:p@[::1]:5432/postgres",
    ])
      expect(disposableAdminDsn({ KS_AIENG_DB_ADMIN_DSN: dsn })).toBe(dsn);
  });

  it("refuses a remote administrator login instead of reaching it", () => {
    for (const dsn of [
      "postgresql://postgres:fake@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
      "postgresql://u:p@10.0.0.5:5432/postgres",
      "postgresql://u:p@127.0.0.1.example.com:5432/postgres",
    ])
      expect(() => disposableAdminDsn({ KS_AIENG_DB_ADMIN_DSN: dsn })).toThrow("DISPOSABLE_ADMIN_DSN_REMOTE_REFUSED");
    expect(() => disposableAdminDsn({ KS_AIENG_DB_ADMIN_DSN: "not a dsn" })).toThrow("DISPOSABLE_ADMIN_DSN_INVALID");
  });
});
