import { describe, expect, it } from "vitest";
import {
  DATABASE_RELEASE_FORMAT,
  DatabaseReleaseRefused,
  serviceReleaseRange,
} from "@aiengineer/knowledge-persistence";
import {
  AIENG_COMPONENT_DSN_VARIABLE,
  databaseReleaseExpectation,
  databaseReleaseStatus,
  startOnAiEngineerDatabase,
  startOnAiEngineerDatabaseAt,
} from "./database-release.js";

const range = serviceReleaseRange();
const stated = (release: string | null, state: string) => ({ format: DATABASE_RELEASE_FORMAT, release, state });

/** A database that does not hold the AI Engineer contract: it has no `api` schema. */
const NO_CONTRACT = Symbol("no api schema");

/**
 * A pool double: counts how often it is asked and whether it was closed. `answer` is what `api.database_release()`
 * returns in a database that has the `api` schema (null: no such function); `NO_CONTRACT` is one without the schema.
 */
function probe(answer: unknown) {
  const seen = { asked: 0, closed: 0 };
  return {
    seen,
    databaseRelease: async () => {
      seen.asked += 1;
      if (answer instanceof Error) throw answer;
      return answer === NO_CONTRACT ? { contract: false, answer: null } : { contract: true, answer };
    },
    close: async () => {
      seen.closed += 1;
    },
  };
}

describe("the release check of an open AI Engineer pool", () => {
  it("reports the release the process starts on", async () => {
    const database = probe(stated(range, "current"));
    const report = await startOnAiEngineerDatabase(
      database,
      { plane: "AIENG", releaseCheck: "enforce" },
      { NODE_ENV: "test" },
    );
    expect(report).toMatchObject({ check: "enforce", range, release: range, state: "current", verdict: "ok" });
    expect(database.seen.asked).toBe(1);
    // What an unauthenticated health answer carries: release, state, range and verdict, never the free-text reason.
    if (!report) throw new Error("the AIENG plane always reports");
    expect(Object.keys(databaseReleaseStatus(report)).sort()).toEqual(
      ["check", "checkedAt", "range", "release", "state", "verdict", "warning"].sort(),
    );
  });

  it("enforces when the selection carries no mode and refuses an incompatible release", async () => {
    await expect(
      startOnAiEngineerDatabase(probe(stated("0.0.1", "current")), { plane: "AIENG" }, { NODE_ENV: "test" }),
    ).rejects.toBeInstanceOf(DatabaseReleaseRefused);
  });

  it("starts on a database without the AI Engineer contract and reports not_applicable; a missing function is refused", async () => {
    for (const releaseCheck of ["enforce", "warn"] as const) {
      const outside = probe(NO_CONTRACT);
      const report = await startOnAiEngineerDatabase(outside, { plane: "AIENG", releaseCheck }, { NODE_ENV: "test" });
      expect(report).toMatchObject({
        check: releaseCheck,
        range,
        release: null,
        state: null,
        verdict: "not_applicable",
        warning: false,
      });
      expect(outside.seen.asked).toBe(1);
    }
    // The api schema without api.database_release() is an AI Engineer database that states no release: unknown.
    await expect(
      startOnAiEngineerDatabase(probe(null), { plane: "AIENG", releaseCheck: "enforce" }, { NODE_ENV: "test" }),
    ).rejects.toMatchObject({ report: { verdict: "unknown" } });
  });

  it("asks nothing on the Biotech plane", async () => {
    const database = probe(stated("0.0.1", "current"));
    expect(await startOnAiEngineerDatabase(database, { plane: "BIOTECH" }, { NODE_ENV: "test" })).toBeUndefined();
    expect(database.seen.asked).toBe(0);
  });
});

describe("the release check behind a DSN (a binding's component login, a one-off CLI write)", () => {
  const dsn = "postgresql://login@127.0.0.1:1/unused";
  const env = (mode?: string) => ({ NODE_ENV: "test", ...(mode ? { AIENG_DB_RELEASE_CHECK: mode } : {}) });

  it("opens one connection, asks, and closes it whatever the verdict", async () => {
    const current = probe(stated(range, "current"));
    const opened: string[] = [];
    const report = await startOnAiEngineerDatabaseAt(dsn, env(), (connectionString) => {
      opened.push(connectionString);
      return current;
    });
    expect(report).toMatchObject({ check: "enforce", verdict: "ok", release: range });
    expect(opened).toEqual([dsn]);
    expect(current.seen).toEqual({ asked: 1, closed: 1 });

    const other = probe(stated("0.0.1", "current"));
    const refused = await startOnAiEngineerDatabaseAt(dsn, env(), () => other).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DatabaseReleaseRefused);
    expect((refused as Error).message).not.toContain(dsn);
    expect(other.seen).toEqual({ asked: 1, closed: 1 });

    const unreachable = probe(new Error("connect ECONNREFUSED 127.0.0.1:1"));
    await expect(startOnAiEngineerDatabaseAt(dsn, env(), () => unreachable)).rejects.toMatchObject({
      report: { verdict: "unknown" },
    });
    expect(unreachable.seen.closed).toBe(1);
  });

  it("starts a binding on a component-only database: not_applicable, and the connection is closed", async () => {
    const componentOnly = probe(NO_CONTRACT);
    const report = await startOnAiEngineerDatabaseAt(dsn, env(), () => componentOnly);
    expect(report).toMatchObject({ check: "enforce", verdict: "not_applicable", release: null });
    expect(componentOnly.seen).toEqual({ asked: 1, closed: 1 });
  });

  it("starts in warn mode and opens nothing in off mode", async () => {
    const other = probe(stated("0.0.1", "current"));
    expect(await startOnAiEngineerDatabaseAt(dsn, env("warn"), () => other)).toMatchObject({
      check: "warn",
      verdict: "incompatible",
    });
    let opened = 0;
    const off = await startOnAiEngineerDatabaseAt(dsn, env("off"), () => {
      opened += 1;
      return other;
    });
    expect(off).toMatchObject({ check: "off", verdict: "not_checked" });
    expect(opened).toBe(0);
  });
});

describe("what a process can say before it asks", () => {
  it("names its range, its mode and the variable that changes the mode", () => {
    expect(databaseReleaseExpectation({})).toEqual({ range, check: "enforce", variable: "AIENG_DB_RELEASE_CHECK" });
    expect(databaseReleaseExpectation({ AIENG_DB_RELEASE_CHECK: "warn" }).check).toBe("warn");
    expect(AIENG_COMPONENT_DSN_VARIABLE).toBe("KS_AIENG_DB_COMPONENT_DSN");
  });
});
