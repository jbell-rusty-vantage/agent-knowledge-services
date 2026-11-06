import { describe, expect, it, vi } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import {
  PostgresVerificationBenchmarkRunStore,
  type DurableVerificationBenchmarkRunInput,
} from "./verification-benchmark-run.js";
import type { LeasedStep } from "./types.js";
import type { TenantSqlClient } from "./postgres.js";

const ids = {
  tenant: "11111111-1111-4111-8111-111111111111",
  operation: "22222222-2222-4222-8222-222222222222",
  step: "33333333-3333-4333-8333-333333333333",
  run: "44444444-4444-4444-8444-444444444444",
  dataset: "55555555-5555-4555-8555-555555555555",
  experiment: "66666666-6666-4666-8666-666666666666",
};
const digest = (value: string) => digestCanonicalJson(value);
const artifact = (artifactId: string, digestValue: string): VerificationArtifactHandle => ({
  artifactId,
  tenantId: ids.tenant,
  digest: digestValue,
  mediaType: "application/json",
  byteLength: 2,
  objectKey: `${ids.tenant}/${artifactId}`,
  createdAt: "2026-09-05T00:00:00.000Z",
  producerActivityId: "fixture",
  producerVersion: "1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
});
const lease: LeasedStep = {
  id: ids.step,
  tenantId: ids.tenant,
  operationId: ids.operation,
  stepKey: "benchmark",
  stepKind: "benchmark",
  inputSha256: "a".repeat(64),
  status: "running",
  attemptCount: 1,
  maxAttempts: 3,
  rowVersion: 1,
  holderIdentity: "worker",
  leaseToken: "token",
  fencingToken: 1,
  expiresAt: "2026-09-05T01:00:00.000Z",
};
const planEntries = [
  { checkpointContextDigest: digest("checkpoint"), caseId: "case-1", armId: "baseline", repetition: 0 },
];
const input = (): DurableVerificationBenchmarkRunInput => ({
  tenantId: ids.tenant,
  operationId: ids.operation,
  lease,
  runId: ids.run,
  datasetArtifact: artifact(ids.dataset, digest("dataset")),
  experimentArtifact: artifact(ids.experiment, digest("experiment")),
  runnerVersion: "verification-benchmark-runner.v1",
  networkPolicy: "offline",
  randomSeed: 7,
  repetitions: 1,
  checkpointPlan: { entries: planEntries, planDigest: digestCanonicalJson(planEntries) },
  startedAt: "2026-09-05T00:00:00.000Z",
});

function subject(options: { active?: boolean } = {}) {
  let run: Record<string, unknown> | undefined;
  const query = vi.fn(
    async (
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
      const sql = text.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql.startsWith("select status from knowledge_service.operation"))
        return { rows: options.active === false ? [] : [{ status: "running" }], rowCount: 1 };
      if (sql.startsWith("select step.id from knowledge_service.operation_step"))
        return { rows: options.active === false ? [] : [{ id: ids.step }], rowCount: 1 };
      if (sql.startsWith("select * from evaluation.verification_benchmark_run"))
        return { rows: run ? [run] : [], rowCount: run ? 1 : 0 };
      if (sql.startsWith("insert into evaluation.verification_benchmark_run")) {
        const v = values;
        run = {
          id: v[0],
          tenant_id: v[1],
          operation_id: v[2],
          dataset_artifact_id: v[3],
          dataset_sha256: v[4],
          experiment_artifact_id: v[5],
          experiment_sha256: v[6],
          runner_version: v[7],
          network_policy: v[8],
          random_seed: v[9],
          repetitions: v[10],
          checkpoint_plan: JSON.parse(String(v[11])),
          checkpoint_plan_sha256: v[12],
          expected_checkpoint_count: v[13],
          started_at: v[14],
          completed_at: null,
          status: "running",
        };
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("select count(*)::text count")) return { rows: [{ count: "0" }], rowCount: 1 };
      throw new Error(`UNEXPECTED_SQL:${text}`);
    },
  );
  const database = {
    transaction: vi.fn(async (_tenant: string, work: (client: TenantSqlClient) => Promise<unknown>) =>
      work({ query } as unknown as TenantSqlClient),
    ),
  };
  return {
    store: new PostgresVerificationBenchmarkRunStore(database as never),
    query,
    get run() {
      return run;
    },
  };
}

describe("PostgresVerificationBenchmarkRunStore", () => {
  it("creates exactly one fenced identity and returns its persisted original start on a later retry", async () => {
    expect(input().tenantId).toMatch(/^[0-9a-f-]+$/);
    expect(input().tenantId).toHaveLength(36);
    const value = subject(),
      first = await value.store.initialize(input()),
      second = await value.store.initialize({ ...input(), startedAt: "2026-09-05T00:01:00.000Z" });
    expect(first.run.startedAt).toBe(input().startedAt);
    expect(second.run.startedAt).toBe(input().startedAt);
    expect(
      value.query.mock.calls.filter(([sql]) =>
        String(sql).includes("insert into evaluation.verification_benchmark_run"),
      ),
    ).toHaveLength(1);
  });
  it("rejects changed admitted bindings and stale/cancelled leases before run mutation", async () => {
    const value = subject();
    await value.store.initialize(input());
    await expect(value.store.initialize({ ...input(), randomSeed: 8 })).rejects.toThrow("IDENTITY_DRIFT");
    const stale = subject({ active: false });
    await expect(stale.store.initialize(input())).rejects.toThrow("OPERATION_NOT_ACTIVE");
    expect(
      stale.query.mock.calls.some(([sql]) => String(sql).includes("insert into evaluation.verification_benchmark_run")),
    ).toBe(false);
  });
  it("does not complete a run until every immutable planned checkpoint exists", async () => {
    const value = subject(),
      opened = await value.store.initialize(input());
    await expect(opened.lifecycle.complete()).rejects.toThrow("CHECKPOINT_PLAN_INCOMPLETE");
  });
});
