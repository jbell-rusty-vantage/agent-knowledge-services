import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  KS_DB_COMPONENT_DSN_VARIABLES,
  KS_DB_VARIABLE_NAMES,
  ksDbPlaneForApplication,
  loadKsDatabaseConfig,
  resolveComponentDsn,
} from "./database.js";

const REF = "abcdefghijklmnopqrst";
const fake = {
  KS_AIENG_DB_PROJECT_REF: REF,
  KS_AIENG_DB_URL: `https://${REF}.supabase.co`,
  KS_AIENG_DB_SECRET_KEY: "fake-secret",
  KS_AIENG_DB_RUNTIME_DSN: `postgresql://postgres.${REF}:fake@pooler.example.test:6543/postgres`,
  KS_AIENG_DB_ADMIN_DSN: `postgresql://postgres:fake@db.${REF}.supabase.co:5432/postgres`,
};

describe("Knowledge Services database config", () => {
  it("selects the plane from the application and defaults to AIENG", () => {
    expect(ksDbPlaneForApplication()).toBe("AIENG");
    expect(ksDbPlaneForApplication("ai-engineer")).toBe("AIENG");
    expect(ksDbPlaneForApplication("biotech")).toBe("BIOTECH");
    expect(() => ksDbPlaneForApplication("other")).toThrow("KS_DB_APPLICATION_UNKNOWN");
  });

  it("resolves the plane object and logs only plane, ref and host", () => {
    const seen: unknown[] = [];
    const config = loadKsDatabaseConfig(fake, undefined, { log: (selection) => seen.push(selection) });
    expect(config.runtimeDsn).toBe(fake.KS_AIENG_DB_RUNTIME_DSN);
    expect(config.secretKey).toBe("fake-secret");
    expect(seen).toEqual([
      { plane: "AIENG", projectRef: REF, hosts: [`${REF}.supabase.co`, "db." + REF + ".supabase.co", "pooler.example.test"].sort() },
    ]);
    expect(JSON.stringify(seen)).not.toContain("fake");
  });

  it("does not read the other plane or any earlier name", () => {
    const config = loadKsDatabaseConfig(
      { KS_BIOTECH_DB_RUNTIME_DSN: "postgresql://x@127.0.0.1/db", POSTGRES_URL: "postgresql://y@127.0.0.1/db", SUPABASE_URL: "http://127.0.0.1" },
      undefined,
      { log: false },
    );
    expect(config.runtimeDsn).toBeUndefined();
    expect(config.url).toBeUndefined();
    expect(loadKsDatabaseConfig({ KS_BIOTECH_DB_RUNTIME_DSN: "postgresql://x@127.0.0.1/db" }, "biotech", { log: false }).runtimeDsn).toBe(
      "postgresql://x@127.0.0.1/db",
    );
  });

  it("refuses a project ref that is absent from a sibling URL or DSN", () => {
    expect(() =>
      loadKsDatabaseConfig({ ...fake, KS_AIENG_DB_RUNTIME_DSN: "postgresql://postgres.otherref:fake@pooler.example.test:6543/postgres" }, undefined, { log: false }),
    ).toThrow("KS_DB_PROJECT_REF_MISMATCH: KS_AIENG_DB_RUNTIME_DSN");
    expect(() =>
      loadKsDatabaseConfig({ ...fake, KS_AIENG_DB_URL: "https://otherref.supabase.co" }, undefined, { log: false }),
    ).toThrow("KS_DB_PROJECT_REF_MISMATCH: KS_AIENG_DB_URL");
  });

  it("skips the ref check when no ref is configured (disposable loopback) and rejects malformed values", () => {
    expect(loadKsDatabaseConfig({ KS_AIENG_DB_RUNTIME_DSN: "postgresql://u:p@127.0.0.1:5432/db" }, undefined, { log: false }).runtimeDsn).toBeDefined();
    expect(() => loadKsDatabaseConfig({ KS_AIENG_DB_RUNTIME_DSN: "mysql://u@h/db" }, undefined, { log: false })).toThrow("KS_DB_INVALID");
  });

  it("resolves a component DSN only through the plane's own name", () => {
    const env = { KS_AIENG_DB_COMPONENT_DSN: "postgresql://u@127.0.0.1/db" };
    expect(resolveComponentDsn(env, "KS_AIENG_DB_COMPONENT_DSN", "ai-engineer").dsn).toBe(env.KS_AIENG_DB_COMPONENT_DSN);
    expect(resolveComponentDsn({}, "KS_BIOTECH_DB_COMPONENT_DSN", "biotech").dsn).toBeUndefined();
    expect(() => resolveComponentDsn(env, "KS_AIENG_DB_COMPONENT_DSN", "biotech")).toThrow("KS_DB_COMPONENT_VARIABLE_PLANE_MISMATCH");
    expect(() => resolveComponentDsn(env, "KS_UNUSED_DSN")).toThrow("KS_DB_COMPONENT_VARIABLE_UNKNOWN");
    expect(KS_DB_COMPONENT_DSN_VARIABLES).toEqual(["KS_AIENG_DB_COMPONENT_DSN", "KS_BIOTECH_DB_COMPONENT_DSN"]);
  });

  it("keeps config/env.registry.yaml and .env.example in step with the module's names", () => {
    const registry = readFileSync(new URL("../../../../config/env.registry.yaml", import.meta.url), "utf8");
    const registered = [...registry.matchAll(/^ {2}- name: (\S+)$/gm)].map((match) => match[1]).sort();
    expect(registered).toEqual([...KS_DB_VARIABLE_NAMES].sort());
    const example = readFileSync(new URL("../../../../.env.example", import.meta.url), "utf8");
    for (const name of KS_DB_VARIABLE_NAMES.filter((candidate) => candidate.startsWith("KS_AIENG_")))
      expect(example).toMatch(new RegExp(`^${name}=`, "m"));
    expect(example).not.toMatch(/^(POSTGRES_URL|SUPABASE_URL|SUPABASE_SECRET_KEY)=/m);
  });
});
