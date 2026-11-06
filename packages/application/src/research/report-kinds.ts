import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Ref, sameRef } from "@aiengineer/knowledge-operation-protocol";
import { type ReportKind, loadReportKind, reportKindRef } from "@aiengineer/knowledge-research-core";

/**
 * The pinned K08 report-kind catalogue an installation serves (`catalog/research/report-kinds/*.json`). A revision's
 * `kind` ref resolves only to the exact pinned document (id, version and canonical digest), in the caller's scope.
 */
export class ReportKindCatalog {
  private readonly kinds: readonly ReportKind[];

  constructor(kinds: readonly ReportKind[]) {
    const keys = kinds.map((kind) => `${kind.id}@${kind.version}`);
    if (new Set(keys).size !== keys.length) throw new Error("REPORT_KIND_DUPLICATE");
    this.kinds = [...kinds];
  }

  /** Load every `*.json` in a catalogue directory; any document outside the envelope refuses `SCHEMA_UNSUPPORTED`. */
  static fromDirectory(directory: string): ReportKindCatalog {
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
    return new ReportKindCatalog(
      files.map((name) => loadReportKind(JSON.parse(readFileSync(resolve(directory, name), "utf8")) as unknown)),
    );
  }

  list(): readonly ReportKind[] {
    return this.kinds;
  }

  /** The ref a producer names for a kind (latest version when `version` is omitted). */
  ref(scope: { tenant: string; binding: string }, id: string, version?: string): Ref<"report_kind"> {
    const candidates = this.kinds.filter(
      (kind) => kind.id === id && (version === undefined || kind.version === version),
    );
    const kind = candidates.sort((a, b) => compareSemver(b.version, a.version))[0];
    if (kind === undefined) throw new Error(`SCHEMA_UNSUPPORTED: report kind ${id}${version ? `@${version}` : ""}`);
    return reportKindRef(kind, scope);
  }

  /** Resolve a revision's kind ref to the exact pinned document; `null` for an unknown kind, version or digest. */
  resolve(scope: { tenant: string; binding: string }, ref: Ref<"report_kind">): ReportKind | null {
    return this.kinds.find((kind) => sameRef(reportKindRef(kind, scope), ref)) ?? null;
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
