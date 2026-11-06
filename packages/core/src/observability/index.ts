import { deepFreeze, sha256Digest } from "../domain/index.js";
export interface OperationMetric {
  readonly operationId: string;
  readonly stage: string;
  readonly status: "succeeded" | "failed" | "degraded";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly itemCount: number;
  readonly usageTokens: number;
  readonly costUsd: number;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}
export interface ServiceSloSnapshot {
  readonly availability: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly errorRate: number;
  readonly degradedRate: number;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly sampleCount: number;
}
export interface ReconciliationFinding {
  readonly kind: "missing_vector" | "orphan_vector" | "digest_mismatch" | "active_pointer_mismatch" | "count_mismatch";
  readonly severity: "warning" | "critical";
  readonly expected: string | number;
  readonly observed: string | number;
}
export class InMemoryTelemetry {
  readonly #metrics: OperationMetric[] = [];
  record(metric: OperationMetric) {
    if (metric.durationMs < 0 || metric.itemCount < 0 || metric.usageTokens < 0 || metric.costUsd < 0)
      throw new Error("INVALID_METRIC");
    this.#metrics.push(deepFreeze({ ...metric, attributes: { ...metric.attributes } }));
  }
  list() {
    return deepFreeze([...this.#metrics]);
  }
  snapshot(stage?: string): ServiceSloSnapshot {
    const values = this.#metrics.filter((x) => stage === undefined || x.stage === stage);
    const durations = values.map((x) => x.durationMs).sort((a, b) => a - b);
    const quantile = (p: number) =>
      durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)]! : 0;
    return deepFreeze({
      availability: values.length ? values.filter((x) => x.status !== "failed").length / values.length : 1,
      p50Ms: quantile(0.5),
      p95Ms: quantile(0.95),
      p99Ms: quantile(0.99),
      errorRate: values.length ? values.filter((x) => x.status === "failed").length / values.length : 0,
      degradedRate: values.length ? values.filter((x) => x.status === "degraded").length / values.length : 0,
      totalCostUsd: values.reduce((n, x) => n + x.costUsd, 0),
      totalTokens: values.reduce((n, x) => n + x.usageTokens, 0),
      sampleCount: values.length,
    });
  }
}
export function reconcileManifests(input: {
  expectedCount: number;
  observedCount: number;
  expectedDigest: string;
  observedDigest: string;
  expectedActiveVersion: string;
  observedActiveVersion?: string;
  missingIds?: readonly string[];
  orphanIds?: readonly string[];
}) {
  const findings: ReconciliationFinding[] = [];
  if (input.expectedCount !== input.observedCount)
    findings.push({
      kind: "count_mismatch",
      severity: "critical",
      expected: input.expectedCount,
      observed: input.observedCount,
    });
  if (input.expectedDigest !== input.observedDigest)
    findings.push({
      kind: "digest_mismatch",
      severity: "critical",
      expected: input.expectedDigest,
      observed: input.observedDigest,
    });
  if (input.expectedActiveVersion !== input.observedActiveVersion)
    findings.push({
      kind: "active_pointer_mismatch",
      severity: "critical",
      expected: input.expectedActiveVersion,
      observed: input.observedActiveVersion ?? "missing",
    });
  for (const id of input.missingIds ?? [])
    findings.push({ kind: "missing_vector", severity: "critical", expected: id, observed: "missing" });
  for (const id of input.orphanIds ?? [])
    findings.push({ kind: "orphan_vector", severity: "warning", expected: "absent", observed: id });
  return deepFreeze({ healthy: findings.length === 0, findings, digest: sha256Digest(JSON.stringify(findings)) });
}
