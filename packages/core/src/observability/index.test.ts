import { describe, expect, it } from "vitest";
import { InMemoryTelemetry, reconcileManifests } from "./index.js";
describe("observability", () => {
  it("reports SLO latency, error, degradation and cost", () => {
    const telemetry = new InMemoryTelemetry();
    for (const [i, status] of ["succeeded", "degraded", "failed"].entries())
      telemetry.record({
        operationId: String(i),
        stage: "retrieval",
        status: status as "succeeded" | "degraded" | "failed",
        startedAt: "2026-01-01T00:00:00Z",
        durationMs: (i + 1) * 10,
        itemCount: 1,
        usageTokens: 10,
        costUsd: 0.01,
        attributes: {},
      });
    expect(telemetry.snapshot()).toMatchObject({
      sampleCount: 3,
      p95Ms: 30,
      errorRate: 1 / 3,
      degradedRate: 1 / 3,
      totalCostUsd: 0.03,
    });
  });
  it("detects publication drift deterministically", () => {
    const result = reconcileManifests({
      expectedCount: 2,
      observedCount: 1,
      expectedDigest: "a",
      observedDigest: "b",
      expectedActiveVersion: "v2",
      observedActiveVersion: "v1",
      missingIds: ["x"],
    });
    expect(result.healthy).toBe(false);
    expect(result.findings).toHaveLength(4);
  });
});
