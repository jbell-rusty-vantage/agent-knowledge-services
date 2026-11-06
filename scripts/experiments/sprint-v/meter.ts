import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SV-09 spend meter (Sprint V plan §4 "reserve before each request; stop before the remaining ceiling could be
 * exceeded"). One persisted JSON file per run (`meter.json`); the helper ceiling spans every run, so a new run starts
 * from the settled spend of every earlier `meter.json` under the SV-09 proofs directory. A reservation that could
 * exceed the ceiling throws `BudgetBlocked`; the caller records the check as `blocked:budget`, never as skipped.
 */
export const HELPER_CEILING_USD = 6;

/** USD per 1M tokens: input, cached input, output (reasoning bills as output). Sources named in the report. */
export const PRICES: Readonly<Record<string, { input: number; cachedInput: number; output: number; source: string }>> =
  {
    "gpt-6-sol": {
      input: 2.0,
      cachedInput: 0.2,
      output: 10.0,
      source: "MC providers/deep_agents/CHANGES.md 2026-10 standard rates",
    },
    "gpt-6-luna": {
      input: 0.1,
      cachedInput: 0.01,
      output: 0.5,
      source: "MC providers/deep_agents/CHANGES.md 2026-10 standard rates",
    },
    "claude-sonnet-5-5": {
      input: 2.0,
      cachedInput: 0.2,
      output: 10.0,
      source: "claude-api skill model table (cached 2026-10-06)",
    },
  };

export function priceFor(model: string) {
  const key = Object.keys(PRICES)
    .filter((candidate) => model === candidate || model.startsWith(`${candidate}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key === undefined ? null : { model: key, ...(PRICES[key] as (typeof PRICES)[string]) };
}

export interface MeterEntry {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly role: string;
  readonly plannedMaxUsd: number;
  status: "reserved" | "settled" | "failed_unbilled" | "failed_billed_estimate";
  actualUsd: number | null;
  basis: "usage" | "estimate" | null;
  usage: Record<string, number> | null;
  latencyMs: number | null;
  reservedAt: string;
  settledAt: string | null;
  note: string | null;
}

export interface MeterFile {
  schemaVersion: "sv09-meter.v1";
  run: string;
  ceilingUsd: number;
  priorRunsSpendUsd: number;
  entries: MeterEntry[];
  runningTotalUsd: number;
  outstandingReservationsUsd: number;
}

export class BudgetBlocked extends Error {
  readonly code = "blocked:budget" as const;
  constructor(message: string) {
    super(`blocked:budget: ${message}`);
    this.name = "BudgetBlocked";
  }
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export class Meter {
  private readonly file: string;
  private state: MeterFile;

  constructor(proofsRoot: string, runDir: string, run: string) {
    this.file = join(runDir, "meter.json");
    let prior = 0;
    if (existsSync(proofsRoot)) {
      for (const name of readdirSync(proofsRoot)) {
        const path = join(proofsRoot, name, "meter.json");
        if (name === run || !existsSync(path)) continue;
        const earlier = JSON.parse(readFileSync(path, "utf8")) as MeterFile;
        prior += earlier.entries.reduce((sum, entry) => sum + (entry.actualUsd ?? 0), 0);
        // An earlier run's unsettled reservation counts at its planned maximum (fail closed).
        prior += earlier.entries
          .filter((entry) => entry.status === "reserved")
          .reduce((sum, entry) => sum + entry.plannedMaxUsd, 0);
      }
    }
    this.state = {
      schemaVersion: "sv09-meter.v1",
      run,
      ceilingUsd: HELPER_CEILING_USD,
      priorRunsSpendUsd: round6(prior),
      entries: [],
      runningTotalUsd: round6(prior),
      outstandingReservationsUsd: 0,
    };
    this.persist();
  }

  get snapshot(): Readonly<MeterFile> {
    return this.state;
  }

  /** Reserve the planned maximum of one request; throws `BudgetBlocked` when it could exceed the ceiling. */
  reserve(input: { id: string; provider: string; model: string; role: string; plannedMaxUsd: number }): MeterEntry {
    const projected = this.state.runningTotalUsd + this.state.outstandingReservationsUsd + input.plannedMaxUsd;
    if (projected > this.state.ceilingUsd) {
      throw new BudgetBlocked(
        `${input.id}: spent ${this.state.runningTotalUsd.toFixed(6)} + reserved ${this.state.outstandingReservationsUsd.toFixed(6)} + planned ${input.plannedMaxUsd.toFixed(6)} > ceiling ${this.state.ceilingUsd}`,
      );
    }
    const entry: MeterEntry = {
      ...input,
      plannedMaxUsd: round6(input.plannedMaxUsd),
      status: "reserved",
      actualUsd: null,
      basis: null,
      usage: null,
      latencyMs: null,
      reservedAt: new Date().toISOString(),
      settledAt: null,
      note: null,
    };
    this.state.entries.push(entry);
    this.recompute();
    return entry;
  }

  settle(
    entry: MeterEntry,
    result: {
      status: MeterEntry["status"];
      actualUsd: number;
      basis: "usage" | "estimate";
      usage: Record<string, number> | null;
      latencyMs: number;
      note?: string;
    },
  ): void {
    entry.status = result.status;
    entry.actualUsd = round6(result.actualUsd);
    entry.basis = result.basis;
    entry.usage = result.usage;
    entry.latencyMs = result.latencyMs;
    entry.settledAt = new Date().toISOString();
    entry.note = result.note ?? null;
    this.recompute();
  }

  private recompute(): void {
    const settled = this.state.entries.reduce((sum, entry) => sum + (entry.actualUsd ?? 0), 0);
    this.state.runningTotalUsd = round6(this.state.priorRunsSpendUsd + settled);
    this.state.outstandingReservationsUsd = round6(
      this.state.entries
        .filter((entry) => entry.status === "reserved")
        .reduce((sum, entry) => sum + entry.plannedMaxUsd, 0),
    );
    this.persist();
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}

/** Estimated planned maximum for one request: input estimated from characters (fail high), output at its cap. */
export function plannedMaxUsd(model: string, inputChars: number, maxOutputTokens: number): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  const inputTokens = Math.ceil(inputChars / 3) + 400;
  return (inputTokens * price.input + maxOutputTokens * price.output) / 1e6;
}

/** Actual cost from provider usage fields (cached input at the cached rate; reasoning is inside output tokens). */
export function usageCostUsd(
  model: string,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncached * price.input + usage.cachedInputTokens * price.cachedInput + usage.outputTokens * price.output) / 1e6
  );
}
