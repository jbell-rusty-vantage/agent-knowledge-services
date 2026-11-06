import { describe, expect, it, vi } from "vitest";
import type { VerificationArtifactHandle } from "@aiengineer/knowledge-contracts";
import { digestCanonicalJson } from "@aiengineer/knowledge-verification";
import {
  PostgresVerificationBenchmarkComparisonStore,
  type VerificationBenchmarkComparisonIdentity,
} from "./verification-benchmark-comparison.js";
import type { LeasedStep } from "./types.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const start = "2026-09-06T00:00:00.000Z",
  end = "2026-09-06T00:01:00.000Z";
const artifact = (n: number): VerificationArtifactHandle => ({
  artifactId: id(n),
  tenantId: id(1),
  digest: digestCanonicalJson(n),
  mediaType: "application/json",
  byteLength: 2,
  objectKey: `private/${id(n)}`,
  createdAt: start,
  producerActivityId: "fixture",
  producerVersion: "1",
  encryptionClass: "managed",
  retentionClass: "audit",
  dataClassification: "restricted",
  parentArtifactIds: [],
});
const identity = (): VerificationBenchmarkComparisonIdentity => ({
  tenantId: id(1),
  operationId: id(2),
  comparisonId: id(3),
  baseline: { runId: id(4), publicationArtifact: artifact(5), payloadDigest: digestCanonicalJson("baseline") },
  candidate: { runId: id(6), publicationArtifact: artifact(7), payloadDigest: digestCanonicalJson("candidate") },
  profileId: "paired_default",
  profileArtifact: artifact(8),
  runtime: {
    deploymentId: "test",
    attemptId: id(9),
    capabilityVersion: "verification-service.v1",
    targetCodeRef: "fixture",
    gitSha: "a".repeat(40),
    dirty: false,
  },
});
const lease: LeasedStep = {
  id: id(10),
  tenantId: id(1),
  operationId: id(2),
  stepKey: "compare_registered_and_publish",
  stepKind: "compare_registered_and_publish",
  inputSha256: "a".repeat(64),
  status: "running",
  attemptCount: 1,
  maxAttempts: 3,
  rowVersion: 1,
  holderIdentity: "test",
  leaseToken: id(11),
  fencingToken: 1,
  expiresAt: end,
};
function subject(options: { active?: boolean; liveLease?: boolean; status?: "running" | "completed" | "sealed" } = {}) {
  const value = identity(),
    status = options.status ?? "running",
    result = artifact(12),
    publication = artifact(13);
  const row = {
    id: value.comparisonId,
    tenant_id: value.tenantId,
    operation_id: value.operationId,
    baseline_run_id: value.baseline.runId,
    candidate_run_id: value.candidate.runId,
    baseline_publication_artifact_id: value.baseline.publicationArtifact.artifactId,
    baseline_publication_sha256: value.baseline.publicationArtifact.digest.slice(7),
    baseline_payload_sha256: value.baseline.payloadDigest.slice(7),
    candidate_publication_artifact_id: value.candidate.publicationArtifact.artifactId,
    candidate_publication_sha256: value.candidate.publicationArtifact.digest.slice(7),
    candidate_payload_sha256: value.candidate.payloadDigest.slice(7),
    profile_id: value.profileId,
    profile_artifact_id: value.profileArtifact.artifactId,
    profile_sha256: value.profileArtifact.digest.slice(7),
    runtime: value.runtime,
    runtime_sha256: digestCanonicalJson(value.runtime).slice(7),
    status,
    started_at: start,
    completed_at: status === "running" ? null : end,
    result_artifact_id: status === "running" ? null : result.artifactId,
    result_sha256: status === "running" ? null : result.digest.slice(7),
    result_digest_sha256: status === "running" ? null : digestCanonicalJson("result").slice(7),
    engineering_gate_outcome: status === "running" ? null : "not_requested",
    publication_artifact_id: status === "sealed" ? publication.artifactId : null,
    publication_sha256: status === "sealed" ? publication.digest.slice(7) : null,
    publication_payload_sha256: status === "sealed" ? digestCanonicalJson("publication").slice(7) : null,
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("select set_config")) return { rows: [] };
    if (sql.startsWith("select status,operation_kind"))
      return {
        rows:
          options.active === false
            ? []
            : [{ status: "running", operation_kind: "verification_benchmark_compare", attempt_id: id(9) }],
      };
    if (sql.startsWith("select step.id")) return { rows: options.liveLease === false ? [] : [{ id: id(10) }] };
    if (sql.startsWith("select * from evaluation.verification_benchmark_comparison")) return { rows: [row] };
    throw new Error("UNEXPECTED_MUTATION");
  });
  const transaction = vi.fn(async (_tenant: string, work: any) => work({ query }));
  return {
    store: new PostgresVerificationBenchmarkComparisonStore({ transaction } as never),
    query,
    transaction,
    result,
    publication,
  };
}
describe("durable benchmark comparison boundary", () => {
  it("reuses retained timing while rejecting changed input identity", async () => {
    const s = subject(),
      first = await s.store.initialize(identity(), lease);
    expect(first.startedAt).toBe(start);
    expect(Object.isFrozen(first.identity)).toBe(true);
    await expect(
      s.store.initialize(
        { ...identity(), baseline: { ...identity().baseline, payloadDigest: digestCanonicalJson("changed") } },
        lease,
      ),
    ).rejects.toThrow("IDENTITY_DRIFT");
    expect(s.query.mock.calls.every(([sql]) => sql.startsWith("select"))).toBe(true);
  });
  it("rejects malformed claims before SQL, and inactive operations or stale leases before reading lifecycle", async () => {
    const malformed = subject();
    await expect(malformed.store.initialize(identity(), { ...lease, leaseToken: "invalid" })).rejects.toThrow(
      "LEASE_INVALID",
    );
    expect(malformed.transaction).not.toHaveBeenCalled();
    for (const [options, cause] of [
      [{ active: false }, "OPERATION_NOT_ACTIVE"],
      [{ liveLease: false }, "STALE_LEASE"],
    ] as const) {
      const s = subject(options);
      await expect(s.store.initialize(identity(), lease)).rejects.toThrow(cause);
      expect(s.query.mock.calls.some(([sql]) => sql.includes("select *"))).toBe(false);
    }
  });
  it("exact completion retry retains its time and rejects result drift", async () => {
    const s = subject({ status: "completed" }),
      comparison = await s.store.initialize(identity(), lease);
    const input = {
      comparison,
      lease,
      resultArtifact: s.result,
      resultDigest: digestCanonicalJson("result"),
      engineeringGateOutcome: "not_requested" as const,
    };
    expect((await s.store.complete(input)).completedAt).toBe(end);
    await expect(s.store.complete({ ...input, resultDigest: digestCanonicalJson("drift") })).rejects.toThrow(
      "RESULT_DRIFT",
    );
    await expect(s.store.complete({ ...input, comparison: { ...comparison, startedAt: end } })).rejects.toThrow(
      "EXPECTED_IDENTITY_INVALID",
    );
  });
  it("sealed retries require the original result and exact publication identity", async () => {
    const s = subject({ status: "sealed" }),
      comparison = await s.store.initialize(identity(), lease),
      input = {
        comparison,
        lease,
        publicationArtifact: s.publication,
        publicationPayloadDigest: digestCanonicalJson("publication"),
      };
    expect((await s.store.seal(input)).status).toBe("sealed");
    await expect(s.store.seal({ ...input, publicationPayloadDigest: digestCanonicalJson("changed") })).rejects.toThrow(
      "PUBLICATION_DRIFT",
    );
    await expect(
      s.store.seal({ ...input, comparison: { ...comparison, resultDigest: digestCanonicalJson("changed") } }),
    ).rejects.toThrow("NOT_COMPLETED");
  });
});
