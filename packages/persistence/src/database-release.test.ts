import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DATABASE_RELEASE_CHECK_MODES,
  DATABASE_RELEASE_CHECK_VARIABLE,
  DATABASE_RELEASE_FORMAT,
  DatabaseReleaseRefused,
  checkDatabaseRelease,
  checkMode,
  compareVersions,
  inRange,
  pinnedContractRelease,
  readDatabaseRelease,
  releaseVerdict,
  serviceReleaseRange,
  type DatabaseReleaseReport,
} from "./database-release.js";

interface SharedCases {
  readonly format: string;
  readonly range: readonly { readonly version: string; readonly range: string; readonly in: boolean }[];
  readonly verdict: readonly {
    readonly name: string;
    readonly observed: unknown;
    readonly range: string;
    readonly verdict: string;
    readonly start: boolean;
    readonly warning: boolean;
  }[];
  readonly mode: { readonly variable: string; readonly values: Readonly<Record<string, string>> };
}

// The cases every consumer of the AI Engineer database runs (VER-S1), read from the vendored contract package.
const pinned = pinnedContractRelease();
const cases = JSON.parse(readFileSync(join(pinned.packageRoot, "release-check.cases.json"), "utf8")) as SharedCases;
const record = JSON.parse(readFileSync(join(pinned.packageRoot, "contract.version.json"), "utf8")) as {
  version: string;
  migration_head: string;
};
const NOW = () => new Date("2026-11-20T00:00:00.000Z");
const stated = (release: string | null, state: string) => ({ format: DATABASE_RELEASE_FORMAT, release, state });

describe("the shared release-check cases of the vendored contract", () => {
  it("are the format this port was written against, and none is empty", () => {
    expect(cases.format).toBe("ai-engineer-release-check-cases/1");
    expect(cases.range.length).toBeGreaterThan(0);
    expect(cases.verdict.length).toBeGreaterThan(0);
  });

  it.each(cases.range)("inRange($version, $range) is $in", (item) => {
    expect(inRange(item.version, item.range)).toBe(item.in);
  });

  it.each(cases.verdict)("verdict: $name", (item) => {
    expect(releaseVerdict(item.observed, item.range)).toMatchObject({
      verdict: item.verdict,
      start: item.start,
      warning: item.warning,
      range: item.range,
    });
  });

  it("names the mode variable and exactly the modes this port accepts", () => {
    expect(cases.mode.variable).toBe(DATABASE_RELEASE_CHECK_VARIABLE);
    expect(Object.keys(cases.mode.values).sort()).toEqual([...DATABASE_RELEASE_CHECK_MODES].sort());
    for (const mode of Object.keys(cases.mode.values))
      expect(checkMode({ [DATABASE_RELEASE_CHECK_VARIABLE]: mode })).toBe(mode);
  });
});

describe("the rule", () => {
  it("compares versions numerically and refuses what is not a version or a range", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("0.12.0", "0.12.0")).toBe(0);
    expect(compareVersions("0.9.0", "0.12.0")).toBe(-1);
    expect(() => inRange("0.12", "0.12.0")).toThrow("not a release version: 0.12");
    expect(() => inRange("0.12.0", "^0.12.0")).toThrow("not a release range: ^0.12.0");
  });

  it("names the release, the range and the state in every verdict", () => {
    expect(releaseVerdict(stated("0.11.0", "current"), "0.12.0")).toEqual({
      verdict: "incompatible",
      start: false,
      warning: false,
      range: "0.12.0",
      release: "0.11.0",
      state: "current",
      reason: "the database is release 0.11.0; this service works with 0.12.0",
    });
    expect(releaseVerdict(stated("0.12.0", "ahead"), "0.12.0")).toMatchObject({
      verdict: "ok",
      start: true,
      warning: true,
      reason: "the database is release 0.12.0; migrations were applied after the stamp (unreleased changes)",
    });
    expect(releaseVerdict(undefined, "0.12.0")).toMatchObject({ verdict: "unknown", release: null, state: null });
    expect(releaseVerdict("0.12.0", "0.12.0")).toMatchObject({ verdict: "unknown", start: false });
  });

  it("defaults the mode to enforce, ignores case and padding, and refuses any other word", () => {
    expect(checkMode({})).toBe("enforce");
    expect(checkMode({ [DATABASE_RELEASE_CHECK_VARIABLE]: " WARN " })).toBe("warn");
    expect(() => checkMode({ [DATABASE_RELEASE_CHECK_VARIABLE]: "skip" })).toThrow(
      "AIENG_DB_RELEASE_CHECK must be enforce, warn or off (got skip)",
    );
    expect(() => checkMode({ [DATABASE_RELEASE_CHECK_VARIABLE]: "" })).toThrow("must be enforce, warn or off");
  });
});

describe("this service's range", () => {
  it("is the version of the vendored contract package, read from its contract.version.json", () => {
    expect(pinned.version).toBe(record.version);
    expect(serviceReleaseRange()).toBe(record.version);
    expect(pinned.migrationHead).toBe(record.migration_head);
    expect(inRange(record.version, serviceReleaseRange())).toBe(true);
  });
});

describe("reading the database", () => {
  const client = (present: unknown, answer: unknown = null) => {
    const statements: string[] = [];
    return {
      statements,
      query: async (text: string) => {
        statements.push(text);
        return { rows: text.includes("to_regprocedure") ? [{ ok: present }] : [{ r: answer }] };
      },
    };
  };

  it("returns the function's JSON when the function exists", async () => {
    const answer = stated("0.12.0", "current");
    const double = client(true, answer);
    expect(await readDatabaseRelease(double)).toEqual(answer);
    expect(double.statements).toEqual([
      "select to_regprocedure('api.database_release()') is not null as ok",
      "select api.database_release() as r",
    ]);
  });

  it("returns null without calling the function when it is not there", async () => {
    const double = client(false);
    expect(await readDatabaseRelease(double)).toBeNull();
    expect(double.statements).toHaveLength(1);
    expect(await readDatabaseRelease({ query: async () => ({ rows: [] }) })).toBeNull();
  });
});

describe("the startup check", () => {
  const events: (DatabaseReleaseReport & { event: string })[] = [];
  const log = (event: DatabaseReleaseReport & { event: string }) => void events.push(event);
  const run = (observed: unknown, mode: "enforce" | "warn" | "off", range = "0.12.0") => {
    events.length = 0;
    return checkDatabaseRelease(async () => observed, { mode, range, log, now: NOW });
  };

  it("starts on the release as stamped and reports release, state, range and verdict", async () => {
    expect(await run(stated("0.12.0", "current"), "enforce")).toEqual({
      check: "enforce",
      range: "0.12.0",
      release: "0.12.0",
      state: "current",
      verdict: "ok",
      warning: false,
      reason: "the database is release 0.12.0",
      checkedAt: "2026-11-20T00:00:00.000Z",
    });
    expect(events.map((event) => event.event)).toEqual(["ks.database.release"]);
  });

  it("starts with a logged warning on ahead, component_drift and unverifiable", async () => {
    for (const state of ["ahead", "component_drift", "unverifiable"]) {
      const report = await run(stated("0.12.0", state), "enforce");
      expect(report).toMatchObject({ verdict: "ok", warning: true, state });
      expect(events).toEqual([{ event: "ks.database.release", ...report }]);
    }
  });

  it("refuses in enforce mode with one error naming release, range, state and the variable", async () => {
    const refused = await run(stated("0.11.0", "current"), "enforce").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DatabaseReleaseRefused);
    expect((refused as DatabaseReleaseRefused).code).toBe("AIENG_DB_RELEASE_REFUSED");
    expect((refused as DatabaseReleaseRefused).report).toMatchObject({ verdict: "incompatible", release: "0.11.0" });
    expect((refused as Error).message).toBe(
      "AIENG_DB_RELEASE_REFUSED: the AI Engineer database is not a release this service works with " +
        "(verdict incompatible: the database is release 0.11.0; this service works with 0.12.0). " +
        "Database release: 0.11.0; state: current; this service works with: 0.12.0. " +
        "AIENG_DB_RELEASE_CHECK=warn starts anyway and logs this verdict; " +
        "AIENG_DB_RELEASE_CHECK=off does not ask the database.",
    );
    expect(events).toEqual([]);
    for (const [observed, verdict] of [
      [null, "unknown"],
      [stated(null, "unstamped"), "unstamped"],
      [stated("0.12.0", "inconsistent"), "inconsistent"],
    ] as const)
      await expect(run(observed, "enforce")).rejects.toMatchObject({ report: { verdict } });
  });

  it("starts in warn mode whatever the verdict, and logs it", async () => {
    const report = await run(stated("0.11.0", "current"), "warn");
    expect(report).toMatchObject({ check: "warn", verdict: "incompatible", release: "0.11.0", state: "current" });
    expect(events).toEqual([{ event: "ks.database.release", ...report }]);
  });

  it("does not ask the database in off mode", async () => {
    let asked = 0;
    const report = await checkDatabaseRelease(
      async () => {
        asked += 1;
        return null;
      },
      { mode: "off", range: "0.12.0", log, now: NOW },
    );
    expect(asked).toBe(0);
    expect(report).toMatchObject({ check: "off", verdict: "not_checked", release: null, state: null });
  });

  it("treats a database that cannot be asked as no answer, and never repeats a DSN", async () => {
    const unreachable = () => Promise.reject(new Error("connect ECONNREFUSED postgresql://user:secret@db.example/x"));
    const refused = await checkDatabaseRelease(unreachable, { mode: "enforce", range: "0.12.0", log: false }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(DatabaseReleaseRefused);
    expect((refused as DatabaseReleaseRefused).report).toMatchObject({
      verdict: "unknown",
      reason: "the database could not be asked for its release (connect ECONNREFUSED <dsn>)",
    });
    expect((refused as Error).message).not.toContain("secret");
    const warned = await checkDatabaseRelease(unreachable, { mode: "warn", range: "0.12.0", log: false });
    expect(warned.verdict).toBe("unknown");
    const unreadable = await run(stated("twelve", "current"), "warn");
    expect(unreadable).toMatchObject({
      verdict: "unknown",
      reason: "the database stated a release this service cannot read (not a release version: twelve)",
    });
  });

  it("asks nothing when it cannot read its own range: enforce refuses, warn starts, off reports", async () => {
    let asked = 0;
    const read = async () => {
      asked += 1;
      return stated("0.12.0", "current");
    };
    const range = (): string => {
      throw new Error("DATABASE_CONTRACT_PACKAGE_MISSING: @aiengineer/database-contract is not installed");
    };
    await expect(checkDatabaseRelease(read, { mode: "enforce", range, log: false })).rejects.toMatchObject({
      code: "AIENG_DB_RELEASE_REFUSED",
      report: { verdict: "unknown", range: "unknown", release: null },
    });
    const warned = await checkDatabaseRelease(read, { mode: "warn", range, log: false });
    expect(warned).toMatchObject({ verdict: "unknown", range: "unknown" });
    expect(warned.reason).toContain("this service cannot state the releases it works with");
    expect(await checkDatabaseRelease(read, { mode: "off", range, log: false })).toMatchObject({
      verdict: "not_checked",
      range: "unknown",
    });
    expect(asked).toBe(0);
  });

  it("uses this service's range by default and refuses a malformed range before asking", async () => {
    const report = await checkDatabaseRelease(async () => stated(serviceReleaseRange(), "current"), {
      mode: "enforce",
      log: false,
    });
    expect(report).toMatchObject({ verdict: "ok", range: serviceReleaseRange(), release: serviceReleaseRange() });
    let asked = 0;
    await expect(
      checkDatabaseRelease(
        async () => {
          asked += 1;
          return null;
        },
        { mode: "enforce", range: "latest", log: false },
      ),
    ).rejects.toThrow("not a release range: latest");
    expect(asked).toBe(0);
  });
});
